// === service-worker.js ===
/**
 * @module service-worker
 * @description MV3 Service Worker: pipeline orchestrator, message bus, and
 *   SW lifecycle manager.
 *
 *   (This file used to claim all state was persisted before every await to
 *   survive SW termination. It never was; the lifecycle note below says what is
 *   actually guaranteed.)
 *
 *   Design decision: The SW uses a message-handler registry pattern (Map of
 *   handlers keyed by message name) instead of a giant switch statement. This
 *   keeps the bus extensible and each handler independently testable.
 *   All inbound message names must match the canonical registry.
 *
 *   SW lifecycle: state that must survive worker termination is re-hydrated by
 *   _bootstrap() at module scope, not from the `activate` event — MV3 does not
 *   re-fire `activate` when it wakes a terminated worker.
 *
 *   What does NOT survive: _runStates. A run in flight when the worker is
 *   terminated is lost, and the pipeline cannot be resumed from where it
 *   stopped — that would mean re-entering the step chain with the right
 *   template context against a tab that may since have navigated. What is
 *   guaranteed instead is that the loss is visible: rows already collected stay
 *   in IndexedDB under their run's cursor, the side panel polls pipeline:status
 *   and reports the interruption rather than showing a Stop button forever, and
 *   the rows remain downloadable. See docs/ISSUE_AUDIT.md D-01.
 *
 * @dependencies proxy-manager, api-key-manager, rate-limiter, ethics-engine, logger
 */

import { logger } from "../utils/logger.js";
import { scanRows, summarizeFindings } from "../ethics/pii-detector.js";
import {
  listSchedules,
  getSchedule,
  saveSchedule,
  deleteSchedule,
  markRun,
  syncAlarms,
  missedWindows,
  scheduleIdFromAlarm,
  MIN_PERIOD_MINUTES,
} from "./scheduler.js";
import { SeenKeys, filterRows, parseFields } from "../utils/row-dedupe.js";
import { extractPdfText, extractPdfItems } from "../utils/pdf-text.js";
import { tablesFromPages } from "../utils/pdf-tables.js";
import {
  ALL_STEP_TYPES,
  STEP_TYPES,
  retryCount,
  retryDelayMs,
  API_RETRY_LIMITS,
  paginationMaxPages,
} from "../utils/step-types.js";
import { applyTransforms } from "../utils/value-transforms.js";
import { evaluateCondition } from "../utils/conditions.js";
import { evaluateAssertion } from "../utils/assertions.js";
import { solveLocalChallenge, tierOf } from "../utils/captcha-solvers.js";
import { matchesSnifferFilter } from "../utils/sniffer-filter.js";
import {
  hasPermission,
  permissionRefusal,
  permissionStatus,
} from "./optional-permissions.js";
// Statically, not with a dynamic import().
//
// `import()` is disallowed outright in a ServiceWorkerGlobalScope — the HTML
// spec forbids it, and Chrome throws "import() is disallowed on
// ServiceWorkerGlobalScope". Nine call sites here used it, so the AI gateway's
// save and test buttons, the API-key handlers and the captcha model path all
// threw the moment they ran in a real browser. Every unit test passed: Node
// allows dynamic import, so the worker harness never reproduced it. An
// end-to-end check against a real Chromium is what finally surfaced it.
import {
  initSessionKey,
  listProviders,
  validateApiKey,
  getApiKey,
  setApiKey,
  solveCaptcha,
} from "./api-key-manager.js";
import {
  applyHeaderRules,
  parseHeaderText,
  clearHeaderRules,
  sweepHeaderRules,
} from "./header-rules.js";
import {
  saveSession,
  loadSession,
  deleteSession,
  listSessions,
} from "./session-store.js";
import {
  loadPool,
  selectProxy,
  rotateProxy,
  clearProxy,
  _applyProxy,
  getPool,
  markProxyFailure,
  testAllProxies,
  parseProxyText,
  addToPool,
  savePool,
  setRotationMode,
  setTargetCountry,
  getTargetCountry,
  poolCountries,
} from "./proxy-manager.js";
import { acquire, backoff, resetRetry } from "./rate-limiter.js";
import {
  runEthicsGates,
  EthicsBlock,
  collectDeclaredOrigins,
} from "./ethics-engine.js";
// The same analyser the panel's import gate and the registry's publish gate
// use. Enforced here as well because this is the only place every pipeline
// passes through — see the check beside the ethics gates below.
import { analyzePipeline, VERDICT } from "../utils/pipeline-capabilities.js";
import {
  initBuffer,
  pushRow,
  flush,
  finalizeBuffer,
  droppedRowCount,
  readAllRows,
} from "../checkpoint/row-buffer.js";
import {
  appendRows as appendDatasetRows,
  readDataset,
  datasetName,
  MAX_DATASET_ROWS,
} from "../checkpoint/dataset-store.js";
import {
  parseListLines,
  itemsFromContext,
  MAX_LIST_ITEMS,
} from "../utils/loop-items.js";
import { saveCursor } from "../checkpoint/cursor-store.js";
import {
  getResumePayload,
  markRunCompleted,
} from "../checkpoint/resume-manager.js";
import {
  compilePipeline,
  findUnexportableSteps,
  findUnresolvedTemplates,
  redactSecrets,
} from "../script-gen/pipeline-compiler.js";
import { emitPython } from "../script-gen/python-emitter.js";
import { emitNode } from "../script-gen/node-emitter.js";
import { runLlmLayer } from "./llm-extractor.js";
import {
  parseSchema,
  weightsFor,
  mapNodeToSchema,
} from "../utils/extraction-schema.js";
import { groundFields } from "../utils/extraction-grounding.js";
import { judgeSelectors, toExtractStep } from "../utils/selector-learning.js";
import {
  buildProvenance,
  summarise as summariseProvenance,
  provenanceColumn,
} from "../utils/extraction-provenance.js";
// Non-secret AI-gateway settings (provider/model/baseUrl). The key itself
// never lives here — it goes through api-key-manager.js's encrypted,
// session-only storage under provider id `gateway:<provider>`, same as every
// other credential this extension holds (K-17).
import {
  GATEWAY_STORAGE_KEY as STORAGE_GATEWAY_KEY,
  readGatewayConfig,
} from "./gateway-config.js";
import {
  askVision,
  testConnection,
  GATEWAY_PROVIDERS,
} from "../utils/ai-gateway.js";
import {
  formatRows,
  formatMeta,
  ROW_FORMATS,
  APPENDABLE_FORMATS,
} from "../exporters/row-formatters.js";

const MODULE = "service-worker";
const STORAGE_FILES_KEY = "vq_storage_files_v1";

// ── Restricted sites that block automated file uploads ────────────────────────
const RESTRICTED_UPLOAD_SITES = Object.freeze({
  "linkedin.com": true,
  "www.linkedin.com": true,
  "facebook.com": true,
  "www.facebook.com": true,
  "twitter.com": true,
  "x.com": true,
  "instagram.com": true,
  "www.instagram.com": true,
});

// ── Cross-origin enforcement ──────────────────────────────────────────────────
/**
 * Refuse to navigate or call an origin the pipeline never declared.
 *
 * The pre-run gate can only see URLs the author typed. A templated URL —
 * `{{item.href}}`, most often — is resolved from the page's own DOM by
 * QUERY_ELEMENTS, which means the *page* chooses it. A hostile or merely
 * compromised page could point a NAVIGATE at any origin it liked and have the
 * following steps (a FILL carrying credentials, an UPLOAD_ACTIVITY carrying
 * files) run there.
 *
 * So the check happens here, where the resolved URL is finally known, against
 * the set of origins the pipeline declared. Same-origin templated links — the
 * ordinary "loop the product cards and open each one" case — pass untouched.
 *
 * @param {string} rawUrl   - already template-resolved
 * @param {object} runState
 * @param {string} stepType
 */
function _assertOriginAllowed(rawUrl, runState, stepType) {
  const allowed = runState?.allowedOrigins;
  if (!allowed || allowed.size === 0) return; // nothing declared; nothing to enforce

  let origin;
  try {
    origin = new URL(rawUrl, runState.targetOrigin || undefined).origin;
  } catch {
    return; // not resolvable here; the step will fail on its own terms
  }

  if (allowed.has(origin)) return;

  throw new EthicsBlock(
    "UndeclaredOrigin",
    `${stepType} resolved to ${origin}, which this pipeline never declared. ` +
      `Allowed: ${[...allowed].join(", ")}. ` +
      `A URL built from page content (for example {{item.href}}) is chosen by the page, ` +
      `not by you — add a step targeting ${origin} explicitly if you meant to go there.`,
  );
}

// ── Network sniffer lifecycle ─────────────────────────────────────────────────
/**
 * page-sniffer.js wraps window.fetch and XMLHttpRequest and forwards every
 * request and response body it sees. It used to be declared in the manifest as
 * a MAIN-world content script on <all_urls> at document_start, so it ran on
 * every site the user visited — banking, webmail, everything — buffering up to
 * 500 KB per response and messaging it to this worker, which then discarded it
 * unless an API_SNIFFER run happened to be active.
 *
 * It is now registered only while such a run is in flight, and scoped to the
 * run's own origin rather than every site.
 */
const SNIFFER_SCRIPT_ID = "vq_page_sniffer";
const SNIFFER_FILE = "content/page-sniffer.js";

/**
 * The isolated-world half of the sniffer.
 *
 * page-sniffer.js runs in the MAIN world, where there is no `chrome.runtime`,
 * so it reports what it caught by posting a window message. injector.js is what
 * listens for that and forwards it to this worker — and injector.js is injected
 * *on demand*, when a page step needs it.
 *
 * On a freshly navigated page it is therefore not there. The hook installed
 * fine, caught the request fine, posted the message fine, and nobody was
 * listening: every capture was dropped. Since a run almost always navigates
 * before the traffic it cares about, the sniffer captured nothing in practice.
 *
 * So the relay is registered with the same matches and the same lifetime as the
 * hook it serves. injector.js guards itself with `__vqInjected`, so this and
 * the on-demand injection cannot install two listeners.
 */
const SNIFFER_RELAY_ID = "vq_sniffer_relay";
const INJECTOR_FILE = "content/injector.js";

/** Runs currently requesting the sniffer; it is unregistered when this empties. */
const _snifferRuns = new Set();

function _snifferMatches(targetOrigin) {
  if (typeof targetOrigin === "string" && /^https?:\/\//.test(targetOrigin)) {
    return [`${targetOrigin}/*`];
  }
  // No usable origin (started from a new tab); fall back to all sites for the
  // duration of the run rather than capturing nothing.
  return ["<all_urls>"];
}

async function _enableSniffer(runId, tabId, targetOrigin) {
  _snifferRuns.add(runId);

  try {
    const existing = await chrome.scripting
      .getRegisteredContentScripts({ ids: [SNIFFER_SCRIPT_ID] })
      .catch(() => []);
    if (existing.length) {
      await chrome.scripting.unregisterContentScripts({
        ids: [SNIFFER_SCRIPT_ID],
      });
    }

    const existingRelay = await chrome.scripting
      .getRegisteredContentScripts({ ids: [SNIFFER_RELAY_ID] })
      .catch(() => []);
    if (existingRelay.length) {
      await chrome.scripting.unregisterContentScripts({
        ids: [SNIFFER_RELAY_ID],
      });
    }

    await chrome.scripting.registerContentScripts([
      {
        id: SNIFFER_SCRIPT_ID,
        js: [SNIFFER_FILE],
        matches: _snifferMatches(targetOrigin),
        runAt: "document_start",
        world: "MAIN",
        allFrames: false,
        persistAcrossSessions: false,
      },
      {
        // The listener for what the hook above posts. Without it the captures
        // go nowhere; see SNIFFER_RELAY_ID.
        //
        // document_start, like the hook, and for the same reason. At
        // document_end the listener did not exist yet while the page was
        // parsing, so a request the page fires from an inline script — the
        // ordinary shape of "load the table over fetch" — was hooked, posted,
        // and landed on nobody. Whether it survived came down to whether the
        // response arrived before parsing finished, which made the capture a
        // coin flip: the ajax challenge failed about one run in three. The
        // injector reads no DOM at load beyond `documentElement`, which exists
        // by document_start, and defers its own document report to
        // DOMContentLoaded, so it is safe this early.
        id: SNIFFER_RELAY_ID,
        js: [INJECTOR_FILE],
        matches: _snifferMatches(targetOrigin),
        runAt: "document_start",
        world: "ISOLATED",
        allFrames: false,
        persistAcrossSessions: false,
      },
    ]);
    logger.info(MODULE, "sniffer-registered", { runId });
  } catch (err) {
    logger.error(MODULE, "sniffer-register-fail", { error: err.message });
    _broadcastLog(
      "error-log",
      `API Sniffer could not start: ${err.message}`,
      runId,
    );
    return;
  }

  // The registration above only takes effect on the next document_start. Inject
  // into the page that is already open so the run does not have to navigate
  // first — traffic that happened before this point is necessarily missed.
  if (tabId) {
    // The relay, on the page that is already open. Through _ensureInjected so
    // a document that already has it is left alone: injector.js survives a
    // second evaluation now, but not injecting twice is still cheaper than
    // relying on it.
    await _ensureInjected(tabId).catch(() => {});
    await chrome.scripting
      .executeScript({
        target: { tabId },
        world: "MAIN",
        files: [SNIFFER_FILE],
      })
      .then(() =>
        _broadcastLog(
          "info-log",
          "API Sniffer active. Requests made before this point are not captured.",
          runId,
        ),
      )
      .catch((err) =>
        _broadcastLog(
          "warn-log",
          `API Sniffer could not hook the current page (${err.message}). It will start on the next navigation.`,
          runId,
        ),
      );
  }
}

async function _disableSniffer(runId) {
  if (!_snifferRuns.delete(runId)) return;
  if (_snifferRuns.size > 0) return; // another run still wants it

  for (const id of [SNIFFER_SCRIPT_ID, SNIFFER_RELAY_ID]) {
    await chrome.scripting
      .unregisterContentScripts({ ids: [id] })
      .then(() => logger.info(MODULE, "sniffer-unregistered", { runId, id }))
      .catch((err) =>
        logger.warn(MODULE, "sniffer-unregister-fail", {
          id,
          error: err.message,
        }),
      );
  }
}

// ── Utility helpers ────────────────────────────────────────────────────────────
const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function _broadcastLog(level, message, runId) {
  const rs = _runStates.get(runId);
  chrome.runtime
    .sendMessage({
      type: "pipeline:log",
      payload: { level, message, runId, tabId: rs?.tabId },
    })
    .catch(() => {});
}

// ── Canonical message names ────────────────────────────────────────────────────
const MSG = Object.freeze({
  PIPELINE_START: "pipeline:start",
  PIPELINE_PAUSE: "pipeline:pause",
  PIPELINE_RESUME: "pipeline:resume",
  PIPELINE_STOP: "pipeline:stop",
  PIPELINE_STATUS: "pipeline:status",
  STEP_EXECUTE: "step:execute",
  STEP_RESULT: "step:result",
  PROXY_SELECT: "proxy:select",
  PROXY_ROTATE: "proxy:rotate",
  PROXY_TEST: "proxy:test",
  CAPTCHA_SOLVE: "captcha:solve",
  CAPTCHA_RESULT: "captcha:result",
  KEY_GET: "key:get",
  FORM_ROW_START: "form:rowStart",
  FORM_ROW_RESULT: "form:rowResult",
  CHECKPOINT_SAVE: "checkpoint:save",
});

// ── Pipeline run state ─────────────────────────────────────────────────────────
/** @type {{ active: boolean, paused: boolean, runId: string|null, tabId: number|null, results: any[], screenshots: string[] }} */
const _runStates = new Map();

// ── SW bootstrap ──────────────────────────────────────────────────────────────
/**
 * Re-hydrate module-scope state that does not survive worker termination.
 *
 * This runs at module scope, not only from the `activate` event: MV3 tears an
 * idle worker down after ~30s and fires `activate` only on a genuine
 * (re)installation, not when it wakes the worker again. Anything hung off
 * `activate` alone is therefore absent for the rest of the browser session —
 * which is why the proxy pool used to come back empty after the first idle
 * timeout.
 *
 * Kept as a floating promise so MV3 listener registration below stays
 * synchronous.
 */
async function _bootstrap() {
  // Anything a crashed run left in force on a tab the user is now browsing by
  // hand. Session rules survive a worker restart; the run that asked for them
  // did not.
  await sweepHeaderRules().catch(() => {});
  await initSessionKey().catch((err) =>
    logger.error(MODULE, "session-key-init-fail", { error: err.message }),
  );
  await loadPool().catch((err) =>
    logger.error(MODULE, "pool-load-fail", { error: err.message }),
  );
  // A run that was routing through a proxy when this worker was terminated
  // left the browser proxied and took the only record of that with it. This
  // worker starts with no run in flight, so anything still held is stale and
  // the user's whole browser is going somewhere they did not choose.
  const held = await chrome.storage.local
    .get(STORAGE_PROXY_HELD_KEY)
    .catch(() => ({}));
  if (held?.[STORAGE_PROXY_HELD_KEY]) {
    await clearProxy().catch((err) =>
      logger.error(MODULE, "stale-proxy-clear-fail", { error: err.message }),
    );
    await chrome.storage.local.remove(STORAGE_PROXY_HELD_KEY).catch(() => {});
    logger.warn(MODULE, "stale-proxy-cleared", {
      runId: held[STORAGE_PROXY_HELD_KEY].runId,
    });
  }

  // Runs that were in flight when this worker was terminated. Their rows are
  // still in IndexedDB; nothing can resume the pipeline itself.
  const resumable = await getResumePayload().catch(() => null);
  if (resumable?.hasResumable) {
    logger.warn(MODULE, "interrupted-runs", {
      count: resumable.runs.length,
      runIds: resumable.runs.map((r) => r.runId),
    });
  }

  // Alarms do not survive an extension reload, and a schedule with no alarm
  // never runs — silently, which is the worst way for a scheduler to fail.
  // Re-armed every time the worker starts, which also clears any alarm whose
  // schedule was deleted while the worker was down.
  await syncAlarms().catch((err) =>
    logger.error(MODULE, "alarm-sync-fail", { error: err.message }),
  );

  logger.info(MODULE, "sw-bootstrapped", {});
}

_bootstrap();

self.addEventListener("activate", () => {
  logger.info(MODULE, "sw-activated", {});
});

self.addEventListener("install", () => {
  logger.info(MODULE, "sw-installed", {});
  self.skipWaiting();
});

// ── Keeping the worker alive during a run ─────────────────────────────────────
/**
 * MV3 shuts an idle service worker down after 30 seconds, and an `await` on a
 * timer does not count as activity. This mattered: a run doing anything slower
 * than 30s between extension events simply vanished mid-pipeline.
 *
 * The old approach was an alarm at `periodInMinutes: 0.33`, described in the
 * code as "~20s". Chrome clamps any period below 1 to one minute in a packed
 * extension (30s unpacked), so the alarm fired *after* the worker it was meant
 * to keep alive had already been torn down (D-02). It was also armed only from
 * the `activate` event, so it never came back after a restart, and cleared
 * whenever the last run ended.
 *
 * What actually resets the idle timer is calling an extension API. So the
 * keep-alive is an interval that makes a cheap call, and the alarm stays as the
 * backstop that can restart a worker Chrome killed anyway — at a period Chrome
 * will honour, and no longer claiming to be a 20-second heartbeat.
 */
const KEEPALIVE_MS = 20000;
let _keepaliveTimer = null;

function _startHeartbeat() {
  chrome.alarms.create("vq_sw_heartbeat", { periodInMinutes: 1 });
  if (_keepaliveTimer) return;
  _keepaliveTimer = setInterval(() => {
    if (_runStates.size === 0) {
      _stopHeartbeat();
      return;
    }
    // Any extension API call resets the 30s idle timer. getPlatformInfo is the
    // cheapest one that touches no state.
    chrome.runtime.getPlatformInfo?.().catch(() => {});
  }, KEEPALIVE_MS);
}

function _stopHeartbeat() {
  if (_keepaliveTimer) {
    clearInterval(_keepaliveTimer);
    _keepaliveTimer = null;
  }
  chrome.alarms.clear("vq_sw_heartbeat").catch(() => {});
}

chrome.alarms.onAlarm.addListener((alarm) => {
  const scheduleId = scheduleIdFromAlarm(alarm.name);
  if (scheduleId) {
    _runSchedule(scheduleId).catch((err) => {
      logger.error(MODULE, "schedule-run-failed", {
        id: scheduleId,
        error: err.message,
      });
    });
    return;
  }

  if (alarm.name === "vq_sw_heartbeat") {
    logger.debug(MODULE, "heartbeat", { active: _runStates.size > 0 });
    // The worker may have been restarted by this very alarm, in which case the
    // interval is gone. Re-arm it if a run is still supposed to be in flight.
    if (_runStates.size > 0) _startHeartbeat();
    else _stopHeartbeat();
  }
});

// ── Capture limits ────────────────────────────────────────────────────────────
/**
 * Screenshots and sniffed requests live in the worker's heap until export, and
 * nothing bounded either of them. A 200-iteration loop with a screenshot step
 * exhausted memory long before the export it was collecting for (D-10), and a
 * sniffer run on a chatty page did the same at up to 550 KB per request (D-11).
 *
 * These are ceilings, not a fix for the design: the right answer is to stream
 * captures to IndexedDB the way rows already are. Until then a run stops
 * retaining rather than dying, and says so once so the export is not silently
 * short.
 */
const CAPTURE_LIMITS = Object.freeze({
  screenshotBytes: 48 * 1024 * 1024,
  screenshotCount: 500,
  networkBytes: 32 * 1024 * 1024,
  networkCount: 5000,
});

/**
 * Append to a capture buffer unless it is full.
 *
 * @param {object} runState
 * @param {'screenshots'|'networks'} key
 * @param {object} entry
 * @param {number} bytes - approximate size of this entry
 * @param {number} maxBytes
 * @param {number} maxCount
 * @param {string} runId
 * @returns {boolean} false when the entry was dropped
 */
function _pushCapture(runState, key, entry, bytes, maxBytes, maxCount, runId) {
  if (!Array.isArray(runState[key])) runState[key] = [];
  const sizeKey = `${key}Bytes`;
  const dropKey = `${key}Dropped`;
  runState[sizeKey] = runState[sizeKey] || 0;
  runState[dropKey] = runState[dropKey] || 0;

  if (
    runState[key].length >= maxCount ||
    runState[sizeKey] + bytes > maxBytes
  ) {
    runState[dropKey]++;
    // One warning per run, not one per dropped item.
    if (runState[dropKey] === 1) {
      _broadcastLog(
        "warn-log",
        `${key === "screenshots" ? "Screenshot" : "Network capture"} buffer is full ` +
          `(${runState[key].length} kept, ~${Math.round(runState[sizeKey] / 1048576)} MB). ` +
          `Further captures in this run are dropped; the export will say how many.`,
        runId,
      );
    }
    return false;
  }

  runState[key].push(entry);
  runState[sizeKey] += bytes;
  return true;
}

// ── Content script injection ─────────────────────────────────────────────────
/**
 * Files the page needs before a step can be dispatched to it.
 *
 * These used to be declared in the manifest for `<all_urls>`, so both ran in
 * every page the user visited — for a tool that operates on one tab at a time
 * (audit C-09). They are injected on demand now, into the tab a run or a picker
 * is about to touch, which is the only tab that ever needed them.
 *
 * Order matters: injector.js expects the smart extractor to be present.
 */
// What every page needs. `injector.js` is the whole step vocabulary; the four
// specialists below are one step each, and used to ride along with it into
// every frame of every page — 201 KB parsed per frame, of which 82 KB was for
// steps the pipeline usually does not contain. A page with twenty iframes paid
// that twenty times.
const CONTENT_FILES = ["content/injector.js"];

/**
 * The specialists, and the one thing each is for.
 *
 * Injected when the step that needs it runs, not before. The injector already
 * throws "not loaded in this page" when its global is missing, which is what
 * made this safe to split: the failure mode was already named and handled, it
 * just never happened because everything was always loaded.
 *
 * Keyed by the message the page is about to be sent, so the loading rule lives
 * beside the routing rather than in each caller.
 */
const ON_DEMAND_FILES = Object.freeze({
  VQ_DETECT_STRUCTURE: "content/structure-detector.js",
  PAGE_DATA: "content/page-data.js",
  PAGE_JSON: "content/page-json.js",
  AUTO_EXTRACT: "content/smart-extractor.js",
  SESSION_STORAGE: "content/session-storage.js",
});

/**
 * Files already put into a tab, so a loop of 500 rows injects each one once.
 *
 * Emptied for a tab the moment it starts loading something else: a new document
 * has none of this, and remembering otherwise would leave the step calling a
 * global that is no longer there — the one way this optimisation could turn
 * into a bug that looks like the feature being broken.
 */
const _onDemandLoaded = new Map();

if (chrome.tabs?.onUpdated?.addListener) {
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (info.status !== "loading") return;
    for (const key of _onDemandLoaded.keys()) {
      if (key.startsWith(`${tabId}:`)) _onDemandLoaded.delete(key);
    }
  });
}
if (chrome.tabs?.onRemoved?.addListener) {
  chrome.tabs.onRemoved.addListener((tabId) => {
    for (const key of _onDemandLoaded.keys()) {
      if (key.startsWith(`${tabId}:`)) _onDemandLoaded.delete(key);
    }
  });
}

/**
 * Put the specialist for this message into the tab, if it needs one.
 *
 * Injected into every frame, matching how the injector itself is placed: a
 * selector picked inside an iframe is answered by that frame, and a specialist
 * present only in the top document would leave it answering "not loaded".
 */
async function _ensureOnDemand(tabId, type) {
  const file = ON_DEMAND_FILES[type];
  if (!file || !tabId) return;
  const key = `${tabId}:${file}`;
  if (_onDemandLoaded.get(key)) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: [file],
    });
    _onDemandLoaded.set(key, true);
  } catch (err) {
    // Not fatal here: the step will fail with the injector's own clear message
    // if the global really is missing, and that message is better than this
    // one at saying what the user should do.
    logger.warn(MODULE, "on-demand-inject-fail", { file, error: err.message });
  }
}

/**
 * Make sure the content scripts are live in a tab.
 *
 * Injecting twice would re-register the message listener and double every
 * response, so ask first. A tab that answers is already set up.
 *
 * @param {number} tabId
 * @returns {Promise<void>}
 */
async function _ensureInjected(tabId) {
  if (!tabId) throw new Error("No tab to inject into");

  // Ask every frame whether it has the script, not just the top document.
  //
  // This used to ping frame 0 and return the moment it answered. Frames that
  // appeared *after* that first injection therefore never got the script: a
  // lazy iframe, one that arrives when a tab is opened, one that navigates on
  // interaction. Since almost anything the user does injects the top document
  // first, by the time they reached for the picker the top frame answered
  // "already there" and the iframes had nothing in them at all — so the picker
  // armed only in the page, clicking inside a frame reached nobody, and both
  // picking and running a step in an iframe failed. Reproduced with an iframe
  // added 1.2s after load.
  let probe;
  try {
    probe = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => Boolean(globalThis.__vqInjected),
    });
  } catch (err) {
    // chrome:// pages, the Web Store, and PDF viewers refuse injection. Saying
    // which is more use than "Receiving end does not exist".
    throw new Error(
      `Cannot run steps on this page (${err.message}). Chrome blocks extensions ` +
        `on chrome:// pages, the Web Store and PDF viewers.`,
    );
  }

  const missing = probe
    .filter((r) => r.result !== true)
    .map((r) => r.frameId)
    .filter((id) => id !== undefined);
  if (missing.length === 0) return;

  try {
    await chrome.scripting.executeScript({
      // Only the frames that need it. injector.js survives a second evaluation
      // (K-01), but it is 167 KB and there is no reason to send it to a frame
      // that already has it.
      target: { tabId, frameIds: missing },
      files: CONTENT_FILES,
    });
  } catch (err) {
    // A single frame can refuse — a sandboxed ad, an about:blank placeholder —
    // without the page as a whole being unusable. Only give up when the top
    // document is the one that refused.
    if (missing.includes(0)) {
      throw new Error(
        `Cannot run steps on this page (${err.message}). Chrome blocks extensions ` +
          `on chrome:// pages, the Web Store and PDF viewers.`,
      );
    }
    logger.warn(MODULE, "frame-inject-partial", {
      error: err.message,
      frames: missing.length,
    });
  }
}

/**
 * Every frame id in a tab, the top document first.
 *
 * Discovered by running a trivial script in all frames. `chrome.webNavigation`
 * would also do it and would cost another permission — C-07 cut four unused
 * ones, and adding one back for a list this cheap would be a poor trade.
 *
 * @returns {Promise<number[]>}
 */
async function _frameIds(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => 1,
    });
    const ids = results.map((r) => r.frameId).filter((id) => id !== undefined);
    // 0 is the top document; try it first so a selector that matches there
    // behaves exactly as it did before the toggle existed.
    return [...new Set([0, ...ids])];
  } catch {
    return [0];
  }
}

/**
 * Did this step actually find anything, or merely not throw?
 *
 * The frame walk needs the difference. EXTRACT does not fail when a field
 * misses — by design, since B-08: it returns the row with nulls rather than
 * inventing data — so the top document "succeeded" with `[{t: null}]` and the
 * walk stopped before reaching the frame that had the element. CLICK is the
 * same shape: `{clicked: 0}` is a successful message and an unsuccessful step.
 *
 * @param {*} result
 * @returns {boolean} true when nothing was found
 */
function _looksEmpty(result) {
  if (result === null || result === undefined) return true;

  if (Array.isArray(result)) {
    if (result.length === 0) return true;
    return result.every(
      (row) =>
        row &&
        typeof row === "object" &&
        Object.values(row).every(
          (v) => v === null || v === undefined || v === "",
        ),
    );
  }

  if (typeof result === "object") {
    if (result.clicked === 0 || result.matched === 0) return true;
    if (result.exists === false) return true;
    if (Array.isArray(result.records) && result.records.length === 0) {
      return result.found === false;
    }
  }
  return false;
}

/**
 * Send a step to each frame in turn, and take the first that succeeds.
 *
 * Only used when a step asks for it. Searching every frame by default would
 * change what an ambiguous selector matches — a page can carry a dozen
 * advertising iframes that each happen to contain a `.title` — so it is a
 * toggle on the step, as it should be.
 *
 * @param {number} tabId
 * @param {object} payload - a resolved step
 * @returns {Promise<{ok: boolean, result?: any, error?: string}>}
 */
async function _sendToFrames(tabId, payload) {
  await _ensureInjected(tabId);
  const frames = await _frameIds(tabId);
  const failures = [];
  let lastEmpty = null;

  for (const frameId of frames) {
    let resp;
    try {
      resp = await chrome.tabs.sendMessage(
        tabId,
        { type: "step:execute", payload },
        { frameId },
      );
    } catch (err) {
      // A frame with no content script — a cross-origin one Chrome refused to
      // inject, or one that has since navigated. Not this step's problem.
      failures.push(`frame ${frameId}: ${err.message}`);
      continue;
    }
    if (resp?.ok && !_looksEmpty(resp.result)) return resp;
    if (resp?.ok) {
      // Ran, found nothing. Keep the last one: if no frame has the element
      // either, this is the answer the step would have given without the
      // toggle, and changing that would make the toggle alter results rather
      // than widen the search.
      lastEmpty = resp;
      failures.push(`frame ${frameId}: nothing matched`);
      continue;
    }
    failures.push(`frame ${frameId}: ${resp?.error ?? "no answer"}`);
  }

  if (lastEmpty) return lastEmpty;
  return {
    ok: false,
    error:
      `Not found in the page or in any of its ${Math.max(0, frames.length - 1)} frame(s). ` +
      failures.slice(0, 3).join("; "),
  };
}

/**
 * What finished runs captured, so it outlives the run state.
 *
 * Bounded twice over: each run's captures are already capped (D-10, D-11), and
 * only the few most recent runs are kept — a worker that hoards every run's
 * screenshots is the memory leak those caps exist to prevent.
 *
 * @type {Map<string, {networks: object[], screenshots: object[]}>}
 */
const _finishedCaptures = new Map();
const FINISHED_CAPTURE_RUNS = 5;

function _keepCaptures(runId, runState) {
  if (!runState) return;
  const networks = runState.networks ?? [];
  const screenshots = runState.screenshots ?? [];
  if (networks.length === 0 && screenshots.length === 0) return;

  _finishedCaptures.set(runId, { networks, screenshots });
  while (_finishedCaptures.size > FINISHED_CAPTURE_RUNS) {
    _finishedCaptures.delete(_finishedCaptures.keys().next().value);
  }
}

/** A run's captures, live or just finished. */
function _capturesFor(runId) {
  const live = _runStates.get(runId);
  if (live) {
    return {
      networks: live.networks ?? [],
      screenshots: live.screenshots ?? [],
    };
  }
  return _finishedCaptures.get(runId) ?? { networks: [], screenshots: [] };
}

/**
 * Chrome's ways of saying "nobody is going to answer that message".
 *
 * Two different facts wear the same shape. "Receiving end does not exist" means
 * the message was never delivered — there is no content script — and the answer
 * is to inject one and try again. "The message port closed before a response
 * was received" means it *was* delivered and the document went away mid-answer,
 * which on a CLICK is the click doing its job. The wording for that second case
 * was missing here, so a click that followed a link surfaced as a raw Chrome
 * error rather than as a navigation.
 */
const _GONE =
  /Receiving end does not exist|message (channel|port) closed|Could not establish connection/i;

/**
 * Send a step to a page, putting the content script back if it is not there.
 *
 * Content scripts are injected on demand (C-09) and are destroyed with the
 * document that hosts them. The run injected once, at the start, so every page
 * step after any navigation — a NAVIGATE, a PAGINATE, a CLICK that follows a
 * link — failed with "Receiving end does not exist". A pipeline that visits
 * more than one page is most pipelines, so this was close to the whole product
 * on any multi-page site; it survived because nothing had ever paginated far
 * enough to notice.
 *
 * Optimistic rather than defensive: send first, and pay for the injection only
 * on the tab where it is actually needed. `_ensureInjected` pings before it
 * injects, so a retry cannot double-register the listener.
 *
 * @param {number} tabId
 * @param {object} payload - a resolved step, `{type, config}`
 * @returns {Promise<{ok: boolean, result?: any, error?: string}>}
 */
/**
 * The frame whose document is at `frameUrl`.
 *
 * Recorded by the picker, so a step runs against the document the user was
 * actually looking at rather than whichever frame answers first. Matched on
 * the URL because frame ids are not stable across a reload — the same iframe
 * gets a new one every navigation, so storing an id would break on the second
 * run.
 *
 * @returns {Promise<?number>} the frame id, or null when that frame is gone
 */
async function _frameIdForUrl(tabId, frameUrl) {
  if (!frameUrl) return null;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => location.href,
    });
    const exact = results.find((r) => r.result === frameUrl);
    if (exact) return exact.frameId;
    // A frame that carries a session id or a cache-buster in its query string
    // is the same frame on the next run; compare without the query.
    const bare = (u) => {
      try {
        const p = new URL(u);
        return p.origin + p.pathname;
      } catch {
        return u;
      }
    };
    const target = bare(frameUrl);
    return (
      results.find((r) => bare(r.result ?? "") === target)?.frameId ?? null
    );
  } catch {
    return null;
  }
}

async function _sendToPage(tabId, payload, opts = {}) {
  // `retryOnGone: false` is for the one step that expects to lose the page it
  // is talking to. Clicking a link tears the document down before it can
  // answer, and the reinjection below would then deliver the same click to the
  // *new* page — a second click nobody asked for, on whatever happens to match
  // there. CLICK opts out and reads the teardown as "it navigated".
  const { retryOnGone = true } = opts;
  await _ensureOnDemand(tabId, payload?.type);

  // A step whose selector was picked inside an iframe knows which one, so aim
  // there rather than broadcasting and taking the first answer. With two
  // frames holding similar data the broadcast returned whichever replied
  // first, which is not a choice the user made.
  const frameUrl = payload?.config?.frameUrl;
  if (frameUrl) {
    const frameId = await _frameIdForUrl(tabId, frameUrl);
    if (frameId !== null) {
      try {
        return await chrome.tabs.sendMessage(
          tabId,
          { type: "step:execute", payload },
          { frameId },
        );
      } catch (err) {
        if (!_GONE.test(err.message) || !retryOnGone) throw err;
        await _ensureInjected(tabId);
        return chrome.tabs.sendMessage(
          tabId,
          { type: "step:execute", payload },
          { frameId },
        );
      }
    }
    // The frame is not on the page any more. Fall through to the frame walk
    // rather than failing outright: the site may have moved the content.
  }

  // "Look inside frames too" — off by default, so a page without iframes
  // behaves exactly as it always did.
  if (payload?.config?.inFrame) return _sendToFrames(tabId, payload);

  // frameId 0 — the top document — explicitly. Without it Chrome delivers the
  // message to *every* frame and hands back whichever answers first, so once
  // the script was injected into all frames an advert's iframe could answer a
  // step aimed at the page. Caught by an e2e check that asserted a selector
  // inside an iframe is *not* found without the toggle.
  const to = { frameId: 0 };
  try {
    return await chrome.tabs.sendMessage(
      tabId,
      { type: "step:execute", payload },
      to,
    );
  } catch (err) {
    if (!_GONE.test(err.message) || !retryOnGone) throw err;
    await _ensureInjected(tabId);
    return chrome.tabs.sendMessage(
      tabId,
      { type: "step:execute", payload },
      to,
    );
  }
}

// ── Message bus ───────────────────────────────────────────────────────────────
/** @type {Map<string, (payload: any, sender: chrome.runtime.MessageSender) => Promise<any>>} */
const _handlers = new Map();

function _registerHandler(name, fn) {
  _handlers.set(name, fn);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { type, payload } = message ?? {};
  if (!type) return false;

  const handler = _handlers.get(type);
  if (!handler) {
    logger.warn(MODULE, "unknown-message", { type });
    sendResponse({ ok: false, error: `Unknown message type: ${type}` });
    return false;
  }

  handler(payload ?? {}, sender)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((err) => {
      // Don't flag "Receiving end does not exist" as a hard SW crash, it just means the target tab needs F5
      if (err.message && err.message.includes("Receiving end does not exist")) {
        logger.warn(MODULE, "tab-not-ready", {
          type,
          message: "Target tab not active/refreshed.",
        });
      } else if (err.expected) {
        // A designed refusal — "this step only means something inside a run".
        // The user still gets the message; the console does not get a red one.
        logger.info(MODULE, "handler-refused", { type, reason: err.message });
      } else {
        logger.error(MODULE, "handler-error", { type, error: err.message });
      }
      sendResponse({ ok: false, error: err.message, code: err.code });
    });

  return true; // keep channel open for async response
});

// ── Message handlers ───────────────────────────────────────────────────────────

/**
 * Build the argument object for runEthicsGates from a run payload.
 *
 * Shared by pipeline:preflight and pipeline:start so the two cannot drift —
 * the preflight the user confirms must be the same evaluation that gates the
 * run. Note bypassRobots: it is sent by the side panel's "Bypass robots.txt"
 * checkbox and used to be dropped here, which made the checkbox inert.
 */
function _gateArgs(payload, tabId) {
  return {
    steps: payload.pipeline?.steps ?? [],
    targetOrigin: payload.targetOrigin,
    targetPath: payload.targetPath ?? "/",
    timing: payload.timing ?? {},
    captcha: {
      enabled: payload.captchaEnabled,
      authorized: payload.captchaAuthorized,
    },
    tabId,
    bypassRobots: payload.bypassRobots ?? false,
    // Gate 5's two inputs. Asked for only when the run will actually use the
    // pool: warning about proxy geography for a run going direct would be the
    // gate crying wolf, which is what makes people stop reading them.
    proxyCountries: payload.useProxy ? poolCountries() : [],
    region: payload.useProxy ? getTargetCountry() : "",
  };
}

/** Serialize gate output for the side panel. */
function _serializeEthics(result) {
  return {
    blocked: result.blocked,
    blocker: result.blocker
      ? { code: result.blocker.code, message: result.blocker.message }
      : null,
    warnings: result.warnings.map((w) => ({
      code: w.code,
      message: w.message,
    })),
  };
}

/**
 * Evaluate the ethics gates without starting anything, so the side panel can
 * show the user what the gates found and let them decide. The gates still run
 * again inside pipeline:start — this is for visibility, not enforcement, and a
 * caller that skips it cannot bypass anything.
 */
_registerHandler("pipeline:preflight", async (payload, sender) => {
  const { pipeline } = payload;
  if (!pipeline) throw new Error("No pipeline provided");
  const tabId = payload.tabId ?? sender.tab?.id;

  const result = await runEthicsGates(_gateArgs(payload, tabId));
  logger.info(MODULE, "preflight", {
    blocked: result.blocked,
    warnings: result.warnings.length,
  });
  return _serializeEthics(result);
});

_registerHandler(MSG.PIPELINE_START, async (payload, sender) => {
  const { pipeline, tabId } = payload;
  if (!pipeline) throw new Error("No pipeline provided");

  // The sniffer is a run-wide capture rather than a step that executes, so its
  // filter comes off the step's config once, here, rather than being consulted
  // per request from a step that has long since finished.
  const snifferStep = (pipeline.steps || []).find(
    (s) => s.type === "API_SNIFFER",
  );
  const enableSniffer = Boolean(snifferStep);
  const snifferFilter = {
    urlFilter: snifferStep?.config?.urlFilter ?? "",
    methods: snifferStep?.config?.methods ?? "",
  };

  const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const runState = {
    active: true,
    paused: false,
    runId,
    tabId: tabId ?? sender.tab?.id,
    enableSniffer,
    snifferFilter,
    targetOrigin: payload.targetOrigin ?? null,
    // Named so a "forever" DEDUPE can tell one pipeline's memory from
    // another's, over the same site.
    pipelineName: pipeline.name ?? "",
    // Half of what SOLVE_CAPTCHA needs. Strict equality, because an absent
    // field must never read as permission.
    captchaAuthorized: payload.captchaAuthorized === true,
    // Off unless the run asks. Chrome has one proxy setting for the whole
    // browser, so this is never a default.
    useProxy: payload.useProxy === true,
    proxyRotateEvery: Number(payload.proxyRotateEvery) || 0,
    allowedOrigins: collectDeclaredOrigins(
      pipeline.steps ?? [],
      payload.targetOrigin,
    ),
    results: [],
    screenshots: [],
  };
  _runStates.set(runId, runState);
  _startHeartbeat(); // only needed while a run is in flight
  await _startRunProxy(runState);

  // The content scripts are no longer declared for every page (C-09), so put
  // them in before the first step needs them. Failing here is better than
  // failing on step 1 with "Receiving end does not exist".
  try {
    await _ensureInjected(runState.tabId);
  } catch (err) {
    _runStates.delete(runId);
    if (_runStates.size === 0) _stopHeartbeat();
    throw err;
  }

  if (enableSniffer) {
    await _enableSniffer(runId, runState.tabId, payload.targetOrigin);
  }

  // Persist state before any await
  await chrome.storage.local.set({
    vq_run_log: { runId, startedAt: Date.now(), status: "running" },
  });

  // Refuse a pipeline that reads credentials and also talks to somewhere it
  // never declared it scrapes. The panel checks this on import and the registry
  // checks it on publish, and neither is enough on its own: a pipeline reaches
  // this function from the MCP server, from a schedule firing hours later, and
  // from anything that can write to chrome.storage — none of which go anywhere
  // near the panel's import dialog.
  //
  // Same reasoning as the ethics gates immediately below, which already re-run
  // rather than trusting a preflight: enforcement must not depend on the caller
  // having asked politely. This is the choke point, so this is where it binds.
  const capabilities = analyzePipeline(pipeline);
  if (capabilities.verdict === VERDICT.BLOCKED) {
    _runStates.delete(runId);
    if (_runStates.size === 0) _stopHeartbeat();
    await _disableSniffer(runId);
    logger.warn(MODULE, "capability-block", {
      runId,
      // Origins, never the pipeline: a refusal that logs the payload puts
      // whatever it was carrying into the log.
      thirdParty: capabilities.thirdPartyOrigins,
    });
    throw new EthicsBlock("CAPABILITY_BLOCK", capabilities.blockedReason);
  }

  // Run ethics gates first. Re-run rather than trusting the preflight result:
  // enforcement must not depend on the caller having asked politely.
  const ethicsResult = await runEthicsGates(_gateArgs(payload, runState.tabId));

  // If ethics gates hard-blocked, abort the run
  if (ethicsResult.blocked) {
    _runStates.delete(runId);
    await _disableSniffer(runId);
    throw new EthicsBlock(
      ethicsResult.blocker.code,
      ethicsResult.blocker.message,
    );
  }

  const warnings = ethicsResult.warnings;
  logger.info(MODULE, "pipeline-start", { runId, warnings: warnings.length });

  // Echo warnings into the run log. They were previously returned to the caller
  // and nothing rendered them, so every soft gate was silent.
  for (const warning of warnings) {
    _broadcastLog(
      "warn-log",
      `Ethics · ${warning.code}: ${warning.message}`,
      runId,
    );
  }

  // Start execution loop async (do not await so UI returns early!)
  _executePipeline(runId, pipeline, runState.tabId).catch((err) => {
    logger.error(MODULE, "pipeline-crash", { runId, error: err.message });
  });

  return {
    runId,
    warnings: warnings.map((w) => ({ code: w.code, message: w.message })),
  };
});

/**
 * Runs whose sniffer filter has already been reported as broken.
 *
 * A busy page makes hundreds of requests. Without this, one bad pattern would
 * log one line per request and bury everything else in the run monitor.
 * @type {Set<string>}
 */
const _snifferFilterWarned = new Set();

_registerHandler("network:sniff", async (payload, sender) => {
  const tabId = sender.tab?.id;
  if (!tabId) return { ok: false };
  for (const [runId, rs] of _runStates.entries()) {
    if (rs.tabId === tabId && rs.active && rs.enableSniffer) {
      // Filtered before it is stored, not after: the capture buffer is bounded
      // (D-10), so on a busy site the analytics beacons, fonts and ad auctions
      // could push the four calls you wanted out of it before the run ended.
      try {
        if (
          !matchesSnifferFilter(
            { url: payload.url, method: payload.method },
            rs.snifferFilter ?? {},
          )
        ) {
          break;
        }
      } catch (err) {
        if (!_snifferFilterWarned.has(runId)) {
          _snifferFilterWarned.add(runId);
          _broadcastLog(
            "warn-log",
            `API_SNIFFER: ${err.message} — recording everything instead.`,
            runId,
          );
        }
      }

      const entry = {
        timestamp: Date.now(),
        method: payload.method,
        url: payload.url,
        status: payload.status,
        requestBody: payload.reqBody || "",
        responseBody: payload.resBody || "",
        type: payload.apiType,
      };
      // Announced, but only every so often: a busy page makes hundreds of
      // requests and one line each would bury the run's own messages.
      const n = (rs.networks?.length ?? 0) + 1;
      if (n <= 3 || n % 25 === 0) {
        _broadcastLog(
          "info-log",
          `Sniffer: ${n} request${n === 1 ? "" : "s"} captured (latest: ${entry.method} ${String(entry.url).slice(0, 80)})`,
          runId,
        );
      }
      // The log going quiet after the third capture is why a working sniffer
      // looked stalled: on a site that makes forty calls you saw three lines
      // and then nothing for the rest of the run. The count is a readout
      // instead, so it keeps moving without burying the run's own messages.
      chrome.runtime
        .sendMessage({
          type: "pipeline:captures",
          payload: { runId, networks: n, tabId: rs.tabId },
        })
        .catch(() => {});
      _pushCapture(
        rs,
        "networks",
        entry,
        (entry.url?.length || 0) +
          entry.requestBody.length +
          entry.responseBody.length,
        CAPTURE_LIMITS.networkBytes,
        CAPTURE_LIMITS.networkCount,
        runId,
      );
      break;
    }
  }
  return { ok: true };
});

// ── Step execution helpers ─────────────────────────────────────────────────────

/**
 * How tall a stitched full-page shot may get, in CSS pixels.
 *
 * An infinite feed has no bottom, so "capture until the page ends" is a loop
 * that never returns. Past this the shot is truncated and says so.
 */
const FULL_PAGE_MAX_HEIGHT = 20000;

/**
 * Chrome caps captureVisibleTab at MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND,
 * which is 2 — a limit found by taking a full-page screenshot in a real
 * browser, where the second strip came back
 * "This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota."
 * Nothing in the unit suite could see it: the mocked captureVisibleTab has no
 * quota, so stitching four strips looked instantaneous and free.
 */
const CAPTURE_MIN_INTERVAL_MS = 550;
let _lastCaptureAt = 0;

/** Take one photograph of whatever is currently on screen. */
async function _captureViewport(windowId, config) {
  // Paced rather than retried-on-failure: a quota error costs a round trip and
  // the retry has to wait anyway, so waiting first is strictly cheaper. It does
  // mean a tall page takes about half a second per screenful, which the panel
  // says.
  const since = Date.now() - _lastCaptureAt;
  if (since < CAPTURE_MIN_INTERVAL_MS) {
    await _sleep(CAPTURE_MIN_INTERVAL_MS - since);
  }
  // format decides whether quality means anything: Chrome ignores it for PNG,
  // so the UI's quality control did nothing at all (B-30). Anything below 100
  // now selects JPEG, where the number is real; 100 keeps lossless PNG.
  const rawQuality = Number(config.quality);
  const quality = Number.isFinite(rawQuality)
    ? Math.max(1, Math.min(100, Math.round(rawQuality)))
    : 100;
  const format = quality >= 100 ? "png" : "jpeg";
  const opts = format === "png" ? { format } : { format, quality };
  let dataUrl;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(windowId, opts);
  } catch (err) {
    // Another extension, or another run, can have spent the quota in the same
    // second. One patient retry rather than failing the step.
    if (!/quota|MAX_CAPTURE/i.test(err.message)) throw err;
    await _sleep(CAPTURE_MIN_INTERVAL_MS);
    dataUrl = await chrome.tabs.captureVisibleTab(windowId, opts);
  }
  _lastCaptureAt = Date.now();
  return { dataUrl, format, quality };
}

/**
 * Join captured strips into one tall image, and optionally crop it.
 *
 * Needs OffscreenCanvas and createImageBitmap, which a service worker has and
 * Node does not — so this path is proven in the e2e suite against a real
 * Chromium rather than in the unit tests. Mocking a canvas would mean asserting
 * against something more capable than the runtime, which is exactly what hid
 * A-12 for four hundred tests.
 *
 * @param {{dataUrl: string, top: number}[]} strips - `top` in device pixels
 * @param {{width: number, height: number, mime: string, crop?: object}} out
 * @returns {Promise<string>} a data: URL
 */
async function _stitchStrips(strips, out) {
  if (
    typeof OffscreenCanvas !== "function" ||
    typeof createImageBitmap !== "function"
  ) {
    throw new Error("This browser cannot join screenshots together.");
  }
  const canvas = new OffscreenCanvas(out.width, out.height);
  const ctx = canvas.getContext("2d");

  for (const strip of strips) {
    const blob = await (await fetch(strip.dataUrl)).blob();
    const bitmap = await createImageBitmap(blob);
    // Drawn at its scroll offset. The last strip overlaps the one before it
    // wherever the page did not have a full viewport left to scroll — which is
    // most pages — so it must be drawn over, not appended.
    ctx.drawImage(bitmap, 0, strip.top);
    bitmap.close?.();
  }

  let surface = canvas;
  if (out.crop) {
    const { x, y, width, height } = out.crop;
    const cropped = new OffscreenCanvas(
      Math.max(1, width),
      Math.max(1, height),
    );
    cropped
      .getContext("2d")
      .drawImage(canvas, x, y, width, height, 0, 0, width, height);
    surface = cropped;
  }

  const blob = await surface.convertToBlob({ type: out.mime });
  return _bytesToDataUrl(new Uint8Array(await blob.arrayBuffer()), out.mime);
}

/**
 * Capture the tab: the visible area, the whole page, or one element.
 *
 * `captureVisibleTab` photographs the viewport and nothing else, which is all
 * this step could ever do. So "screenshot the page" gave you the top of it, and
 * photographing one element was impossible — both under a control that said
 * only "quality".
 */
async function _takeShot(tabId, config = {}, runId) {
  const area = config.area || "viewport";
  try {
    // captureVisibleTab photographs whichever tab is active in the window, so
    // the target has to be the active one. It used to be activated
    // unconditionally, yanking focus away from whatever the user was doing on
    // every screenshot in a loop (B-29). Check first: when the tab is already
    // active — the common case, since the run is driving it — do nothing.
    const before = await chrome.tabs.get(tabId);
    if (!before.active) {
      await chrome.tabs.update(tabId, { active: true });
      await _sleep(400);
    }
    const tab = await chrome.tabs.get(tabId);

    if (area === "full")
      return { ...(await _captureFullPage(tab, config, runId)), area };
    if (area === "element") {
      return { ...(await _captureElement(tab, config, runId)), area };
    }
    const { dataUrl, format } = await _captureViewport(tab.windowId, config);
    return { dataUrl, ext: format === "png" ? "png" : "jpg", area };
  } catch (err) {
    throw new Error(`Screenshot failed: ${err.message}`);
  }
}

/**
 * Take a screenshot and keep it with the run.
 *
 * Split from _takeShot so that testing a single SCREENSHOT step can hand the
 * image straight back. It could not be tested at all before: the step runs in
 * the worker, but the test path forwarded everything it did not special-case
 * to the page, where injector.js rejects SCREENSHOT by design (B-32). Pressing
 * "Test" on a screenshot step therefore always failed.
 */
async function _captureScreenshot(tabId, config = {}, runId) {
  const runState = _runStates.get(runId);
  if (!runState) return;
  const shot = await _takeShot(tabId, config, runId);

  // Held in memory until export, so it is bounded (D-10).
  const kept = _pushCapture(
    runState,
    "screenshots",
    { dataUrl: shot.dataUrl, ts: Date.now(), ext: shot.ext, area: shot.area },
    shot.dataUrl.length,
    CAPTURE_LIMITS.screenshotBytes,
    CAPTURE_LIMITS.screenshotCount,
    runId,
  );
  if (kept) {
    _broadcastLog(
      "info-log",
      `Screenshot #${runState.screenshots.length} captured (${shot.area}).`,
      runId,
    );
  }
}

/** Walk the page a viewport at a time and join the strips. */
async function _captureFullPage(tab, config, runId) {
  const m = await _sendToPage(tab.id, { type: "PAGE_METRICS", config: {} });
  if (!m?.ok) throw new Error(m?.error || "Could not measure the page");
  const {
    scrollHeight,
    viewportHeight,
    width,
    dpr = 1,
    scrollY = 0,
  } = m.result;

  let height = scrollHeight;
  if (height > FULL_PAGE_MAX_HEIGHT) {
    height = FULL_PAGE_MAX_HEIGHT;
    _broadcastLog(
      "warn-log",
      `Screenshot: the page is ${scrollHeight}px tall — truncated to ${FULL_PAGE_MAX_HEIGHT}px. ` +
        `An endless feed has no bottom to reach.`,
      runId,
    );
  }

  const shots = Math.ceil(height / viewportHeight);
  if (shots > 4) {
    _broadcastLog(
      "info-log",
      `Screenshot: ${shots} screenfuls to capture — Chrome allows about two a ` +
        `second, so this will take roughly ${Math.ceil((shots * CAPTURE_MIN_INTERVAL_MS) / 1000)}s.`,
      runId,
    );
  }

  const strips = [];
  let format = "png";
  for (let top = 0; top < height; top += viewportHeight) {
    const moved = await _sendToPage(tab.id, {
      type: "SCROLL_TO",
      config: { top },
    });
    if (!moved?.ok)
      throw new Error(moved?.error || "Could not scroll the page");
    // Where the page ran out of scroll, the strip shows a lower offset than
    // asked for — draw it where it actually landed or the join is doubled.
    const landed = Number(moved.result?.top ?? top);
    const cap = await _captureViewport(tab.windowId, config);
    format = cap.format;
    strips.push({ dataUrl: cap.dataUrl, top: Math.round(landed * dpr) });
  }

  // Put the page back where the run had it: leaving it at the bottom breaks
  // every step after this one that depends on what is on screen.
  await _sendToPage(tab.id, {
    type: "SCROLL_TO",
    config: { top: scrollY },
  }).catch(() => {});

  const ext = format === "png" ? "png" : "jpg";
  const mime = format === "png" ? "image/png" : "image/jpeg";
  try {
    const dataUrl = await _stitchStrips(strips, {
      width: Math.round(width * dpr),
      height: Math.round(height * dpr),
      mime,
    });
    return { dataUrl, ext };
  } catch (err) {
    // Said plainly rather than passed off as a full-page shot: the first strip
    // is the top of the page, which is what the old behaviour already gave.
    _broadcastLog(
      "warn-log",
      `Screenshot: ${err.message} Keeping the first screenful only.`,
      runId,
    );
    return { dataUrl: strips[0]?.dataUrl ?? "", ext };
  }
}

/** Photograph one element, by cropping a capture to its box. */
async function _captureElement(tab, config, runId) {
  const box = await _sendToPage(tab.id, {
    type: "ELEMENT_BOX",
    config: { selector: config.selector || "" },
  });
  if (!box?.ok) throw new Error(box?.error || "Could not find that element");
  const { x, y, width, height, dpr = 1 } = box.result;
  if (!(width > 0 && height > 0)) {
    throw new Error(
      `The element matching "${config.selector}" has no size on screen.`,
    );
  }

  const view = box.result.viewport ?? {};
  const viewWidth = view.width ?? width + x;
  const viewHeight = view.height ?? height + y;

  // The page already scrolled the element to the middle of the screen
  // (ELEMENT_BOX, injector.js) before measuring it, so a box that still runs
  // off the top/bottom/sides here is one `captureVisibleTab` genuinely cannot
  // show in a single shot: it only ever photographs the viewport, and an
  // element taller (or wider) than that has no scroll position that puts all
  // of it on screen at once. Crop to whatever was actually on screen and say
  // so, rather than padding the rest of the box with blank canvas and calling
  // it the whole element (K-27).
  const visLeft = Math.max(0, x);
  const visTop = Math.max(0, y);
  const visWidth = Math.max(1, Math.min(x + width, viewWidth) - visLeft);
  const visHeight = Math.max(1, Math.min(y + height, viewHeight) - visTop);
  const truncated = visWidth < width - 0.5 || visHeight < height - 0.5;
  if (truncated) {
    _broadcastLog(
      "warn-log",
      `Screenshot: the element matching "${config.selector}" is ` +
        `${Math.round(width)}×${Math.round(height)}px — taller or wider than the ` +
        `${Math.round(viewWidth)}×${Math.round(viewHeight)}px viewport Chrome can ` +
        `capture in one shot, so only the part on screen is in this image.`,
      runId,
    );
  }

  const cap = await _captureViewport(tab.windowId, config);
  const ext = cap.format === "png" ? "png" : "jpg";
  const mime = cap.format === "png" ? "image/png" : "image/jpeg";
  try {
    const dataUrl = await _stitchStrips([{ dataUrl: cap.dataUrl, top: 0 }], {
      // The canvas the crop is taken *from* is the whole capture, not the
      // element: sizing it to the element would leave everything but the
      // top-left corner of the viewport outside it, and the crop would come
      // back blank for any element not at the very top of the page.
      width: Math.round(viewWidth * dpr),
      height: Math.round(viewHeight * dpr),
      mime,
      crop: {
        x: Math.round(visLeft * dpr),
        y: Math.round(visTop * dpr),
        width: Math.round(visWidth * dpr),
        height: Math.round(visHeight * dpr),
      },
    });
    return { dataUrl, ext, truncated };
  } catch (err) {
    _broadcastLog(
      "warn-log",
      `Screenshot: ${err.message} Keeping the whole visible area instead.`,
      runId,
    );
    return { dataUrl: cap.dataUrl, ext, truncated };
  }
}

async function _executePdfExtraction(config = {}, runId) {
  const source = String(config.source || "url").trim();
  const maxPages = Number(config.maxPages) || 50;
  const storeAs = String(config.storeAs || "pdf_text").trim() || "pdf_text";

  let bytes;

  if (source === "file") {
    const fileId = String(config.fileId || "").trim();
    const stored = await chrome.storage.local.get(STORAGE_FILES_KEY);
    const library = Array.isArray(stored?.[STORAGE_FILES_KEY])
      ? stored[STORAGE_FILES_KEY]
      : [];
    const file = library.find((f) => f.id === fileId);
    if (!file) throw new Error(`PDF file not found in storage: ${fileId}`);
    bytes = _dataUrlToBytes(file.dataUrl);
  } else {
    const fileUrl = String(config.url || "").trim();
    if (!fileUrl) {
      throw new Error("PDF_EXTRACTION requires a PDF URL or file selection");
    }
    // Same origin rules as any other fetch the run makes.
    await _assertOriginAllowed(
      fileUrl,
      _runStates.get(runId),
      "PDF_EXTRACTION",
    );
    const res = await fetch(fileUrl);
    if (!res.ok) {
      throw new Error(`Failed to fetch PDF: ${res.status} ${res.statusText}`);
    }
    bytes = new Uint8Array(await res.arrayBuffer());
  }

  // A PDF has no notion of a table — only strings and the coordinates to draw
  // them at — so reading one back means keeping the positions the text reader
  // throws away. Two modes rather than always doing both: positions are
  // several times the size of the text, and most PDFs are prose.
  if (String(config.mode || "text") === "tables") {
    const positioned = await extractPdfItems(bytes, { maxPages });
    const { records, perPage } = tablesFromPages(positioned.pages, {
      hasHeader: config.hasHeader !== false,
      rowTolerance: Number(config.rowTolerance) || undefined,
      columnTolerance: Number(config.columnTolerance) || undefined,
    });

    for (const warning of positioned.warnings) {
      _broadcastLog("warn-log", `PDF_EXTRACTION: ${warning}`, runId);
    }
    if (positioned.truncated) {
      _broadcastLog(
        "warn-log",
        `PDF_EXTRACTION: read ${positioned.pages.length} of ${positioned.pageCount} pages (maxPages is ${maxPages}).`,
        runId,
      );
    }
    if (records.length === 0) {
      // Not an error — a PDF of prose has no table in it — but silence here
      // would look exactly like a successful read of nothing.
      _broadcastLog(
        "warn-log",
        "PDF_EXTRACTION: no table found. The pages have text but nothing laid " +
          "out in columns, so there is no grid to read.",
        runId,
      );
    } else {
      const runState = _runStates.get(runId);
      await _collectRows(runState, runId, records);
      _broadcastLog(
        "info-log",
        `PDF_EXTRACTION: ${records.length} row${records.length === 1 ? "" : "s"} ` +
          `from ${perPage.filter((p) => p.rows > 0).length} page(s), ` +
          `columns: ${(perPage.find((p) => p.columns.length)?.columns ?? []).join(", ")}.`,
        runId,
      );
    }

    return {
      [storeAs]: {
        mode: "tables",
        records,
        perPage,
        pageCount: positioned.pageCount,
        truncated: positioned.truncated,
        warnings: positioned.warnings,
        source,
      },
    };
  }

  // This used to log "use MCP tool pdf_extract_text" and store
  // {status: "pending"} — an instruction the user cannot act on, because there
  // is no bridge from the extension to the MCP server (B-28, G-05). It extracts
  // now, in the worker, with no dependencies.
  const result = await extractPdfText(bytes, { maxPages });

  for (const warning of result.warnings) {
    _broadcastLog("warn-log", `PDF_EXTRACTION: ${warning}`, runId);
  }
  if (result.truncated) {
    _broadcastLog(
      "warn-log",
      `PDF_EXTRACTION: read ${result.pages.length} of ${result.pageCount} pages (maxPages is ${maxPages}).`,
      runId,
    );
  }
  _broadcastLog(
    "info-log",
    `PDF_EXTRACTION: ${result.text.length} characters from ${result.pages.length} page(s).`,
    runId,
  );

  return {
    [storeAs]: {
      mode: "text",
      text: result.text,
      pages: result.pages,
      pageCount: result.pageCount,
      truncated: result.truncated,
      warnings: result.warnings,
      source,
    },
  };
}

// ── AUTO_EXTRACT orchestrator ──────────────────────────────────────────────────
/**
 * Runs the full cascading extraction pipeline for a single page:
 *   1. Triggers smart-extractor.js (Layers 1 & 2) inside the tab.
 *   2. If confidence is too low and a Gemini key is present, runs Layer 3 LLM.
 *   3. Merges results, returns a single product row.
 *
 * @param {object} config   - Step config ({ confidenceThreshold, useLlm })
 * @param {number} tabId    - Target Chrome tab ID
 * @param {string} runId    - Pipeline run identifier
 * @param {object} ctx      - Runtime context for template resolution
 * @returns {Promise<object>} - Product row with _confidence and _method meta fields
 */
async function _executeAutoExtract(config = {}, tabId, runId, ctx = {}) {
  const threshold = Number(config.confidenceThreshold ?? 70);
  // Default on for pipelines saved before the toggle was honoured.
  const useLlm = config.useLlm !== false;

  // What is being asked for. An empty schema is the product default, so every
  // pipeline saved before schemas existed behaves exactly as it did.
  const { fields, isDefault, rejected } = parseSchema(config.schema);
  for (const bad of rejected) {
    _broadcastLog(
      "warn-log",
      `AUTO_EXTRACT: "${bad}" is not usable as a field name and was left out.`,
      runId,
    );
  }

  // ── Layer 1 & 2: run in-page smart-extractor ──────────────────────────────
  const l12Resp = await _sendToPage(tabId, {
    type: "AUTO_EXTRACT",
    config: {
      confidenceThreshold: threshold,
      schema: isDefault ? null : fields,
    },
  }).catch((err) => ({ ok: false, error: err.message }));

  if (!l12Resp?.ok) {
    throw new Error(
      `AUTO_EXTRACT (L1/L2) failed: ${l12Resp?.error || "No response"}`,
    );
  }

  let extraction = l12Resp.result;

  // A schema of the user's own: the page reported the site's structured-data
  // keys, and the matching happens here because the matcher is an ES module a
  // classic content script cannot import.
  if (!isDefault) {
    extraction = _applySchema(extraction, fields, threshold, runId);
  }

  // Set only when a model answered and proposed selectors for its answer.
  let llmSelectors = null;

  // ── Layer 3: LLM fallback if confidence is still low ──────────────────────
  if (extraction.needsLlm && !useLlm) {
    // The step's "Enable AI fallback" toggle used to be ignored entirely, so
    // turning it off did not stop the page being sent to Gemini.
    _broadcastLog(
      "warn-log",
      `AUTO_EXTRACT: confidence ${extraction.overallConfidence}% is below ${threshold}%, but AI fallback is off — keeping the L1/L2 result.`,
      runId,
    );
  } else if (extraction.needsLlm && extraction.simplifiedDom) {
    _broadcastLog(
      "info-log",
      `AUTO_EXTRACT: L1/L2 confidence ${extraction.overallConfidence}% — escalating to LLM...`,
      runId,
    );

    // Report *why* the layer produced nothing. This used to be
    // .catch(() => null) with a "skipped or failed" message that covered a
    // missing key, a network error and a malformed response alike.
    let llmResult = null;
    let llmError = null;
    try {
      llmResult = await runLlmLayer(
        extraction.simplifiedDom,
        {
          fields,
          isDefault,
          // Only for a schema the user named: the product prompt has its own
          // fixed shape, and widening it is a change to the path every saved
          // pipeline already runs.
          wantSelectors: !isDefault && config.learnSelectors !== false,
        },
        // The URL is part of the cache key, so an answer is never served for a
        // page it was not given for.
        { url: await _tabUrl(tabId), cache: config.cache !== false },
      );
    } catch (err) {
      llmError = err.message;
    }

    // Everything the model said has to be on the page it was shown. The text
    // is already in hand, so this costs a string comparison and rules out the
    // failure the prompt can only ask about: a column of plausible values the
    // page never contained.
    if (llmResult?.result && config.grounded !== false) {
      const checked = groundFields(
        llmResult.result,
        llmResult.fields ?? fields,
        extraction.simplifiedDom,
      );
      llmResult.result = checked.result;
      llmResult.grounding = checked.how;
      for (const { field, value } of checked.dropped) {
        // Named, with what was claimed: "the model made something up" is only
        // useful if you can see what, and on which field.
        _broadcastLog(
          "warn-log",
          `AUTO_EXTRACT: dropped "${field}" — the model answered ${JSON.stringify(value)}, ` +
            "which is not on the page it was shown. An empty cell cannot be acted on by mistake; a made-up one can.",
          runId,
        );
      }
      // A field the model invented is a field nothing answered, so its
      // confidence has to fall with it or the merge would prefer the hole.
      for (const { field } of checked.dropped) {
        if (llmResult.perField) llmResult.perField[field] = 0;
      }
    }

    if (llmResult?.error) {
      // The gateway already phrased this for a person — a key it refused, a
      // local server that is not running, a rate limit. Repeating it beats
      // replacing it with "the LLM layer failed".
      _broadcastLog(
        "warn-log",
        `AUTO_EXTRACT: ${llmResult.error} — using the L1/L2 result (confidence: ${extraction.overallConfidence}%).`,
        runId,
      );
    } else if (llmResult) {
      llmSelectors = llmResult.selectors ?? null;
      // LLM wins field-by-field where it has higher confidence
      extraction = _mergeLlmOverL12(extraction, llmResult);
      _broadcastLog(
        "info-log",
        llmResult.cached
          ? `AUTO_EXTRACT: answered from cache — this page has not changed since the model last read it (confidence ${extraction.overallConfidence}%).`
          : `AUTO_EXTRACT: the model answered — overall confidence now ${extraction.overallConfidence}%.`,
        runId,
      );
    } else if (llmError) {
      _broadcastLog(
        "warn-log",
        `AUTO_EXTRACT: the AI layer failed (${llmError}) — using L1/L2 result (confidence: ${extraction.overallConfidence}%).`,
        runId,
      );
    } else {
      // No provider configured. Not a failure: it is the default state, and
      // the free layers already answered. Says what to do rather than naming
      // one vendor — a local model costs nothing and is the point.
      _broadcastLog(
        "warn-log",
        `AUTO_EXTRACT: no AI model is configured, so the fallback was skipped — using the L1/L2 result (confidence: ${extraction.overallConfidence}%). ` +
          "Pick a provider under Settings → AI gateway; a local Ollama or LM Studio server works and costs nothing.",
        runId,
      );
    }
  } else if (!extraction.needsLlm) {
    _broadcastLog(
      "info-log",
      `AUTO_EXTRACT: finished via ${extraction.method} (confidence: ${extraction.overallConfidence}%).`,
      runId,
    );
  }

  // Emit per-field warnings to pipeline log
  for (const warning of extraction.warnings || []) {
    _broadcastLog("warn-log", warning, runId);
  }

  // Selectors the model proposed, checked in the page.
  //
  // Checked, not trusted: run each one and keep it only if it produces the
  // value the model reported. What survives is offered as an ordinary EXTRACT
  // step, which scrapes this site deterministically and for free from then on
  // — and, unlike AUTO_EXTRACT, exports to a Playwright script.
  if (llmSelectors && Object.keys(llmSelectors).length) {
    await _learnSelectors(llmSelectors, extraction.result ?? {}, tabId, runId);
  }

  // Which layer answered each field, and what that is worth.
  //
  // The row carries one `_extractionMethod`, taken from whichever layer
  // answered first — untrue of any real page, where `name` comes from the
  // site's JSON-LD and `price` from a guess at the markup. Both fields are
  // kept as they were so no existing export changes shape; the per-field
  // record goes to the panel beside them.
  const provenance = buildProvenance({
    fields: extraction.fields ?? Object.keys(extraction.result ?? {}),
    result: extraction.result ?? {},
    perField: extraction.perField,
    from: extraction.from,
    grounding: extraction.grounding,
  });

  _broadcastProvenance(provenance, runId, tabId);
  _broadcastLog(
    "info-log",
    `AUTO_EXTRACT: ${summariseProvenance(provenance)}`,
    runId,
  );

  // Build the final row — include confidence metadata as hidden fields
  const row = {
    ...extraction.result,
    _confidence: extraction.overallConfidence,
    _extractionMethod: extraction.method,
  };

  // Off by default: provenance is per field and a CSV cell is not, so adding
  // it to every row would change the shape of every export that exists for a
  // detail most runs never look at.
  if (config.provenance) row._provenance = provenanceColumn(provenance);

  return row;
}

/**
 * Say once, per run, if what is being collected carries personal data.
 *
 * Not a block. The user asked for these rows and may well be entitled to
 * them — a directory of businesses is full of email addresses and scraping it
 * is not by itself a problem. What they should not do is find out afterwards,
 * from someone else, that the file they exported and shared had personal data
 * in it.
 *
 * Two things it will not do. It will not print the value: a warning about
 * personal data that puts that data in the log, and from there into a
 * screenshot in a bug report, has made things worse rather than better. The
 * detector reports a type, a column and a row index, and that is all that is
 * passed on. And it will not repeat itself: a 500-row scrape warning 500 times
 * is the same as not warning at all, so the run stops scanning once it has
 * said so — which also keeps a long run from paying for a check whose answer
 * cannot change.
 */
function _checkRowsForPii(runState, runId, rows) {
  if (!runState || runState.piiWarned) return;
  if (!Array.isArray(rows) || rows.length === 0) return;

  const findings = scanRows(rows);
  if (findings.length === 0) return;

  runState.piiWarned = true;
  const columns = [...new Set(findings.map((f) => f.field))];
  _broadcastLog(
    "warn-log",
    `Ethics · PII: these rows contain personal data (${summarizeFindings(findings)}) ` +
      `in ${columns.length === 1 ? "column" : "columns"} ${columns.join(", ")}. ` +
      "The run is continuing — this is a note, not a block. Check what you are " +
      "allowed to keep and share before exporting.",
    runId,
  );
  logger.warn(MODULE, "pii-in-rows", {
    types: [...new Set(findings.map((f) => f.type))],
    columns,
    // Never the values. The detector is built not to carry them and this must
    // not undo that.
  });
}

/**
 * Check the model's selectors in the page, and offer what survives.
 *
 * The page runs them and reports what each found; the judging happens here,
 * because `content/injector.js` is a classic content script and cannot import
 * `utils/selector-learning.js`. A field whose value grounding dropped has a
 * null value by now, so its selector is never judged — a selector "verified"
 * against something the model invented has been checked against nothing.
 *
 * Nothing is added to the pipeline: the panel offers it and the user decides.
 * A step appearing in a pipeline nobody added is worse than not offering one.
 */
async function _learnSelectors(selectors, values, tabId, runId) {
  let probed;
  try {
    // Not through `_sendToPage`: that helper rewrites the outer type to
    // "step:execute" because everything it carries is a step, and a probe is
    // not one. Same shape as the structure detector's own path — make sure the
    // script is there, then address the message directly.
    await _ensureInjected(tabId);
    const resp = await chrome.tabs.sendMessage(tabId, {
      type: "VQ_PROBE_SELECTORS",
      payload: { selectors },
    });
    probed = resp?.ok ? resp.result : null;
  } catch (err) {
    logger.warn(MODULE, "probe-failed", { error: err.message });
    probed = null;
  }
  if (!probed) return;

  const { verified, how, fragile } = judgeSelectors({
    selectors,
    values,
    probe: (_sel, field) => probed[field] ?? { count: 0, text: null },
  });

  const kept = Object.keys(verified);
  if (kept.length === 0) {
    // Said once, quietly. A model that proposed nothing usable costs nothing
    // beyond the request that was being made anyway.
    const tried = Object.keys(how).length;
    if (tried) {
      _broadcastLog(
        "info-log",
        `AUTO_EXTRACT: none of the ${tried} selector(s) the model proposed matched the value it reported, so none were kept.`,
        runId,
      );
    }
    return;
  }

  _broadcastLog(
    "info-log",
    `AUTO_EXTRACT: ${kept.length} selector(s) checked against the page and verified (${kept.join(", ")}). ` +
      "Save them as an EXTRACT step and this site is scraped without a model from then on." +
      (fragile.length
        ? ` ${fragile.join(", ")} rely on position rather than a class or id, so they will break if the page is restructured.`
        : ""),
    runId,
  );

  const step = toExtractStep(verified);
  if (!step) return;
  chrome.runtime
    .sendMessage({
      type: "pipeline:selectors",
      payload: { step, verified, fragile, how, runId, tabId },
    })
    .catch(() => {});
}

/**
 * The URL of a tab, or "" if it cannot be read.
 *
 * Part of the AI cache key. A failure here has to be a cache miss rather than
 * a failed step, so it never throws.
 */
async function _tabUrl(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    return tab?.url ?? "";
  } catch {
    return "";
  }
}

/**
 * Send the per-field record to the panel.
 *
 * Its own message rather than a log line: a log line is a sentence, and this
 * is a table the panel renders as one — and as nodes, because every value in
 * it came off a page.
 */
function _broadcastProvenance(provenance, runId, tabId) {
  chrome.runtime
    .sendMessage({
      type: "pipeline:provenance",
      payload: { provenance, runId, tabId },
    })
    .catch(() => {});
}

/**
 * Fill a user's schema from what the page reported.
 *
 * The free layers answer for the fields they were taught. Layer 1's product
 * normaliser knows `name` and `price`; layer 2's heuristics know the same
 * seven. A field neither was written for gets **no opinion** rather than a
 * guess — a heuristic answering for a column it was never taught is exactly
 * the failure this three-layer arrangement exists to avoid, and it would be
 * indistinguishable from a real answer in the export.
 *
 * What generalises for free is the site's own structured data: a page that
 * publishes `datePublished` answers a request for `published date` with no
 * model and no cost. That is why the page now reports the raw node.
 *
 * @param {object} extraction - what the page returned
 * @param {string[]} fields
 * @param {number} threshold - below this, ask a model
 * @param {string} runId
 * @returns {object} the same shape, re-keyed to the schema
 */
function _applySchema(extraction, fields, threshold, runId) {
  const structured = mapNodeToSchema(extraction.structuredNode, fields);
  const meta = mapNodeToSchema(extraction.metaNode, fields);
  const product = extraction.result ?? {};
  const productConf = extraction.perField ?? {};

  const result = {};
  const perField = {};
  const from = {};

  for (const field of fields) {
    // JSON-LD first: a publisher's assertion about its own page beats a meta
    // tag the CMS filled in, and both beat a guess from the markup.
    if (structured.values[field] != null) {
      result[field] = structured.values[field];
      perField[field] = 95;
      from[field] = `json-ld:${structured.matchedKeys[field]}`;
      continue;
    }
    if (meta.values[field] != null) {
      result[field] = meta.values[field];
      perField[field] = 85;
      from[field] = `meta:${meta.matchedKeys[field]}`;
      continue;
    }
    // The product heuristics, but only where the field is one they know.
    const known = Object.prototype.hasOwnProperty.call(product, field);
    if (known && product[field] != null && product[field] !== "") {
      result[field] = product[field];
      perField[field] = productConf[field] ?? 50;
      from[field] = "heuristic";
      continue;
    }
    result[field] = null;
    perField[field] = 0;
    from[field] = "none";
  }

  const weights = weightsFor(fields, false);
  let total = 0;
  let sum = 0;
  for (const field of fields) {
    total += weights[field] ?? 1;
    sum += (perField[field] ?? 0) * (weights[field] ?? 1);
  }
  const overallConfidence = total ? Math.round(sum / total) : 0;

  const answered = fields.filter((f) => result[f] != null).length;
  _broadcastLog(
    "info-log",
    `AUTO_EXTRACT: the page answered ${answered} of ${fields.length} field(s) for free` +
      (answered
        ? ` (${fields.filter((f) => result[f] != null).join(", ")})`
        : "") +
      ".",
    runId,
  );

  return {
    ...extraction,
    result,
    perField,
    from,
    fields,
    overallConfidence,
    // Re-decided here: the page cannot know whether the free layers covered a
    // schema it has no rules for, so its own needsLlm is about products only.
    // Either reason is enough: a low score, or a field nothing answered.
    // A schema of five fields where four came back at 95 still averages well
    // above the threshold while one column is entirely empty.
    needsLlm: overallConfidence < threshold || answered < fields.length,
    method: answered ? "structured+heuristic" : "none",
  };
}

/**
 * Field-level merge: for each field, pick whichever source (L1/L2 or LLM)
 * has higher per-field confidence.
 */
function _mergeLlmOverL12(l12, llm) {
  // Whatever was asked for. `l12.fields` is set by _applySchema for a custom
  // schema; without one it is the product default, which is where the list
  // used to be spelled out. A merge over a hardcoded list would have dropped
  // every field a user named for themselves — the model would answer and the
  // answer would be discarded on the way back.
  const fieldList = l12.fields ?? [
    "name",
    "price",
    "originalPrice",
    "currency",
    "brand",
    "description",
    "sku",
    "availability",
    "rating",
    "reviewCount",
    "images",
  ];

  const mergedResult = { ...(l12.result || {}) };
  const mergedPerField = { ...(l12.perField || {}) };
  const mergedFrom = { ...(l12.from || {}) };
  const mergedWarnings = [...(l12.warnings || []), ...(llm.warnings || [])];

  for (const field of fieldList) {
    const l12Conf = l12.perField?.[field] ?? 0;
    const llmConf = llm.perField?.[field] ?? 0;
    const llmVal = llm.result?.[field];

    const isEmpty = (v) =>
      v === null ||
      v === undefined ||
      v === "" ||
      (Array.isArray(v) && v.length === 0);

    // LLM wins if: it has a value AND either L1/L2 is empty OR LLM has higher confidence
    if (
      !isEmpty(llmVal) &&
      (isEmpty(mergedResult[field]) || llmConf > l12Conf)
    ) {
      mergedResult[field] = llmVal;
      mergedPerField[field] = llmConf;
      // Or the row would keep layer 1's label on a value layer 3 replaced,
      // which is the exact untruth per-field provenance exists to remove.
      mergedFrom[field] = "llm";
    }
  }

  // Recompute overall confidence after merge, over the fields that were
  // actually asked for. The product weights were hardcoded here, so a custom
  // schema summed seven fields it does not have and reported 0% however well
  // the model had answered.
  const weights = weightsFor(fieldList, !l12.fields);
  let totalWeight = 0,
    weightedSum = 0;
  for (const field of fieldList) {
    const weight = weights[field] ?? 0;
    totalWeight += weight;
    weightedSum += (mergedPerField[field] || 0) * weight;
  }
  const overallConfidence = totalWeight
    ? Math.round(weightedSum / totalWeight)
    : 0;

  return {
    ...l12,
    result: mergedResult,
    perField: mergedPerField,
    from: mergedFrom,
    grounding: llm.grounding || l12.grounding,
    overallConfidence,
    method: llm.method || l12.method,
    warnings: mergedWarnings,
    needsLlm: false,
    simplifiedDom: "",
  };
}

// ── Minimal pure-JS ZIP creator (store, no compression) ───────────────────────
function _buildZip(files) {
  // files: [{name: string, bytes: Uint8Array}]
  const u16 = (n) => {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, n, true);
    return b;
  };
  const u32 = (n) => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n, true);
    return b;
  };
  const cat = (...arrays) => {
    const t = arrays.reduce((s, a) => s + a.length, 0),
      r = new Uint8Array(t);
    let o = 0;
    arrays.forEach((a) => {
      r.set(a, o);
      o += a.length;
    });
    return r;
  };
  function crc32(d) {
    let c = -1;
    for (const b of d) {
      c ^= b;
      for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
    }
    return ~c >>> 0;
  }
  const enc = new TextEncoder();
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, bytes } of files) {
    const nb = enc.encode(name),
      crc = crc32(bytes),
      sz = bytes.length;
    const lh = cat(
      new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(sz),
      u32(sz),
      u16(nb.length),
      u16(0),
      nb,
      bytes,
    );
    locals.push(lh);
    centrals.push(
      cat(
        new Uint8Array([0x50, 0x4b, 0x01, 0x02]),
        u16(20),
        u16(20),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(crc),
        u32(sz),
        u32(sz),
        u16(nb.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(offset),
        nb,
      ),
    );
    offset += lh.length;
  }
  const cs = centrals.reduce((s, c) => s + c.length, 0);
  const eocd = cat(
    new Uint8Array([0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0]),
    u16(files.length),
    u16(files.length),
    u32(cs),
    u32(offset),
    u16(0),
  );
  return cat(...locals, ...centrals, eocd);
}

function _dataUrlToBytes(dataUrl) {
  const b64 = dataUrl.split(",")[1];
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/**
 * A stable identity for a row, independent of key order.
 * @param {object} row
 * @returns {string}
 */
function _rowKey(row) {
  if (!row || typeof row !== "object") return JSON.stringify(row);
  return JSON.stringify(
    Object.keys(row)
      .sort()
      .map((k) => [k, row[k]]),
  );
}

/**
 * Bytes to a `data:` URL the downloads API can fetch.
 *
 * A service worker has `Blob` but **not** `URL.createObjectURL` — MV3 removed
 * it from worker contexts. So every EXPORT failed with "URL.createObjectURL is
 * not a function" and downloaded nothing, in every real browser, while the unit
 * tests passed because the worker harness stubs that function (A-12).
 *
 * The comment this replaces argued for Blob URLs on the grounds that "a large
 * export could exceed what a data: URL can carry". The downloads API takes them
 * at least into the tens of megabytes — verified at 20 MB in e2e — and a Blob
 * URL that cannot be created carries nothing at all.
 *
 * @param {Uint8Array} bytes
 * @param {string} mime
 * @returns {string}
 */
function _bytesToDataUrl(bytes, mime) {
  if (bytes.length > MAX_DOWNLOAD_BYTES) {
    throw new Error(
      `Export is ${Math.round(bytes.length / 1048576)} MB, over the ` +
        `${Math.round(MAX_DOWNLOAD_BYTES / 1048576)} MB limit for a single download. ` +
        `Export fewer rows, or split the run.`,
    );
  }
  // Chunked: String.fromCharCode(...bytes) blows the argument limit on anything
  // of real size, which is exactly the case that matters here.
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

/** Ceiling on one download. Above this the base64 string itself is the problem. */
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;

async function _doExport(runId, config) {
  const runState = _runStates.get(runId);
  if (!runState) return;
  const idbRows = await readAllRows(runId).catch(() => []);
  const allRows = [...runState.results];
  // Dedup by a key that does not depend on insertion order. JSON.stringify was
  // used directly, so a row read back from IndexedDB with its properties in a
  // different order never matched its in-memory twin and every row came out
  // twice (D-07). Sorting the keys makes the two comparable.
  const seen = new Set(allRows.map(_rowKey));
  for (const r of idbRows) {
    const { runId: _, ...clean } = r;
    const key = _rowKey(clean);
    if (seen.has(key)) continue;
    seen.add(key);
    allRows.push(clean);
  }

  const screenshots = runState.screenshots || [];
  const enc = new TextEncoder();
  const ts = Date.now();

  // Formatting lives in exporters/row-formatters.js so the service worker, the
  // side panel's partial download and the MCP server all produce identical
  // output. The three inline implementations disagreed: this one turned a
  // legitimate 0 or false into an empty cell, and quoted every CSV field.
  const fmt = ROW_FORMATS.includes(config.format) ? config.format : "csv";
  const { mime: dataMime, ext: dataExt } = formatMeta(fmt);

  // "A run per day into one dataset." The rows are kept between runs and the
  // whole set is written out again under one name — an extension cannot append
  // to a file, because chrome.downloads writes and never reads, so yesterday's
  // file is not something this can open and add to. Rendering from rows has
  // one advantage over a real append: a page that gains a column mid-week gets
  // that column, where an append to a written CSV could only drop it.
  let rowsToWrite = allRows;
  let stem = `verquill_export_${ts}`;
  if (config.append) {
    if (!APPENDABLE_FORMATS.includes(fmt)) {
      throw new Error(
        `EXPORT: "${fmt}" cannot be added to a file a run at a time — a JSON ` +
          `array, an XML tree and a Markdown table each have to be rewritten ` +
          `whole. Use ${APPENDABLE_FORMATS.join(", ")}, or turn appending off.`,
      );
    }
    const name = datasetName(config.dataset);
    const { added, total, dropped } = await appendDatasetRows(name, allRows);
    rowsToWrite = await readDataset(name);
    stem = `verquill_${name}`;
    _broadcastLog(
      dropped ? "warn-log" : "info-log",
      `EXPORT: added ${added} row${added === 1 ? "" : "s"} to "${name}" ` +
        `(${total} in total)` +
        (dropped
          ? ` — ${dropped} did not fit; a dataset holds ${MAX_DATASET_ROWS} rows.`
          : "."),
      runId,
    );
  }

  const dataContent = formatRows(rowsToWrite, fmt);

  const networks = runState.networks || [];
  if (screenshots.length > 0 || networks.length > 0) {
    // Bundle everything into a ZIP
    const zipFiles = [];
    if (rowsToWrite.length > 0) {
      zipFiles.push({
        name: `data.${dataExt}`,
        bytes: enc.encode("\uFEFF" + dataContent),
      });
    }
    screenshots.forEach((s, i) => {
      zipFiles.push({
        name: `screenshot_${i + 1}_${s.ts}.${s.ext || "png"}`,
        bytes: _dataUrlToBytes(s.dataUrl),
      });
    });

    if (networks.length > 0) {
      // Same formatter as the data file, so the sniffer log is not a fourth
      // hand-rolled CSV with its own quoting rules.
      const netFormat = fmt === "json" || fmt === "jsonl" ? fmt : "csv";
      zipFiles.push({
        name: `api-sniffer.${formatMeta(netFormat).ext}`,
        bytes: enc.encode(
          netFormat === "csv"
            ? "\uFEFF" + formatRows(networks, netFormat)
            : formatRows(networks, netFormat),
        ),
      });
    }

    const zipBytes = _buildZip(zipFiles);
    await chrome.downloads.download({
      url: _bytesToDataUrl(zipBytes, "application/zip"),
      filename: `verquill_export_${ts}.zip`,
      saveAs: false,
    });
    // A short export is never silent: if the capture buffers filled, the count
    // that did not make it is part of the result.
    const dropped =
      (runState.screenshotsDropped || 0) +
      (runState.networksDropped || 0) +
      droppedRowCount(runId);
    _broadcastLog(
      dropped ? "warn-log" : "info-log",
      `Exported ZIP: ${rowsToWrite.length} rows, ${screenshots.length} screens, ${networks.length} APIs` +
        (dropped
          ? ` — ${dropped} capture(s) dropped when the buffer filled.`
          : "."),
      runId,
    );
  } else if (rowsToWrite.length > 0) {
    // The BOM goes through the encoder with the rest of the content, so it is
    // base64 of real UTF-8 bytes rather than a character dropped into a URL and
    // mangled — which is what the original data: URL build got wrong.
    await chrome.downloads.download({
      url: _bytesToDataUrl(enc.encode("\uFEFF" + dataContent), dataMime),
      filename: `${stem}.${dataExt}`,
      // A growing dataset is one file, so each run replaces it rather than
      // leaving "dataset (3).csv" beside "dataset (2).csv" — which is the pile
      // of files appending exists to avoid.
      conflictAction: config.append ? "overwrite" : "uniquify",
      saveAs: false,
    });
    _broadcastLog(
      "info-log",
      `Exported ${rowsToWrite.length} rows as ${fmt.toUpperCase()}.`,
      runId,
    );
  } else {
    _broadcastLog("warn-log", "Export: no data collected.", runId);
  }
}

// ── DOWNLOAD_FILE ─────────────────────────────────────────────────────────────

/** However many a step asks for, this is where one step stops. */
const DOWNLOAD_HARD_CAP = 200;

/**
 * What a filename segment may contain — letters, digits, and a short list of
 * punctuation that no filesystem argues about.
 *
 * An allowlist rather than a list of forbidden characters, because the input is
 * page-supplied and the forbidden list is the one that is never finished: both
 * separators, the control range, and `<>:"|?*` all fall out of it without being
 * enumerated, while a Japanese or accented filename survives intact.
 */
const UNSAFE_IN_SEGMENT = /[^\p{L}\p{N} ._()\[\]{}@#&+,;'!~=%-]/gu;

/**
 * One path segment, made safe to write.
 *
 * The split is the traversal defence, and it comes first so that the answer is
 * a readable name rather than a row of underscores: anything the value tried to
 * make a path out of is flattened, and the `.` and `..` in it are dropped on
 * the way — `../../etc/passwd` becomes `etc_passwd`. The leading-dot strip
 * catches what is left, `...` included. Trailing dots and spaces go for a
 * duller reason: Windows drops them silently, so `report. ` and `report` become
 * the same file and one overwrites the other.
 *
 * @param {unknown} value
 * @returns {string}
 */
function _safeSegment(value) {
  return String(value ?? "")
    .split(/[\\/]/)
    .filter((part) => part !== "" && part !== "." && part !== "..")
    .join("_")
    .replace(UNSAFE_IN_SEGMENT, "_")
    .replace(/^[.\s]+/, "")
    .replace(/[.\s]+$/, "")
    .slice(0, 100);
}

/**
 * What `{{file.*}}` means for one URL.
 *
 * @param {{url: string, text?: string, alt?: string, title?: string}} target
 * @param {number} index - 1-based, so it reads like {{loop.index}}
 */
function _fileFacts(target, index) {
  const url = String(target.url || "");
  let name = "";
  let host = "";

  if (/^data:/i.test(url)) {
    // A data: URL has no name and no path; its media type is the only thing in
    // it that describes the file, so that is what the extension comes from.
    const subtype = /^data:[^/;,]*\/([A-Za-z0-9.+-]+)/.exec(url)?.[1] || "bin";
    name = `file-${index}.${subtype.replace(/\+.*$/, "")}`;
  } else {
    try {
      const u = new URL(url);
      host = u.hostname;
      name = decodeURIComponent(
        u.pathname.split("/").filter(Boolean).pop() ?? "",
      );
    } catch {
      name = "";
    }
  }

  if (!name) name = `file-${index}`;
  const dot = name.lastIndexOf(".");
  const hasExt = dot > 0 && dot < name.length - 1 && name.length - dot <= 9;
  return {
    index,
    url,
    host,
    name,
    stem: hasExt ? name.slice(0, dot) : name,
    ext: hasExt ? name.slice(dot + 1) : "",
    text: target.text || "",
    alt: target.alt || "",
    title: target.title || "",
  };
}

/**
 * The template, rendered into a path the downloads API will accept.
 *
 * The template is split on `/` *before* the values go in, so the author keeps
 * their subfolders and no value can add one. Everything after that is about the
 * name being a name: 8 segments deep at most, 100 characters a segment, and an
 * extension put back when the template produced a name without one — a JPEG
 * saved as `Blue Widget` is a file the operating system cannot open.
 *
 * @param {string} template
 * @param {object} ctx - the run context, with `file` added for this URL
 * @param {object} facts - _fileFacts, for the fallbacks
 * @returns {string}
 */
function _resolveDownloadPath(template, ctx, facts) {
  const resolved = String(template ?? "")
    .split("/")
    .map((segment) => _safeSegment(_resolveStr(segment, ctx)));

  // The last segment is the name, whether or not it survived resolution.
  // Filtering the empties out *before* taking it promoted a folder into the
  // filename the moment a template referenced a field that was not there:
  // `shots/{{missing}}` saved every file as `shots.jpg`, one overwriting the
  // next, and the folder the author asked for was gone. The folders are
  // filtered; the name falls back to the file's own.
  const last = resolved.pop() ?? "";
  const segments = resolved.filter(Boolean).slice(0, 8);

  let name = last || _safeSegment(facts.name) || `file-${facts.index}`;
  if (facts.ext && !new RegExp(`\\.${facts.ext}$`, "i").test(name)) {
    if (!/\.[A-Za-z0-9]{1,8}$/.test(name)) name = `${name}.${facts.ext}`;
  }
  return [...segments, name].join("/");
}

/** Schemes chrome.downloads can be handed without surprising the user. */
function _downloadableScheme(url) {
  return /^(?:https?|data):/i.test(String(url));
}

/**
 * Download every file a selector points at.
 *
 * Two halves on purpose. The page resolves the URLs, because only it knows its
 * own base and its own shadow roots, and because doing it there makes the step
 * loop-scoped for nothing — `_queryScoped` already answers against the loop's
 * current record. The worker downloads them, because a content script cannot.
 *
 * The counting is the feature. A gallery step that saves nine of ten files and
 * says "done" is the failure this codebase is written against, so the step
 * reports what it saved, what it refused and why, and fails outright when it
 * found URLs and saved none of them.
 *
 * @param {object} step  - already template-resolved; `__vqRawConfig` still has
 *                         the filename template, which is resolved per file
 * @param {number} tabId
 * @param {?string} runId
 * @param {object} ctx
 * @returns {Promise<object>} the summary, also left on ctx.downloads
 */
/**
 * Read every cookie an origin has, including the HttpOnly ones.
 *
 * Only reachable with the `cookies` permission; the caller has already checked
 * for it. Both the URL and the bare domain are asked for, because a cookie set
 * on `.example.com` is not returned by a `getAll({url})` on a subdomain path
 * in every Chrome version, and a missing session cookie is the one failure
 * this feature cannot afford.
 *
 * @param {string} url
 * @returns {Promise<object[]>}
 */
async function _readCookiesFor(url) {
  const parsed = new URL(url);
  const seen = new Map();
  const add = (list) => {
    for (const c of list || []) {
      seen.set(`${c.domain}|${c.path}|${c.name}`, c);
    }
  };
  add(await chrome.cookies.getAll({ url }));
  add(await chrome.cookies.getAll({ domain: parsed.hostname }));
  return [...seen.values()];
}

/**
 * Put cookies back, one by one, reporting how many stuck.
 *
 * `chrome.cookies.set` refuses a cookie whose domain does not match the URL it
 * is given, so each one is written against a URL rebuilt from its own domain
 * and path rather than against the tab's address.
 *
 * @param {object[]} cookies
 * @returns {Promise<{written: number, refused: string[]}>}
 */
async function _writeCookies(cookies) {
  let written = 0;
  const refused = [];
  for (const c of cookies) {
    const host = String(c.domain || "").replace(/^\./, "");
    if (!host) continue;
    const scheme = c.secure ? "https" : "http";
    const details = {
      url: `${scheme}://${host}${c.path || "/"}`,
      name: c.name,
      value: c.value,
      path: c.path || "/",
      secure: !!c.secure,
      httpOnly: !!c.httpOnly,
      sameSite: c.sameSite === "unspecified" ? undefined : c.sameSite,
    };
    // A host-only cookie must not be given a domain, or Chrome widens it to
    // the whole registrable domain, which is a different cookie.
    if (String(c.domain || "").startsWith(".")) details.domain = c.domain;
    if (!c.session && c.expirationDate)
      details.expirationDate = c.expirationDate;
    try {
      const set = await chrome.cookies.set(details);
      if (set) written++;
      else refused.push(c.name);
    } catch (err) {
      logger.warn(MODULE, "cookie-set-fail", {
        name: c.name,
        error: err.message,
      });
      refused.push(c.name);
    }
  }
  return { written, refused };
}

/** Where a "forever" dedupe remembers its keys, one entry per pipeline+site. */
const STORAGE_DEDUPE_PREFIX = "vq_seen_";

/**
 * Collect rows into the run, dropping the ones a DEDUPE step has already seen.
 *
 * The one path rows take. Every producer — EXTRACT, PAGE_DATA, PAGE_JSON, API,
 * AUTO_EXTRACT — used to push into `results` and the buffer itself, in five
 * copies of the same two lines; a filter added to four of them would have been
 * a filter that leaks.
 *
 * @param {object} runState
 * @param {string} runId
 * @param {object[]} rows
 * @returns {Promise<{kept: object[], dropped: number}>}
 */
async function _collectRows(runState, runId, rows) {
  // The one place every row passes on its way to storage, whichever step
  // produced it. Ethics gate 2 used to sit at preflight, filtering for a step
  // type that does not exist, and could not have worked even spelled
  // correctly: rows do not exist before the page has been read.
  _checkRowsForPii(runState, runId, rows);

  const dedupe = runState?.dedupe;
  const { kept, dropped } = dedupe
    ? filterRows(rows, dedupe.seen, dedupe.fields)
    : { kept: rows, dropped: 0 };

  if (dedupe && dropped) {
    dedupe.dropped += dropped;
    dedupe.dirty = true;
  }
  if (kept.length) {
    runState.results.push(...kept);
    for (const row of kept) await pushRow(runId, row);
  }
  return { kept, dropped };
}

/**
 * DEDUPE — from here on, drop rows this run (or an earlier one) already has.
 *
 * A gate rather than a transform, and the reason is where the rows are: they
 * reach IndexedDB as they are extracted, so a step that "filtered the results"
 * would be unwriting rows that are already on disk. Placed before the LOOP that
 * extracts, it reads exactly as it behaves.
 *
 * "forever" persists the keys under the pipeline and the site, so tomorrow's
 * run of the same pipeline collects only what is new. That is the mode people
 * actually want for a watchlist, and it is the one with a cost worth stating:
 * the keys are kept until you clear them.
 *
 * @param {object} step
 * @param {string} runId
 */
async function _executeDedupe(step, runId) {
  const runState = _runStates.get(runId);
  if (!runState) return;
  const config = step.config || {};
  const fields = parseFields(config.fields);
  const scope = config.scope === "forever" ? "forever" : "run";
  const limit = Number(config.limit) > 0 ? Number(config.limit) : undefined;

  let restored = [];
  let storageKey = "";
  if (scope === "forever") {
    // Keyed by pipeline and site together: the same pipeline pointed at a
    // second site is a different list, and two pipelines over one site are two
    // different questions.
    storageKey =
      STORAGE_DEDUPE_PREFIX +
      _safeSegment(
        `${runState.pipelineName || "pipeline"}@${_hostOf(runState.targetOrigin) || "site"}`,
      );
    const stored = await chrome.storage.local
      .get([storageKey])
      .catch(() => ({}));
    restored = Array.isArray(stored?.[storageKey]) ? stored[storageKey] : [];
  }

  runState.dedupe = {
    fields,
    scope,
    storageKey,
    seen: new SeenKeys(limit, restored),
    dropped: 0,
    dirty: false,
  };

  _broadcastLog(
    "info-log",
    `DEDUPE: on${fields.length ? ` ${fields.join(", ")}` : " every field"}, ` +
      (scope === "forever"
        ? `remembering ${restored.length} row(s) from earlier runs.`
        : "within this run.") +
      " Rows collected from here on are checked.",
    runId,
  );
}

/**
 * Write a "forever" dedupe's keys back, at the end of the run.
 *
 * Once, not per row: a storage write for every row of a 50,000-row run would
 * cost more than the scrape. Called on every exit from a run, so a stopped run
 * still remembers what it collected — those rows are on disk either way, and
 * re-collecting them tomorrow is the thing this exists to prevent.
 *
 * @param {object} runState
 */
async function _saveDedupeKeys(runState) {
  const dedupe = runState?.dedupe;
  if (!dedupe || dedupe.scope !== "forever" || !dedupe.storageKey) return;
  if (!dedupe.dirty && !runState.results?.length) return;
  try {
    await chrome.storage.local.set({
      [dedupe.storageKey]: dedupe.seen.toArray(),
    });
  } catch (err) {
    // Worth saying: the next run will re-collect everything this one did.
    _broadcastLog(
      "warn-log",
      `DEDUPE: could not remember this run's rows (${err.message}), so the ` +
        "next run will see them as new.",
      runState.runId,
    );
  }
}

/**
 * SET_HEADERS — send request headers of your choosing for the rest of the run.
 *
 * A browser will not let a page change its own request headers, so this is the
 * only honest way to send a `User-Agent` a site will accept — and sites do
 * refuse: tryscrapeme.com answers 403 to anything that looks automated,
 * site-wide.
 *
 * The rules are scoped to this run's tab and removed when the run ends, by
 * `clearHeaderRules` on every exit path. That lifecycle is the lesson of A-05,
 * where a run set a browser-wide proxy and never gave it back.
 *
 * @param {object} step
 * @param {number} tabId
 * @param {string} runId
 */
async function _executeSetHeaders(step, tabId, runId) {
  const config = step.config || {};
  const headers = parseHeaderText(config.headers);
  if (!headers.length) {
    throw new Error("SET_HEADERS has no headers to send.");
  }
  if (!(await hasPermission("declarativeNetRequestWithHostAccess"))) {
    throw new ExplainedRefusal(
      permissionRefusal("declarativeNetRequestWithHostAccess"),
    );
  }
  if (!tabId) {
    throw new Error("SET_HEADERS needs the run's tab; there is none open.");
  }

  const { applied, refused } = await applyHeaderRules(runId, tabId, headers);
  if (refused.length) {
    // Named rather than dropped: a user who typed Host and saw nothing happen
    // would reasonably conclude the step is broken.
    _broadcastLog(
      "warn-log",
      `SET_HEADERS: the browser will not let a rule set ${refused.join(", ")}. ` +
        "Those are the browser's own to control.",
      runId,
    );
  }
  if (!applied) {
    throw new Error("SET_HEADERS: none of those headers can be set.");
  }
  _broadcastLog(
    "info-log",
    `SET_HEADERS: ${applied} header(s) will be sent on this tab's requests ` +
      "until the run ends.",
    runId,
  );
}

/**
 * SESSION — save, restore, or forget a logged-in session.
 *
 * The session lives in two places the extension has to reach separately: the
 * cookie jar, which only the worker can read in full, and the page's own
 * localStorage/sessionStorage, which only the page can see. Both halves are
 * gathered here so a restore puts back what a save took.
 *
 * Without the `cookies` permission the step still works, and says exactly what
 * it lost: `document.cookie` cannot see an HttpOnly cookie, which is what a
 * session cookie usually is, so a session saved that way often restores as a
 * logged-out one. Telling the user that at save time is the whole point —
 * finding out at restore time means a run that silently scrapes the login
 * page.
 *
 * @param {object} step
 * @param {number} tabId
 * @param {string} runId
 */
async function _executeSession(step, tabId, runId) {
  const config = step.config || {};
  const mode = String(config.mode || "save").trim();
  const name = String(config.name || "default").trim() || "default";
  const wantCookies = config.includeCookies !== false;
  const wantStorage = config.includeStorage !== false;

  if (mode === "clear") {
    const existed = await deleteSession(name);
    _broadcastLog(
      existed ? "info-log" : "warn-log",
      existed
        ? `SESSION: forgot the saved session "${name}".`
        : `SESSION: there was no saved session called "${name}".`,
      runId,
    );
    return;
  }

  const tab = await chrome.tabs.get(tabId);
  const url = tab?.url || "";
  let origin;
  try {
    origin = new URL(url).origin;
  } catch {
    throw new Error(
      "SESSION needs a page open on a real site; this tab has no address it can use.",
    );
  }

  const canReadCookies = await hasPermission("cookies");

  // The page's half. Asked for even when only cookies are wanted, because the
  // reply also confirms which origin actually answered.
  const pageResp = await _sendToPage(tabId, {
    type: "SESSION_STORAGE",
    config: {
      mode: mode === "restore" ? "restore" : "dump",
      includeStorage: wantStorage,
      // Cookies come from the worker when it may read them; asking the page as
      // well would only add the partial copy back on top of the full one.
      includeCookies: !canReadCookies && wantCookies,
      data: undefined,
    },
  });

  if (mode === "save") {
    if (!pageResp?.ok) {
      throw new Error(pageResp?.error || "SESSION could not read the page.");
    }
    const page = pageResp.result || {};
    let cookies = [];
    let cookieSource = "none";
    if (wantCookies) {
      if (canReadCookies) {
        cookies = await _readCookiesFor(url);
        cookieSource = "chrome.cookies";
      } else {
        cookies = page.cookies || [];
        cookieSource = "document.cookie";
      }
    }

    const meta = await saveSession(name, {
      origin,
      url,
      cookies,
      cookieSource,
      localStorage: page.localStorage || {},
      sessionStorage: page.sessionStorage || {},
    });

    for (const w of page.warnings || [])
      _broadcastLog("warn-log", `SESSION: ${w}`, runId);
    _broadcastLog(
      "info-log",
      `SESSION: saved "${name}" for ${origin} — ${meta.cookieCount} cookie(s), ` +
        `${meta.localCount} localStorage and ${meta.sessionCount} sessionStorage entries.`,
      runId,
    );
    if (!canReadCookies && wantCookies) {
      _broadcastLog(
        "warn-log",
        `SESSION: ${permissionRefusal("cookies")}`,
        runId,
      );
    }
    return;
  }

  if (mode !== "restore") {
    throw new Error(`SESSION does not know the mode "${mode}".`);
  }

  const saved = await loadSession(name);
  if (!saved) {
    const known = (await listSessions()).map((s) => s.name);
    throw new Error(
      `There is no saved session called "${name}".` +
        (known.length ? ` Saved: ${known.join(", ")}.` : " Save one first."),
    );
  }
  if (saved.origin && saved.origin !== origin) {
    // Refused rather than tried: writing one site's cookies while another is
    // open is how a session ends up somewhere it was never meant to go.
    throw new Error(
      `The session "${name}" was saved on ${saved.origin}, and this tab is on ` +
        `${origin}. Open ${saved.origin} first, or save a session for this site.`,
    );
  }

  let cookiesWritten = 0;
  const refused = [];
  if (wantCookies && (saved.cookies || []).length) {
    if (canReadCookies) {
      const res = await _writeCookies(saved.cookies);
      cookiesWritten = res.written;
      refused.push(...res.refused);
    } else {
      // The page can write the ones it could have read. HttpOnly cookies are
      // skipped there, which is exactly the gap the permission closes.
      const back = await _sendToPage(tabId, {
        type: "SESSION_STORAGE",
        config: {
          mode: "restore",
          includeStorage: false,
          includeCookies: true,
          data: { cookies: saved.cookies },
        },
      });
      cookiesWritten = back?.result?.cookiesWritten ?? 0;
      _broadcastLog(
        "warn-log",
        `SESSION: ${permissionRefusal("cookies")}`,
        runId,
      );
    }
  }

  let localWritten = 0;
  let sessionWritten = 0;
  if (wantStorage) {
    const back = await _sendToPage(tabId, {
      type: "SESSION_STORAGE",
      config: {
        mode: "restore",
        includeStorage: true,
        includeCookies: false,
        data: {
          localStorage: saved.localStorage || {},
          sessionStorage: saved.sessionStorage || {},
        },
      },
    });
    if (!back?.ok)
      throw new Error(back?.error || "SESSION could not write to the page.");
    localWritten = back.result?.localWritten ?? 0;
    sessionWritten = back.result?.sessionWritten ?? 0;
    for (const w of back.result?.warnings || []) {
      _broadcastLog("warn-log", `SESSION: ${w}`, runId);
    }
  }

  if (refused.length) {
    _broadcastLog(
      "warn-log",
      `SESSION: the browser refused ${refused.length} cookie(s): ${refused.slice(0, 5).join(", ")}.`,
      runId,
    );
  }
  _broadcastLog(
    "info-log",
    `SESSION: restored "${name}" — ${cookiesWritten} cookie(s), ` +
      `${localWritten} localStorage and ${sessionWritten} sessionStorage entries. ` +
      `Reload the page for the site to see them.`,
    runId,
  );
}

async function _executeDownloadFile(step, tabId, runId, ctx = {}) {
  const config = step.config || {};
  const authored = step.__vqRawConfig || config;
  const runState = _runStates.get(runId);
  const literal = String(config.url || "").trim();

  let targets = [];
  let matched = 0;
  let unusable = [];

  if (literal) {
    // The author typed this one, so it is held to the same origin rule a
    // NAVIGATE is. A URL read off the page is not: see K-23.
    _assertOriginAllowed(literal, runState, "DOWNLOAD_FILE");
    targets = [{ url: literal }];
    matched = 1;
  } else {
    const selector = String(config.selector || "").trim();
    if (!selector) {
      throw new Error(
        "DOWNLOAD_FILE needs a selector to match, or a URL to fetch directly.",
      );
    }
    const resp = await _sendToPage(tabId, {
      type: "DOWNLOAD_COLLECT",
      config: {
        selector,
        attr: config.attr,
        inFrame: config.inFrame,
        frameUrl: config.frameUrl,
      },
      __vqContext: step.__vqContext || ctx,
    });
    if (!resp?.ok) {
      throw new Error(resp?.error || "DOWNLOAD_FILE could not read the page");
    }
    targets = resp.result?.urls ?? [];
    matched = resp.result?.matched ?? 0;
    unusable = resp.result?.skipped ?? [];
  }

  const asked = Number(authored.max ?? config.max);
  const limit = Number.isFinite(asked) && asked > 0 ? asked : targets.length;
  const queue = targets.slice(0, Math.min(limit, DOWNLOAD_HARD_CAP));
  const template =
    String(authored.filename ?? config.filename ?? "").trim() ||
    "verquill/{{file.name}}";
  const domain = _runDomain(runState);

  const files = [];
  const failures = [];
  const offOrigin = new Set();

  for (let i = 0; i < queue.length; i++) {
    if (runState && !runState.active) break;
    const target = queue[i];
    const shown = String(target.url).slice(0, 120);

    if (!_downloadableScheme(target.url)) {
      failures.push({
        url: shown,
        reason: "only http, https and data URLs can be downloaded",
      });
      continue;
    }
    if (!literal && runState?.allowedOrigins?.size) {
      try {
        const origin = new URL(target.url).origin;
        if (!runState.allowedOrigins.has(origin)) offOrigin.add(origin);
      } catch {
        // A data: URL has no origin; there is nothing to report.
      }
    }

    const facts = _fileFacts(target, i + 1);
    const filename = _resolveDownloadPath(
      template,
      { ...ctx, file: facts },
      facts,
    );

    // Paced like every other request this run makes. A gallery is forty
    // requests to the same site, and the limiter is the only thing standing
    // between a scrape and a burst that looks like an attack.
    await acquire(domain);
    try {
      const id = await chrome.downloads.download({
        url: target.url,
        filename,
        // Two files called product.jpg are two files, not one overwritten.
        conflictAction: "uniquify",
        saveAs: false,
      });
      if (id === undefined || id === null) {
        throw new Error("Chrome accepted the request and started no download");
      }
      files.push({ id, filename, url: target.url });
    } catch (err) {
      failures.push({ url: shown, reason: err?.message || String(err) });
    }
  }

  const summary = {
    matched,
    requested: queue.length,
    saved: files.length,
    failed: failures.length,
    files,
    failures,
  };
  ctx.downloads = summary;

  if (!literal && matched === 0) {
    _broadcastLog(
      "warn-log",
      `DOWNLOAD_FILE: nothing matched "${config.selector}" — no files.`,
      runId,
    );
  }
  for (const item of unusable.slice(0, 3)) {
    _broadcastLog("warn-log", `DOWNLOAD_FILE: ${item.reason}.`, runId);
  }
  if (unusable.length > 3) {
    _broadcastLog(
      "warn-log",
      `DOWNLOAD_FILE: ${unusable.length - 3} more matched elements carried no URL.`,
      runId,
    );
  }
  if (targets.length > queue.length) {
    _broadcastLog(
      "info-log",
      `DOWNLOAD_FILE: ${targets.length} files matched, ${queue.length} downloaded — raise the limit to take the rest.`,
      runId,
    );
  }
  if (offOrigin.size > 0) {
    _broadcastLog(
      "warn-log",
      `DOWNLOAD_FILE: files came from ${[...offOrigin].join(", ")}, which this pipeline never declared. ` +
        "That is normal for a CDN, and it is the page that chose the address — check it is one you expect.",
      runId,
    );
  }
  for (const failure of failures.slice(0, 5)) {
    _broadcastLog(
      "warn-log",
      `DOWNLOAD_FILE: ${failure.url} — ${failure.reason}`,
      runId,
    );
  }

  if (queue.length > 0 && files.length === 0) {
    // Found something to fetch and fetched none of it. Reported as a failure
    // rather than as a quiet zero, which is how "the images did not download"
    // goes unnoticed until the folder is empty.
    throw new Error(
      `DOWNLOAD_FILE saved none of the ${queue.length} file(s) it found: ${failures[0]?.reason ?? "no reason given"}`,
    );
  }
  if (files.length > 0) {
    _broadcastLog(
      "info-log",
      `Downloaded ${files.length} file${files.length === 1 ? "" : "s"}` +
        (failures.length ? `, ${failures.length} failed` : "") +
        ` — first: ${files[0].filename}`,
      runId,
    );
  }
  return summary;
}

// ── Template resolver ── {{loop.index}}, {{item.href}}, {{extracted.name}} ────
function _resolvePath(ctx, expr) {
  const parts = expr.trim().split(".");
  let val = ctx;

  for (let part of parts) {
    if (val === undefined || val === null) return undefined;

    // support data[] indexing and numeric indexing
    const arrayMatch = part.match(/^(.+?)\[(\d+)\]$/);
    if (arrayMatch) {
      const key = arrayMatch[1];
      const idx = Number(arrayMatch[2]);
      val = val?.[key];
      if (!Array.isArray(val)) return undefined;
      val = val[idx];
      continue;
    }

    if (/^\d+$/.test(part)) {
      const idx = Number(part);
      if (!Array.isArray(val)) return undefined;
      val = val[idx];
      continue;
    }

    val = val[part];
  }
  return val;
}

function _resolveStr(s, ctx) {
  if (!s || typeof s !== "string" || !s.includes("{{")) return s;
  return s.replace(/\{\{([^}]+)\}\}/g, (_, expr) => {
    const val = _resolvePath(ctx, expr);
    return val !== undefined && val !== null ? String(val) : "";
  });
}
function _resolveConfig(step, ctx) {
  if (!ctx || !Object.keys(ctx).length) return step;
  // Every string, at any depth. This used to map top-level values only, so a
  // template inside FILL.fields[].value or an EXTRACT field passed through
  // literally and got typed into the page as "{{item.href}}" (B-11).
  // EXTRACT selectors survived by accident, because injector.js re-renders them
  // from __vqContext; resolving here first is a no-op for those.
  return {
    ...step,
    config: _resolveAny(step.config || {}, ctx),
    __vqContext: ctx,
    // The step as its author wrote it. DOWNLOAD_FILE needs it: its filename
    // template is resolved once per file, against a context that does not
    // exist yet here, and a pass through _resolveStr now would blank
    // {{file.name}} before the first file is known.
    __vqRawConfig: step.config,
  };
}

function _resolveAny(value, ctx) {
  if (typeof value === "string") return _resolveStr(value, ctx);
  if (Array.isArray(value)) return value.map((v) => _resolveAny(v, ctx));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = _resolveAny(v, ctx);
    return out;
  }
  return value;
}

function _parseApiHeaders(rawHeaders, ctx) {
  if (!rawHeaders) return {};
  if (typeof rawHeaders === "string") {
    const rendered = _resolveStr(rawHeaders, ctx);
    try {
      const parsed = JSON.parse(rendered);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return _resolveAny(parsed, ctx);
      }
      return {};
    } catch {
      return {};
    }
  }
  if (
    rawHeaders &&
    typeof rawHeaders === "object" &&
    !Array.isArray(rawHeaders)
  ) {
    return _resolveAny(rawHeaders, ctx);
  }
  return {};
}

/**
 * `Retry-After` (RFC 9110 §10.2.3) comes as either a delta in seconds or an
 * HTTP date, and real servers use both. Anything else means the header did
 * not answer, not that the caller should guess a number.
 * @param {?string} value
 * @returns {?number} milliseconds to wait, or null when the header is absent
 *   or unparseable
 */
function _parseRetryAfterMs(value) {
  if (!value) return null;
  const trimmed = String(value).trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

/** Set (not append) a query parameter, tolerating a URL fetch would resolve
 * relatively rather than one `new URL()` can parse on its own. */
function _addQueryParam(url, key, value) {
  try {
    const u = new URL(url);
    u.searchParams.set(key, String(value));
    return u.toString();
  } catch {
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`;
  }
}

/**
 * The `rel="next"` target out of an RFC 8288 `Link` header, or null when
 * there is none. Split on commas that precede a new `<`, not on every comma,
 * because a quoted attribute (`title="a, b"`) can carry one too.
 * @param {string} value
 * @param {string} baseUrl - resolves a relative target against the page that answered
 * @returns {?string}
 */
function _linkHeaderNext(value, baseUrl) {
  if (!value) return null;
  for (const part of String(value).split(/,(?=\s*<)/)) {
    const urlMatch = part.match(/<([^>]+)>/);
    const relMatch = part.match(/rel\s*=\s*"?([^",;]+)"?/i);
    if (!urlMatch || !relMatch || relMatch[1].toLowerCase() !== "next") {
      continue;
    }
    try {
      return new URL(urlMatch[1], baseUrl).toString();
    } catch {
      return urlMatch[1];
    }
  }
  return null;
}

/**
 * The array of records inside a response body. An empty `rowsPath` means the
 * body itself, if it is an array — the shape of an endpoint with no
 * envelope. A path that does not resolve to an array yields no rows rather
 * than throwing, the same way a miss elsewhere in this file becomes an empty
 * result instead of a crash.
 * @param {*} body
 * @param {string} rowsPath
 * @returns {Array}
 */
function _extractApiRows(body, rowsPath) {
  const path = String(rowsPath || "").trim();
  const target = path ? _resolvePath(body, path) : body;
  return Array.isArray(target) ? target : [];
}

/** Hold for a run's pause, and report whether the run is still worth continuing. */
async function _apiRunGate(runCtx) {
  const runState = runCtx?.runState;
  if (!runState) return true; // a standalone step test carries no run to gate on
  while (runState.paused && runState.active) await _sleep(500);
  return Boolean(runState.active);
}

/** Sleep in slices so Stop is answered inside the wait rather than after it. */
async function _apiSleep(ms, runCtx) {
  const runState = runCtx?.runState;
  if (!runState) {
    await _sleep(ms);
    return true;
  }
  const until = Date.now() + ms;
  while (runState.active && Date.now() < until) {
    await _sleep(Math.min(200, until - Date.now()));
  }
  return Boolean(runState.active);
}

/** One bare HTTP request for an API step — no retry, no pagination. */
async function _apiRequestOnce(
  url,
  method,
  headers,
  bodyInit,
  timeoutMs,
  responseType,
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const init = { method, headers, signal: controller.signal };
    if (bodyInit !== undefined) init.body = bodyInit;

    const startedAt = Date.now();
    const resp = await fetch(url, init);
    const contentType = resp.headers.get("content-type") || "";
    let body;

    if (
      responseType === "json" ||
      (responseType === "auto" && contentType.includes("application/json"))
    ) {
      try {
        body = await resp.json();
      } catch {
        body = await resp.text();
      }
    } else {
      body = await resp.text();
    }

    return {
      ok: resp.ok,
      status: resp.status,
      statusText: resp.statusText,
      url: resp.url,
      method,
      elapsedMs: Date.now() - startedAt,
      headers: Object.fromEntries(resp.headers.entries()),
      linkHeader: resp.headers.get("link") || "",
      body,
    };
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new Error(`API ${method} ${url} timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One page's worth of an API step: fetch, and retry it in place on a 429 or
 * 5xx. `Retry-After` is the server naming exactly how long to wait — ignoring
 * it and guessing would be both ruder and worse — and a server that names
 * none falls back to the same exponential shape `backoff()` uses elsewhere.
 * Bounded by API_RETRY_LIMITS so a server that keeps asking for more time
 * cannot stall a run for an hour; a count is a courtesy, not a promise.
 *
 * Consistent with `_dispatchWithRetries` (K-12): a retry is a fresh HTTP
 * request, so it queues behind the rate limiter and holds for a pause
 * exactly like the first attempt did, and stops the moment the run is
 * stopped. `isFirstRequest` skips that gate for the very first fetch of the
 * whole step — the caller already queued behind the limiter for that one.
 *
 * @returns {Promise<object>} the last response, success or failure — HTTP
 *   status is not itself a thrown error here; the caller decides what a
 *   failing status means
 */
async function _apiFetchWithRetry(
  url,
  method,
  headers,
  bodyInit,
  timeoutMs,
  responseType,
  runCtx,
  { isFirstRequest = false } = {},
) {
  let attempt = 0;
  let waitedMs = 0;
  let first = isFirstRequest;

  for (;;) {
    if (!first) {
      if (!(await _apiRunGate(runCtx))) {
        throw new Error("API request abandoned: the run was stopped.");
      }
      if (runCtx?.runState) await acquire(_runDomain(runCtx.runState));
    }
    first = false;

    const result = await _apiRequestOnce(
      url,
      method,
      headers,
      bodyInit,
      timeoutMs,
      responseType,
    );
    attempt += 1;

    const retryable =
      result.status === 429 || (result.status >= 500 && result.status <= 599);
    if (
      !retryable ||
      attempt >= API_RETRY_LIMITS.maxAttempts ||
      waitedMs >= API_RETRY_LIMITS.maxTotalWaitMs
    ) {
      return result;
    }

    const headerWaitMs = _parseRetryAfterMs(result.headers["retry-after"]);
    const backoffMs =
      API_RETRY_LIMITS.fallbackBaseMs * Math.pow(2, attempt - 1);
    const remainingMs = API_RETRY_LIMITS.maxTotalWaitMs - waitedMs;
    const waitMs = Math.max(
      0,
      Math.min(headerWaitMs ?? backoffMs, remainingMs),
    );

    if (runCtx?.runId) {
      _broadcastLog(
        "warn-log",
        `API ${method} ${url} → ${result.status}${headerWaitMs != null ? " (Retry-After)" : ""} — ` +
          `retry ${attempt} of ${API_RETRY_LIMITS.maxAttempts - 1} in ${waitMs}ms.`,
        runCtx.runId,
      );
    }

    waitedMs += waitMs;
    if (!(await _apiSleep(waitMs, runCtx))) return result;
  }
}

async function _executeApiStep(config = {}, ctx = {}, runCtx = null) {
  const method = String(config.method || "GET").toUpperCase();
  const baseUrl = _resolveStr(config.url || config.endpoint || "", ctx);
  if (!baseUrl) throw new Error("API step missing URL");

  const headers = _parseApiHeaders(config.headers, ctx);
  const timeoutMs = Math.max(500, Number(config.timeoutMs ?? 15000));
  const responseType = String(config.responseType || "auto").toLowerCase();
  const rowsPath = String(config.rowsPath || "").trim();

  let bodyInit;
  if (!["GET", "HEAD"].includes(method)) {
    const bodyText = _resolveStr(config.body || "", ctx);
    if (bodyText) {
      if (
        (headers["Content-Type"] || headers["content-type"] || "").includes(
          "application/json",
        )
      ) {
        try {
          bodyInit = JSON.stringify(JSON.parse(bodyText));
        } catch {
          bodyInit = bodyText;
        }
      } else {
        bodyInit = bodyText;
      }
    }
  }

  const pagination =
    config.pagination && typeof config.pagination === "object"
      ? config.pagination
      : {};
  const mode = String(pagination.mode || "none").toLowerCase();

  if (mode !== "none" && !rowsPath) {
    // Without rowsPath there is no way to tell "an empty page" from a page
    // that just does not carry rows the way this endpoint's envelope is
    // shaped — and an empty page is one of the three things pagination has
    // to be able to stop on.
    throw new Error(
      "API pagination needs rowsPath — a dotted path to the array of " +
        "records in each page's body — so it knows what an empty page is.",
    );
  }
  if (mode === "cursor" && !String(pagination.cursorPath || "").trim()) {
    throw new Error(
      'API pagination is set to "cursor" but has no cursorPath — nothing ' +
        "names where the next cursor lives in the response body, for " +
        'example "next_cursor" or "meta.next".',
    );
  }
  if (!["none", "cursor", "page", "link"].includes(mode)) {
    throw new Error(`API pagination has an unknown mode "${pagination.mode}".`);
  }

  const maxPages = mode === "none" ? 1 : paginationMaxPages(pagination);
  const cursorParam =
    String(pagination.cursorParam || "cursor").trim() || "cursor";
  const pageParam = String(pagination.pageParam || "page").trim() || "page";
  const startPage = Number.isFinite(Number(pagination.startPage))
    ? Number(pagination.startPage)
    : 1;
  const pageStep =
    Number.isFinite(Number(pagination.pageStep)) &&
    Number(pagination.pageStep) !== 0
      ? Number(pagination.pageStep)
      : 1;

  const rows = [];
  // Page mode names its number on every request, including the first — the
  // start page is a request parameter, not just a step the loop counts from.
  let requestUrl =
    mode === "page" ? _addQueryParam(baseUrl, pageParam, startPage) : baseUrl;
  let pageNumber = startPage;
  let pageCount = 0;
  let lastResult = null;
  let stopReason = "";

  for (let i = 0; i < maxPages; i++) {
    let result;
    try {
      result = await _apiFetchWithRetry(
        requestUrl,
        method,
        headers,
        bodyInit,
        timeoutMs,
        responseType,
        runCtx,
        { isFirstRequest: i === 0 },
      );
    } catch (err) {
      // The first page failing is the whole step failing, same as before
      // pagination existed. A later page failing after real rows were
      // already collected should not throw them away — it stops here and
      // hands back what it has, the way a numbered LOOP paginator stops
      // rather than erroring when a page will not open (K-20).
      if (i === 0) throw err;
      stopReason = `page ${i + 1} could not be fetched: ${err.message}`;
      break;
    }

    lastResult = result;
    pageCount += 1;

    if (!result.ok && config.failOnHttpError !== false) {
      if (i === 0) {
        throw new Error(
          `API ${method} ${requestUrl} failed: ${result.status} ${result.statusText}`,
        );
      }
      stopReason = `page ${i + 1} failed: ${result.status} ${result.statusText}`;
      break;
    }

    const pageRows = _extractApiRows(result.body, rowsPath);
    rows.push(...pageRows);

    if (mode === "none") break;

    if (pageRows.length === 0) {
      stopReason = "the page was empty";
      break;
    }
    if (i === maxPages - 1) {
      stopReason = `reached the ${maxPages}-page limit`;
      break;
    }

    let next = null;
    if (mode === "cursor") {
      const cursorValue = _resolvePath(result.body, pagination.cursorPath);
      if (
        cursorValue !== undefined &&
        cursorValue !== null &&
        cursorValue !== ""
      ) {
        next = _addQueryParam(baseUrl, cursorParam, cursorValue);
      }
    } else if (mode === "page") {
      pageNumber += pageStep;
      next = _addQueryParam(baseUrl, pageParam, pageNumber);
    } else if (mode === "link") {
      next = _linkHeaderNext(result.linkHeader, result.url || requestUrl);
    }

    if (!next) {
      stopReason =
        mode === "cursor"
          ? "no next cursor in the response"
          : 'no rel="next" in the Link header';
      break;
    }
    requestUrl = next;
  }

  if (!lastResult) {
    // Unreachable in practice — the first iteration always either returns or
    // throws — but a clear message beats a crash reading .ok below.
    throw new Error(`API ${method} ${baseUrl} produced no response.`);
  }

  return {
    ...lastResult,
    paginated: mode !== "none",
    pages: pageCount,
    rows,
    stopReason,
  };
}

async function _executeUploadActivityStep(config = {}, tabId, runId = null) {
  const tabData = await chrome.tabs.get(tabId);
  const tabUrl = tabData?.url || "";
  const domain = new URL(tabUrl).hostname;

  const stored = await chrome.storage.local.get(STORAGE_FILES_KEY);
  const library = Array.isArray(stored?.[STORAGE_FILES_KEY])
    ? stored[STORAGE_FILES_KEY]
    : [];

  const mode = config.mode === "drop" ? "drop" : "input";
  const selector = String(config.selector || "").trim();
  if (!selector) {
    throw new Error(
      mode === "drop"
        ? "UPLOAD_ACTIVITY requires a selector for the drop zone."
        : "UPLOAD_ACTIVITY requires a file input selector.",
    );
  }

  const wantedIds = Array.isArray(config.fileIds) ? config.fileIds : [];
  const selected = wantedIds.length
    ? library.filter((f) => wantedIds.includes(f.id))
    : library;

  if (!selected.length) {
    throw new Error(
      "UPLOAD_ACTIVITY has no files selected. Add files in Storage and select them in step config.",
    );
  }

  if (!tabId) {
    throw new Error("No target tab for UPLOAD_ACTIVITY.");
  }

  // This used to say to use MCP tool "upload_file_to_site", which is not one of
  // the server's registered tools and never was — and there is no bridge from
  // the extension to the MCP server anyway, so it was an instruction nobody
  // could act on (G-05). Say what is actually true instead.
  if (RESTRICTED_UPLOAD_SITES[domain]) {
    _broadcastLog(
      "warn-log",
      `⚠️ ${domain} blocks script-driven file uploads. The step will try anyway; ` +
        `if it fails, the file has to be attached by hand.`,
      runId,
    );
  }

  _broadcastLog(
    "info-log",
    `Upload Activity: ${mode === "drop" ? "dropping" : "uploading"} ${selected.length} file(s) ${mode === "drop" ? "onto" : "to"} ${selector}`,
    runId,
  );

  // _sendToPage, not chrome.tabs.sendMessage: content scripts are injected on
  // demand (C-09) and are destroyed with the document that hosts them, so
  // talking to the tab directly meant every upload on a freshly loaded page
  // failed with "Receiving end does not exist" — the same defect that had
  // already been fixed for every other page step, missed here because this one
  // had its own send. Found by an end-to-end check in a real browser; no unit
  // test could see it, because the harness answers whether or not anything was
  // injected.
  const resp = await _sendToPage(tabId, {
    type: "UPLOAD_ACTIVITY",
    config: {
      selector,
      mode,
      inFrame: config.inFrame,
      frameUrl: config.frameUrl,
      files: selected.map((file) => ({
        name: file.name,
        type: file.type || "application/octet-stream",
        dataUrl: file.dataUrl,
      })),
    },
  }).catch((err) => ({ ok: false, error: err?.message }));

  if (!resp?.ok) {
    throw new Error(resp?.error || "Upload failed in page context.");
  }

  // A drop that nothing handled is the silent failure this mode could
  // otherwise produce: the events go out, the page ignores them, and the step
  // reports success having uploaded nothing. A page that accepts a drop has to
  // cancel `dragover` for the browser to allow it, so "nothing cancelled it"
  // is a real answer rather than a guess.
  if (mode === "drop" && resp.result?.accepted === false) {
    throw new Error(
      `Upload: "${selector}" did not accept the drop — nothing on the page ` +
        "handled it, so no files were taken. Check the selector names the drop " +
        "zone itself, or use the file-input mode if the widget has one.",
    );
  }

  _broadcastLog(
    "info-log",
    mode === "drop"
      ? `Upload Activity complete: ${selected.length} file(s) dropped and accepted.`
      : `Upload Activity complete: ${selected.length} file(s) staged in target input.`,
    runId,
  );

  return {
    uploaded: selected.length,
    mode,
    fileNames: selected.map((f) => f.name),
  };
}

/**
 * Ceiling on any single loop, whatever the page reports. A selector that
 * matches thousands of nodes should not be able to wedge the worker in a loop
 * no one can see the end of.
 */
const LOOP_HARD_CAP = 10000;

async function _executeLoop(step, tabId, runId, parentCtx = {}) {
  const {
    type: ltype = "count",
    selector = "",
    max = 10,
    onFail = "skip",
  } = step.config;
  const children = step.children || [];
  const limit = Number(max);
  let iters;
  let elementsData = null;

  if (ltype === "paginate-links" && selector) {
    // The page's own page-number links are the bound, the same way the element
    // list is in "elements" mode: five links means five pages, and there is
    // nothing to probe for "is there another one" because a numbered paginator
    // never disables anything — the links simply stop existing.
    let found = null;
    try {
      const r = await _sendToPage(tabId, {
        type: "QUERY_ELEMENTS",
        config: { selector },
      });
      if (r?.ok && Array.isArray(r.result)) found = r.result;
    } catch (e) {
      _broadcastLog(
        "warn-log",
        `Loop: page-link query failed: ${e.message}`,
        runId,
      );
      return;
    }
    if (!found || found.length === 0) {
      _broadcastLog(
        "warn-log",
        `Loop: no page links matched "${selector}" — skipping.`,
        runId,
      );
      return;
    }
    elementsData = found;
    iters = limit > 0 ? Math.min(found.length, limit) : found.length;
    _broadcastLog(
      "info-log",
      `Loop: ${found.length} page links for "${selector}"`,
      runId,
    );
  } else if (ltype === "paginate-url") {
    // Nothing to count here — the template says where the pages are and `max`
    // says how many. That is the whole appeal of this mode: it can start at
    // page 40 instead of walking to it.
    if (!String(step.config.urlTemplate || "").includes("{page}")) {
      throw new Error(
        'Loop in "paginate-url" mode needs a URL template containing {page}, ' +
          `for example https://example.com/list?page={page} (got "${step.config.urlTemplate ?? ""}").`,
      );
    }
    if (!Number.isFinite(limit) || limit < 1) {
      throw new Error(
        `Loop in "paginate-url" mode needs a page count of at least 1 (got ${max}).`,
      );
    }
    iters = limit;
  } else if (ltype === "list") {
    // The one mode whose bound is not on the page. Everything else counts what
    // it matched; this counts what you gave it.
    const source = step.config.source || "lines";
    let items = [];
    let truncated = 0;
    if (source === "context") {
      const { items: got, reason } = itemsFromContext(
        parentCtx,
        step.config.contextPath,
      );
      if (reason) {
        // Named rather than skipped in silence: a path that holds nothing and
        // a list that is genuinely empty look the same from the outside, and
        // the first is a typo the user can fix.
        _broadcastLog("warn-log", `Loop: ${reason} — skipping.`, runId);
        return;
      }
      items = got;
    } else {
      const parsed = parseListLines(step.config.lines, {
        delimiter: step.config.delimiter,
        hasHeader: step.config.hasHeader === true,
      });
      items = parsed.items;
      truncated = parsed.truncated;
    }

    if (items.length === 0) {
      _broadcastLog("warn-log", "Loop: the list is empty — skipping.", runId);
      return;
    }
    if (truncated > 0) {
      _broadcastLog(
        "warn-log",
        `Loop: the list was cut to ${MAX_LIST_ITEMS} items; ${truncated} were left out.`,
        runId,
      );
    }

    elementsData = items;
    iters = limit > 0 ? Math.min(items.length, limit) : items.length;
    _broadcastLog(
      "info-log",
      `Loop: ${items.length} item${items.length === 1 ? "" : "s"} in the list` +
        (iters < items.length ? `, running ${iters}` : "") +
        ".",
      runId,
    );
  } else if (ltype === "elements" && selector) {
    let found = null;
    try {
      // Pre-collect ALL element data upfront so templates can use {{item.href}}, {{item.text}} etc.
      const r = await _sendToPage(tabId, {
        type: "QUERY_ELEMENTS",
        config: { selector },
      });
      if (r?.ok && Array.isArray(r.result)) found = r.result;
    } catch (e) {
      // Falling through with elementsData still null used to leave iters at
      // `max`, so a failed query quietly ran the body N times against empty
      // items instead of skipping the loop.
      _broadcastLog(
        "warn-log",
        `Loop: element query failed: ${e.message}`,
        runId,
      );
      return;
    }

    if (!found || found.length === 0) {
      _broadcastLog(
        "warn-log",
        `Loop: no elements matched "${selector}" — skipping.`,
        runId,
      );
      return;
    }

    elementsData = found;
    // Here 0 really does mean unlimited, as the UI says — bounded only by how
    // many elements the page has, and by the hard cap below.
    iters = limit > 0 ? Math.min(found.length, limit) : found.length;
    _broadcastLog(
      "info-log",
      `Loop: found ${found.length} elements for "${selector}"`,
      runId,
    );
  } else {
    // count and paginate. There is nothing to derive a bound from here, so 0 is
    // not "unlimited" — it is a loop that runs zero times and says nothing,
    // which is what it silently did (B-22).
    if (!Number.isFinite(limit) || limit < 1) {
      throw new Error(
        `Loop in "${ltype}" mode needs a repeat count of at least 1 (got ${max}). ` +
          `Only "elements" mode treats 0 as unlimited, because the page supplies the bound.`,
      );
    }
    iters = limit;
  }

  if (iters > LOOP_HARD_CAP) {
    _broadcastLog(
      "warn-log",
      `Loop: ${iters} iterations exceeds the ${LOOP_HARD_CAP} cap — running ${LOOP_HARD_CAP}.`,
      runId,
    );
    iters = LOOP_HARD_CAP;
  }

  const runState = _runStates.get(runId);
  for (let i = 0; i < iters && runState?.active; i++) {
    const item = elementsData?.[i] ?? {
      index: i + 1,
      index0: i,
      text: "",
      href: "",
      src: "",
      value: "",
    };
    const isFirst = i === 0;
    const isLast = i === iters - 1;

    const loopCtx = {
      ...parentCtx,
      loop: {
        index: i + 1,
        index0: i,
        count: iters,
        selector,
        items: elementsData || [],
        first: isFirst,
        last: isLast,
        current: item,
      },
      item,
    };

    // A numbered paginator: go to the i-th page link. The first iteration is
    // the page already open, so only later ones navigate.
    if (ltype === "paginate-links" && i > 0) {
      const link = elementsData?.[i];
      const href = String(link?.href || "").trim();
      try {
        if (href) {
          // Preferred when the link has one: an href is stable, and it does not
          // depend on the new page rendering its paginator the same way. Sites
          // commonly render the *current* page as a <span> rather than an <a>,
          // which shifts every index after it.
          await _navigateTo(tabId, href, runState, runId, {
            timeoutMs: step.config.timeoutMs,
            what: "Loop (page link)",
          });
        } else {
          // No href — a JavaScript paginator. Click the i-th match on the page
          // as it is now, which is the only thing that can work there.
          const clicked = await _sendToPage(tabId, {
            type: "CLICK",
            config: { selector, index: i },
          });
          if (!clicked?.ok) throw new Error(clicked?.error || "click failed");
        }
      } catch (e) {
        _broadcastLog(
          "warn-log",
          `Loop: could not open page ${i + 1} — ${e.message}`,
          runId,
        );
        break;
      }
      const settle = Number(step.config.settleMs);
      if (Number.isFinite(settle) && settle > 0) await _sleep(settle);
    }

    // A URL template: compute this iteration's page and go there. Every
    // iteration navigates, including the first — the tab may be sitting on a
    // different page than the template's start, and silently scraping that one
    // twice is the bug this avoids.
    if (ltype === "paginate-url") {
      const start = Number(step.config.startPage);
      const stride = Number(step.config.pageStep);
      const n =
        (Number.isFinite(start) ? start : 1) +
        i * (Number.isFinite(stride) && stride !== 0 ? stride : 1);
      try {
        await _navigateTo(
          tabId,
          _pageUrl(step.config.urlTemplate, n),
          runState,
          runId,
          { timeoutMs: step.config.timeoutMs, what: "Loop (page URL)" },
        );
      } catch (e) {
        _broadcastLog(
          "warn-log",
          `Loop: could not open page ${n} — ${e.message}`,
          runId,
        );
        break;
      }
      const settle = Number(step.config.settleMs);
      if (Number.isFinite(settle) && settle > 0) await _sleep(settle);
    }

    if (ltype === "paginate" && i > 0 && selector) {
      // PAGINATE, not CLICK. A click past the last page matches nothing and
      // reports success, so the loop used to re-scrape the final page until
      // "max pages" ran out — duplicate rows, and no sign of a problem (the
      // dedup in the exporter hid the evidence too). PAGINATE says whether
      // there was another page.
      let paged;
      try {
        paged = await _executePaginate(
          tabId,
          {
            selector,
            settleMs: step.config.settleMs,
            requireChange: step.config.requireChange,
            timeoutMs: step.config.timeoutMs,
          },
          runState,
          runId,
        );
      } catch (e) {
        _broadcastLog(
          "warn-log",
          `Loop: pagination failed on page ${i + 1} — ${e.message}`,
          runId,
        );
        break;
      }
      if (paged.exhausted) {
        const why = paged.reason || "no further pages";
        _broadcastLog(
          "info-log",
          `Loop: stopped after ${i} page${i === 1 ? "" : "s"} — ${why}.`,
          runId,
        );
        break;
      }
    }
    const rowsBefore = runState?.results?.length ?? 0;
    try {
      await _executeStepList(children, tabId, runId, loopCtx);
      _broadcastLog("info-log", `Loop [${i + 1}/${iters}] done.`, runId);
    } catch (e) {
      _broadcastLog(
        "warn-log",
        `Loop [${i + 1}/${iters}] — ${e.message}`,
        runId,
      );
      if (onFail === "stop") break;
    }

    // Past the last page (B-27 / VQ-04). "paginate-url" has nothing to probe:
    // the template says where the pages are and `max` says how many, so a run
    // asked for 20 pages of a 5-page site fetched 15 empty ones — and sites
    // that clamp ?page=99 to the last page served the same rows fifteen times
    // over instead. A page that yields nothing when an earlier page yielded
    // something is the signal that exists here, and it is the same signal a
    // person reads off the screen.
    //
    // Only after a productive page: a pipeline whose rows all come from a
    // later step, or whose first page is genuinely empty, must not be cut off
    // at page one. And only when asked for — a loop whose body extracts
    // nothing at all (screenshots, downloads) has no rows to count.
    if (
      ltype === "paginate-url" &&
      step.config.stopWhenEmpty !== false &&
      (runState?.results?.length ?? 0) === rowsBefore &&
      rowsBefore > 0
    ) {
      _broadcastLog(
        "info-log",
        `Loop: stopped after ${i + 1} page${i === 0 ? "" : "s"} — that page ` +
          "produced no rows, so the pages have run out.",
        runId,
      );
      break;
    }
  }
}

async function _executeIfElse(step, tabId, runId, parentCtx = {}) {
  const resolved = _resolveConfig(step, parentCtx);
  const condition = resolved.config.condition || "exists";
  let met = false;

  try {
    // The page reports what it saw; the comparison happens here, against the
    // one shared definition, so a numeric branch uses the same number reader
    // EXTRACT does.
    const r = await _sendToPage(tabId, resolved);
    if (!r?.ok) throw new Error(r?.error || "could not read the page");

    // A branch comparing against a second element, whose second element is not
    // on the page, has no comparison to make. It takes ELSE — but silently
    // that is indistinguishable from a condition that was simply not met, and
    // "the selector is wrong" is the far more likely explanation.
    if (resolved.config.compareTo === "selector" && !r.result?.other?.exists) {
      _broadcastLog(
        "warn-log",
        `IF_ELSE: nothing matched "${resolved.config.valueSelector}", the element ` +
          "it was told to compare against — so there is nothing to compare with, " +
          "and the ELSE branch is taken.",
        runId,
      );
    }

    met = evaluateCondition(condition, r.result, resolved.config);
  } catch (err) {
    // This used to swallow everything into `met = false` and take ELSE, so a
    // broken condition — a bad pattern, a non-numeric comparison value, a dead
    // tab — was indistinguishable from an unmet one.
    _broadcastLog(
      "warn-log",
      `IF_ELSE (${condition}) could not be evaluated: ${err.message} — taking the ELSE branch.`,
      runId,
    );
    met = false;
  }

  _broadcastLog(
    "info-log",
    `IF_ELSE: condition ${met ? "met → IF" : "not met → ELSE"} branch.`,
    runId,
  );
  await _executeStepList(
    met ? step.ifBranch || [] : step.elseBranch || [],
    tabId,
    runId,
    parentCtx,
  );
}

/**
 * Apply each EXTRACT field's transforms to the rows the page produced.
 *
 * Here rather than in the content script for three reasons: the transforms are
 * an ES module and a classic content script cannot import one, so doing it in
 * the page would mean a second copy that drifts (G-01); the worker knows the
 * tab's URL, which is what a relative link has to be resolved against; and a
 * failing transform can then name the field it failed on, rather than surfacing
 * as a column quietly full of nulls.
 *
 * @param {object[]} rows
 * @param {object} config - the EXTRACT step's config, for its `fields`
 * @param {number} tabId
 * @returns {Promise<object[]>}
 */
async function _transformRows(rows, config = {}, tabId) {
  const fields = (config.fields ?? []).filter(
    (f) => Array.isArray(f.transform) && f.transform.length > 0,
  );
  if (fields.length === 0) return rows;

  // Only fetched when something actually needs it.
  let base = "";
  if (fields.some((f) => f.transform.includes("url"))) {
    base = (await chrome.tabs.get(tabId).catch(() => null))?.url || "";
  }

  return rows.map((row) => {
    const out = { ...row };
    for (const field of fields) {
      const name = field.name || "data";
      if (!(name in out)) continue;
      try {
        out[name] = applyTransforms(out[name], field.transform, {
          base,
          pattern: field.regexPattern,
          flags: field.regexFlags,
          group: field.regexGroup,
        });
      } catch (err) {
        throw new Error(`EXTRACT field "${name}": ${err.message}`);
      }
    }
    return out;
  });
}

/** How long a navigation may take before the run stops waiting for it. */
const NAV_TIMEOUT_MS = 30000;

/**
 * Wait for a tab to finish loading.
 *
 * NAVIGATE used to `_sleep(3000)` and hope. On a slow site the next step ran
 * against a blank page and extracted nothing; on a fast one every navigation
 * cost three seconds, which inside a loop over 200 links is ten minutes of
 * doing nothing.
 *
 * Polling rather than chrome.tabs.onUpdated: the listener has to be added
 * before the navigation and removed on every exit path, and a service worker
 * that is torn down mid-wait leaks it. A poll has no such state.
 *
 * @returns {Promise<boolean>} false if the timeout was reached first
 */
async function _waitForTabLoad(tabId, timeoutMs = NAV_TIMEOUT_MS) {
  // Chrome does not flip `status` to "loading" synchronously with the
  // tabs.update call, so an immediate first poll can still see the *previous*
  // page sitting at "complete" and return before anything has moved.
  await _sleep(150);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      return false; // the tab is gone; the caller's next step will say so
    }
    if (tab?.status === "complete") return true;
    await _sleep(150);
  }
  return false;
}

/**
 * Turn to the next page, and report whether there was one.
 *
 * Split across two messages on purpose. Clicking a real `<a href>` navigates
 * the tab: the content script is destroyed with the document, its reply is
 * never delivered, and Chrome surfaces "the message channel closed before a
 * response was received". A page-side step that both decides and clicks
 * therefore fails on exactly the sites pagination is for. So the page answers
 * the question first, the worker performs the click, and losing the page after
 * it is the expected outcome rather than an error.
 *
 * @returns {Promise<{paginated: boolean, exhausted: boolean, reason: string}>}
 */
/**
 * Send the tab to a URL and wait for it to land.
 *
 * Shared by NAVIGATE and by the two URL-driven pagination modes, so the origin
 * check, the wait and the "still loading" warning cannot drift apart between
 * them — the origin check especially: a loop that computes its own URLs is
 * exactly where an unchecked navigation would be easiest to miss.
 */
async function _navigateTo(tabId, url, runState, runId, opts = {}) {
  const { wait = true, timeoutMs, what = "NAVIGATE" } = opts;
  _assertOriginAllowed(url, runState, what);
  // Before the request, not after: rotating once the page has loaded would
  // move the proxy for the *next* navigation while attributing it to this one.
  await _maybeRotateProxy(runState);
  await chrome.tabs.update(tabId, { url });
  if (!wait) {
    // The caller asked not to wait; still give the navigation a beat to
    // commit, or the next step runs against the page being replaced.
    await _sleep(400);
    return;
  }
  const ms = Number(timeoutMs) || NAV_TIMEOUT_MS;
  const loaded = await _waitForTabLoad(tabId, ms);
  if (!loaded) {
    _broadcastLog(
      "warn-log",
      `${what}: the page was still loading after ${Math.round(ms / 1000)}s — continuing anyway.`,
      runId,
    );
    await _noteProxyFailure(runState, what);
  }
}

/**
 * Charge a failed navigation to the proxy that was carrying it.
 *
 * `markProxyFailure` existed, counted failures, and flipped a proxy to dead at
 * the third one — and was imported by this file and called by nothing. So the
 * pool's health only ever changed when the user pressed Test in Settings, and
 * a proxy that had started refusing connections mid-run went on being selected
 * for every subsequent run.
 *
 * A navigation that never finished is the honest signal available here: it is
 * what the proxy is for, and it is the failure the run can attribute. It is
 * not proof — a slow site times out too — which is why three are needed before
 * a proxy is written off rather than one.
 *
 * Rotating immediately afterwards, rather than waiting for the cadence, is the
 * point of noticing at all.
 */
async function _noteProxyFailure(runState, what) {
  const held = runState?.proxyEntry;
  if (!runState?.proxyHeld || !held) return;

  const died = await markProxyFailure(held.host, held.port).catch(() => false);
  if (!died) return;

  _broadcastLog(
    "warn-log",
    `${held.host}:${held.port} failed three times and is marked dead — ${what} ` +
      "could not load a page through it.",
    runState.runId,
  );
  const next = await rotateProxy({
    domain: _hostOf(runState.targetOrigin),
  }).catch(() => null);
  if (next) {
    runState.proxyEntry = { host: next.host, port: next.port };
    _broadcastLog(
      "info-log",
      `Switched to ${next.host}:${next.port}.`,
      runState.runId,
    );
  } else {
    runState.proxyHeld = false;
    runState.proxyEntry = null;
    _broadcastLog(
      "warn-log",
      "No live proxy is left in the pool — the rest of this run goes direct.",
      runState.runId,
    );
  }
}

/**
 * The URL for page `n` of a `paginate-url` loop.
 *
 * The template carries `{page}` where the number goes. Anything else is left
 * alone, so a URL that already has query parameters needs no escaping.
 */
function _pageUrl(template, n) {
  return String(template).replaceAll("{page}", String(n));
}

/**
 * Move a run onto the page a click opened in a second tab, and close it.
 *
 * A new tab is empty at the moment it is created, so its address has to be
 * waited for rather than read. Everything here is best-effort: failing to adopt
 * leaves the run where it was, which is the behaviour before this existed, and
 * is better than throwing away a page of results over a tab that would not
 * settle.
 *
 * @param {number} tabId - the run's tab
 * @param {number} openedId - the tab the click opened
 * @returns {Promise<boolean>} whether the run's tab moved
 */
async function _adoptOpenedTab(tabId, openedId, runState = null, runId = null) {
  let url = "";
  for (let i = 0; i < 30 && !url; i++) {
    const tab = await chrome.tabs.get(openedId).catch(() => null);
    if (!tab) return false;
    const candidate = String(tab.pendingUrl || tab.url || "");
    if (candidate && !/^(about:|chrome:)/.test(candidate)) url = candidate;
    else await _sleep(100);
  }
  await chrome.tabs.remove(openedId).catch(() => {});
  if (!url) return false;
  logger.info(MODULE, "adopted-opened-tab", { host: _hostOf(url) });
  await _navigateTo(tabId, url, runState, runId, {
    what: "Paginate (page opened in a new tab)",
  });
  return true;
}

async function _executePaginate(
  tabId,
  config = {},
  runState = null,
  runId = null,
) {
  const selector = String(config.selector || "").trim();
  if (!selector) throw new Error("Paginate: no Next selector configured.");
  const settleMs =
    Number(config.settleMs) >= 0 ? Number(config.settleMs) : 1500;

  const probe = await _sendToPage(tabId, {
    type: "PAGINATE_PROBE",
    config: { selector },
  });
  if (!probe?.ok) throw new Error(probe?.error || "Paginate: probe failed");
  if (probe.result.exhausted) {
    return { paginated: false, exhausted: true, reason: probe.result.reason };
  }
  const before = probe.result.fingerprint;

  if (probe.result.newTab && probe.result.href) {
    // The Next link opens in a new tab. Clicking it would leave the run on the
    // page it was already on while the next one loaded somewhere nobody is
    // looking — the loop then re-scrapes the same rows until "max pages" runs
    // out. Following the href in this tab is what the user meant by "next
    // page", and it is the same request the click would have made.
    await _navigateTo(tabId, probe.result.href, runState, runId, {
      timeoutMs: config.timeoutMs,
      what: "Paginate (next page)",
    });
  } else {
    // A tab this one opens while we are clicking. A JavaScript paginator can
    // call window.open with no anchor to read, so the href check above cannot
    // see it coming; this catches it after the fact.
    let opened = null;
    const onCreated = (tab) => {
      if (tab.openerTabId === tabId && !opened) opened = tab;
    };
    chrome.tabs.onCreated?.addListener?.(onCreated);

    try {
      // Deliberately not _sendToPage: a lost reply here means the click
      // navigated, and re-sending it would turn a second page.
      await chrome.tabs.sendMessage(tabId, {
        type: "step:execute",
        payload: { type: "PAGINATE", config: { selector } },
      });
    } catch (err) {
      // The click took the content script with it, which is success. Anything
      // else is not.
      if (!_GONE.test(err.message)) throw err;
    } finally {
      chrome.tabs.onCreated?.removeListener?.(onCreated);
    }

    await _waitForTabLoad(tabId, NAV_TIMEOUT_MS);
    if (opened) await _adoptOpenedTab(tabId, opened.id, runState, runId);
  }
  if (settleMs > 0) await _sleep(settleMs);

  if (config.requireChange) {
    // For a paginator whose Next button is always present and always enabled —
    // a common single-page-app shape — an unchanged page is the only signal
    // that the pages have run out.
    const after = await _sendToPage(tabId, {
      type: "PAGINATE_PROBE",
      config: { selector },
    }).catch(() => null);
    if (after?.ok && after.result.fingerprint === before) {
      return {
        paginated: false,
        exhausted: true,
        reason: "the page did not change after clicking Next",
      };
    }
  }

  return { paginated: true, exhausted: false, reason: "" };
}

/**
 * Click, then wait for whatever the click was supposed to cause.
 *
 * Two problems, one function.
 *
 * The first is that "Load more" and "Next" do their work *after* the click
 * returns. Until now the only answer was a WAIT step with a guessed number of
 * milliseconds — too small on a slow day and the next step reads the old rows,
 * too large and every run pays for the worst case. `waitAfter` names the thing
 * to wait for instead of the time to wait.
 *
 * The second is that a click on a real link destroys the document that was
 * about to answer it. That is not an error, it is the intended outcome, so the
 * teardown is read as "it navigated" and the tab is given time to land rather
 * than the click being delivered a second time to the page that replaced it.
 *
 * @param {object} step  - a resolved CLICK step
 * @param {number} tabId
 * @param {string} runId
 */
async function _executeClick(step, tabId, runId) {
  const config = step.config ?? {};
  const waitAfter = String(config.waitAfter || "none");
  const timeoutMs =
    Number(config.waitTimeoutMs) > 0 ? Number(config.waitTimeoutMs) : 15000;

  // Ping-and-inject before the send, so that a teardown afterwards can only
  // mean the click navigated. Without it "there is no content script here"
  // and "the click took the page away" arrive as the same error, and a click
  // that never happened would be reported as a successful navigation.
  await _ensureInjected(tabId);

  let result = null;
  let navigated = false;
  try {
    let resp = await _sendToPage(tabId, step, { retryOnGone: false });

    // Same captcha question the generic path asks: a click that matched
    // nothing is as often a wall as a bad selector.
    if (
      resp?.ok &&
      _looksEmpty(resp.result) &&
      (await _pauseForCaptcha(runId, tabId, "CLICK"))
    ) {
      if (await _awaitResume(runId)) {
        resp = await _sendToPage(tabId, step, { retryOnGone: false });
      }
    }

    if (!resp?.ok) throw new Error(resp?.error || "CLICK failed");
    result = resp.result;
  } catch (err) {
    if (!_GONE.test(err.message)) throw err;
    navigated = true;
  }

  // A navigation is waited for whether or not one was asked for: the next step
  // running against a page halfway through being replaced is the failure this
  // avoids, and it is invisible when it happens.
  if (navigated || waitAfter === "load") {
    const loaded = await _waitForTabLoad(tabId, timeoutMs);
    if (!loaded) {
      _broadcastLog(
        "warn-log",
        `CLICK: the page was still loading after ${Math.round(timeoutMs / 1000)}s — continuing anyway.`,
        runId,
      );
    }
  }

  const passThrough = {
    inFrame: config.inFrame,
    frameUrl: config.frameUrl,
    timeout: timeoutMs,
  };

  if (waitAfter === "selector" || waitAfter === "selector-gone") {
    const selector = String(config.waitSelector || "").trim();
    if (!selector) {
      throw new Error(
        'CLICK: "wait for an element" needs a selector to wait for.',
      );
    }
    const resp = await _sendToPage(tabId, {
      type: "WAIT",
      config: {
        ...passThrough,
        mode: waitAfter === "selector" ? "selector-visible" : "selector-gone",
        selector,
      },
    });
    if (!resp?.ok) {
      throw new Error(
        resp?.error ||
          `CLICK: "${selector}" never ${waitAfter === "selector" ? "appeared" : "went away"} after the click.`,
      );
    }
  } else if (waitAfter === "settle") {
    const resp = await _sendToPage(tabId, {
      type: "WAIT",
      config: {
        ...passThrough,
        mode: "DOM-stable",
        quietMs: Number(config.quietMs) > 0 ? Number(config.quietMs) : 500,
      },
    });
    if (!resp?.ok) {
      throw new Error(
        resp?.error ||
          "CLICK: the page never stopped changing after the click.",
      );
    }
  }

  if (navigated) {
    _broadcastLog("info-log", "CLICK: the click navigated the tab.", runId);
  }
  return { ...(result ?? {}), navigated };
}

/**
 * Execute one already-resolved step.
 *
 * This chain used to exist twice — once in _executeStepList for loop and branch
 * bodies, once inline in _executePipeline for top-level steps — and the copies
 * had already drifted: only the nested one flushed the row buffer before an
 * EXPORT. Adding the B-03 origin check meant patching four call sites instead
 * of two, which is what prompted merging them.
 *
 * @param {object} step     - resolved step (templates already applied)
 * @param {number} tabId
 * @param {string} runId
 * @param {object} ctx      - mutable run context; EXTRACT and API results land here
 */
async function _dispatchStep(step, tabId, runId, ctx) {
  const runState = _runStates.get(runId);

  switch (step.type) {
    case "WEBSITE":
    case "NAVIGATE": {
      await _navigateTo(tabId, step.config.url, runState, runId, {
        wait: step.config.wait !== false,
        timeoutMs: step.config.timeoutMs,
        what: step.type,
      });
      return;
    }

    case "WAIT": {
      const waitMode = step.config.mode || "fixed";
      if (waitMode === "fixed") {
        await _sleep(Number(step.config.ms) || 1000);
        return;
      }
      // Every other mode needs to watch the DOM, so it belongs to the page.
      // The content script has implemented them since the beginning; nothing
      // had ever sent them there, which made them unreachable.
      await _ensureInjected(tabId);
      const waitResp = await _sendToPage(tabId, step);
      if (!waitResp?.ok) {
        throw new Error(waitResp?.error || `WAIT (${waitMode}) failed`);
      }
      return;
    }

    case "CLICK":
      await _executeClick(step, tabId, runId);
      return;

    case "SCREENSHOT":
      await _captureScreenshot(tabId, step.config, runId);
      return;

    case "API": {
      _assertOriginAllowed(step.config.url, runState, "API");
      const apiResult = await _executeApiStep(step.config, ctx, {
        runId,
        runState,
      });
      const storeAs = String(step.config.storeAs || "api").trim() || "api";
      ctx[storeAs] = apiResult;
      ctx.api = apiResult;
      if (
        step.config.exposeBodyAsExtracted === true &&
        apiResult.body &&
        typeof apiResult.body === "object" &&
        !Array.isArray(apiResult.body)
      ) {
        Object.assign(ctx.extracted, apiResult.body);
      }
      // rowsPath rows land in the run's results the same way EXTRACT's and
      // PAGE_DATA's do — one path into the buffer, whether the response came
      // from a single call or was walked across several pages of pagination.
      if (Array.isArray(apiResult.rows) && apiResult.rows.length > 0) {
        await _collectRows(runState, runId, apiResult.rows);
      }
      _broadcastLog(
        "info-log",
        apiResult.paginated
          ? `API ${apiResult.method} ${apiResult.url} → ${apiResult.status} ` +
              `(${apiResult.pages} page${apiResult.pages === 1 ? "" : "s"}, ` +
              `${apiResult.rows.length} row${apiResult.rows.length === 1 ? "" : "s"}` +
              `${apiResult.stopReason ? ", " + apiResult.stopReason : ""}).`
          : `API ${apiResult.method} ${apiResult.url} → ${apiResult.status}`,
        runId,
      );
      return;
    }

    case "DEDUPE":
      await _executeDedupe(step, runId);
      return;

    case "SET_HEADERS":
      await _executeSetHeaders(step, tabId, runId);
      return;

    case "SESSION":
      await _executeSession(step, tabId, runId);
      return;

    case "DOWNLOAD_FILE":
      await _executeDownloadFile(step, tabId, runId, ctx);
      return;

    case "API_SNIFFER":
      // Capture is set up when the run starts; nothing to do per step.
      await _sleep(50);
      return;

    case "PDF_EXTRACTION": {
      const pdfResult = await _executePdfExtraction(step.config, runId);
      const storeAs = Object.keys(pdfResult)[0] || "pdf_text";
      ctx[storeAs] = pdfResult[storeAs];
      return;
    }

    case "UPLOAD_ACTIVITY":
      await _executeUploadActivityStep(step.config, tabId, runId);
      return;

    case "AUTO_EXTRACT": {
      const row = await _executeAutoExtract(step.config, tabId, runId, ctx);
      await _collectRows(runState, runId, [row]);
      Object.assign(ctx.extracted, row);
      _broadcastLog(
        "info-log",
        `AUTO_EXTRACT: product row saved (confidence: ${row._confidence}%).`,
        runId,
      );
      return;
    }

    case "EXPORT":
      // Flush buffered rows first, or the export misses anything still in
      // memory. The top-level copy of this chain did not do it.
      await finalizeBuffer(runId).catch(() => {});
      initBuffer(runId);
      await _doExport(runId, step.config);
      return;

    case "PAGE_JSON": {
      const resp = await _sendToPage(tabId, step);
      if (!resp?.ok) throw new Error(resp?.error || "PAGE_JSON failed");
      const page = resp.result;
      ctx[String(step.config.storeAs || "pageJson").trim() || "pageJson"] =
        page;

      if (!page.found) {
        _broadcastLog("warn-log", `PAGE_JSON: ${page.reason}`, runId);
        return;
      }
      if (page.truncated) {
        _broadcastLog("warn-log", `PAGE_JSON: ${page.reason}`, runId);
      }

      // One row, holding the page. Rows are what the exporters understand, so
      // this is what makes the JSON downloadable at all — and JSON is the
      // format to pick, since a tree does not fit a spreadsheet cell.
      const row = {
        url: page.url,
        title: page.title,
        mode: page.mode,
        nodes: page.nodes,
        content: page.tree ?? page.text ?? page.rows,
      };
      await _collectRows(runState, runId, [row]);
      _broadcastLog(
        "info-log",
        `PAGE_JSON: read ${page.nodes} elements as ${page.mode}.`,
        runId,
      );
      return;
    }

    case "PAGE_DATA": {
      const resp = await _sendToPage(tabId, step);
      if (!resp?.ok) throw new Error(resp?.error || "PAGE_DATA failed");
      const data = resp.result;
      const storeAs = String(step.config.storeAs || "pageData").trim();
      ctx[storeAs || "pageData"] = data;

      for (const warning of data.warnings ?? []) {
        _broadcastLog("warn-log", `PAGE_DATA: ${warning}`, runId);
      }

      if (!data.found) {
        // Not an error: a pipeline reading many pages should not stop because
        // one of them carries no markup. But it must not be silent either —
        // an empty export with no explanation is the thing this step exists
        // to replace.
        _broadcastLog("warn-log", `PAGE_DATA: ${data.reason}`, runId);
        return;
      }

      const rows = data.records ?? [];
      await _collectRows(runState, runId, rows);
      if (rows.length > 0) {
        Object.assign(ctx.extracted, rows[rows.length - 1]);
      }
      _broadcastLog(
        "info-log",
        rows.length
          ? `PAGE_DATA: read ${rows.length} record${rows.length === 1 ? "" : "s"} from ${data.sources.join(" + ")}.`
          : `PAGE_DATA: no records, but ${Object.keys(data.meta ?? {}).length} page tags read.`,
        runId,
      );
      return;
    }

    case "ASSERT": {
      const resp = await _sendToPage(tabId, step);
      if (!resp?.ok) {
        throw new Error(resp?.error || "ASSERT could not read the page");
      }
      const assertion = step.config.assertion || "exists";
      const failure = evaluateAssertion(assertion, resp.result, step.config);
      if (failure) {
        // Thrown, so the run stops here with the reason in the log. That is the
        // whole point of the step: a page whose shape has changed produces
        // empty columns rather than an error, and the export looks like a
        // successful run of nothing.
        throw new Error(`ASSERT (${assertion}) failed: ${failure}.`);
      }
      _broadcastLog(
        "info-log",
        `ASSERT (${assertion}) held: ${resp.result.count} match${resp.result.count === 1 ? "" : "es"} for "${step.config.selector}".`,
        runId,
      );
      return;
    }

    case "SOLVE_CAPTCHA":
      await _executeSolveCaptcha(step, tabId, runId);
      return;

    case "PAGINATE": {
      const paged = await _executePaginate(tabId, step.config, runState, runId);
      if (paged.exhausted) {
        _broadcastLog("info-log", `Paginate: ${paged.reason}`, runId);
      }
      return;
    }

    case "LOOP":
      await _executeLoop(step, tabId, runId, ctx);
      return;

    case "IF_ELSE":
      await _executeIfElse(step, tabId, runId, ctx);
      return;

    default: {
      let resp = await _sendToPage(tabId, step);

      // Being blocked does not look like an error from here. EXTRACT does not
      // fail on a miss — by design, so a genuinely empty column is not a
      // crash (B-08) — so a captcha wall produced a run of empty rows and said
      // nothing. An empty result from a step that should have found something
      // is the moment to ask why.
      if (
        resp?.ok &&
        CAPTCHA_SUSPECT_STEPS.has(step.type) &&
        _looksEmpty(resp.result) &&
        (await _pauseForCaptcha(runId, tabId, step.type))
      ) {
        if (await _awaitResume(runId)) {
          resp = await _sendToPage(tabId, step);
        }
      }

      if (!resp?.ok) throw new Error(resp?.error || "Step failed");

      // A skipped honeypot has to be said out loud. The field was listed and
      // was not filled, and a form that quietly does less than it was told to
      // is exactly the class of surprise this tool exists to avoid.
      for (const trap of resp.result?.skipped ?? []) {
        _broadcastLog(
          "warn-log",
          `${step.type} skipped ${trap.selector}: ${trap.reason}. ` +
            "A field nobody can see is a bot trap — filling it is what flags the submission.",
          runId,
        );
      }

      if (step.type === "EXTRACT" && Array.isArray(resp.result)) {
        const rows = await _transformRows(resp.result, step.config, tabId);
        const { kept, dropped } = await _collectRows(runState, runId, rows);
        _broadcastLog(
          "info-log",
          `Extracted ${kept.length} rows (total: ${runState.results.length})` +
            (dropped ? `, ${dropped} already seen.` : "."),
          runId,
        );
        // Without this the count only moves on the next step's status message,
        // so the last EXTRACT of a run never showed its rows at all.
        chrome.runtime
          .sendMessage({
            type: "pipeline:status",
            payload: {
              state: "running",
              rows: runState.results.length,
              runId,
              tabId: runState.tabId,
            },
          })
          .catch(() => {});
        // So later steps can reference {{extracted.fieldName}}
        if (rows.length > 0) {
          Object.assign(ctx.extracted, rows[rows.length - 1]);
        }
      }
    }
  }
}

/**
 * Step types that touch the page or the network, and so should be paced.
 *
 * WAIT, EXPORT and the two containers are excluded: WAIT is already a delay,
 * EXPORT is local, and LOOP and IF_ELSE recurse into this same loop, so their
 * children are paced individually and charging the container too would
 * double-count.
 */
const RATE_LIMITED_STEPS = new Set(
  ALL_STEP_TYPES.filter(
    (t) => !["WAIT", "EXPORT", "LOOP", "IF_ELSE"].includes(t),
  ),
);

/** The bucket key for a run: its target host, or one shared default. */
function _runDomain(runState) {
  try {
    return new URL(runState?.targetOrigin ?? "").hostname || "default";
  } catch {
    return "default";
  }
}

/**
 * Run a list of steps in order.
 *
 * @param {object[]} steps
 * @param {number} tabId
 * @param {string} runId
 * @param {object} ctx
 * @param {{ total: number, count: number }} [progress] - present only for the
 *   top-level list. Its presence also selects the error policy: at the top
 *   level a non-optional failure stops the run, whereas nested it propagates so
 *   the enclosing LOOP can apply its own onFail setting.
 */
/**
 * Steps whose failure is most often a captcha rather than a bad selector.
 * Checking after every step would cost an injection per step for a condition
 * that is rare; checking when a page step cannot find what it wants is the
 * moment the answer is worth having.
 */
const CAPTCHA_SUSPECT_STEPS = new Set([
  "CLICK",
  "FILL",
  "EXTRACT",
  "SELECT",
  "HOVER",
  "PAGINATE",
  "AUTO_EXTRACT",
  "PAGE_DATA",
]);

const CAPTCHA_FILE = "content/captcha-check.js";

/**
 * Is a captcha standing in the way right now?
 *
 * Injected on demand rather than bundled into CONTENT_FILES: it is 4 KB that
 * most runs never need, and the capability review found the injection payload
 * to be the one load cost worth cutting.
 *
 * @returns {Promise<null|{blocking:boolean, type:string, sitekey:?string,
 *   where:string, reason:string}>}
 */
async function _checkCaptcha(tabId) {
  if (!tabId) return null;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [CAPTCHA_FILE],
    });
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => globalThis.__vqCheckCaptcha?.() ?? null,
    });
    if (!result) return null;
    // The page reports what it saw; the tier is decided here, where the parser
    // that would have to answer a written question actually lives.
    return { ...result, tier: tierOf(result) };
  } catch {
    // A page that refuses injection cannot be checked, and saying nothing is
    // better than claiming there is no captcha.
    return null;
  }
}

/**
 * Stop on a captcha instead of scraping past it.
 *
 * Paused, not failed: the person is right there and can solve it, and Resume
 * already exists. A run that fails here throws away the rows it has and makes
 * the user start again for a thirty-second obstacle.
 *
 * Returns true when the run was paused, so the caller can retry the step.
 *
 * `known` is the check a caller has already paid for — SOLVE_CAPTCHA has just
 * classified the page and would otherwise inject the checker a second time to
 * be told the same thing.
 */
async function _pauseForCaptcha(runId, tabId, stepType, known = null) {
  const runState = _runStates.get(runId);
  if (!runState?.active || runState.paused) return false;

  const found = known ?? (await _checkCaptcha(tabId));
  if (!found?.blocking) return false;

  runState.paused = true;
  runState.pausedForCaptcha = true;
  const label =
    {
      recaptcha: "reCAPTCHA",
      hcaptcha: "hCaptcha",
      turnstile: "Cloudflare Turnstile",
      cloudflare: "Cloudflare challenge",
      image: "image captcha",
    }[found.type] ?? found.type;
  const kept = runState.results.length;
  _broadcastLog(
    "warn-log",
    `Paused: ${label} is in the way (${found.where}), so ${stepType} found nothing. ` +
      `Solve it in the tab, then press Resume` +
      (kept
        ? ` — the ${kept} row${kept === 1 ? "" : "s"} collected so far are kept.`
        : "."),
    runId,
  );
  chrome.runtime
    .sendMessage({
      type: "pipeline:captcha",
      payload: {
        runId,
        tabId: runState.tabId,
        type: found.type,
        sitekey: found.sitekey,
        where: found.where,
      },
    })
    .catch(() => {});
  return true;
}

/**
 * Ask a configured model to read a captcha image.
 *
 * The last resort, and only ever reached after the free path has declined. It
 * is the user's own key and the user's own money — or their own machine, if
 * they pointed the gateway at a local model — so this spends neither without
 * being asked twice: the step exists because somebody added it, the run
 * carries the authorisation, the domain carries the attestation, and a
 * provider had to be configured in Settings.
 *
 * Only image captchas. A reCAPTCHA or hCaptcha widget is not a picture with an
 * answer in it — it is a behavioural check whose token comes from a solving
 * service, and handing its screenshot to a vision model spends tokens to be
 * told nothing. Refusing is the honest answer there.
 *
 * @returns {Promise<{answer: string, how: string}|{error: string}|null>} null
 *   when no provider is configured, which is not a failure — it is the
 *   default state of a tool that costs nothing to use.
 */
async function _askGatewayForCaptcha(tabId, found, runId) {
  // One reader for the storage key, the gateway:<provider> naming convention
  // and the "a local server needs no key" exception — this used to be spelled
  // out here and again in the extraction layer, which is two chances for the
  // free path to work in one place and be refused in the other.
  const config = await readGatewayConfig();
  if (!config) return null;
  const apiKey = config.apiKey;

  let grabbed = null;
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => globalThis.__vqGrabCaptchaImage?.() ?? null,
    });
    grabbed = result;
  } catch {
    return { error: "the page would not let the image be read" };
  }
  if (!grabbed) return { error: "no captcha image was found on the page" };
  if (grabbed.error) return { error: grabbed.error };

  _broadcastLog(
    "info-log",
    `SOLVE_CAPTCHA is asking your ${config.provider} model to read the image (${grabbed.width}×${grabbed.height}).`,
    runId,
  );
  const said = await askVision(
    {
      // Written to make a wrong answer less likely to look like a right one:
      // no explanation to parse out, and an explicit way to say "I cannot".
      prompt:
        "This image is a captcha from a web form. Reply with only the " +
        "characters it shows, exactly as they appear, with no spaces, " +
        "quotes, punctuation or explanation. If you cannot read it with " +
        "confidence, reply with the single word UNREADABLE.",
      image: {
        data: String(grabbed.dataUrl).split(",")[1] ?? "",
        mediaType: grabbed.mediaType,
      },
    },
    {
      provider: config.provider,
      apiKey,
      model: config.model,
      baseUrl: config.baseUrl,
    },
  );
  if (!said?.ok) {
    return { error: said?.error || "the model could not be reached" };
  }

  // Trusted no further than a local parse is. A model that pads its answer, or
  // answers a different question, produces a failed attempt against a site
  // that usually allows three — so anything that is not a short, clean token
  // is treated as no answer at all.
  const text = String(said.text ?? "")
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "");
  if (!text || /unreadable/i.test(text)) {
    return { error: "the model said it could not read the image" };
  }
  if (text.length > 12 || /\s/.test(text)) {
    return {
      error: `the model answered with something that is not a captcha code: "${text.slice(0, 40)}"`,
    };
  }
  return {
    answer: text,
    how: `read by your ${config.provider} model`,
    answerSelector: grabbed.answerSelector,
  };
}

// ── Proxies, during a run ────────────────────────────────────────────────────
//
// The pool has always parsed, health-checked, deduped and rotated, and no run
// has ever consulted it (A-05). Wiring it up is less about rotation than about
// one fact that shapes everything here: `chrome.proxy.settings.set` is
// **browser-wide**. There is no per-tab proxy in an extension, so a run that
// takes a proxy takes the user's whole browser with it — their other tabs,
// their mail, their bank. That is why this is off unless asked for, says so in
// the log when it starts, and is cleared on every way a run can end, including
// the ones nobody plans for.

/** Set while a run holds the browser's proxy setting, so it can be given back. */
const STORAGE_PROXY_HELD_KEY = "vq_proxy_held_v1";

/**
 * Take a proxy for this run, if it asked for one and the pool has a live entry.
 *
 * Returns quietly when proxying is off, which is the ordinary case: a tool that
 * silently routed traffic somewhere would be a worse failure than one that does
 * nothing.
 */
async function _startRunProxy(runState) {
  if (!runState?.useProxy) return;
  const entry = selectProxy({
    domain: _hostOf(runState.targetOrigin),
    targetCountry: getTargetCountry(),
  });
  if (!entry) {
    _broadcastLog(
      "warn-log",
      "Proxy rotation is on, but no proxy in the pool is alive — the run is " +
        "going direct. Test the pool in Settings.",
      runState.runId,
    );
    return;
  }
  try {
    await _applyProxy(entry);
  } catch (err) {
    _broadcastLog(
      "warn-log",
      `Could not apply a proxy (${err.message}) — the run is going direct.`,
      runState.runId,
    );
    return;
  }
  runState.proxyHeld = true;
  // Which one, not just that there is one. Failure reporting needs a name,
  // and `proxyHeld` being a boolean is why nothing could report a failure.
  runState.proxyEntry = { host: entry.host, port: entry.port };
  // Recorded outside the run state as well: a service worker that is torn down
  // mid-run loses `_runStates`, and the browser would be left proxied with
  // nothing remembering to undo it. Bootstrap reads this.
  await chrome.storage.local
    .set({
      [STORAGE_PROXY_HELD_KEY]: { runId: runState.runId, at: Date.now() },
    })
    .catch(() => {});
  // Never the credentials, and never at info level as a passing detail: this
  // is the whole browser's traffic, which the person should know about.
  _broadcastLog(
    "warn-log",
    `This run is routing through ${entry.host}:${entry.port} (${entry.type}). ` +
      "Chrome has one proxy setting for the whole browser, so every tab goes " +
      "through it until the run ends.",
    runState.runId,
  );
}

/**
 * Move to the next proxy, if the run asked to rotate on a cadence.
 *
 * Counted in navigations rather than in steps: a page load is what a site sees
 * as a visit, and "every 5 steps" would rotate mid-page, which changes the
 * proxy between a click and the response it was waiting for.
 */
async function _maybeRotateProxy(runState) {
  if (!runState?.proxyHeld) return;
  const every = Number(runState.proxyRotateEvery);
  if (!Number.isFinite(every) || every < 1) return;
  runState.proxyNavCount = (runState.proxyNavCount ?? 0) + 1;
  if (runState.proxyNavCount % every !== 0) return;
  const next = await rotateProxy({
    domain: _hostOf(runState.targetOrigin),
  }).catch(() => null);
  if (next) {
    runState.proxyEntry = { host: next.host, port: next.port };
    _broadcastLog(
      "info-log",
      `Rotated to ${next.host}:${next.port} after ${runState.proxyNavCount} page loads.`,
      runState.runId,
    );
  }
}

/**
 * Give the browser back its own connection.
 *
 * Called on every exit from a run — completed, stopped, crashed — and on
 * bootstrap for a run that was cut off before it could get here.
 */
async function _endRunProxy(runState) {
  const held = runState?.proxyHeld;
  if (runState) runState.proxyHeld = false;
  await chrome.storage.local.remove(STORAGE_PROXY_HELD_KEY).catch(() => {});
  if (!held) return;
  try {
    await clearProxy();
    _broadcastLog(
      "info-log",
      "Proxy released — the browser is back on its own connection.",
      runState?.runId,
    );
  } catch (err) {
    // Worth shouting about: the browser is still proxied and the run that
    // asked for it is over.
    _broadcastLog(
      "error-log",
      `Could not release the proxy (${err.message}). Clear it in Settings — ` +
        "every tab is still going through it.",
      runState?.runId,
    );
  }
}

// ── Solving, and the two things it needs before it will ──────────────────────

/**
 * Domains the user has personally attested to.
 *
 * Answering a challenge is the one thing in this tool that is a statement about
 * a relationship with a site rather than a technique, so it is not something a
 * checkbox on a run can carry: a run payload is rebuilt every time Run is
 * pressed, and a flag there says only "today I meant it". The attestation says
 * "this domain is mine, or I have permission on it, or the account is my own",
 * it is given once per domain, and it survives the run — the same shape as the
 * pipeline library and the storage file library, in chrome.storage.local under
 * an `vq_*_v1` key.
 *
 * It is deliberately separate from `captchaAuthorized`: the flag is per run and
 * the attestation is per domain, and neither alone is a decision to solve
 * anything.
 */
const CAPTCHA_ATTEST_KEY = "vq_captcha_attest_v1";

/** @param {string} url @returns {string} the domain, or "" if there is none */
function _hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/** @returns {Promise<Record<string, {at: number}>>} */
async function _captchaAttestations() {
  const stored = await chrome.storage.local.get(CAPTCHA_ATTEST_KEY);
  const map = stored?.[CAPTCHA_ATTEST_KEY];
  return map && typeof map === "object" ? map : {};
}

/** @param {string} host @returns {Promise<boolean>} */
async function _captchaAttested(host) {
  if (!host) return false;
  return Boolean((await _captchaAttestations())[host]);
}

_registerHandler("captcha:attest", async (payload) => {
  const host = _hostOf(payload?.origin) || String(payload?.host ?? "");
  if (!host) throw new Error("No domain to attest for.");
  const map = await _captchaAttestations();
  if (payload?.attested) map[host] = { at: Date.now() };
  else delete map[host];
  await chrome.storage.local.set({ [CAPTCHA_ATTEST_KEY]: map });
  logger.info(MODULE, "captcha-attest", {
    host,
    attested: !!payload?.attested,
  });
  return { host, attested: Boolean(payload?.attested) };
});

_registerHandler("captcha:attest-get", async (payload) => {
  const host = _hostOf(payload?.origin) || String(payload?.host ?? "");
  return { host, attested: await _captchaAttested(host) };
});

/**
 * SOLVE_CAPTCHA — answer a challenge the user asked to have answered.
 *
 * Every gate here is a refusal to act rather than a check that can be satisfied
 * by trying harder, so they are all up front and they all explain themselves.
 * In order: the step exists only because somebody added it; the run has to
 * carry the authorisation flag; the domain has to carry the attestation; and
 * the challenge has to be one nothing is spent on. What remains is the local
 * solver, and when that has no confident answer this ends exactly where the
 * tool ended before the step existed — paused, with the challenge named, and
 * the person in front of the tab.
 */
async function _executeSolveCaptcha(step, tabId, runId) {
  const runState = _runStates.get(runId);

  // Both gates are read before either is reported. They have different
  // lifetimes on purpose — the flag is per run, the attestation is per domain —
  // and refusing on the first one found missing meant a user who had given
  // neither satisfied one, pressed Run, and was told about the other. One
  // refusal, naming the state of both.
  let host = "";
  try {
    host = _hostOf((await chrome.tabs.get(tabId))?.url);
  } catch {
    host = _hostOf(runState?.targetOrigin);
  }
  const authorised = Boolean(runState?.captchaAuthorized);
  const attested = await _captchaAttested(host);
  if (!authorised || !attested) {
    const where = host || "this domain";
    throw new ExplainedRefusal(
      "SOLVE_CAPTCHA did not run. Answering a challenge needs two things, and " +
        `${!authorised && !attested ? "neither is in place" : "one of them is missing"}:\n` +
        (authorised
          ? "✓ This run is authorised to answer challenges.\n"
          : "✗ This run is not authorised to answer challenges — turn on " +
            "“Answer captchas” in Settings, which applies for the run.\n") +
        (attested
          ? `✓ You have attested for ${where}.`
          : `✗ You have not attested for ${where} — open the step and confirm ` +
            "that you own the site, have permission to automate it, or are " +
            "signing in to your own account there. That is given once per " +
            "domain and is not something the tool can decide for you."),
    );
  }

  const found = await _checkCaptcha(tabId);
  if (!found?.present) {
    _broadcastLog(
      "info-log",
      "SOLVE_CAPTCHA: no challenge on this page, so there was nothing to do.",
      runId,
    );
    return { solved: false, reason: "no captcha present" };
  }

  if (found.tier === "not-solvable") {
    throw new ExplainedRefusal(
      `SOLVE_CAPTCHA cannot answer a ${found.type} interstitial (${found.where}): ${found.reason}. ` +
        "It lifts on what the browser looks like, not on anything typed into it, " +
        "so no solver — free or paid — has an answer to give. " +
        "Open the page yourself and resume the run once it lets you through.",
    );
  }

  const answer =
    found.tier === "solvable-locally"
      ? solveLocalChallenge(found.question)
      : null;

  // Free has declined. An image captcha is the one shape a vision model can
  // actually read, and only if the user configured one — their key, their
  // money, or their own machine. Everything else falls through to the pause.
  let viaGateway = null;
  if (!answer && found.type === "image") {
    viaGateway = await _askGatewayForCaptcha(tabId, found, runId);
    if (viaGateway?.error) {
      _broadcastLog(
        "warn-log",
        `SOLVE_CAPTCHA asked your model and got no usable answer: ${viaGateway.error}.`,
        runId,
      );
      viaGateway = null;
    }
  }
  const solved = answer ?? viaGateway;

  if (!solved) {
    // Either a widget, which needs a service this build deliberately has none
    // of, or a written question the solver would only be guessing at. Both end
    // the same way, and it is the way the tool already behaved (K-02).
    // Keyed on what the page is, not on its tier. A written question the
    // parser could not answer is tiered `needs-a-service` precisely *because*
    // it could not answer it, so keying on the tier gave the generic "no free
    // way" line for the one case where we can say something more useful: we
    // read your question and would only be guessing.
    _broadcastLog(
      "warn-log",
      found.type === "question"
        ? `SOLVE_CAPTCHA read the question but is not certain of the answer, and a wrong answer is worse than a pause: "${found.question}".`
        : `SOLVE_CAPTCHA has no free way to answer a ${found.type} challenge (${found.tier}).`,
      runId,
    );
    if (await _pauseForCaptcha(runId, tabId, "SOLVE_CAPTCHA", found)) {
      await _awaitResume(runId);
    }
    return { solved: false, reason: "no local solver applies" };
  }

  const fill = await _sendToPage(tabId, {
    type: "FILL",
    config: {
      mode: "single",
      // The image path finds its own answer box, beside the picture; a written
      // question's box came back with the question.
      selector: solved.answerSelector || found.answerSelector,
      text: solved.answer,
      delayMs: 60,
    },
  });
  if (!fill?.ok) {
    throw new Error(
      fill?.error || "SOLVE_CAPTCHA could not type into the answer field",
    );
  }
  // The provenance is not decoration: "solved on this machine" is the whole
  // promise of the free tier, and "your model" is the line that spent the
  // user's money. Whichever answered has to be the part they can see.
  const provenance = answer
    ? "solved on this machine, at no cost"
    : "answered by the model you configured";
  _broadcastLog(
    "info-log",
    found.question
      ? `SOLVE_CAPTCHA answered "${found.question}" with "${solved.answer}" (${solved.how}) — ${provenance}.`
      : `SOLVE_CAPTCHA answered the image captcha with "${solved.answer}" (${solved.how}) — ${provenance}.`,
    runId,
  );

  if (step.config?.submitSelector) {
    const submit = await _sendToPage(tabId, {
      type: "CLICK",
      config: { selector: step.config.submitSelector },
    });
    if (!submit?.ok) {
      throw new Error(submit?.error || "SOLVE_CAPTCHA could not submit");
    }
  }
  return { solved: true, answer: answer.answer, how: answer.how };
}

/** Hold until the user resumes, or the run ends. */
async function _awaitResume(runId) {
  const rs = _runStates.get(runId);
  while (rs?.paused && rs?.active) await _sleep(500);
  return Boolean(rs?.active);
}

/**
 * Run one step, trying again when it fails and the step asked for retries.
 *
 * A retry is a fresh attempt at the same step, so it queues behind the rate
 * limiter exactly as the first attempt did — "try five times" must not be five
 * requests the pacing never saw. The wait and the attempt both stop the moment
 * the run is stopped, and a pause holds the next attempt rather than skipping
 * it.
 *
 * @returns {Promise<?Error>} the last failure, or null when an attempt worked
 */
async function _dispatchWithRetries(step, tabId, runId, ctx) {
  const runState = _runStates.get(runId);
  const tries = retryCount(step.config);
  const delayMs = retryDelayMs(step.config);
  let lastError = null;

  for (let attempt = 0; attempt <= tries; attempt++) {
    if (attempt > 0) {
      _broadcastLog(
        "warn-log",
        `[${step.type}] ${lastError.message} — retry ${attempt} of ${tries} in ${delayMs}ms.`,
        runId,
      );
      // Slept in slices rather than in one go, so Stop is answered inside a
      // long delay instead of after it.
      const until = Date.now() + delayMs;
      while (runState?.active && Date.now() < until) {
        await _sleep(Math.min(200, until - Date.now()));
      }
      while (runState?.paused && runState?.active) await _sleep(500);
      if (!runState?.active) break;
      if (RATE_LIMITED_STEPS.has(step.type)) {
        await acquire(_runDomain(runState));
      }
    }

    try {
      await _dispatchStep(step, tabId, runId, ctx);
      return null;
    } catch (err) {
      lastError = err;
    }
  }

  return lastError;
}

async function _executeSteps(steps, tabId, runId, ctx, progress = null) {
  const runState = _runStates.get(runId);

  for (const step of steps) {
    if (!runState || !runState.active) break;

    // Hold here while paused. The old _executePipeline loop did this and the
    // merge in B-27 dropped it, so pause silently stopped working — it lives
    // here now, which also means it applies inside loops and branches for the
    // first time.
    while (runState.paused && runState.active) {
      await _sleep(500);
    }
    if (!runState.active) break;

    const resolvedStep = _resolveConfig(step, ctx);

    // Pace the run. Ethics gate 3 warns about request volume and nothing
    // enforced it — rate-limiter.js was imported for two form-fill handlers
    // that are themselves unreachable (audit F-09), while the emitted Python
    // told the reader "MIN_DELAY_MS = 800  # Floor enforced by Verquill
    // ethics engine", which was not true of the extension. It is now.
    if (RATE_LIMITED_STEPS.has(resolvedStep.type)) {
      await acquire(_runDomain(runState));
    }

    chrome.runtime
      .sendMessage({
        type: "pipeline:status",
        payload: {
          state: "running",
          currentStepId: step.id,
          progress: progress
            ? { current: progress.count, total: progress.total }
            : {},
          // Rows collected so far. The panel's "Processed" card used to show
          // progress.current, which counts steps — next to a Download Data
          // button, so it read as a row count and was not one (E-04).
          rows: runState?.results.length ?? 0,
          runId,
          tabId: runState?.tabId,
        },
      })
      .catch(() => {});

    const err = await _dispatchWithRetries(resolvedStep, tabId, runId, ctx);
    if (err) {
      // "Not found" on a page step is what being blocked looks like from here.
      // Ask once, and if a captcha is in the way pause and retry the step
      // rather than reporting a selector problem that is not one.
      if (
        CAPTCHA_SUSPECT_STEPS.has(resolvedStep.type) &&
        (await _pauseForCaptcha(runId, tabId, resolvedStep.type))
      ) {
        while (runState.paused && runState.active) {
          await _sleep(500);
        }
        if (!runState.active) break;
        let recovered = false;
        try {
          await _dispatchStep(resolvedStep, tabId, runId, ctx);
          recovered = true;
        } catch {
          // Still failing after the pause — report it normally, with the
          // original error.
        }
        // Not `continue`: the progress counter and cursor are updated at the
        // bottom of this loop, and skipping them would leave a resumed run
        // repeating the step it just completed.
        if (recovered) {
          if (progress) {
            progress.count += 1;
            await saveCursor({
              runId,
              rowIndex: progress.count,
              stepIndex: progress.count,
            }).catch(() => {});
          }
          continue;
        }
      }

      const optional = Boolean(resolvedStep.config?.optional);
      _broadcastLog(
        optional ? "warn-log" : "error-log",
        `[${resolvedStep.type}] ${err.message}${optional ? " (optional, skipping)" : ""}`,
        runId,
      );

      if (!optional) {
        if (!progress) throw err; // nested: the LOOP decides what to do
        runState.active = false;
        break;
      }
    }

    if (progress) {
      progress.count += 1;
      await saveCursor({
        runId,
        rowIndex: progress.count,
        stepIndex: progress.count,
      }).catch(() => {});
    }
  }
}

/** Loop and branch bodies. */
function _executeStepList(steps, tabId, runId, ctx = {}) {
  // A child list gets its own `extracted` layer so a nested EXTRACT does not
  // leak back into the parent's context.
  return _executeSteps(
    steps,
    tabId,
    runId,
    { ...ctx, extracted: { ...(ctx.extracted || {}) } },
    null,
  );
}

// ── Background Execution Orchestrator ─────────────────────────────────────────
async function _executePipeline(runId, pipeline, targetTabId) {
  const progress = { count: 0, total: pipeline.steps.length };
  const runtimeCtx = { extracted: {} };
  initBuffer(runId);

  try {
    await _executeSteps(
      pipeline.steps,
      targetTabId,
      runId,
      runtimeCtx,
      progress,
    );
  } catch (err) {
    // _executeSteps handles per-step failures at the top level; anything
    // reaching here is the orchestration itself failing.
    logger.error(MODULE, "pipeline-crash", { runId, error: err.message });
    _broadcastLog("error-log", `Pipeline stopped: ${err.message}`, runId);
    const rs = _runStates.get(runId);
    if (rs) rs.active = false;
  }

  await finalizeBuffer(runId).catch(() => {});
  await _disableSniffer(runId);
  await _endRunProxy(_runStates.get(runId));
  await clearHeaderRules(runId);
  await _saveDedupeKeys(_runStates.get(runId));

  const endRunState = _runStates.get(runId);
  const stateStr = endRunState?.active ? "completed" : "stopped";

  chrome.runtime
    .sendMessage({
      type: "pipeline:status",
      payload: {
        state: stateStr,
        currentStepId: null,
        progress: { current: progress.count, total: progress.total },
        runId,
      },
    })
    .catch(() => {});

  // A finished run is not resumable. markRunCompleted was exported and called
  // from nowhere, so cursors accumulated forever and every completed run kept
  // showing up in the resume banner (audit B-26). A run the user stopped keeps
  // its cursor, because its rows are still worth recovering.
  if (stateStr === "completed") {
    await markRunCompleted(runId).catch(() => {});
  }

  // Keep what the run captured. Rows survive in IndexedDB; screenshots and
  // sniffed requests lived only on the run state, so deleting it threw them
  // away at the exact moment the user goes looking for them — which is why
  // the sniffer appeared to capture nothing when it had captured plenty.
  _keepCaptures(runId, _runStates.get(runId));
  _runStates.delete(runId);
  if (_runStates.size === 0) {
    _stopHeartbeat();
  }
}

// The picker is driven straight from the panel with chrome.tabs.sendMessage, so
// it needs its own way to make sure the page is ready first (C-09).
/**
 * Read the repeating structures on a page.
 *
 * The panel drives this: rather than the user naming and picking each field,
 * the page is read and offered as tables to choose from.
 */
_registerHandler("content:detect", async (payload, sender) => {
  const tabId = payload?.tabId ?? sender.tab?.id;
  if (!tabId) throw new Error("No tab to read");
  await _ensureInjected(tabId);
  await _ensureOnDemand(tabId, "VQ_DETECT_STRUCTURE");
  const resp = await chrome.tabs.sendMessage(tabId, {
    type: "VQ_DETECT_STRUCTURE",
    payload: {},
  });
  if (!resp?.ok) throw new Error(resp?.error || "Could not read the page");
  return resp.result;
});

// ── Schedules ────────────────────────────────────────────────────────────────
//
// A schedule is a stored pipeline and an alarm. The run happens in the browser
// the user already has open, which is what makes this free — and what makes
// the two limits worth stating rather than burying: Chrome has to be running,
// and a minute is the floor Chrome will honour.

/** Schedules currently mid-run, so one cannot start a second copy of itself. */
const _scheduleRuns = new Set();

/**
 * Fire one schedule.
 *
 * Opens the page in a background tab, runs the pipeline through the same
 * handler the Run button uses — enforcement, ethics gates and all — and closes
 * the tab afterwards.
 */
async function _runSchedule(id) {
  const schedule = await getSchedule(id);
  if (!schedule) {
    // The alarm outlived its schedule. Clear it rather than firing forever for
    // something the user deleted and can no longer see.
    await chrome.alarms.clear(`vq_schedule_${id}`);
    return;
  }
  if (!schedule.enabled) return;

  if (_scheduleRuns.has(id)) {
    // An hourly run over a slow site can still be going when the next hour
    // comes round. Two copies of one pipeline on one tab is not a schedule
    // running twice, it is a mess — and the site gets double the traffic.
    _broadcastLog(
      "warn-log",
      `Schedule "${schedule.name}" is already running, so this firing was skipped.`,
      null,
    );
    return;
  }

  const missed = missedWindows(schedule, Date.now());
  if (missed > 0) {
    // Named rather than made up for. A gap in the data that looks like the
    // site having had no results is the failure this line exists to prevent;
    // running the missed windows back to back would be a worse one.
    _broadcastLog(
      "warn-log",
      `Schedule "${schedule.name}": ${missed} run(s) were missed, most likely because Chrome was not running. ` +
        "They are not being made up — running them back to back would hammer the site.",
      null,
    );
  }

  _scheduleRuns.add(id);
  let tab = null;
  try {
    // Not focused: a schedule that steals the window every hour is unusable.
    tab = await chrome.tabs.create({ url: schedule.url, active: false });
    // The same wait every navigation uses. A pipeline started against a
    // half-loaded page fails on step 1 for a reason that has nothing to do
    // with the pipeline.
    if (!(await _waitForTabLoad(tab.id))) {
      throw new Error("The scheduled page did not finish loading.");
    }

    const start = _handlers.get(MSG.PIPELINE_START);
    const result = await start(
      {
        pipeline: schedule.pipeline,
        tabId: tab.id,
        targetOrigin: new URL(schedule.url).origin,
      },
      {},
    );
    await markRun(id, "started");
    _broadcastLog(
      "info-log",
      `Schedule "${schedule.name}" started (run ${result?.runId ?? "?"}).`,
      result?.runId ?? null,
    );
  } catch (err) {
    await markRun(id, `failed: ${err.message}`);
    _broadcastLog(
      "error-log",
      `Schedule "${schedule.name}" failed to start: ${err.message}`,
      null,
    );
    if (tab?.id) await chrome.tabs.remove(tab.id).catch(() => {});
  } finally {
    _scheduleRuns.delete(id);
  }
}

_registerHandler("schedule:list", async () => ({
  schedules: await listSchedules(),
  minPeriodMinutes: MIN_PERIOD_MINUTES,
}));

_registerHandler("schedule:save", async (payload) => {
  const saved = await saveSchedule(payload?.schedule ?? payload);
  await syncAlarms();
  return saved;
});

_registerHandler("schedule:delete", async (payload) => {
  const removed = await deleteSchedule(payload?.id);
  await syncAlarms();
  return { removed };
});

_registerHandler("schedule:run", async (payload) => {
  await _runSchedule(payload?.id);
  return { started: true };
});

_registerHandler("content:ensure", async (payload, sender) => {
  const tabId = payload?.tabId ?? sender.tab?.id;
  await _ensureInjected(tabId);
  return { ready: true };
});

/**
 * Steps that only mean something inside a run.
 *
 * A LOOP has nothing to iterate, an EXPORT has no rows, and API_SNIFFER is a
 * run-wide capture that does nothing as a step. Saying so is the point: these
 * used to be forwarded to the page, which answered "Unknown step type: LOOP"
 * — a message that reads like the step is broken.
 *
 * @type {Record<string, string>}
 */
/**
 * Marks a rejection as an explanation rather than a fault.
 *
 * These reach the user as the message they should see, so logging them at
 * error level printed a red `handler-error` in the console for a step that
 * behaved exactly as designed — noise that hides the real errors next to it.
 */
class ExplainedRefusal extends Error {
  constructor(message) {
    super(message);
    this.name = "ExplainedRefusal";
    this.expected = true;
  }
}

const RUN_ONLY_STEPS = {
  LOOP: "A loop needs a pipeline to iterate. Press Run to see it work — its steps can be tested one at a time.",
  EXPORT:
    "An export needs the rows a run collected. Press Run; the file is written when the run reaches this step.",
  API_SNIFFER:
    "The sniffer records network traffic for the whole run rather than doing anything at this point in it. Press Run, then look at the monitor.",
  DEDUPE:
    "Dedupe checks the rows a run collects from this step onward, so on its own there is nothing for it to check. Press Run.",
  SET_HEADERS:
    "Headers are set for the length of a run and taken back when it ends, so a single-step test would leave them in force with no run to end. Press Run.",
  SOLVE_CAPTCHA:
    "Answering a challenge is gated on the authorisation a run carries and on your attestation for the domain, and a single-step test carries neither. Press Run.",
};

_registerHandler(MSG.STEP_EXECUTE, async (payload, sender) => {
  const { step, tabId } = payload;
  const targetTabId = tabId ?? sender.tab?.id;
  const testCtx = payload?.context || {};
  const resolvedStep = _resolveConfig(step, testCtx);
  const type = resolvedStep.type;

  if (RUN_ONLY_STEPS[type]) throw new ExplainedRefusal(RUN_ONLY_STEPS[type]);

  if (type === "API") return _executeApiStep(resolvedStep.config, testCtx);

  if (type === "PDF_EXTRACTION") {
    return _executePdfExtraction(resolvedStep.config, null);
  }

  if (!targetTabId) {
    throw new Error("No target tab specified for execution test");
  }

  if (type === "UPLOAD_ACTIVITY") {
    return _executeUploadActivityStep(resolvedStep.config, targetTabId, null);
  }

  // Testing a single step is the other path that needs the page set up (C-09).
  await _ensureInjected(targetTabId);

  if (type === "SCREENSHOT") {
    return _takeShot(targetTabId, resolvedStep.config, null);
  }

  if (type === "PAGINATE") {
    // The same helper the run uses, rather than a second copy that drifts.
    return _executePaginate(targetTabId, resolvedStep.config);
  }

  if (type === "SESSION") {
    // Worth testing for real rather than refusing: saving a session is a thing
    // you do once, by hand, right after logging in — which is exactly a
    // single-step test and not a run.
    return _executeSession(resolvedStep, targetTabId, null);
  }

  if (type === "DOWNLOAD_FILE") {
    // Testing it really downloads: a step whose whole point is a file on disk
    // cannot be tested by a dry run that reports what it would have saved.
    return _executeDownloadFile(resolvedStep, targetTabId, null, testCtx);
  }

  if (type === "AUTO_EXTRACT") {
    return _executeAutoExtract(resolvedStep.config, targetTabId, null, {
      extracted: {},
    });
  }

  if (type === "WEBSITE" || type === "NAVIGATE") {
    await chrome.tabs.update(targetTabId, { url: resolvedStep.config.url });
    // Wait the same way a run does. Returning the moment the tab was told to
    // navigate meant testing a step reported success against the page being
    // replaced, so "Test step" and "Run" disagreed about what the step did.
    const loaded =
      resolvedStep.config.wait === false
        ? false
        : await _waitForTabLoad(
            targetTabId,
            Number(resolvedStep.config.timeoutMs) || NAV_TIMEOUT_MS,
          );
    return { navigated: true, url: resolvedStep.config.url, loaded };
  }

  // WAIT is the one type that runs in both places: a fixed wait needs no page,
  // and every other mode watches the DOM. Mirrors _dispatchStep.
  const isPageWait =
    type === "WAIT" && (resolvedStep.config.mode || "fixed") !== "fixed";
  if (type === "WAIT" && !isPageWait) {
    await _sleep(Number(resolvedStep.config.ms) || 1000);
    return { waited: true, mode: "fixed" };
  }

  // Everything left should be a page step. Checked against the registry rather
  // than assumed: a background type reaching injector.js gets "Unknown step
  // type", which is how testing LOOP, API_SNIFFER and PDF_EXTRACTION all
  // failed with a message that read like the step was broken. A hand-kept list
  // of exceptions is what drifted; the registry already knows (G-01).
  if (STEP_TYPES[type]?.runsIn === "background" && !isPageWait) {
    throw new Error(
      `${type} runs in the extension, not in the page, and testing it on its own is not wired up. Please report this.`,
    );
  }

  // _sendToPage puts the content script back if the page has navigated since
  // it was injected; only a tab that refuses injection outright reaches the
  // message below.
  let resp;
  try {
    resp = await _sendToPage(targetTabId, resolvedStep);
  } catch (err) {
    if (_GONE.test(err.message)) {
      throw new Error(
        "Could not reach this page. Reload the tab and try again.",
      );
    }
    throw err;
  }

  if (!resp || !resp.ok) {
    throw new Error(resp?.error || "Test failed inside content environment");
  }

  // A run cleans EXTRACT's values on the way out (_dispatchStep) and Test did
  // not, so a field with a transform showed its raw value here and its cleaned
  // value in the run. Configure "Decode base64", press Test, see the base64 —
  // and conclude the transform is broken. Same helper, so the two cannot
  // disagree again.
  if (type === "EXTRACT" && Array.isArray(resp.result)) {
    return _transformRows(resp.result, resolvedStep.config, targetTabId);
  }
  return resp.result;
});

_registerHandler(MSG.PIPELINE_PAUSE, async (payload) => {
  const rs = _runStates.get(payload?.runId);
  if (!rs) return { ok: false, paused: false };
  rs.paused = true;
  logger.info(MODULE, "pipeline-paused", { runId: rs.runId });
  _broadcastLog(
    "warn-log",
    "Paused. The current step finishes first.",
    rs.runId,
  );
  return { ok: true, paused: true };
});

// There was no resume: PIPELINE_PAUSE could set the flag and only PIPELINE_STOP
// ever cleared it, so pausing a run meant ending it.
_registerHandler(MSG.PIPELINE_RESUME, async (payload) => {
  const rs = _runStates.get(payload?.runId);
  if (!rs) return { ok: false, paused: false };
  rs.paused = false;
  // The next captcha in the same run should stop it again; leaving this set
  // would let one solved challenge stand in for every later one.
  rs.pausedForCaptcha = false;
  logger.info(MODULE, "pipeline-resumed", { runId: rs.runId });
  _broadcastLog("info-log", "Resumed.", rs.runId);
  return { ok: true, paused: false };
});

_registerHandler(MSG.PIPELINE_STOP, async (payload) => {
  const rs = _runStates.get(payload?.runId);
  if (rs) {
    rs.active = false;
    rs.paused = false;
    logger.info(MODULE, "pipeline-stopped", { runId: rs.runId });
  }
  if (_runStates.size === 0) _stopHeartbeat();
  return { ok: true };
});

_registerHandler(MSG.PIPELINE_STATUS, async (payload) => {
  const runState = _runStates.get(payload?.runId);

  // `known` separates "that run finished" from "this worker has no memory of
  // that run". _runStates is in-memory only, so an MV3 termination mid-run
  // leaves the side panel showing a Stop button for something that no longer
  // exists. The panel polls this and can tell the difference.
  if (!runState) {
    return {
      known: false,
      active: false,
      paused: false,
      runId: payload?.runId,
    };
  }

  return {
    known: true,
    active: runState.active,
    paused: runState.paused,
    runId: runState.runId,
    rowCount: runState.results.length,
  };
});

_registerHandler(MSG.PROXY_SELECT, async (payload) => {
  const proxy = selectProxy(payload?.context ?? {});
  if (!proxy) throw new Error("No alive proxies");
  // Strip credentials from response — content script does not need them
  const { user, pass, ...safe } = proxy;
  return safe;
});

_registerHandler(MSG.PROXY_ROTATE, async (payload) => {
  const proxy = await rotateProxy(payload?.context ?? {});
  if (!proxy) throw new Error("Proxy rotation failed");
  const { user, pass, ...safe } = proxy;
  return safe;
});

_registerHandler(MSG.PROXY_TEST, async (payload) => {
  const { autoRemoveDead = false, retryCount = 3 } = payload ?? {};
  await testAllProxies({ autoRemoveDead, retryCount });
  return { ok: true };
});

_registerHandler(MSG.CAPTCHA_SOLVE, async (payload) => {
  const token = await solveCaptcha(payload);
  return { token };
});

// Never returns key values — only which providers have one stored and, on
// request, whether that key actually works.
//
// This handler used to import getApiKey and validateApiKey (and import the
// module twice), use neither, and return the provider list alone. So no key was
// ever validated: all six _validate* functions in api-key-manager.js were
// unreachable, and saving a bad key gave the same "saved" as a good one (F-03).
_registerHandler(MSG.KEY_GET, async (payload) => {
  const providers = await listProviders();
  if (!payload?.validate) return { providers };

  // Validation makes a network call per provider, so it is opt-in.
  const only = payload.provider ? [payload.provider] : providers;
  const results = {};
  for (const provider of only) {
    if (!providers.includes(provider)) {
      results[provider] = { valid: false, error: "No key stored" };
      continue;
    }
    try {
      results[provider] = await validateApiKey(provider);
    } catch (err) {
      results[provider] = { valid: null, error: err.message };
    }
  }
  return { providers, validation: results };
});

_registerHandler(MSG.FORM_ROW_START, async (payload) => {
  const { rowIndex, domain } = payload;
  // Rate limit acquisition
  await acquire(domain ?? "default", 1);
  logger.info(MODULE, "form-row-start", { rowIndex });
  return { ok: true };
});

_registerHandler(MSG.FORM_ROW_RESULT, async (payload) => {
  const { rowIndex, status, error } = payload;
  logger.info(MODULE, "form-row-result", { rowIndex, status });
  // Reset retry state on success
  if (status === "success") resetRetry(payload.domain ?? "default");
  return { ok: true };
});

_registerHandler(MSG.CHECKPOINT_SAVE, async (payload) => {
  const { runId, cursorData } = payload;
  await chrome.storage.local.set({
    [`vq_checkpoint_${runId}`]: { ...cursorData, savedAt: Date.now() },
  });
  logger.info(MODULE, "checkpoint-saved", { runId });
  return { ok: true };
});

// ── New handlers: wire up previously dead UI buttons ──────────────────────────

// Wire up API key save buttons
_registerHandler("key:set", async (payload) => {
  await setApiKey(payload.provider, payload.value);
  return { ok: true };
});

// ── AI gateway (K-17): bring-your-own-key settings ─────────────────────────
//
// This is the only place that connects a stored key to the provider-agnostic
// utils/ai-gateway.js module — the module itself never touches chrome.storage
// (see its module docblock). The gateway's own provider ids ("gateway:openai",
// "gateway:anthropic", ...) are kept distinct from the existing "openai" and
// "gemini" entries in the API Keys panel above: those feed the captcha/LLM-
// extraction paths another part of this codebase owns, and conflating the two
// would mean changing one silently changes the other's behavior.
_registerHandler("gateway:save", async (payload) => {
  const { provider, apiKey, model, baseUrl } = payload ?? {};
  if (!GATEWAY_PROVIDERS[provider]) {
    return { ok: false, error: `Unknown provider "${provider}"` };
  }
  // An empty key field means "keep whatever is already saved" — the model or
  // base URL is the common thing to change, and re-pasting the key every time
  // would be needless friction (and a needless chance to fat-finger it).
  if (apiKey) {
    await setApiKey(`gateway:${provider}`, apiKey);
  }
  await chrome.storage.local.set({
    [STORAGE_GATEWAY_KEY]: {
      provider,
      model: model || "",
      baseUrl: baseUrl || "",
    },
  });
  logger.info(MODULE, "gateway-config-saved", { provider });
  // NEVER log apiKey, baseUrl (a local base URL is not secret, but stays out
  // of the log for the same reason a proxy line does — C-03).
  return { ok: true };
});

// The panel asks what is granted; the grant itself must happen in the panel,
// because chrome.permissions.request needs a user gesture and a service worker
// has none. A request made from here is refused without ever prompting, which
// is indistinguishable from the user saying no.
_registerHandler("permissions:status", async () => permissionStatus());

_registerHandler("gateway:config-get", async () => {
  const stored = await chrome.storage.local.get(STORAGE_GATEWAY_KEY);
  return (
    stored[STORAGE_GATEWAY_KEY] ?? {
      provider: "anthropic",
      model: "",
      baseUrl: "",
    }
  );
});

_registerHandler("gateway:test", async (payload) => {
  const { provider, apiKey, model, baseUrl } = payload ?? {};
  // The field may be blank because the user is testing a key saved earlier —
  // fall back to storage rather than treating "blank box" as "no key".
  const key =
    apiKey || (await getApiKey(`gateway:${provider}`).catch(() => null));
  return testConnection({ provider, apiKey: key, model, baseUrl });
});

// Wire up proxy update button
_registerHandler("proxy:update", async (payload) => {
  const entries = parseProxyText(payload.text);
  addToPool(entries);
  if (payload.mode) setRotationMode(payload.mode);
  // Sent even when empty, so clearing the box clears the preference rather
  // than leaving geo mode chasing a country the user has stopped asking for.
  if (payload.region !== undefined) setTargetCountry(payload.region);
  await savePool();
  return { ok: true, count: entries.length };
});

// Wire up script export button
_registerHandler("script:export", async (payload) => {
  try {
    const { ast } = compilePipeline(payload.pipeline);
    if (!ast) throw new Error("Pipeline compilation returned empty AST");

    // Steps the emitters cannot express are reported alongside the code. They
    // used to become a `# TODO` comment, so the exported script looked
    // complete, ran, and silently did less than the pipeline.
    const unexportable = findUnexportableSteps(ast);

    // Templates are resolved by this executor at run time; a standalone script
    // has nothing to resolve them with, so they are named before download
    // rather than shipped as literal braces in a URL (B-16).
    const templates = findUnresolvedTemplates(ast);

    // Credentials become __VQ_ENV__NAME__ markers that both emitters resolve
    // from the environment. Only proxy credentials were handled before, so a
    // password or an Authorization header went into the file in plaintext
    // (B-14). Must run after the two scans, which read the original values.
    const secrets = redactSecrets(ast);

    const code = payload.format === "node" ? emitNode(ast) : emitPython(ast);

    return { code, unexportable, templates, secrets };
  } catch (err) {
    throw new Error(`Script export failed: ${err.message}`);
  }
});

// Wire up checkpoint/resume check
_registerHandler("checkpoint:check", async () => {
  return await getResumePayload();
});

// Wire up partial data download
_registerHandler("data:download", async (payload) => {
  const runId = payload?.runId;
  if (!runId) {
    // The caller used to pass the string "latest" as a sentinel, which matched
    // no index key, so the download reported "no data" rather than an error.
    throw new Error("data:download requires a runId");
  }
  const rows = await readAllRows(runId);
  // Screenshots and captured requests too. They were reachable only inside the
  // export archive, so a run with the sniffer on looked as though it had done
  // nothing at all — which is how "the API sniffer is not working" was
  // reported for a sniffer that was working and had nowhere to put its answer.
  const { networks, screenshots } = _capturesFor(runId);
  return { runId, rows, networks, screenshots };
});

// ── Side panel connection ───────────────────────────────────────────────────────
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(() => {});

// ── Test surface ──────────────────────────────────────────────────────────────
// The executor is the heart of the product and had no behavioural coverage,
// because this module has no exports and registers listeners at import. ES
// module exports are inert in a service worker and nothing in the extension
// imports these; they exist so tests/executor.test.mjs can drive the step
// chain directly. Keep this list minimal.
export const __testing = {
  _dispatchStep,
  _executeSteps,
  _executeStepList,
  _executePipeline,
  _executeApiStep,
  _assertOriginAllowed,
  _resolveStr,
  _resolveConfig,
  _resolveDownloadPath,
  _safeSegment,
  _runStates,
  _captchaAttested,
  _startRunProxy,
  _maybeRotateProxy,
  _endRunProxy,
};

// === END service-worker.js ===
