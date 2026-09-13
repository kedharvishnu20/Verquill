// === sidepanel/pipeline-builder.js ===
"use strict";

import {
  STEP_TYPES,
  USER_STEP_TYPES,
  RETRY_LIMITS,
  defaultConfig,
  isKnownStepType,
  retryCount,
} from "../utils/step-types.js";
import {
  TRANSFORMS,
  isValidRegex,
  REGEX_FLAGS,
  normalizeRegexFlags,
  normalizeRegexGroup,
} from "../utils/value-transforms.js";
import { CONDITIONS } from "../utils/conditions.js";
import { ASSERTIONS } from "../utils/assertions.js";
import { snifferFilterError } from "../utils/sniffer-filter.js";
import {
  formatRows,
  formatMeta,
  ROW_FORMATS,
  APPENDABLE_FORMATS,
} from "../exporters/row-formatters.js";
import { exportRows } from "../exporters/text-exporters.js";
import { parseListLines } from "../utils/loop-items.js";
import { analyzePipeline, VERDICT } from "../utils/pipeline-capabilities.js";

const MSG = {
  PIPELINE_START: "pipeline:start",
  PIPELINE_STOP: "pipeline:stop",
  PIPELINE_PAUSE: "pipeline:pause",
  PIPELINE_RESUME: "pipeline:resume",
};
let SK = { PIPELINE: "vq_active_pipeline" };
SK.STORAGE_FILES = "vq_storage_files_v1";
SK.UPLOAD_ACTIVITIES = "vq_upload_activities_v1";

let _tabId = null;
/**
 * True when boot could not work out which tab this panel belongs to, so
 * SK.PIPELINE is still the shared, un-suffixed key rather than a per-tab one.
 * Anything saved while this holds is saved somewhere a correctly-bound boot
 * will not look, so the flag exists to warn about it and to hand the work over
 * once a tab does arrive.
 */
let _pipelineKeyUnbound = false;

/**
 * The attestation for the domain in the active tab, as the worker holds it.
 *
 * Mirrored here because the config panel renders synchronously; the worker's
 * copy in chrome.storage.local is the one SOLVE_CAPTCHA actually consults, so
 * a stale mirror can only ever show the wrong checkbox, never let a step run.
 */
let _captchaAttest = { host: "", attested: false };

// ── Step Registry ─────────────────────────────────────────────────────────────
// The vocabulary lives in utils/step-types.js so the panel, the script emitters
// and the MCP server cannot drift apart again. Only user-selectable steps
// appear in the palette.
const STEP_REGISTRY = Object.fromEntries(
  USER_STEP_TYPES.map((type) => [type, STEP_TYPES[type]]),
);

// ── State ─────────────────────────────────────────────────────────────────────
let _pipeline = { steps: [] };
/**
 * Which step cards are open.
 *
 * This was a single id, so opening one card closed whichever was already
 * open. Configuring a LOOP with five children under that rule is a cycle of
 * open, read, close, open — and comparing two steps' settings, which is what
 * you are actually doing when a selector works in one place and not another,
 * was impossible. A set costs nothing and removes the restriction.
 *
 * Deliberately not persisted. It describes where you are in a piece of work,
 * not what the pipeline is, and a panel that reopened nine cards from
 * yesterday would be answering a question nobody asked.
 */
const _expandedNodeIds = new Set();
let _insertCtx = { index: -1, parentId: "", branchKey: "" };
let _runState = {
  active: false,
  paused: false,
  timer: null,
  startTs: 0,
  runId: null,
};
/** The most recent run, kept after it ends so its rows stay downloadable. */
let _lastRunId = null;
let _storageFiles = [];
let _uploadActivities = [];
let _dragSourceId = null;
let _keyListening = false;

// ── DOM refs ──────────────────────────────────────────────────────────────────
const elCanvas = document.getElementById("pipeline-canvas");
const elPalette = document.getElementById("step-palette-overlay");
const elPaletteSearch = document.getElementById("palette-search");
const elPaletteContent = document.getElementById("palette-content");
const elBoardViewport = document.getElementById("board-viewport");

// ── Init ──────────────────────────────────────────────────────────────────────

/**
 * Which tab this panel is driving.
 *
 * The board is stored per tab under `vq_active_pipeline_<tabId>` (E-13), so
 * this answer decides which pipeline appears. Getting it wrong does not look
 * like an error — it looks like the user's work is gone.
 *
 * A single `tabs.query({active, currentWindow})` was not reliable enough to
 * carry that. The side panel can boot while the window has no settled active
 * tab — during a window switch, as a tab is being replaced, or immediately
 * after the panel itself reloads — and the query then resolves to an empty
 * list. So: two query shapes, because `currentWindow` and `lastFocusedWindow`
 * disagree exactly when focus is in motion, and a couple of short retries,
 * because this is a race with the browser settling rather than a real absence.
 *
 * @returns {Promise<number|null>} the tab id, or null if it truly cannot be found
 */
async function _resolveTabId() {
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const query of [
      { active: true, currentWindow: true },
      { active: true, lastFocusedWindow: true },
    ]) {
      const [tab] = await chrome.tabs.query(query).catch(() => []);
      if (tab?.id != null) return tab.id;
    }
    // Short and bounded. This resolves on the first retry when it resolves at
    // all; a longer wait would just delay an empty board.
    await new Promise((r) => setTimeout(r, 60));
  }
  return null;
}

async function init() {
  _tabId = await _resolveTabId();
  if (_tabId != null) {
    SK.PIPELINE = `vq_active_pipeline_${_tabId}`;
  } else {
    // Falling through to the bare `vq_active_pipeline` key is the dangerous
    // part, and it used to happen in silence: the board loads empty, the user
    // reasonably concludes their pipeline is gone, and the moment they touch
    // anything, saveState writes to that shared key — so the next boot that
    // *does* resolve the tab reads the real key and loses whatever they just
    // did. Nothing here can bind to a tab that does not exist, but it can at
    // least refuse to be quiet about it.
    _pipelineKeyUnbound = true;
  }

  // Also listen for tab changes within the sidepanel to swap state
  chrome.tabs.onActivated.addListener(async (activeInfo) => {
    // A run belongs to the tab it started on. Swapping the board out from under
    // a live run left Stop pointing at the right runId while the canvas showed
    // an unrelated pipeline, and the monitor kept filling with log lines the
    // visible steps had nothing to do with (E-13).
    if (_runState.active && activeInfo.tabId !== _tabId) {
      notify(
        "warn-log",
        "A run is in flight on another tab. The board stays on it until the run ends.",
      );
      return;
    }

    _tabId = activeInfo.tabId;
    SK.PIPELINE = `vq_active_pipeline_${_tabId}`;
    const saved = (await chrome.storage.local.get(SK.PIPELINE))[SK.PIPELINE];

    // A panel that booted without a tab has been writing to the shared key.
    // Now that there is a real one to bind to, work already on the board is
    // adopted into it rather than thrown away — clearing here would delete
    // exactly the work the unbound boot put at risk, which is the failure this
    // whole path exists to prevent. Only when the tab has nothing of its own:
    // a tab with a saved pipeline keeps it.
    if (_pipelineKeyUnbound) {
      _pipelineKeyUnbound = false;
      if (!saved?.steps && _pipeline.steps.length) {
        await saveState();
        notify(
          "info-log",
          `Board moved onto this tab (${_pipeline.steps.length} steps kept).`,
        );
        _expandedNodeIds.clear();
        await _refreshCaptchaAttestation();
        renderPipeline();
        return;
      }
    }

    _pipeline = saved?.steps ? saved : { steps: [] };
    _expandedNodeIds.clear();
    // A different tab is very likely a different domain, and the attestation
    // belongs to the domain rather than to the panel.
    await _refreshCaptchaAttestation();
    renderPipeline();
    // The storage library and the upload activity list are not tab-scoped —
    // only SK.PIPELINE is — so there is nothing there to re-render. The audit
    // (E-13) said otherwise; entry corrected.
  });

  await _refreshCaptchaAttestation();

  bindNavTabs();
  bindGlobalControls();
  bindStorageControls();
  bindPalette();
  bindDelegatedEvents();
  bindKeyboardActivation();
  _loadGatewayConfig();

  // Said only once the log pane is bound, and said at all because the failure
  // it describes is otherwise indistinguishable from "my pipeline vanished".
  if (_pipelineKeyUnbound) {
    notify(
      "warn-log",
      "Could not tell which tab this panel belongs to, so the saved board for it could not be loaded. Click the page you want to work on and reopen the panel. Nothing has been deleted.",
    );
  }

  const savedState = await chrome.storage.local.get([
    SK.PIPELINE,
    SK.STORAGE_FILES,
    SK.UPLOAD_ACTIVITIES,
  ]);
  if (savedState?.[SK.PIPELINE]?.steps) _pipeline = savedState[SK.PIPELINE];

  _storageFiles = Array.isArray(savedState?.[SK.STORAGE_FILES])
    ? savedState[SK.STORAGE_FILES]
    : [];

  _uploadActivities = Array.isArray(savedState?.[SK.UPLOAD_ACTIVITIES])
    ? savedState[SK.UPLOAD_ACTIVITIES]
    : [];

  // Running activities cannot survive a sidepanel reload; mark them interrupted.
  let touchedActivities = false;
  _uploadActivities = _uploadActivities.map((activity) => {
    if (activity.status !== "running") return activity;
    touchedActivities = true;
    return {
      ...activity,
      status: "interrupted",
      updatedAt: Date.now(),
      message: "Interrupted (panel reloaded)",
    };
  });
  if (touchedActivities) {
    await _saveUploadActivities();
  }

  renderPipeline();
  renderStoragePanel();
  renderUploadActivities();
  populatePalette();
  listenToSystem();

  await _showResumeBanner();
}

/**
 * Offer the rows from runs that never finished.
 *
 * The banner used to delegate to the "Download Data" button, which passed
 * `_runState.runId || "latest"` — and on a fresh panel there is no runId, so
 * the sentinel matched nothing and the download reported no data. Each run is
 * now downloaded by its own id.
 */
async function _showResumeBanner() {
  const res = await chrome.runtime
    .sendMessage({ type: "checkpoint:check" })
    .catch(() => null);

  const runs = res?.ok ? (res.result?.runs ?? []) : [];
  if (runs.length === 0) return;

  const view = document.getElementById("view-monitor");
  if (!view) return;

  document.querySelector(".resume-banner")?.remove();

  const banner = document.createElement("div");
  banner.className = "resume-banner";

  const label = document.createElement("span");
  label.textContent =
    runs.length === 1
      ? "⟳ A previous run did not finish"
      : `⟳ ${runs.length} previous runs did not finish`;
  banner.appendChild(label);

  for (const run of runs) {
    const btn = document.createElement("button");
    btn.className = "btn";
    btn.style.fontSize = "11px";
    btn.textContent =
      runs.length === 1 ? "Download data" : `Download ${run.runId.slice(-6)}`;
    btn.addEventListener("click", () => _downloadRunRows(run.runId));
    banner.appendChild(btn);
  }

  view.prepend(banner);
}

/**
 * Download every row stored for a run.
 * @param {string} runId
 */
async function _downloadRunRows(runId) {
  if (!runId) {
    logToMonitor("warn-log", "No run selected to download.");
    return;
  }

  const res = await chrome.runtime
    .sendMessage({ type: "data:download", payload: { runId } })
    .catch(() => null);

  if (!res?.ok) {
    logToMonitor(
      "error-log",
      `Download failed: ${res?.error ?? "no response"}`,
    );
    return;
  }

  const rows = (res.result?.rows ?? []).map(
    ({ runId: _runId, ...rest }) => rest,
  );
  // The captured requests come back in the same reply. This used to read
  // `rows` alone and announce "That run stored no rows" — so a run whose whole
  // purpose was the sniffer reported that it had collected nothing, while its
  // captures sat unread in the response. That is what "the API sniffer is not
  // working" was, for a sniffer that was working.
  const networks = res.result?.networks ?? [];

  if (rows.length === 0 && networks.length === 0) {
    logToMonitor(
      "warn-log",
      "That run collected no rows and captured no API calls.",
    );
    return;
  }

  // exporters/text-exporters.js was written for exactly this and nothing
  // imported it (F-01). It uses the File System Access API's save dialog where
  // the browser has one — which a service worker cannot show, but the side
  // panel can — and falls back to a Blob download everywhere else.
  const written = [];
  try {
    if (rows.length > 0) {
      await exportRows(rows, "csv", `verquill_${runId}.csv`);
      written.push(`${rows.length} row${rows.length === 1 ? "" : "s"}`);
    }
    if (networks.length > 0) {
      // A separate file, not merged: an API capture and an extracted row have
      // nothing in common but the run they came from, and one CSV holding both
      // would have a column for every field of each.
      await exportRows(networks, "csv", `verquill_${runId}_api.csv`);
      written.push(
        `${networks.length} captured request${networks.length === 1 ? "" : "s"}`,
      );
    }
  } catch (err) {
    // A cancelled save dialog is a choice, not a failure.
    if (err?.name === "AbortError") return;
    notify("error-log", `Download failed: ${err.message}`);
    return;
  }
  logToMonitor(
    "info-log",
    `Downloaded ${written.join(" and ")} from ${runId}.`,
  );
}

async function saveState() {
  await chrome.storage.local.set({ [SK.PIPELINE]: _pipeline });
}

async function _saveStorageFiles() {
  const snapshot = _storageFiles;
  try {
    await chrome.storage.local.set({ [SK.STORAGE_FILES]: _storageFiles });
  } catch (error) {
    // The pre-check should make this unreachable, but a quota is a quota: if
    // the write is refused, drop back to what is actually on disk rather than
    // leaving the panel showing files that were never saved.
    const onDisk = (await chrome.storage.local.get(SK.STORAGE_FILES))[
      SK.STORAGE_FILES
    ];
    _storageFiles = Array.isArray(onDisk) ? onDisk : [];
    notify(
      "error-log",
      `Storage save refused (${snapshot.length} files, ${_mb(_storageBytesUsed())} on disk). ` +
        `Remove large files and retry. ${error?.message || ""}`,
    );
    renderStoragePanel();
    throw error;
  }
}

async function _saveUploadActivities() {
  await chrome.storage.local.set({ [SK.UPLOAD_ACTIVITIES]: _uploadActivities });
}

function bindStorageControls() {
  const storageInput = document.getElementById("input-storage-files");

  document
    .getElementById("btn-storage-add-files")
    ?.addEventListener("click", () => storageInput?.click());

  storageInput?.addEventListener("change", async (event) => {
    const files = Array.from(event.target?.files || []);
    if (!files.length) return;
    await _stageFilesInStorage(files);
    event.target.value = "";
  });

  document
    .getElementById("btn-storage-clear")
    ?.addEventListener("click", async () => {
      const n = _storageFiles.length;
      if (!n) return;
      const ok = await _confirmDestructive({
        title: "Clear the file library?",
        body: `${n} stored file${n === 1 ? "" : "s"} will be deleted. This cannot be undone, and any UPLOAD_ACTIVITY step referencing them will stop working.`,
        confirmLabel: "Delete all",
      });
      if (!ok) return;

      _storageFiles = [];
      await _saveStorageFiles();
      renderStoragePanel();
      logToMonitor("warn-log", `Storage library cleared (${n} files).`);
    });

  document
    .getElementById("storage-file-list")
    ?.addEventListener("click", async (event) => {
      const btn = event.target.closest("[data-action='storage-remove-file']");
      if (!btn) return;
      const fileId = btn.dataset.fileId;
      if (!fileId) return;

      _storageFiles = _storageFiles.filter((f) => f.id !== fileId);
      await _saveStorageFiles();
      renderStoragePanel();
    });
}

/**
 * chrome.storage.local is capped at about 10 MB without the `unlimitedStorage`
 * permission, which this extension deliberately does not request. Files are
 * held as base64 data URLs, which inflates them by roughly a third, so two 4 MB
 * PDFs are already over the line. There was a try/catch that logged a quota
 * message after the fact, but nothing checked before writing, and the failed
 * write left the in-memory list holding files that were not persisted (C-12).
 */
const STORAGE_QUOTA_BYTES = 10 * 1024 * 1024;
/** Leave room for pipelines, overlay prefs and the proxy pool. */
const STORAGE_BUDGET_BYTES = Math.floor(STORAGE_QUOTA_BYTES * 0.8);
/** base64 costs 4 bytes per 3, plus the data: prefix. */
const BASE64_OVERHEAD = 4 / 3;

/** Bytes the library currently occupies once encoded. */
function _storageBytesUsed() {
  return _storageFiles.reduce(
    (n, f) => n + (f.dataUrl?.length ?? Math.ceil(f.size * BASE64_OVERHEAD)),
    0,
  );
}

/** @param {number} n @returns {string} */
function _mb(n) {
  return `${(n / 1048576).toFixed(1)} MB`;
}

async function _stageFilesInStorage(files) {
  const activityId = _createActivity({
    kind: "storage-stage",
    fileIds: [],
    fileNames: files.map((f) => f.name),
    totalFiles: files.length,
    message: "Staging files in storage library",
  });

  const existing = new Set(
    _storageFiles.map((f) => `${f.name}::${f.size}::${f.lastModified}`),
  );

  let processed = 0;
  let used = _storageBytesUsed();
  const rejected = [];

  for (const file of files) {
    const sig = `${file.name}::${file.size}::${file.lastModified}`;
    if (!existing.has(sig)) {
      // Checked before reading the file, not after the write fails: a rejected
      // write used to leave the in-memory list holding a file that was never
      // persisted, so the panel showed it and the next reload did not.
      const projected = Math.ceil(file.size * BASE64_OVERHEAD);
      if (used + projected > STORAGE_BUDGET_BYTES) {
        rejected.push(file.name);
        processed += 1;
        continue;
      }

      const dataUrl = await _readFileAsDataUrl(file);
      used += dataUrl.length;
      const item = {
        id: `sf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        name: file.name,
        type: file.type || "application/octet-stream",
        size: file.size,
        lastModified: file.lastModified,
        addedAt: Date.now(),
        dataUrl,
      };
      _storageFiles.unshift(item);
      existing.add(sig);
    }
    processed += 1;
    _updateActivity(activityId, {
      processedFiles: processed,
      progress: Math.round((processed / files.length) * 100),
      status: "running",
      message: `Staging ${processed}/${files.length}`,
    });
  }

  await _saveStorageFiles();

  if (rejected.length) {
    notify(
      "error-log",
      `${rejected.length} file(s) not added — the library would exceed its ` +
        `${_mb(STORAGE_BUDGET_BYTES)} budget (${_mb(used)} in use): ${rejected.join(", ")}. ` +
        `Remove something first.`,
    );
  }

  _updateActivity(activityId, {
    processedFiles: files.length,
    progress: 100,
    status: rejected.length ? "partial" : "completed",
    completedAt: Date.now(),
    message: rejected.length
      ? `${files.length - rejected.length} of ${files.length} staged; ${rejected.length} over quota`
      : "Files staged in storage",
  });

  renderStoragePanel();
  renderUploadActivities();
}

function _createActivity({ kind, fileIds, fileNames, totalFiles, message }) {
  const activity = {
    id: `ua_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    kind,
    status: "running",
    fileIds,
    fileNames,
    totalFiles,
    processedFiles: 0,
    progress: 0,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    completedAt: null,
    message,
  };
  _uploadActivities.unshift(activity);
  _uploadActivities = _uploadActivities.slice(0, 120);
  _saveUploadActivities();
  renderUploadActivities();
  return activity.id;
}

function _updateActivity(activityId, patch) {
  const idx = _uploadActivities.findIndex((a) => a.id === activityId);
  if (idx === -1) return;
  _uploadActivities[idx] = {
    ..._uploadActivities[idx],
    ...patch,
    updatedAt: Date.now(),
  };
  _saveUploadActivities();
  renderUploadActivities();
}

function renderStoragePanel() {
  const listEl = document.getElementById("storage-file-list");

  // How full the library is. Files are base64 in chrome.storage.local against a
  // fixed budget, and there was no aggregate anywhere — the first sign of
  // trouble was a save being refused (E-20).
  const usageEl = document.getElementById("storage-usage");
  if (usageEl) {
    const used = _storageBytesUsed();
    const pct = Math.min(100, Math.round((used / STORAGE_BUDGET_BYTES) * 100));
    usageEl.textContent = _storageFiles.length
      ? `${_storageFiles.length} file${_storageFiles.length === 1 ? "" : "s"} · ${_mb(used)} of ${_mb(STORAGE_BUDGET_BYTES)} (${pct}%)`
      : `0 files · ${_mb(STORAGE_BUDGET_BYTES)} available`;
    usageEl.style.color =
      pct >= 90
        ? "var(--red)"
        : pct >= 70
          ? "var(--yellow)"
          : "var(--text-dim)";
  }

  if (listEl) {
    if (!_storageFiles.length) {
      listEl.innerHTML = `<div class="empty-inline">No files in storage yet. Add files to build your reusable library.</div>`;
    } else {
      listEl.innerHTML = _storageFiles
        .map(
          (file) => `<div class="storage-item">
          <div class="storage-item-head">
            <div class="mono" style="font-size:12px;">${esc(file.name)}</div>
            <button class="btn btn-icon" data-action="storage-remove-file" data-file-id="${file.id}" title="Remove">✕</button>
          </div>
          <div class="storage-meta">${esc(file.type || "application/octet-stream")} · ${_formatBytes(file.size)} · Added ${_formatTime(file.addedAt)}</div>
        </div>`,
        )
        .join("");
    }
  }
}

function renderUploadActivities() {
  const target = document.getElementById("upload-activity-list-monitor");
  if (!target) return;

  const html = !_uploadActivities.length
    ? `<div class="empty-inline">No upload activity yet.</div>`
    : _uploadActivities
        .map((activity) => {
          const statusClass =
            activity.status === "completed"
              ? "pill pill-completed"
              : activity.status === "running"
                ? "pill pill-running"
                : "pill pill-interrupted";
          return `<div class="upload-item">
          <div class="upload-item-head">
            <div style="font-size:12px;"><b>${activity.kind === "storage-stage" ? "Storage Intake" : "Activity"}</b></div>
            <span class="${statusClass}">${activity.status}</span>
          </div>
          <div class="upload-meta">${activity.message || ""}</div>
          <div class="upload-meta">Files: ${activity.processedFiles || 0}/${activity.totalFiles || 0} · Progress: ${activity.progress || 0}%</div>
          <div class="upload-meta">${(activity.fileNames || []).map((n) => esc(n)).join(", ")}</div>
          <div class="upload-meta">Started ${_formatTime(activity.startedAt)}</div>
        </div>`;
        })
        .join("");

  target.innerHTML = html;
}

function _readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () =>
      reject(new Error(`Failed to read file: ${file.name}`));
    reader.readAsDataURL(file);
  });
}

function _formatBytes(bytes) {
  const size = Number(bytes || 0);
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024)
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function _formatTime(ts) {
  if (!ts) return "-";
  return new Date(ts).toLocaleString();
}

// ── Nav tabs ──────────────────────────────────────────────────────────────────
function bindNavTabs() {
  document.querySelectorAll(".nav-pill").forEach((btn) => {
    btn.addEventListener("click", () => {
      document
        .querySelectorAll(".nav-pill")
        .forEach((b) => b.classList.remove("active"));
      document
        .querySelectorAll(".view")
        .forEach((v) => v.classList.remove("active"));
      btn.classList.add("active");
      document
        .getElementById(`view-${btn.dataset.tab}`)
        ?.classList.add("active");
    });
  });
}

// ── Global controls ───────────────────────────────────────────────────────────
function bindGlobalControls() {
  document
    .getElementById("btn-clear-pipeline")
    .addEventListener("click", async () => {
      const n = _pipeline.steps.length;
      if (!n) return;
      const ok = await _confirmDestructive({
        title: "Clear the pipeline?",
        body: `${n} step${n === 1 ? "" : "s"} will be deleted. This cannot be undone.`,
        confirmLabel: "Clear",
      });
      if (!ok) return;

      _pipeline.steps = [];
      _expandedNodeIds.clear();
      await chrome.storage.local.remove(SK.PIPELINE);
      saveState();
      renderPipeline();
      logToMonitor("warn-log", `Pipeline cleared (${n} steps).`);
    });

  const btnRun = document.getElementById("btn-master-run");
  const btnStop = document.getElementById("btn-master-stop");
  const btnPause = document.getElementById("btn-master-pause");

  // The service worker has always had a pause flag and the executor waits on
  // it, but nothing in the UI could set it — and there was no resume message at
  // all, so pausing a run would have meant ending it.
  btnPause?.addEventListener("click", async () => {
    if (!_runState.active || !_runState.runId) return;

    const next = !_runState.paused;
    const res = await chrome.runtime
      .sendMessage({
        type: next ? MSG.PIPELINE_PAUSE : MSG.PIPELINE_RESUME,
        payload: { runId: _runState.runId },
      })
      .catch(() => null);

    if (!res?.ok || res.result?.ok === false) {
      logToMonitor("warn-log", "That run is no longer active.");
      return;
    }
    _setPausedUI(next);
  });

  btnRun.addEventListener("click", async () => {
    if (!_pipeline.steps.length) {
      logToMonitor("warn-log", "Pipeline is empty.");
      return;
    }
    const targetTabId = _tabId;
    if (!targetTabId) {
      logToMonitor("warn-log", "No active tab found.");
      return;
    }
    let tab;
    try {
      tab = await chrome.tabs.get(targetTabId);
    } catch {
      logToMonitor("warn-log", "Active tab is inaccessible.");
      return;
    }

    const bypassRobots =
      document.getElementById("bypass-robots")?.checked || false;
    let urlObj = null;
    try {
      urlObj = new URL(tab.url);
    } catch {}

    document.getElementById("mon-errs").textContent = "0";
    document.getElementById("mon-rows").textContent = "0";
    document.getElementById("mon-progress-fill").style.width = "0%";
    document.getElementById("mon-progress-text").textContent = "0%";

    // The run half of what SOLVE_CAPTCHA needs. Sent only when the pipeline
    // has such a step, so a stale toggle cannot authorise a run that was never
    // going to answer anything.
    const solvesCaptcha = _flattenSteps(_pipeline.steps).some(
      (s) => s.type === "SOLVE_CAPTCHA",
    );
    const captchaAuthorized =
      solvesCaptcha &&
      (document.getElementById("authorize-captcha")?.checked || false);
    if (solvesCaptcha && !captchaAuthorized) {
      logToMonitor(
        "warn-log",
        "This pipeline has a Solve Captcha step, but the run is not authorised " +
          "to answer challenges — the step will refuse. Turn on 'Authorise " +
          "captcha answering for this run' in Settings.",
      );
    }

    const runPayload = {
      pipeline: _pipeline,
      tabId: targetTabId,
      targetOrigin: urlObj ? urlObj.origin : null,
      targetPath: urlObj ? urlObj.pathname : "/",
      bypassRobots,
      captchaEnabled: solvesCaptcha,
      captchaAuthorized,
      // Read at Run rather than stored on the pipeline: routing traffic
      // somewhere is a decision about this run on this machine, not a property
      // of a pipeline somebody might share.
      useProxy: document.getElementById("use-proxy")?.checked || false,
      proxyRotateEvery:
        Number(document.getElementById("proxy-rotate-every")?.value) || 0,
    };

    // Pre-flight: run the ethics gates and show the user what they found before
    // anything executes. The background re-runs them at start, so this is for
    // visibility and consent, not enforcement.
    const pre = await chrome.runtime.sendMessage({
      type: "pipeline:preflight",
      payload: runPayload,
    });

    if (!pre?.ok) {
      logToMonitor(
        "error-log",
        `Pre-flight check failed: ${pre?.error || "Unknown error"}`,
      );
      return;
    }

    const { blocked, blocker, warnings = [] } = pre.result ?? {};

    if (blocked) {
      document.querySelector('[data-tab="monitor"]').click();
      logToMonitor(
        "error-log",
        `Blocked · ${blocker?.code}: ${blocker?.message}`,
      );
      return;
    }

    if (warnings.length) {
      document.querySelector('[data-tab="monitor"]').click();
      for (const w of warnings) {
        logToMonitor("warn-log", `Ethics · ${w.code}: ${w.message}`);
      }
      const proceed = await _confirmEthicsWarnings(warnings);
      if (!proceed) {
        logToMonitor("warn-log", "Run cancelled at the ethics check.");
        return;
      }
      runPayload.confirmed = true;
    }

    const res = await chrome.runtime.sendMessage({
      type: MSG.PIPELINE_START,
      payload: runPayload,
    });
    if (res?.ok) {
      _runState = {
        active: true,
        startTs: Date.now(),
        runId: res.result?.runId,
        timer: null,
      };
      btnRun.classList.add("hidden");
      document.getElementById("run-controls")?.classList.remove("hidden");
      // A previous run's capture count is not this run's.
      document.getElementById("mon-apis-card")?.classList.add("hidden");
      const apis = document.getElementById("mon-apis");
      if (apis) apis.textContent = "0";
      _setPausedUI(false);
      document.querySelector('[data-tab="monitor"]').click();
      startMonitorTimer();
      logToMonitor("info-log", "Pipeline started.");
    } else {
      logToMonitor(
        "error-log",
        `Failed to start: ${res?.error || "Unknown error"}`,
      );
    }
  });

  btnStop.addEventListener("click", async () => {
    await chrome.runtime.sendMessage({
      type: "pipeline:stop",
      payload: { runId: _runState.runId, tabId: _tabId },
    });
    stopRunUI();
    logToMonitor("warn-log", "Pipeline stopped by user.");
  });

  document.getElementById("btn-clear-logs").addEventListener("click", () => {
    document.getElementById("mon-logs").innerHTML = "";
  });

  document
    .getElementById("btn-save-key-2captcha")
    ?.addEventListener("click", () =>
      _saveAndValidateKey("2captcha", "2Captcha", "key-2captcha"),
    );
  document
    .getElementById("btn-sched-add")
    ?.addEventListener("click", () => _addSchedule());
  _renderSchedules();
  document
    .getElementById("btn-gateway-save")
    ?.addEventListener("click", () => _saveGatewayConfig());
  document
    .getElementById("btn-gateway-test")
    ?.addEventListener("click", () => _testGatewayConnection());
  _renderPermissions();
  document
    .getElementById("btn-update-proxies")
    ?.addEventListener("click", async () => {
      const text = document.getElementById("config-proxy-text").value.trim();
      const mode = document.getElementById("config-proxy-mode").value;
      const region = (
        document.getElementById("config-proxy-region")?.value ?? ""
      )
        .trim()
        .toUpperCase();
      if (!text) return logToMonitor("warn-log", "Paste proxy list first.");
      const res = await chrome.runtime.sendMessage({
        type: "proxy:update",
        payload: { text, mode, region },
      });
      logToMonitor(
        res?.ok ? "info-log" : "error-log",
        res?.ok
          ? `Proxy pool updated: ${res.result?.count || 0} entries.`
          : "Failed to update proxy pool.",
      );
    });
  document
    .getElementById("btn-detect-structure")
    ?.addEventListener("click", () => _detectStructure());

  document
    .getElementById("btn-export-script")
    ?.addEventListener("click", async () => {
      if (!_pipeline.steps.length)
        return logToMonitor("warn-log", "Pipeline is empty.");
      // prompt() is blocked in the side panel, which is why this was hardcoded
      // to python and the Node emitter was unreachable (B-12). A select is not.
      const format =
        document.getElementById("sel-export-format")?.value === "node"
          ? "node"
          : "python";
      const res = await chrome.runtime.sendMessage({
        type: "script:export",
        payload: { pipeline: _pipeline, format },
      });
      if (res?.ok && res.result?.code) {
        // Say what the script will not do before handing it over.
        for (const step of res.result.unexportable ?? []) {
          logToMonitor(
            "warn-log",
            `Not exported: ${step.type} — ${step.reason}. The script will throw if it reaches that step.`,
          );
        }

        // Templates are a runtime feature of the executor. A standalone script
        // has nothing to resolve them with, so it would request a URL with
        // braces in it (B-16).
        for (const t of res.result.templates ?? []) {
          logToMonitor(
            "warn-log",
            `Unresolved template in ${t.type} ${t.where}: ${t.template} — the script uses it literally.`,
          );
        }

        // Credentials are replaced with environment lookups (B-14), which the
        // user has to set before the script will work.
        const secrets = res.result.secrets ?? [];
        if (secrets.length) {
          logToMonitor(
            "info-log",
            `${secrets.length} credential(s) replaced with environment variables: ${secrets
              .map((x) => x.env)
              .join(", ")}. Set them before running the script.`,
          );
        }

        const blob = new Blob([res.result.code], { type: "text/plain" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `verquill_${format}.${format === "python" ? "py" : "mjs"}`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        logToMonitor("info-log", `Exported as ${format} script.`);
      } else {
        logToMonitor(
          "error-log",
          `Export failed: ${res?.error || "Unknown error"}`,
        );
      }
    });

  const uploadPipelineInput = document.getElementById("input-upload-pipeline");

  document
    .getElementById("btn-upload-pipeline")
    ?.addEventListener("click", () => {
      uploadPipelineInput?.click();
    });

  uploadPipelineInput?.addEventListener("change", async (event) => {
    const file = event.target?.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const normalized = _normalizeImportedPipeline(parsed);

      // The file came from outside this panel, so it is somebody else's
      // program until proven otherwise. Nothing is written to state until the
      // review below returns true — and for the one refused combination it
      // never asks, it just declines.
      const accepted = await _reviewImport(normalized, file.name);
      if (!accepted) {
        logToMonitor("warn-log", `Did not load ${file.name}.`);
        return;
      }

      _pipeline = normalized;
      _expandedNodeIds.clear();
      await saveState();
      renderPipeline();
      logToMonitor(
        "info-log",
        `Loaded pipeline from ${file.name} (${normalized.steps.length} top-level steps).`,
      );
    } catch (error) {
      logToMonitor(
        "error-log",
        `Upload failed: ${error?.message || "Invalid pipeline JSON file."}`,
      );
    } finally {
      event.target.value = "";
    }
  });

  // --- Library Dropdown Logic ---
  const libBtn = document.getElementById("btn-library-dropdown");
  const libDropdown = document.getElementById("library-dropdown");
  const libList = document.getElementById("library-list");

  if (libBtn) {
    libBtn.addEventListener("click", async () => {
      libDropdown.classList.toggle("hidden");
      if (libDropdown.classList.contains("hidden")) return;

      libList.innerHTML = `<div style="color: var(--dim); font-size: 11px; padding: 4px;">Loading...</div>`;

      const res = await chrome.storage.local.get([
        "vq_github_pat",
        "vq_github_repo",
      ]);
      const pat = res.vq_github_pat;
      let repoUrl =
        res.vq_github_repo ||
        "https://github.com/kedharvishnu20/Verquill_Market_place.git";

      let repoPath = repoUrl
        .replace("https://github.com/", "")
        .replace(".git", "")
        .replace(/\/$/, "");
      const headers = { Accept: "application/vnd.github.v3+json" };
      if (pat) headers["Authorization"] = `token ${pat}`;
      const decode = (c) =>
        JSON.parse(
          decodeURIComponent(escape(atob(String(c).replace(/\s/g, "")))),
        );

      const pipelines = [];
      const seen = new Set();
      const add = (p, source) => {
        if (!p || typeof p !== "object" || !Array.isArray(p.steps)) return;
        const id = p.id || p.name;
        if (!id || seen.has(id)) return;
        seen.add(id);
        p.__source = source;
        pipelines.push(p);
      };

      // 1) Local pipelines you built in the sidepanel (chrome.storage). Always shown.
      try {
        const stored = await chrome.storage.local.get(null);
        Object.keys(stored)
          .filter((k) => k.startsWith("vq_active_pipeline"))
          .forEach((k) => {
            const p = stored[k];
            if (p && typeof p === "object" && Array.isArray(p.steps)) {
              if (!p.id) p.id = k;
              add(p, "local");
            }
          });
      } catch (_) {}

      // 2) GitHub personal library (per-file + legacy). Best-effort.
      let githubError = false;
      try {
        const dirRes = await fetch(
          `https://api.github.com/repos/${repoPath}/contents/pipelines`,
          { headers, cache: "no-store" },
        );
        if (dirRes.ok) {
          const items = await dirRes.json();
          for (const it of Array.isArray(items) ? items : []) {
            if (
              it.type !== "file" ||
              !it.name.toLowerCase().endsWith(".json") ||
              it.name.toLowerCase() === "registry.json"
            )
              continue;
            try {
              const fr = await fetch(it.url, { headers, cache: "no-store" });
              if (!fr.ok) continue;
              add(decode((await fr.json()).content), "github");
            } catch (_) {}
          }
        }
        const legRes = await fetch(
          `https://api.github.com/repos/${repoPath}/contents/registry.json`,
          { headers, cache: "no-store" },
        );
        if (legRes.ok) {
          const arr = decode((await legRes.json()).content);
          (Array.isArray(arr) ? arr : []).forEach((p) => add(p, "github"));
        }
      } catch (_) {
        githubError = true;
      }

      // 3) Render.
      if (!pipelines.length) {
        libList.innerHTML = githubError
          ? `<div style="color: var(--red); font-size: 11px; padding: 8px;">Couldn't reach GitHub, and no local pipelines found.</div>`
          : `<div style="color: var(--dim); font-size: 11px; padding: 8px;">No pipelines yet. Build one on the canvas, or push from the Marketplace.</div>`;
        return;
      }

      libList.innerHTML = "";
      pipelines.forEach((p) => {
        const stepCount = Array.isArray(p.steps) ? p.steps.length : 0;
        const name = p.name || p.id || "Untitled Pipeline";
        const srcLabel = p.__source === "github" ? "GITHUB" : "LOCAL";

        const item = document.createElement("button");
        item.type = "button";
        item.title = p.description || p.desc || "";
        item.style.cssText =
          "display:flex;flex-direction:column;align-items:flex-start;gap:2px;" +
          "width:100%;padding:8px 10px;background:transparent;border:1px solid transparent;" +
          "border-radius:var(--radius);cursor:pointer;text-align:left;color:var(--ink);";
        item.addEventListener("mouseenter", () => {
          item.style.background = "var(--void)";
          item.style.borderColor = "var(--line)";
        });
        item.addEventListener("mouseleave", () => {
          item.style.background = "transparent";
          item.style.borderColor = "transparent";
        });

        const nameEl = document.createElement("div");
        nameEl.textContent = name;
        nameEl.style.cssText =
          "font-size:12px;font-weight:600;line-height:1.3;word-break:break-word;";

        const metaEl = document.createElement("div");
        metaEl.textContent =
          `${srcLabel} · ${stepCount} step${stepCount === 1 ? "" : "s"}` +
          (p.author ? ` · @${p.author}` : "");
        metaEl.style.cssText =
          "font-family:var(--mono);font-size:9px;letter-spacing:0.08em;text-transform:uppercase;color:var(--dim);";

        item.appendChild(nameEl);
        item.appendChild(metaEl);
        item.onclick = async () => {
          try {
            _pipeline = _normalizeImportedPipeline(p);
          } catch (_) {
            _pipeline = p;
          }
          _expandedNodeIds.clear();
          await saveState();
          renderPipeline();
          libDropdown.classList.add("hidden");
          logToMonitor(
            "info-log",
            `Loaded "${name}" from library (${(_pipeline.steps || []).length} top-level steps).`,
          );
        };
        libList.appendChild(item);
      });

      if (githubError) {
        const note = document.createElement("div");
        note.textContent = "GitHub unreachable — showing local only.";
        note.style.cssText =
          "color: var(--red); font-size: 10px; padding: 6px 8px;";
        libList.appendChild(note);
      }
    });

    // Close dropdown when clicking outside
    document.addEventListener("click", (e) => {
      if (!libBtn.contains(e.target) && !libDropdown.contains(e.target)) {
        libDropdown.classList.add("hidden");
      }
    });
  }

  document
    .getElementById("btn-open-registry")
    ?.addEventListener("click", () => {
      chrome.tabs.create({
        url: chrome.runtime.getURL("site/dist/index.html"),
      });
    });

  document
    .getElementById("btn-download-pipeline")
    ?.addEventListener("click", async () => {
      if (!_pipeline.steps.length) {
        logToMonitor("warn-log", "Pipeline is empty.");
        return;
      }

      const payload = {
        ..._pipeline,
        meta: {
          exportedAt: new Date().toISOString(),
          source: "verquill-sidepanel",
        },
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `verquill_pipeline_${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      logToMonitor("info-log", "Pipeline JSON downloaded.");
    });

  document
    .getElementById("btn-download-partial")
    ?.addEventListener("click", () =>
      _downloadRunRows(_runState.runId ?? _lastRunId),
    );
}

function startMonitorTimer() {
  if (_runState.timer) clearInterval(_runState.timer);

  let ticks = 0;
  _runState.timer = setInterval(() => {
    const elapsed = Math.floor((Date.now() - _runState.startTs) / 1000);
    document.getElementById("mon-time").textContent =
      `${String(Math.floor(elapsed / 60)).padStart(2, "0")}:${String(elapsed % 60).padStart(2, "0")}`;

    // Every 5s, check the run still exists. _runStates in the service worker is
    // in-memory only, so an MV3 termination mid-run leaves this panel showing a
    // Stop button for a run that no longer exists and will never report
    // finishing. Polling also wakes the worker, so a run that is merely idle
    // between steps answers normally.
    if (++ticks % 5 === 0) _checkRunAlive();
  }, 1000);
}

/** Notice a run that the service worker has forgotten. */
async function _checkRunAlive() {
  if (!_runState.active || !_runState.runId) return;

  const res = await chrome.runtime
    .sendMessage({
      type: "pipeline:status",
      payload: { runId: _runState.runId },
    })
    .catch(() => null);

  // No answer at all: the worker is starting up. Try again on the next tick
  // rather than declaring the run dead.
  if (!res?.ok) return;
  if (res.result?.known) return;

  const lostRunId = _runState.runId;
  stopRunUI();
  document.getElementById("mon-state").textContent = "Interrupted";
  document.getElementById("mon-state").style.color = "var(--red)";
  logToMonitor(
    "error-log",
    "The background worker was shut down mid-run, so the pipeline stopped. " +
      "Rows collected up to that point are still recoverable.",
  );
  await _showResumeBanner();
  logToMonitor("info-log", `Interrupted run: ${lostRunId}`);
}
/** Reflect paused state in the button and the status card. */
function _setPausedUI(paused) {
  _runState.paused = paused;
  const btn = document.getElementById("btn-master-pause");
  if (btn) btn.textContent = paused ? "▶ Resume" : "⏸ Pause";

  const state = document.getElementById("mon-state");
  if (state && paused) {
    state.textContent = "Paused";
    state.style.color = "var(--yellow, #FACC15)";
  }
}

function stopRunUI() {
  _runState.active = false;
  _runState.paused = false;
  // The listener filters by runId, so leaving the finished run's id here meant
  // a late pipeline:log for it was still accepted and appended to a pane that
  // now describes nothing (E-19). The id is kept separately, because the rows
  // stay downloadable after the run ends and the button needs to name them.
  _lastRunId = _runState.runId ?? _lastRunId;
  _runState.runId = null;
  clearInterval(_runState.timer);
  _runState.timer = null;
  document.getElementById("btn-master-run").classList.remove("hidden");
  document.getElementById("run-controls")?.classList.add("hidden");
  _setPausedUI(false);
  document.getElementById("mon-state").textContent = "Stopped";
  document.getElementById("mon-state").style.color = "var(--text-dim)";
  document
    .querySelectorAll(".node-card")
    .forEach((n) => n.classList.remove("running"));
}

/**
 * Bring a card into view.
 *
 * The board used to be a pannable, zoomable canvas: a 1400x1200 stage
 * transformed inside a ~400px side panel. In a strip that narrow it did not
 * work — nodes sat outside the viewport with `overflow: hidden` clipping them,
 * which is why dropping a step into a loop body appeared to do nothing. The
 * board is a scrolling vertical list now, so "focus a node" is a scroll, and
 * the pan/zoom/wire machinery it replaced (about 200 lines and an SVG redraw
 * on every pointer move) is gone.
 */
function _focusNodeOnBoard(card) {
  if (!card) return;
  card.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

// ── Palette ───────────────────────────────────────────────────────────────────
function bindPalette() {
  document
    .getElementById("btn-close-palette")
    .addEventListener("click", () => elPalette.classList.remove("open"));
  elPaletteSearch.addEventListener("input", (e) => {
    const q = e.target.value.toLowerCase();
    document
      .querySelectorAll(".palette-category")
      .forEach((c) => (c.style.display = "none"));
    document.querySelectorAll(".palette-item").forEach((item) => {
      const match =
        item.dataset.type.toLowerCase().includes(q) ||
        item.dataset.desc.toLowerCase().includes(q);
      item.style.display = match ? "flex" : "none";
      if (match)
        item
          .closest(".palette-group")
          .querySelector(".palette-category").style.display = "block";
    });
  });
}
function populatePalette() {
  const cats = { Action: [], Flow: [], Data: [] };
  for (const [type, data] of Object.entries(STEP_REGISTRY))
    cats[data.cat].push({ type, ...data });
  let html = "";
  for (const [cat, items] of Object.entries(cats)) {
    html += `<div class="palette-group"><div class="palette-category">${cat}</div><div class="palette-grid">`;
    // A row per step, with the description the registry already carried and
    // the palette threw away — it was in a data- attribute for the search box
    // and nowhere a reader could see it. Three columns of emoji tiles in a
    // 400px panel wrapped "UPLOAD_ACTIVITY" onto three lines and told nobody
    // what any of it did.
    html += items
      .map(
        (
          i,
        ) => `<div class="palette-item" data-action="add-step" data-type="${i.type}" data-desc="${esc(i.desc)}">
      <span class="palette-item-bar" style="background:var(--step-${i.type});"></span>
      <span class="palette-item-text">
        <span class="palette-item-label">${i.type}</span>
        <span class="palette-item-desc">${esc(i.desc)}</span>
      </span></div>`,
      )
      .join("");
    html += `</div></div>`;
  }
  elPaletteContent.innerHTML = html;
  _makeKeyboardAccessible(elPaletteContent);
}

// ── Deep step helpers ─────────────────────────────────────────────────────────
/**
 * Every step in the board, loop children and both branches included.
 *
 * A gate that only walked the top level is exactly the hole B-03 found in the
 * domain lock: moving the step inside a LOOP got past it.
 *
 * @param {object[]} steps
 * @param {object[]} [out]
 * @returns {object[]}
 */
function _flattenSteps(steps, out = []) {
  for (const s of Array.isArray(steps) ? steps : []) {
    out.push(s);
    _flattenSteps(s.children, out);
    _flattenSteps(s.ifBranch, out);
    _flattenSteps(s.elseBranch, out);
  }
  return out;
}

function _findStepDeep(steps, id) {
  for (const s of steps) {
    if (s.id === id) return s;
    let found = null;
    if (s.children) found = _findStepDeep(s.children, id);
    if (!found && s.ifBranch) found = _findStepDeep(s.ifBranch, id);
    if (!found && s.elseBranch) found = _findStepDeep(s.elseBranch, id);
    if (found) return found;
  }
  return null;
}
function _removeStepDeep(steps, id) {
  for (let i = 0; i < steps.length; i++) {
    if (steps[i].id === id) {
      steps.splice(i, 1);
      return true;
    }
    if (steps[i].children && _removeStepDeep(steps[i].children, id))
      return true;
    if (steps[i].ifBranch && _removeStepDeep(steps[i].ifBranch, id))
      return true;
    if (steps[i].elseBranch && _removeStepDeep(steps[i].elseBranch, id))
      return true;
  }
  return false;
}

function _nextStepId() {
  return `s_${Date.now()}${Math.floor(Math.random() * 1000)}`;
}

/**
 * Show what an imported pipeline can do, and get an answer.
 *
 * Resolves true only when the person said yes to something they were shown.
 * A pipeline that reads credentials *and* talks to a site it never declared
 * resolves false without offering a button at all — that pairing is the shape
 * of account theft and has no version worth confirming. Everything short of it
 * is disclosed and left to the reader, because a gate that fires on everything
 * is one people learn to click through, and then it protects nobody.
 *
 * A pipeline with nothing worth saying loads with no interruption.
 */
function _reviewImport(pipeline, filename) {
  const analysis = analyzePipeline(pipeline);
  if (analysis.verdict === VERDICT.ALLOW) return Promise.resolve(true);

  const overlay = document.getElementById("import-review-overlay");
  const body = document.getElementById("import-review-body");
  const title = document.getElementById("import-review-title");
  const accept = document.getElementById("btn-import-accept");
  const reject = document.getElementById("btn-import-reject");
  const close = document.getElementById("btn-import-cancel");

  // No overlay in the document (a stripped test harness) is not a reason to
  // load an unreviewed pipeline. Fail closed and say why.
  if (!overlay || !body || !accept) {
    logToMonitor(
      "error-log",
      "Cannot review this import, so it was not loaded.",
    );
    return Promise.resolve(false);
  }

  const blocked = analysis.verdict === VERDICT.BLOCKED;
  overlay.classList.toggle("blocked", blocked);
  title.textContent = blocked
    ? "This pipeline was refused"
    : "Before you load this";

  const caps = analysis.capabilities
    .map(
      (c) =>
        `<div class="imp-cap imp-${c.severity}">
           <div class="imp-cap-rule"></div>
           <div>
             <div class="imp-cap-title">${esc(c.title)}</div>
             <div class="imp-cap-detail">${esc(c.detail)}</div>
           </div>
         </div>`,
    )
    .join("");

  body.innerHTML = blocked
    ? `<div class="imp-verdict imp-blocked">
         <b>Refused — not loaded</b>
         ${esc(analysis.blockedReason)}
       </div>${caps}`
    : `<div class="imp-verdict imp-review">
         <b>Read this first</b>
         ${esc(filename)} can do the following. None of it is refused, but it is
         worth agreeing to on purpose.
       </div>${caps}`;

  // A refused pipeline gets no "load anyway": the whole point is that this one
  // is not the reader's call to make under a persuasive listing.
  accept.style.display = blocked ? "none" : "";
  reject.textContent = blocked ? "Close" : "Don't load";

  overlay.classList.add("open");
  (blocked ? reject : accept).focus();

  return new Promise((resolve) => {
    const finish = (result) => {
      overlay.classList.remove("open", "blocked");
      accept.removeEventListener("click", onAccept);
      reject.removeEventListener("click", onReject);
      close?.removeEventListener("click", onReject);
      document.removeEventListener("keydown", onKey);
      resolve(result);
    };
    const onAccept = () => finish(!blocked);
    const onReject = () => finish(false);
    const onKey = (e) => {
      if (e.key === "Escape") finish(false);
    };

    accept.addEventListener("click", onAccept);
    reject.addEventListener("click", onReject);
    close?.addEventListener("click", onReject);
    document.addEventListener("keydown", onKey);
  });
}

function _normalizeImportedPipeline(source) {
  const input = source?.pipeline?.steps ? source.pipeline : source;
  if (!input || typeof input !== "object" || !Array.isArray(input.steps)) {
    throw new Error("Pipeline file must contain an object with a steps array.");
  }

  const seenIds = new Set();
  const steps = input.steps.map((step, index) =>
    _normalizeImportedStep(step, `steps[${index}]`, seenIds),
  );

  return {
    name: typeof input.name === "string" ? input.name : "Imported Pipeline",
    version: typeof input.version === "string" ? input.version : "1.0.0",
    targetOrigin:
      typeof input.targetOrigin === "string" ? input.targetOrigin : "",
    steps,
  };
}

function _normalizeImportedStep(step, where, seenIds) {
  if (!step || typeof step !== "object") {
    throw new Error(`${where} is not a valid step object.`);
  }

  const type = String(step.type || "")
    .trim()
    .toUpperCase();
  if (!type) {
    throw new Error(`${where} is missing a step type.`);
  }
  // Any uppercase string used to be accepted. It rendered with a "?" icon and
  // an undefined CSS colour, then failed at run time with "Unknown step type"
  // — long after the import said it had worked (D-09).
  if (!isKnownStepType(type)) {
    throw new Error(
      `${where} has an unknown step type "${type}". Known types: ${USER_STEP_TYPES.join(", ")}.`,
    );
  }
  if (STEP_TYPES[type].internal) {
    throw new Error(
      `${where} uses "${type}", which the executor dispatches internally and cannot be placed in a pipeline.`,
    );
  }

  // The id is the one imported value that reaches the DOM unescaped. It is
  // interpolated into `data-id="…"` and `id="cfg-…"` attributes in more than
  // sixty places across renderStepNode and generateConfigHtml, and unlike every
  // other untrusted value in this file it never passes through esc(). An id of
  //
  //   x" onmouseenter="…
  //
  // therefore closes the attribute and adds one of its own. The extension's CSP
  // (`script-src 'self'`, no unsafe-inline) stops that handler from running, so
  // this is attribute injection rather than script execution — but `data-id` is
  // the lookup key every step action uses (`target.dataset.id` → _findStepDeep),
  // so a crafted id lets one element carry another's identity, and the CSP is
  // the only thing standing between that and the rest.
  //
  // Escaping sixty-one call sites would leave the sixty-second to whoever adds
  // it next. Constraining the value where it enters means there is nothing to
  // escape: ids are ours to choose, an imported one is only a hint, and a
  // pipeline whose ids are rewritten still works because _normalizeImportedStep
  // already rewrites duplicates and remaps children to match.
  const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
  const offered =
    typeof step.id === "string" && step.id.trim() ? step.id.trim() : "";
  let id = SAFE_ID.test(offered) ? offered : "";
  if (!id || seenIds.has(id)) {
    id = _nextStepId();
  }
  seenIds.add(id);

  // Registry defaults first, then whatever the file supplied. An imported step
  // missing keys used to render a half-empty config form and hit undefined at
  // run time; now it looks exactly like one built in the palette (D-09).
  const normalized = {
    id,
    type,
    config: {
      ...defaultConfig(type),
      ...(step.config && typeof step.config === "object"
        ? JSON.parse(JSON.stringify(step.config))
        : {}),
    },
  };

  if (Array.isArray(step.children) || type === "LOOP") {
    normalized.children = Array.isArray(step.children)
      ? step.children.map((child, idx) =>
          _normalizeImportedStep(child, `${where}.children[${idx}]`, seenIds),
        )
      : [];
  }

  if (
    Array.isArray(step.ifBranch) ||
    Array.isArray(step.elseBranch) ||
    type === "IF_ELSE"
  ) {
    normalized.ifBranch = Array.isArray(step.ifBranch)
      ? step.ifBranch.map((child, idx) =>
          _normalizeImportedStep(child, `${where}.ifBranch[${idx}]`, seenIds),
        )
      : [];
    normalized.elseBranch = Array.isArray(step.elseBranch)
      ? step.elseBranch.map((child, idx) =>
          _normalizeImportedStep(child, `${where}.elseBranch[${idx}]`, seenIds),
        )
      : [];
  }

  return normalized;
}

// ── Add / remove / open palette ───────────────────────────────────────────────
function _addStep(type) {
  const newStep = {
    id: "s_" + Date.now() + Math.floor(Math.random() * 1000),
    type,
    config: { ...defaultConfig(type), optional: false },
  };
  if (type === "LOOP") {
    newStep.children = [];
  }
  if (type === "IF_ELSE") {
    newStep.ifBranch = [];
    newStep.elseBranch = [];
  }

  const { index, parentId, branchKey } = _insertCtx;
  if (parentId) {
    const parent = _findStepDeep(_pipeline.steps, parentId);
    if (parent && Array.isArray(parent[branchKey])) {
      index === -1
        ? parent[branchKey].push(newStep)
        : parent[branchKey].splice(index, 0, newStep);
    }
  } else {
    index === -1 || index >= _pipeline.steps.length
      ? _pipeline.steps.push(newStep)
      : _pipeline.steps.splice(Math.max(0, index), 0, newStep);
  }
  elPalette.classList.remove("open");
  _expandedNodeIds.add(newStep.id);
  saveState();
  renderPipeline();
}

function _openPalette(index, parentId = "", branchKey = "") {
  _insertCtx = { index, parentId, branchKey };
  elPaletteSearch.value = "";
  populatePalette();
  elPalette.classList.add("open");
  elPaletteSearch.focus();
}

// ── Pipeline renderer ─────────────────────────────────────────────────────────
function renderPipeline() {
  if (!_pipeline.steps.length) {
    // Three empty slots and a hint. The sparkle emoji this replaced said
    // nothing about what the board is for; the slots show its shape.
    elCanvas.innerHTML = `<div class="empty-state">
      <div class="empty-rack" aria-hidden="true"><span></span><span></span><span></span></div>
      <p class="prose empty-hint">A pipeline is a list of steps, run top to bottom.<br />Start with the page you want to open.</p>
      <button class="btn btn-accent" data-action="open-palette" data-index="-1" data-parent-id="" data-branch="">Add first step</button>
    </div>`;
    _makeKeyboardAccessible(elCanvas);
    return;
  }
  // Drop ids for steps that no longer exist. Removing a LOOP takes its
  // children with it, so pruning at the point of removal would mean walking
  // the deleted subtree; doing it here is one pass and self-healing, and it
  // also covers Clear and import. Without it the set grows for the life of the
  // panel and a re-used id would open a card nobody opened.
  const live = new Set();
  const collect = (steps) => {
    for (const s of steps || []) {
      live.add(s.id);
      collect(s.children);
      collect(s.ifBranch);
      collect(s.elseBranch);
    }
  };
  collect(_pipeline.steps);
  for (const id of _expandedNodeIds)
    if (!live.has(id)) _expandedNodeIds.delete(id);

  // innerHTML discards the scrolled position along with the nodes. A redraw
  // happens on add, remove and reorder — all of which the user performed at a
  // particular place in a long pipeline, and none of which is a reason to send
  // them back to the top.
  const viewport = elCanvas.closest("#board-viewport");
  const scrollTop = viewport?.scrollTop ?? 0;

  let html = `<div class="insert-step top-insert" data-action="open-palette" data-index="0" data-parent-id="" data-branch="">+</div>`;
  _pipeline.steps.forEach((step, i) => {
    html += renderStepNode(step, i, _pipeline.steps.length, "", "");
  });
  elCanvas.innerHTML = html;
  if (viewport) viewport.scrollTop = scrollTop;
  bindConfigInputs();
  bindDragAndDrop();
  _makeKeyboardAccessible(elCanvas);
}

function renderStepNode(step, index, total, parentId, branchKey) {
  const isExpanded = _expandedNodeIds.has(step.id);

  let html = `<div class="node-wrapper" data-index="${index}" data-id="${step.id}" data-parent-id="${parentId}" data-branch="${branchKey}">`;
  // One custom property carries the step's category colour; the stylesheet
  // spends it on the left bar, the glyph chip and the running state. It used
  // to also carry an inline `border-left`, which meant the card's own rules
  // could never restyle that edge.
  html += `<div class="node-card ${isExpanded ? "expanded" : ""}" style="--step-color:var(--step-${step.type});" draggable="true" data-drag-id="${step.id}" data-step-type="${step.type}">`;
  html += `<div class="node-header" data-action="toggle-expand" data-id="${step.id}">
    <div class="node-title-group">
      <div class="node-title">${stepCardTitle(step)}<span class="node-status-icon running-spinner">⏳</span></div>
      <div class="node-subtitle">${getStepSubtitle(step)}</div>
    </div>
    <div class="node-actions">
      <button class="btn-icon action-btn" data-action="test-step" data-id="${step.id}" title="Test Step">▶</button>
      <button class="btn-icon action-btn btn-icon-danger" data-action="remove-step" data-id="${step.id}" title="Remove">✕</button>
    </div>
  </div>`;
  html += `<div class="node-config">${generateConfigHtml(step)}</div>`;
  html += `</div>`; // end .node-card

  // LOOP container body
  if (step.type === "LOOP") {
    html += `<div class="loop-body">
      <div class="loop-scope-bar"></div>
      <div class="loop-body-inner" data-parent-id="${step.id}" data-branch="children">`;
    const children = step.children || [];
    children.forEach((child, ci) => {
      html += renderStepNode(child, ci, children.length, step.id, "children");
    });
    html += `<div class="insert-inner" data-action="open-palette" data-index="-1" data-parent-id="${step.id}" data-branch="children" title="Add step inside loop">+</div>`;
    html += `</div></div>`;
    html += `<div class="loop-end-marker">↩ LOOP END</div>`;
  }

  // IF_ELSE container branches
  if (step.type === "IF_ELSE") {
    html += `<div class="if-branches">`;
    for (const bk of ["ifBranch", "elseBranch"]) {
      const isIf = bk === "ifBranch";
      const branch = step[bk] || [];
      html += `<div class="if-branch ${isIf ? "if-true" : "if-false"}">`;
      html += `<div class="branch-header">${isIf ? "IF ✓ (met)" : "ELSE ✗ (not met)"}</div>`;
      html += `<div class="loop-body-inner" data-parent-id="${step.id}" data-branch="${bk}">`;
      branch.forEach((child, ci) => {
        html += renderStepNode(child, ci, branch.length, step.id, bk);
      });
      html += `<div class="insert-inner" data-action="open-palette" data-index="-1" data-parent-id="${step.id}" data-branch="${bk}" title="Add step in branch">+</div>`;
      html += `</div></div>`;
    }
    html += `</div>`;
    html += `<div class="ifelse-end-marker">↩ IF END</div>`;
  }

  // Bottom insert between steps
  html += `<div class="insert-step" data-action="open-palette" data-index="${index + 1}" data-parent-id="${parentId}" data-branch="${branchKey}">+</div>`;
  html += `</div>`; // end .node-wrapper
  return html;
}

/**
 * The card's human-facing name.
 *
 * The registry has carried an `icon` and a `desc` for every step type since it
 * was written, and the card used neither: it rendered `step.type`, so the most
 * visible text in the builder was AUTO_EXTRACT, UPLOAD_ACTIVITY and
 * PAGINATE_PROBE. The friendly name already existed and was being thrown away.
 *
 * The enum is demoted rather than dropped. It is what the docs, the exported
 * Playwright script and the run log all call the step, so someone reading any
 * of those needs to be able to find it on the board.
 */
function stepCardTitle(step) {
  const meta = STEP_TYPES[step.type] || {};
  const glyph = meta.icon
    ? `<span class="node-glyph" aria-hidden="true">${meta.icon}</span>`
    : "";
  // An unregistered type has no friendly name to fall back on, so it shows the
  // raw one rather than the word "undefined".
  const label = meta.desc || step.type;

  // The chip is only worth its space when the name does not already contain
  // the enum. "Smart Auto-Extract AUTO_EXTRACT" and "Loop / Repeat LOOP" say
  // the same thing twice; "Read the page's structured data" genuinely does not
  // tell you it is PAGE_DATA, which is what the exported script will call it.
  const flatten = (s) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const chip = flatten(label).includes(flatten(step.type))
    ? ""
    : `<span class="node-type">${esc(step.type)}</span>`;

  return `${glyph}<span class="node-label">${esc(label)}</span>${chip}`;
}

function getStepSubtitle(step) {
  const c = step.config;
  switch (step.type) {
    case "WEBSITE":
      return c.url || "No URL";
    case "NAVIGATE":
      return c.url || "No URL";
    case "API":
      return `${(c.method || "GET").toUpperCase()} ${c.url || "No URL"}`;
    case "CLICK":
      return c.selector
        ? `${c.all ? "All: " : ""}${c.selector}`
        : "No selector";
    case "FILL":
      return c.mode === "multi"
        ? `${(c.fields || []).length} fields`
        : c.selector || "No selector";
    case "WAIT":
      return `Wait ${c.ms}ms`;
    case "LOOP":
      return c.type === "elements" && !(c.max > 0)
        ? "elements mode · every match"
        : `${c.type} mode · max ${c.max}`;
    case "IF_ELSE":
      return `${c.condition}: ${c.selector || "?"}`;
    case "ASSERT":
      return `${c.assertion || "exists"}: ${c.selector || "?"}`;
    case "SOLVE_CAPTCHA":
      return _captchaAttest.attested
        ? `attested for ${_captchaAttest.host}`
        : "not attested — will refuse";
    case "UPLOAD_ACTIVITY": {
      const validIds = new Set(_storageFiles.map((f) => f.id));
      const selected = (c.fileIds || []).filter((id) => validIds.has(id));
      return `${selected.length} file(s) -> ${c.selector || "input[type=file]"}`;
    }
    case "AUTO_EXTRACT":
      return `AI Extract · conf≥${c.confidenceThreshold ?? 70}%`;
    default:
      return STEP_REGISTRY[step.type]?.desc || "";
  }
}

// ── Config HTML generators ────────────────────────────────────────────────────
/**
 * The config panel for one step: its own fields, then the options every page
 * step shares.
 *
 * The shared part is appended here rather than inside each of the twenty
 * type-specific blocks, because twenty copies of a toggle is twenty places for
 * one of them to be forgotten — which is precisely how IF_ELSE shipped without
 * the "optional" toggle (E-15).
 */
function generateConfigHtml(step) {
  let html = _configFields(step);
  if (STEP_TYPES[step.type]?.runsIn === "page") {
    html += toggle(step, "inFrame", "Look inside iframes as well");
    html += hint(
      "An iframe is a separate page embedded in this one, and its contents " +
        "are invisible to a selector by default — which is why nothing could " +
        "reach them. With this on, the step tries the page first and then each " +
        "frame, and uses the first one where the selector matches.",
    );
  }
  html += _retryFields(step);
  return html;
}

/**
 * Try again before giving up — offered on every step, like "optional".
 *
 * The two answer different questions and are often set together: retries are
 * for a step that works on the second attempt, "optional" for one whose failure
 * the run can live with. Appended here for the same reason the iframe toggle is
 * — twenty copies of a control is twenty places to forget one.
 */
function _retryFields(step) {
  const c = step.config;
  let html = field(
    step,
    "retries",
    `Retry on failure (0–${RETRY_LIMITS.maxRetries} times)`,
    "number",
    c.retries ?? 0,
  );
  html += field(
    step,
    "retryDelayMs",
    "Wait between attempts (ms)",
    "number",
    c.retryDelayMs ?? RETRY_LIMITS.defaultDelayMs,
  );
  html += hint(
    retryCount(c) > 0
      ? "A retry is a fresh attempt at the same step, paced like any other " +
          "request. A paused or stopped run does not retry."
      : "For a selector that is flaky rather than wrong — an image that " +
          "loads late, a panel that animates in. Leave at 0 to fail on the " +
          "first attempt.",
  );
  return html;
}

function _configFields(step) {
  const c = step.config;
  let html = "";

  // ── WEBSITE / NAVIGATE ──
  if (step.type === "WEBSITE" || step.type === "NAVIGATE") {
    html += field(
      step,
      "url",
      step.type === "WEBSITE" ? "Website URL" : "URL",
      "text",
      c.url || "",
    );
    html += toggle(step, "wait", "Wait for page load");
    if (c.wait !== false) {
      html += field(
        step,
        "timeoutMs",
        "Give up waiting after (ms)",
        "number",
        c.timeoutMs ?? 30000,
      );
      html += hint(
        "The run polls until the tab reports it has finished loading, then " +
          "moves on. Past this it continues anyway and says so in the log.",
      );
    }
    html += toggle(
      step,
      "optional",
      "Optional — keep going if this step fails",
    );
    return html;
  }

  // ── API ──
  if (step.type === "API") {
    html += field(step, "url", "API URL", "text", c.url || "");
    html += `<label>Method</label><select id="cfg-${step.id}-method" data-id="${step.id}" data-key="method" class="cfg-bind" style="margin-bottom:8px;">
      <option value="GET" ${(c.method || "GET") === "GET" ? "selected" : ""}>GET</option>
      <option value="POST" ${c.method === "POST" ? "selected" : ""}>POST</option>
      <option value="PUT" ${c.method === "PUT" ? "selected" : ""}>PUT</option>
      <option value="PATCH" ${c.method === "PATCH" ? "selected" : ""}>PATCH</option>
      <option value="DELETE" ${c.method === "DELETE" ? "selected" : ""}>DELETE</option>
    </select>`;
    html += `<label>Headers (JSON)</label>
      <textarea id="cfg-${step.id}-headers" data-id="${step.id}" data-key="headers" class="cfg-bind" rows="3" style="margin-bottom:8px;">${esc(c.headers || '{"Accept":"application/json"}')}</textarea>`;
    html += `<label>Body (JSON or text)</label>
      <textarea id="cfg-${step.id}-body" data-id="${step.id}" data-key="body" class="cfg-bind" rows="3" style="margin-bottom:8px;">${esc(c.body || "")}</textarea>`;
    html += field(
      step,
      "timeoutMs",
      "Timeout (ms)",
      "number",
      c.timeoutMs ?? 15000,
    );
    html += `<label>Response Type</label><select id="cfg-${step.id}-responseType" data-id="${step.id}" data-key="responseType" class="cfg-bind" style="margin-bottom:8px;">
      <option value="auto" ${(c.responseType || "auto") === "auto" ? "selected" : ""}>Auto</option>
      <option value="json" ${c.responseType === "json" ? "selected" : ""}>JSON</option>
      <option value="text" ${c.responseType === "text" ? "selected" : ""}>Text</option>
    </select>`;
    html += field(
      step,
      "storeAs",
      "Store Result As",
      "text",
      c.storeAs || "api",
    );
    html += toggle(step, "failOnHttpError", "Fail on non-2xx status");
    html += toggle(
      step,
      "exposeBodyAsExtracted",
      "Merge JSON body into extracted context",
    );
    html += toggle(
      step,
      "optional",
      "Optional — keep going if this step fails",
    );
    return html;
  }

  // ── CLICK ──
  if (step.type === "CLICK") {
    html += selectorRow(step, "selector");
    html += toggle(step, "all", "Click ALL matching elements");
    html += toggle(
      step,
      "fallbackToLoopItem",
      "Inside a loop, click the item itself if the selector misses",
    );

    const button = c.button || "left";
    html += `<label>Mouse button</label>
    <select id="cfg-${step.id}-button" data-id="${step.id}" data-key="button" data-rerender="true" class="cfg-bind" style="margin-bottom:8px;">
      <option value="left"${button === "left" ? " selected" : ""}>Left</option>
      <option value="middle"${button === "middle" ? " selected" : ""}>Middle</option>
      <option value="right"${button === "right" ? " selected" : ""}>Right</option>
    </select>`;
    html += `<label>Keys held while clicking</label>`;
    html += memberToggle(step, "modifiers", "ctrl", "Ctrl");
    html += memberToggle(step, "modifiers", "shift", "Shift");
    html += memberToggle(step, "modifiers", "alt", "Alt");
    html += memberToggle(step, "modifiers", "meta", "Cmd / Meta");
    if (button !== "left" || (c.modifiers || []).length) {
      html += hint(
        "These reach the page's own handlers — a custom context menu, ctrl-click " +
          "multi-select. They will not make Chrome open a tab or show its own menu: " +
          "the browser keeps those reactions for real clicks, and an extension cannot " +
          "fake one.",
      );
    }

    // "Load more" finishes after the click returns. Naming what to wait for
    // beats a WAIT step holding a guessed number of milliseconds.
    const waitAfter = c.waitAfter || "none";
    html += `<label>After the click, wait for</label>
    <select id="cfg-${step.id}-waitAfter" data-id="${step.id}" data-key="waitAfter" data-rerender="true" class="cfg-bind" style="margin-bottom:8px;">
      <option value="none"${waitAfter === "none" ? " selected" : ""}>Nothing — carry straight on</option>
      <option value="load"${waitAfter === "load" ? " selected" : ""}>The page to finish loading</option>
      <option value="selector"${waitAfter === "selector" ? " selected" : ""}>An element to appear</option>
      <option value="selector-gone"${waitAfter === "selector-gone" ? " selected" : ""}>An element to disappear</option>
      <option value="settle"${waitAfter === "settle" ? " selected" : ""}>The page to stop changing</option>
    </select>`;
    if (waitAfter === "selector" || waitAfter === "selector-gone") {
      html += selectorRow(step, "waitSelector", "Element to wait for");
    }
    if (waitAfter !== "none") {
      html += field(
        step,
        "waitTimeoutMs",
        "Give up after (ms)",
        "number",
        c.waitTimeoutMs ?? 15000,
      );
    }
    html += hint(
      "A click that follows a link waits for the new page whatever is chosen here — " +
        "the next step running against a half-replaced page is the one failure you cannot see.",
    );

    html += toggle(
      step,
      "optional",
      "Optional — keep going if this step fails",
    );
    return html;
  }

  // ── FILL (single + multi) ──
  if (step.type === "FILL") {
    const mode = c.mode || "single";
    html += `<div class="mode-toggle" style="margin-bottom:8px;">
      <button class="btn ${mode === "single" ? "btn-primary" : ""}" data-action="set-fill-mode" data-id="${step.id}" data-mode="single">Single Field</button>
      <button class="btn ${mode === "multi" ? "btn-primary" : ""}" data-action="set-fill-mode" data-id="${step.id}" data-mode="multi">Multi Fields</button>
    </div>`;
    if (mode === "single") {
      html += selectorRow(step, "selector");
      html += field(step, "text", "Text to type", "text", c.text || "");
      html += field(
        step,
        "delayMs",
        "Delay per char (ms)",
        "number",
        c.delayMs ?? 50,
      );
      html += toggle(step, "append", "Append (don't clear field)");
    } else {
      // multi mode
      html += toggle(step, "append", "Append to ALL fields (don't clear)");
      html += `<div id="fill-fields-${step.id}" style="margin-bottom:8px;">`;
      (c.fields || []).forEach((f, fi) => {
        html += `<div class="fill-field-row">
          <input type="text" class="field-edit" data-id="${step.id}" data-index="${fi}" data-prop="selector" value="${esc(f.selector || "")}" placeholder="selector" style="flex:1.5;font-size:10px;">
          <input type="text" class="field-edit" data-id="${step.id}" data-index="${fi}" data-prop="value" value="${esc(f.value || "")}" placeholder="value" style="flex:2;">
          <button class="btn btn-icon" style="color:var(--red);" data-action="remove-fill-field" data-id="${step.id}" data-index="${fi}">✕</button>
        </div>`;
      });
      html += `</div>
      <div class="flex gap-2" style="align-items:flex-end;margin-bottom:8px;">
        <div style="flex:1"><label style="margin-top:0;">Value</label><input type="text" id="new-fill-val-${step.id}" placeholder="e.g. John Doe"></div>
        <button class="btn btn-primary" data-action="add-fill-field" data-id="${step.id}" style="height:28px;">Pick Field</button>
      </div>`;
      html += `<label style="margin-top:6px;">Submit Button Selector (optional)</label>`;
      html += selectorRow(step, "submitSelector");
    }
    html += toggle(
      step,
      "optional",
      "Optional — keep going if this step fails",
    );
    return html;
  }

  // ── KEYBOARD ──
  if (step.type === "KEYBOARD") {
    html += `<label>Key to Press</label>
    <div class="flex gap-2" style="margin-bottom:6px;align-items:center;">
      <div class="key-display" id="key-disp-${step.id}">${esc(c.key || "Not set")}</div>
      <button class="btn key-register-btn" id="key-reg-${step.id}" data-action="register-key" data-id="${step.id}">Register Key</button>
    </div>`;
    // Typed as well as captured: Ctrl+W and its friends cannot be pressed here
    // at all — Chrome closes the tab before this page sees the key.
    html += `<div class="flex gap-2" style="margin-bottom:8px;align-items:center;">
      <span style="flex:0 0 auto;font-size:10px;color:var(--text-dim);">or type it instead</span>
      <input type="text" class="key-manual-input" data-id="${step.id}"
        value="${esc(c.key || "")}" placeholder="Ctrl+Shift+K" style="flex:1;font-size:11px;">
    </div>`;
    if (_isBrowserReservedKey(c.key)) {
      html += `<div style="background:rgba(245,158,11,0.10);border:1px solid rgba(245,158,11,0.35);border-radius:6px;padding:8px 10px;margin-bottom:10px;font-size:11px;color:var(--text-dim);line-height:1.5;">
        <b>${esc(c.key)} is a browser shortcut.</b> Chrome acts on it before the
        page does, so pressing it here would ${esc(c.key).toLowerCase().includes("w") ? "close the tab" : "open a tab or window"}
        rather than register it — type it in the box instead. The step still
        sends it to the page, which works if the page listens for it, but the
        browser's own action cannot be suppressed by any extension.
      </div>`;
    }
    html += `<label>Send it to <span style="color:var(--text-dim);font-weight:400;">(optional)</span></label>`;
    html += selectorRow(step, "selector");
    html += hint(
      "Leave blank to send the key wherever the page currently has focus. " +
        "Naming an element focuses it first — which is what a search box needs " +
        "before it will accept Enter.",
    );
    html += field(
      step,
      "repeat",
      "Press this many times",
      "number",
      c.repeat ?? 1,
    );
    if ((c.repeat ?? 1) > 1) {
      html += field(
        step,
        "delayMs",
        "Wait between presses (ms)",
        "number",
        c.delayMs ?? 50,
      );
    }
    html += toggle(
      step,
      "optional",
      "Optional — keep going if this step fails",
    );
    return html;
  }

  // ── LOOP ──
  if (step.type === "LOOP") {
    const ltype = c.type || "elements";
    html += `<label>Iteration Mode</label>
    <select id="cfg-${step.id}-type" data-id="${step.id}" data-key="type" data-rerender="true" class="cfg-bind" style="margin-bottom:8px;">
      <option value="elements" ${ltype === "elements" ? "selected" : ""}>Loop through Elements (auto-count)</option>
      <option value="count"    ${ltype === "count" ? "selected" : ""}>Fixed Count (N times)</option>
      <option value="list"     ${ltype === "list" ? "selected" : ""}>Loop through a list you supply</option>
      <option value="paginate" ${ltype === "paginate" ? "selected" : ""}>Paginate (click Next)</option>
      <option value="paginate-links" ${ltype === "paginate-links" ? "selected" : ""}>Paginate (numbered page links)</option>
      <option value="paginate-url" ${ltype === "paginate-url" ? "selected" : ""}>Paginate (URL pattern)</option>
    </select>`;
    if (ltype === "elements") {
      html += `<div style="background:rgba(99,102,241,0.08);border:1px solid var(--step-LOOP,#6366F1);border-radius:4px;padding:6px 10px;font-size:11px;color:var(--step-LOOP,#6366F1);margin-bottom:8px;">
        Iterates over ALL matched elements automatically.</div>`;
      html += selectorRow(step, "selector");
      html += field(
        step,
        "max",
        "Safety max (0 = every match)",
        "number",
        c.max ?? 0,
      );
    } else if (ltype === "count") {
      // 0 is only "unlimited" in elements mode, where the page supplies the
      // bound. Here it means zero iterations, so do not offer it as a default
      // when switching over from elements mode (B-22).
      html += field(
        step,
        "max",
        "Repeat N times (at least 1)",
        "number",
        c.max > 0 ? c.max : 10,
      );
    } else if (ltype === "list") {
      const source = c.source || "lines";
      html += `<div class="step-note">
        <div class="step-note-title">Walk a list, not the page</div>
        <p class="prose">Every other mode takes its count from the page. This one takes it from you — 500 product URLs, a column out of a spreadsheet, or the rows an earlier API step returned. Each item reaches the steps below as <code>{{item.value}}</code>, and a delimited paste also gives you <code>{{item.&lt;column&gt;}}</code>.</p>
      </div>`;
      html += `<label>Where the list comes from</label>
      <select id="cfg-${step.id}-source" data-id="${step.id}" data-key="source" data-rerender="true" class="cfg-bind" style="margin-bottom:8px;">
        <option value="lines"${source === "lines" ? " selected" : ""}>Lines I paste here</option>
        <option value="context"${source === "context" ? " selected" : ""}>Something an earlier step produced</option>
      </select>`;

      if (source === "context") {
        html += field(
          step,
          "contextPath",
          "Where to read it from",
          "text",
          c.contextPath || "",
        );
        html += hint(
          "A dotted path into what the run holds: api.rows after an API step, " +
            "pageData.records after PAGE_DATA. The step that stores it has to " +
            "run before this loop.",
        );
        html += `<p style="font-size:11px;color:var(--amber,#d97706);margin:-4px 0 10px;">This mode cannot be exported as a script: a standalone script has no run to read from. A pasted list exports fine.</p>`;
      } else {
        html += `<label>The list, one item per line</label>
        <textarea id="cfg-${step.id}-lines" data-id="${step.id}" data-key="lines" class="cfg-bind" rows="6" placeholder="https://example.com/p/1&#10;https://example.com/p/2" style="margin-bottom:8px;">${esc(c.lines || "")}</textarea>`;
        html += field(
          step,
          "delimiter",
          "Split each line on (leave empty for whole lines)",
          "text",
          c.delimiter || "",
        );
        if (c.delimiter) {
          html += toggle(step, "hasHeader", "The first line names the columns");
        }

        // A preview, because a delimiter that splits in the wrong place shifts
        // every column after it and nothing about the resulting scrape says so.
        const parsed = parseListLines(c.lines, {
          delimiter: c.delimiter,
          hasHeader: c.hasHeader === true,
        });
        if (parsed.items.length) {
          const first = parsed.items[0];
          const shown = parsed.columns
            .map((col) => `{{item.${col}}} = ${String(first[col] ?? "")}`)
            .slice(0, 6)
            .join("  ·  ");
          html += `<p style="font-size:11px;color:var(--text-dim);margin:-4px 0 10px;">${parsed.items.length} item${parsed.items.length === 1 ? "" : "s"}. First one: ${esc(shown)}</p>`;
        }
      }
      html += field(
        step,
        "max",
        "Safety max (0 = every item)",
        "number",
        c.max ?? 0,
      );
    } else if (ltype === "paginate-links") {
      html += `<div class="step-note">
        <div class="step-note-title">Walk a row of page numbers</div>
        <p class="prose">For a paginator that shows 1 2 3 4 5 rather than a Next button. Pick the links themselves — all of them, not one — and the body below runs once per link. There is nothing to detect the end with here, so the number of links is the number of pages.</p>
      </div>`;
      html += selectorRow(step, "selector", "The page-number links");
      html += field(
        step,
        "max",
        "Max pages (0 = every link found)",
        "number",
        c.max ?? 0,
      );
      html += field(
        step,
        "settleMs",
        "Wait after each page loads (ms)",
        "number",
        c.settleMs ?? 1500,
      );
    } else if (ltype === "paginate-url") {
      html += `<div class="step-note">
        <div class="step-note-title">Fill the page number into a URL</div>
        <p class="prose">When the address bar carries the page — <code>?page=2</code>, <code>/page/2</code>. No selector needed, and unlike the other modes this one can start at page 40 without walking there first.</p>
      </div>`;
      html += field(
        step,
        "urlTemplate",
        "URL with {page} where the number goes",
        "text",
        c.urlTemplate ?? "",
      );
      html += field(
        step,
        "startPage",
        "First page",
        "number",
        c.startPage ?? 1,
      );
      html += field(
        step,
        "pageStep",
        "Count by (1, or 10 for offset-style URLs)",
        "number",
        c.pageStep ?? 1,
      );
      html += field(
        step,
        "max",
        "How many pages (at least 1)",
        "number",
        c.max > 0 ? c.max : 5,
      );
      html += field(
        step,
        "settleMs",
        "Wait after each page loads (ms)",
        "number",
        c.settleMs ?? 1500,
      );
      html += toggle(step, "stopWhenEmpty", "Stop when a page has no rows");
      html += hint(
        c.stopWhenEmpty === false
          ? "Off: all the pages above are fetched, empty or not. Ask for exactly " +
              "as many as the site has."
          : "This mode cannot ask the site how many pages there are, so a page " +
              "that produces nothing is the signal that they have run out. " +
              "Turn off if the loop's rows come from somewhere else.",
      );
    } else {
      // paginate
      html += `<div class="step-note">
        <div class="step-note-title">Click Next until the pages run out</div>
        <p class="prose">Pick the site's Next control — the "&rsaquo;", "Next" or "&raquo;" link. The body below runs once per page. It stops on its own when there is no next page, so Max pages is only a safety limit.</p>
      </div>`;
      html += selectorRow(step, "selector", "Next button");
      html += field(
        step,
        "max",
        "Max pages (safety limit)",
        "number",
        c.max ?? 10,
      );
      html += field(
        step,
        "settleMs",
        "Wait after each page loads (ms)",
        "number",
        c.settleMs ?? 1500,
      );
      html += toggle(
        step,
        "requireChange",
        "Stop if the page does not change (for Next buttons that are never disabled)",
      );
    }
    html += `<label>On iteration failure</label>
    <select id="cfg-${step.id}-onFail" data-id="${step.id}" data-key="onFail" class="cfg-bind" style="margin-bottom:8px;">
      <option value="skip" ${(c.onFail || "skip") === "skip" ? "selected" : ""}>Skip and continue</option>
      <option value="stop" ${c.onFail === "stop" ? "selected" : ""}>Stop loop, keep data</option>
    </select>`;
    html += toggle(
      step,
      "optional",
      "Optional — keep going if this step fails",
    );
    return html;
  }

  // ── SOLVE_CAPTCHA ──
  if (step.type === "SOLVE_CAPTCHA") {
    const host = _captchaAttest.host || "this domain";
    html += hint(
      "Answers the written challenges a small site writes itself — " +
        '"what is 3 + 4", "how many letters in CAT" — on this machine, with ' +
        "no service and no key. Everything else pauses the run and asks you, " +
        "exactly as it does without this step.",
    );
    html += `<div class="toggle-wrap">
      <input type="checkbox" class="captcha-attest" data-id="${step.id}" ${_captchaAttest.attested ? "checked" : ""}>
      <div class="toggle-switch"></div>
      <span>I own ${esc(host)}, have permission to automate it, or the account is my own</span>
    </div>`;
    html += hint(
      _captchaAttest.attested
        ? `Recorded for ${host}. It stays until you switch it off here, and it covers no other domain.`
        : `Without this the step refuses and says so. It is asked once per domain, and it is about ${host}, not about this pipeline.`,
    );
    html += selectorRow(step, "submitSelector", "Submit button (optional)");
    html += hint(
      "Left empty, the answer is typed and nothing is pressed — the next step " +
        "in the pipeline submits the form.",
    );
    html += toggle(
      step,
      "optional",
      "Optional — keep going if this step fails",
    );
    return html;
  }

  // ── ASSERT ──
  if (step.type === "ASSERT") {
    const kind = c.assertion || "exists";
    const meta = ASSERTIONS[kind] ?? ASSERTIONS.exists;
    html += `<label>Check</label>
    <select id="cfg-${step.id}-assertion" data-id="${step.id}" data-key="assertion" data-rerender="true" class="cfg-bind" style="margin-bottom:8px;">
      ${Object.entries(ASSERTIONS)
        .map(
          ([name, m]) =>
            `<option value="${name}" ${kind === name ? "selected" : ""}>${esc(m.label)}</option>`,
        )
        .join("")}
    </select>`;
    html += selectorRow(step, "selector");

    if (meta.needs === "count") {
      html += field(step, "count", "How many", "number", c.count ?? 1);
      if (!Number.isFinite(Number(String(c.count ?? "").trim()))) {
        html += `<p style="font-size:11px;color:var(--red);margin:-4px 0 8px 0;">Not a number — the step would fail on any page.</p>`;
      }
    }
    if (meta.needs === "value") {
      html += field(step, "value", "Expected text", "text", c.value || "");
      html += hint(
        "Compared against the first match, with runs of whitespace treated " +
          "as one space.",
      );
    }
    html += hint(
      "A failed check stops the run and says why, instead of letting it " +
        "export rows the page never had. Mark it optional to log the failure " +
        "and carry on.",
    );
    html += toggle(
      step,
      "optional",
      "Optional — keep going if this step fails",
    );
    return html;
  }

  // ── IF_ELSE ──
  if (step.type === "IF_ELSE") {
    const cond = c.condition || "exists";
    // Built from the registry, so a condition cannot exist without the panel
    // offering it, and each one says which inputs it needs — which is how
    // "Attr" once shipped with nowhere to type the attribute name (B-07).
    const meta = CONDITIONS[cond] ?? CONDITIONS.exists;
    html += `<label>Condition</label>
    <select id="cfg-${step.id}-condition" data-id="${step.id}" data-key="condition" data-rerender="true" class="cfg-bind" style="margin-bottom:8px;">
      ${Object.entries(CONDITIONS)
        .map(
          ([name, m]) =>
            `<option value="${name}" ${cond === name ? "selected" : ""}>${esc(m.label)}</option>`,
        )
        .join("")}
    </select>`;
    html += selectorRow(step, "selector");

    if (meta.needs === "attr" || meta.needs === "attr+value") {
      html += field(step, "attr", "Attribute name", "text", c.attr || "");
      html += hint("For example href, src, data-id, aria-expanded.");
    }
    if (meta.needs === "value" || meta.needs === "attr+value") {
      const numeric = cond.startsWith("number-");
      const against = c.compareTo === "selector" ? "selector" : "value";
      html += `<label>Compare against</label>
      <select id="cfg-${step.id}-compareTo" data-id="${step.id}" data-key="compareTo" data-rerender="true" class="cfg-bind" style="margin-bottom:8px;">
        <option value="value"${against === "value" ? " selected" : ""}>A value I type</option>
        <option value="selector"${against === "selector" ? " selected" : ""}>Another element on the page</option>
      </select>`;

      if (against === "selector") {
        html += selectorRow(
          step,
          "valueSelector",
          "Element to compare against",
        );
        html += hint(
          "Both elements are read in the same moment, so a page that updates " +
            "itself cannot be compared against its own earlier state. If nothing " +
            "matches, the ELSE branch is taken and the log says why.",
        );
        html += toggle(
          step,
          "optional",
          "Optional — keep going if this step fails",
        );
        return html;
      }

      html += field(
        step,
        "value",
        numeric ? "Compare against (a number)" : "Value to compare",
        "text",
        c.value || "",
      );
      if (numeric) {
        html += hint(
          'The number is read out of the text around it, so "$25.50" is 25.5. ' +
            "Text with no number in it never matches — it is not treated as zero.",
        );
        if (c.value && !Number.isFinite(Number(String(c.value).trim()))) {
          html += `<p style="font-size:11px;color:var(--red);margin:-4px 0 8px 0;">Not a number — this branch would fail and always take ELSE.</p>`;
        }
      } else if (cond === "text-matches") {
        html += hint(
          "A regular expression, tested against the element's text.",
        );
        if (c.value && !isValidRegex(c.value)) {
          html += `<p style="font-size:11px;color:var(--red);margin:-4px 0 8px 0;">Not a valid pattern — this branch would fail and always take ELSE.</p>`;
        }
      }
    }
    if (meta.needs === "none" && cond !== "exists" && cond !== "not-exists") {
      html += hint(
        cond === "is-empty"
          ? 'True when the element is missing, empty, or holds only whitespace — all three are "there is nothing here".'
          : "True only when the element is there and has some text in it.",
      );
    }

    html += `<p style="font-size:11px;color:var(--text-dim);margin-top:8px;margin-bottom:0;">
      Add steps in the <b>IF ✓</b> and <b>ELSE ✗</b> blocks below the card.</p>`;
    // Every other step type ends with this; IF_ELSE was the only one without it,
    // so a branch whose selector was missing took the whole run down with no way
    // to mark it tolerable (E-15).
    html += toggle(
      step,
      "optional",
      "Optional — keep going if this step fails",
    );
    return html;
  }

  // ── SCROLL ──
  if (step.type === "SCROLL") {
    html += `<label>Mode</label><select id="cfg-${step.id}-mode" data-id="${step.id}" data-key="mode" data-rerender="true" class="cfg-bind" style="margin-bottom:8px;">
      <option value="pixel"   ${(c.mode || "pixel") === "pixel" ? "selected" : ""}>Pixel (scroll by amount)</option>
      <option value="percent" ${c.mode === "percent" ? "selected" : ""}>Percent of page</option>
      <option value="selector"${c.mode === "selector" ? "selected" : ""}>To element (selector)</option>
      <option value="infinite"${c.mode === "infinite" ? "selected" : ""}>Infinite — load everything</option>
    </select>`;
    if (c.mode === "selector") {
      html += selectorRow(step, "selector");
    } else if (c.mode === "infinite") {
      html += hint(
        "Scrolls to the bottom over and over until the page stops growing — " +
          "for feeds and 'load more' lists. One step replaces a stack of them.",
      );
      html += field(
        step,
        "maxScrolls",
        "Stop after this many scrolls",
        "number",
        c.maxScrolls ?? 50,
      );
      html += field(
        step,
        "settleMs",
        "Wait after each scroll (ms)",
        "number",
        c.settleMs ?? 1200,
      );
      html += `<label>Item selector <span style="color:var(--text-dim);font-weight:400;">(optional)</span></label>`;
      html += selectorRow(step, "selector");
      html += hint(
        "Given one, growth is measured in items rather than page height — " +
          "more reliable on a feed that swaps placeholders for cards.",
      );
      html += `<label>Container <span style="color:var(--text-dim);font-weight:400;">(optional)</span></label>`;
      html += selectorRow(step, "container");
      html += hint(
        "For a feed inside its own scrolling div rather than the whole page — " +
          "growth is measured on this element instead of the document.",
      );
    } else {
      html += field(step, "amount", "Amount", "number", c.amount ?? 500);
      if ((c.mode || "pixel") === "pixel" || c.mode === "percent") {
        html += `<label>Container <span style="color:var(--text-dim);font-weight:400;">(optional)</span></label>`;
        html += selectorRow(step, "container");
        html += hint(
          "Scrolls this element instead of the page — for a feed with its own scrollbar.",
        );
      }
    }
    html += toggle(
      step,
      "optional",
      "Optional — keep going if this step fails",
    );
    return html;
  }

  // ── EXPORT ──
  if (step.type === "EXPORT") {
    html += `<label>Format</label><select id="cfg-${step.id}-format" data-id="${step.id}" data-key="format" data-rerender="true" class="cfg-bind" style="margin-bottom:8px;">
      ${ROW_FORMATS.map(
        (f) =>
          `<option value="${f}" ${(c.format || "csv") === f ? "selected" : ""}>${esc(formatMeta(f).label)}</option>`,
      ).join("")}
    </select>`;

    const canAppend = APPENDABLE_FORMATS.includes(c.format || "csv");
    if (canAppend) {
      html += toggle(step, "append", "Add to a dataset instead of a new file", {
        rerender: true,
      });
    } else if (c.append) {
      // The toggle is on and the format cannot carry it. Say so here rather
      // than letting the run fail at the last step, after all the scraping.
      html += `<p style="font-size:11px;color:var(--red);margin:0 0 8px;">Appending is on, but ${esc(formatMeta(c.format).label)} cannot be added to a file a run at a time — a JSON array, an XML tree and a Markdown table each have to be rewritten whole. Choose ${esc(APPENDABLE_FORMATS.join(", ").toUpperCase())}, or turn appending off.</p>`;
      html += toggle(step, "append", "Add to a dataset instead of a new file", {
        rerender: true,
      });
    }

    if (canAppend && c.append) {
      html += field(step, "dataset", "Dataset name", "text", c.dataset || "");
      html += hint(
        "Every run adds its rows to this dataset and writes the whole thing out " +
          "as one file. The file is replaced each time rather than added to — an " +
          "extension cannot read what is already in your Downloads folder — so " +
          "anything you edit into it by hand is lost on the next run. The upside " +
          "is that a page that gains a column mid-week gets that column, which a " +
          "real append could never do.",
      );
    }

    html += toggle(
      step,
      "optional",
      "Optional — keep going if this step fails",
    );
    return html;
  }

  // ── UPLOAD_ACTIVITY ──
  if (step.type === "UPLOAD_ACTIVITY") {
    const validIds = new Set(_storageFiles.map((f) => f.id));
    const selectedIds = Array.isArray(c.fileIds)
      ? c.fileIds.filter((id) => validIds.has(id))
      : [];

    const upMode = c.mode === "drop" ? "drop" : "input";
    html += `<label>How the page takes files</label>
    <select id="cfg-${step.id}-mode" data-id="${step.id}" data-key="mode" data-rerender="true" class="cfg-bind" style="margin-bottom:8px;">
      <option value="input"${upMode === "input" ? " selected" : ""}>It has a file input</option>
      <option value="drop"${upMode === "drop" ? " selected" : ""}>It is a drop zone with no file input</option>
    </select>`;
    html += selectorRow(
      step,
      "selector",
      upMode === "drop" ? "The drop zone" : "The file input",
    );
    if (upMode === "drop") {
      html += hint(
        "For a widget built on the drop event, which has no input whose files " +
          "could be set. Pick the zone itself. If nothing on the page handles the " +
          "drop the step fails and says so, rather than reporting an upload that " +
          "never happened.",
      );
    }

    html += `<div class="flex gap-2" style="margin-bottom:8px;">
      <button class="btn" data-action="upload-step-select-all" data-id="${step.id}">Select All Storage Files</button>
      <button class="btn" data-action="upload-step-clear" data-id="${step.id}">Clear</button>
    </div>`;

    html += `<div style="margin-bottom:8px; font-size:12px; color: var(--text-dim);">Selected: <span class="mono">${selectedIds.length}</span></div>`;

    if (!_storageFiles.length) {
      html += `<div class="empty-inline">No files in Storage library. Add files in the Storage tab first.</div>`;
    } else {
      html += `<div class="file-selector-list" style="max-height:160px; margin-bottom:8px;">`;
      html += _storageFiles
        .map((file) => {
          const checked = selectedIds.includes(file.id) ? "checked" : "";
          return `<label class="selector-item" style="display:flex; gap:8px; align-items:flex-start;">
            <input class="upload-step-file-check" data-step-id="${step.id}" data-file-id="${file.id}" type="checkbox" ${checked} style="margin-top:3px;" />
            <div>
              <div class="mono" style="font-size:12px;">${esc(file.name)}</div>
              <div class="storage-meta">${esc(file.type || "application/octet-stream")} · ${_formatBytes(file.size)}</div>
            </div>
          </label>`;
        })
        .join("");
      html += `</div>`;
    }

    html += toggle(
      step,
      "optional",
      "Optional — keep going if this step fails",
    );
    return html;
  }

  // ── EXTRACT ──
  if (step.type === "EXTRACT") {
    html += `<div id="extract-fields-${step.id}">`;
    (c.fields || []).forEach((f, fi) => {
      html += `<div class="flex gap-2" style="margin-bottom:4px;align-items:center;">
        <input type="text" class="field-edit" data-id="${step.id}" data-index="${fi}" data-prop="name" value="${esc(f.name || "")}" placeholder="name" style="flex:1;">
        <input type="text" class="field-edit" data-id="${step.id}" data-index="${fi}" data-prop="selector" value="${esc(f.selector || "")}" placeholder="selector" style="flex:2;">
        <select class="extract-type-select" data-id="${step.id}" data-index="${fi}" style="flex:0.8;font-size:11px;padding:4px 6px;">
          <option value="text" ${(f.type || "text") === "text" ? "selected" : ""}>Text</option>
          <option value="html" ${f.type === "html" ? "selected" : ""}>HTML</option>
          <option value="attribute" ${f.type === "attribute" ? "selected" : ""}>Attr</option>
          <option value="count" ${f.type === "count" ? "selected" : ""}>Count</option>
        </select>
        <button class="btn btn-icon" style="color:var(--red);" data-action="remove-extract-field" data-id="${step.id}" data-index="${fi}">✕</button>
      </div>`;
      if (f.type === "count") {
        // Counting is how a rating rendered as four filled stars becomes the
        // number 4. Without a selector there is nothing to count, so the
        // injector refuses rather than returning a plausible 0.
        html += `<div class="flex gap-2" style="margin:-2px 0 6px 0;align-items:center;">
          <span style="flex:1;font-size:10px;color:var(--text-dim);text-align:right;">count of</span>
          <input type="text" class="extract-count-input" data-id="${step.id}" data-index="${fi}"
            value="${esc(f.countSelector || "")}" placeholder="i.icon-star.filled"
            style="flex:2.8;font-size:11px;">
        </div>`;
      }
      if (f.type === "attribute") {
        // Without a name there is nothing to read: injector requires
        // field.attribute, so "Attr" used to fall through to text extraction.
        html += `<div class="flex gap-2" style="margin:-2px 0 6px 0;align-items:center;">
          <span style="flex:1;font-size:10px;color:var(--text-dim);text-align:right;">attribute</span>
          <input type="text" class="extract-attr-input" data-id="${step.id}" data-index="${fi}"
            value="${esc(f.attribute || "")}" placeholder="href, src, data-id…"
            style="flex:2.8;font-size:11px;">
        </div>`;
      }

      // Clean the value here, rather than in a spreadsheet afterwards.
      const picked = Array.isArray(f.transform) ? f.transform[0] : "";
      html += `<div class="flex gap-2" style="margin:-2px 0 6px 0;align-items:center;">
        <span style="flex:1;font-size:10px;color:var(--text-dim);text-align:right;">clean up</span>
        <select class="extract-transform-select" data-id="${step.id}" data-index="${fi}" style="flex:2.8;font-size:11px;padding:4px 6px;">
          <option value="">As it appears on the page</option>
          ${Object.entries(TRANSFORMS)
            .map(
              ([name, meta]) =>
                `<option value="${name}" ${picked === name ? "selected" : ""}>${esc(meta.label)}</option>`,
            )
            .join("")}
        </select>
      </div>`;
      if (picked) html += hint(TRANSFORMS[picked]?.help ?? "");
      if (picked === "regex") {
        // Told now, in the box, rather than as an empty column after a run.
        const bad = f.regexPattern && !isValidRegex(f.regexPattern);
        html += `<div class="flex gap-2" style="margin:-6px 0 6px 0;align-items:center;">
          <span style="flex:1;font-size:10px;color:var(--text-dim);text-align:right;">pattern</span>
          <input type="text" class="extract-regex-input" data-id="${step.id}" data-index="${fi}"
            value="${esc(f.regexPattern || "")}" placeholder="SKU: (\\S+)"
            style="flex:2.8;font-size:11px;${bad ? "border-color:var(--red);" : ""}">
        </div>
        <div class="flex gap-2" style="margin:-6px 0 6px 0;align-items:center;">
          <span style="flex:1;font-size:10px;color:var(--text-dim);text-align:right;">group</span>
          <input type="number" min="0" max="20" class="extract-regex-group" data-id="${step.id}" data-index="${fi}"
            value="${esc(f.regexGroup ?? "")}" placeholder="1"
            style="flex:1;font-size:11px;">
          <span style="flex:0.6;font-size:10px;color:var(--text-dim);text-align:right;">flags</span>
          <input type="text" class="extract-regex-flags" data-id="${step.id}" data-index="${fi}"
            value="${esc(f.regexFlags || "")}" placeholder="${REGEX_FLAGS}" maxlength="3"
            style="flex:1;font-size:11px;">
        </div>`;
        if (bad) {
          html += `<p style="font-size:11px;color:var(--red);margin:-4px 0 8px 0;">Not a valid pattern — this field would come back empty.</p>`;
        }
      }
    });
    html += `</div>
    <div class="flex gap-2" style="margin-top:12px;align-items:flex-end;">
      <div style="flex:1"><label style="margin-top:0;">Field Name <span style="color:var(--text-dim);font-weight:400;">(optional)</span></label><input type="text" id="new-ex-name-${step.id}" placeholder="named from the element if blank"></div>
      <button class="btn btn-primary" data-action="add-extract-field" data-id="${step.id}" style="height:28px;">Pick Element</button>
    </div>`;
    html += toggle(
      step,
      "optional",
      "Optional — keep going if this step fails",
    );
    return html;
  }

  // ── PDF_EXTRACTION ──
  if (step.type === "PDF_EXTRACTION") {
    const source = c.source || "url";
    const pdfMode = c.mode === "tables" ? "tables" : "text";
    html += `<label>What to read out</label>
    <select id="cfg-${step.id}-mode" data-id="${step.id}" data-key="mode" data-rerender="true" class="cfg-bind" style="margin-bottom:8px;">
      <option value="text"${pdfMode === "text" ? " selected" : ""}>The text</option>
      <option value="tables"${pdfMode === "tables" ? " selected" : ""}>The table, as rows</option>
    </select>`;
    if (pdfMode === "tables") {
      html += toggle(step, "hasHeader", "The first row names the columns");
      html += hint(
        "A PDF has no table structure of its own — only words and where they " +
          "sit — so the grid is reassembled from their positions. Rows come " +
          "from the vertical position, columns from clustering the horizontal " +
          "one, so a row with an empty cell keeps its values under the right " +
          "headings. If the pages hold prose rather than columns, the step says " +
          "so instead of returning rows that are not there.",
      );
    }
    html += `<label>Source Type</label>
    <select id="cfg-${step.id}-source" data-id="${step.id}" data-key="source" data-rerender="true" class="cfg-bind" style="margin-bottom:8px;">
      <option value="url" ${source === "url" ? "selected" : ""}>PDF URL</option>
      <option value="file" ${source === "file" ? "selected" : ""}>From Storage</option>
    </select>`;

    if (source === "url") {
      html += field(
        step,
        "url",
        "PDF URL",
        "text",
        c.url || "https://example.com/document.pdf",
      );
    } else {
      const validIds = new Set(_storageFiles.map((f) => f.id));
      const selectedId = c.fileId;
      html += `<label>Select PDF File</label>
      <select id="cfg-${step.id}-fileId" data-id="${step.id}" data-key="fileId" class="cfg-bind" style="margin-bottom:8px;">
        <option value="">-- Choose file --</option>`;
      _storageFiles.forEach((f) => {
        const selected = selectedId === f.id ? "selected" : "";
        html += `<option value="${esc(f.id)}" ${selected}>${esc(f.name)}</option>`;
      });
      html += `</select>`;
      if (!_storageFiles.length) {
        html += `<div class="empty-inline">No files in Storage. Add PDF files in the Storage tab first.</div>`;
      }
    }

    html += field(
      step,
      "maxPages",
      "Max pages to extract",
      "number",
      c.maxPages ?? 50,
    );
    html += field(
      step,
      "storeAs",
      "Store extracted text as",
      "text",
      c.storeAs || "pdf_text",
    );
    html += toggle(
      step,
      "optional",
      "Optional — keep going if this step fails",
    );
    return html;
  }

  // ── AUTO_EXTRACT ──
  if (step.type === "AUTO_EXTRACT") {
    html += `<div class="step-note">
      <div class="step-note-title">Smart Auto-Extractor</div>
      <p class="prose">Product pages. The first layers run in the page and cost nothing; a model is asked only when they cannot answer confidently.</p>
      <ol class="step-note-layers">
        <li>JSON-LD / Schema.org</li>
        <li>Open Graph tags</li>
        <li>Heuristic DOM scorer</li>
        <li>Whichever model you set up under Settings &rarr; AI gateway</li>
      </ol>
    </div>`;

    html += `<label>Fields to look for</label>
    <textarea id="cfg-${step.id}-schema" data-id="${step.id}" data-key="schema" data-rerender="true" class="cfg-bind" rows="3" placeholder="Leave empty for a product page. Or name your own: title, author, published date" style="margin-bottom:8px;">${esc(c.schema || "")}</textarea>`;
    if (String(c.schema || "").trim()) {
      html += hint(
        "The page's own structured data answers these for free wherever it " +
          "publishes them — a site that says datePublished answers a request " +
          "for \u201cpublished date\u201d with no model and no cost. The product " +
          "heuristics only have an opinion about product fields, so anything " +
          "else falls to the model, and a field nothing can answer stays empty " +
          "rather than being guessed at.",
      );
    } else {
      html += hint(
        "Empty means the product fields: name, price, brand, description, sku, " +
          "availability, rating, images and the rest.",
      );
    }

    html += field(
      step,
      "confidenceThreshold",
      "Escalate to AI below this confidence (0-100)",
      "number",
      c.confidenceThreshold ?? 70,
    );
    html += `<p style="font-size:11px;color:var(--text-dim);margin:-4px 0 10px;">
      Rows are always kept. Below this score the page text is sent to your
      configured model for a second opinion; above it, only the on-page layers
      run. A local Ollama or LM Studio server works here and costs nothing \u2014
      nothing leaves the machine.</p>`;

    html += toggle(
      step,
      "useLlm",
      "Ask a model when the on-page layers are not confident",
    );

    // Default on, and the label for turning it off says what that means
    // rather than "disable verification".
    html += toggle(
      step,
      "grounded",
      "Only keep answers that are actually on the page",
      { rerender: true },
    );
    if (c.grounded === false) {
      html += `<p style="font-size:11px;color:var(--amber,#d97706);margin:-4px 0 10px;">
        With this off, a value the model invented is kept and exported like any
        other. Nothing downstream can tell the difference.</p>`;
    } else {
      html += hint(
        "Every value the model returns is looked for in the page text it was " +
          "shown; anything that is not there is dropped and named in the log. " +
          "It rules out invention, not confusion — a real value in the wrong " +
          "column still passes, which is what the confidence figure is for.",
      );
    }

    html += toggle(
      step,
      "learnSelectors",
      "Ask the model for selectors, and offer the ones that check out",
    );
    html += hint(
      "Each selector is run in the page and kept only if it produces the " +
        "value the model reported. What survives is offered as an EXTRACT " +
        "step \u2014 after that the site is scraped with no model at all, and " +
        "the pipeline exports to a Playwright or Python script, which this " +
        "step cannot.",
    );

    html += toggle(
      step,
      "cache",
      "Reuse the model's answer for a page that has not changed",
    );
    html += hint(
      "The page text is the key, so a page that changed is asked again and a " +
        "page that did not costs nothing the second time. Switching model or " +
        "changing the fields asks again too \u2014 a different question. Only " +
        "answers are kept, never the page text.",
    );

    html += toggle(
      step,
      "provenance",
      "Add a column recording where each field came from",
    );
    html += hint(
      "The panel shows this for every run either way. The column puts it in " +
        "the file too, as one cell per row — useful when someone else has " +
        "to check the data and cannot see the run that produced it.",
    );

    html += `<div style="margin-top:10px;padding:8px 10px;border-radius:6px;background:rgba(99,102,241,0.1);font-size:11px;color:var(--text-dim);">
      <b>Extracted fields:</b> name, price, originalPrice, currency, brand, description, sku, availability, rating, reviewCount, images[]<br>
      <b>Tip:</b> Use this step inside a LOOP to extract products from multiple pages automatically.
    </div>`;

    html += toggle(
      step,
      "optional",
      "Optional — keep going if this step fails",
    );
    return html;
  }

  // ── WAIT ──
  if (step.type === "WAIT") {
    const wmode = c.mode || "fixed";
    html += `<label>Wait for</label>
    <select id="cfg-${step.id}-mode" data-id="${step.id}" data-key="mode" data-rerender="true" class="cfg-bind" style="margin-bottom:8px;">
      <option value="fixed"            ${wmode === "fixed" ? "selected" : ""}>A fixed time</option>
      <option value="selector-visible" ${wmode === "selector-visible" ? "selected" : ""}>An element to appear</option>
      <option value="selector-gone"    ${wmode === "selector-gone" ? "selected" : ""}>An element to disappear</option>
      <option value="DOM-stable"       ${wmode === "DOM-stable" ? "selected" : ""}>The page to stop changing</option>
    </select>`;
    if (wmode === "fixed") {
      html += field(step, "ms", "Wait (ms)", "number", c.ms ?? 1000);
      html += hint(
        "A fixed wait is a guess. If you are waiting for something specific, " +
          "the modes above wait exactly as long as it takes and no longer.",
      );
    } else if (wmode === "DOM-stable") {
      html += hint(
        "Waits until no elements have been added or removed for half a " +
          "second — useful after a search or a filter, when you do not know " +
          "which element to watch.",
      );
      html += field(
        step,
        "timeout",
        "Give up after (ms)",
        "number",
        c.timeout ?? 15000,
      );
    } else {
      html += selectorRow(step, "selector");
      html += hint(
        wmode === "selector-visible"
          ? "An element that exists but is hidden does not count as appeared."
          : "Use this for a loading spinner or an overlay you need gone.",
      );
      html += field(
        step,
        "timeout",
        "Give up after (ms)",
        "number",
        c.timeout ?? 15000,
      );
      html += hint("Past the timeout the step fails, rather than continuing.");
    }
    html += toggle(
      step,
      "optional",
      "Optional — keep going if this step fails",
    );
    return html;
  }

  // ── PAGINATE ──
  if (step.type === "PAGINATE") {
    html += `<label>Next-page control</label>`;
    html += selectorRow(step, "selector");
    html += hint(
      "Clicks it, and reports whether there was another page. A missing, " +
        "disabled or hrefless control means the last page — a loop around " +
        "this step stops there instead of re-scraping it.",
    );
    html += field(
      step,
      "settleMs",
      "Wait for the next page (ms)",
      "number",
      c.settleMs ?? 1500,
    );
    html += toggle(
      step,
      "requireChange",
      "Also stop if the page did not change after the click",
    );
    html += toggle(
      step,
      "optional",
      "Optional — keep going if this step fails",
    );
    return html;
  }

  // ── HOVER ──
  if (step.type === "HOVER") {
    html += selectorRow(step, "selector");
    html += `<label>Wait for this to appear <span style="color:var(--text-dim);font-weight:400;">(optional)</span></label>`;
    html += selectorRow(step, "revealSelector");
    html += hint(
      "Name the menu or tooltip the hover should open, and the step waits for " +
        "it and fails if it never comes. Left blank, the step cannot tell " +
        "whether the hover achieved anything.",
    );
    if (c.revealSelector) {
      html += field(
        step,
        "timeout",
        "Give up after (ms)",
        "number",
        c.timeout ?? 3000,
      );
    }
    html += `<div style="background:rgba(245,158,11,0.10);border:1px solid rgba(245,158,11,0.35);border-radius:6px;padding:8px 10px;margin:6px 0 10px;font-size:11px;color:var(--text-dim);line-height:1.5;">
      <b>A menu that opens only through CSS cannot be opened here.</b>
      JavaScript menus open fine. A <span class="mono">:hover</span> rule follows
      the real mouse pointer, and no extension may move it without attaching a
      debugger to the browser. If the menu also opens on click, use CLICK.
    </div>`;
    html += toggle(
      step,
      "optional",
      "Optional — keep going if this step fails",
    );
    return html;
  }

  // ── SELECT ──
  if (step.type === "SELECT") {
    html += `<label>Dropdown</label>`;
    html += selectorRow(step, "selector");
    html += field(step, "value", "Option to choose", "text", c.value || "");
    html += hint(
      "Matched against each option's value first, then its visible label, " +
        "ignoring case. No match fails the step rather than clearing the " +
        "dropdown. Templates work here: {{item.text}}.",
    );
    html += toggle(
      step,
      "optional",
      "Optional — keep going if this step fails",
    );
    return html;
  }

  // ── DRAG_DROP ──
  if (step.type === "DRAG_DROP") {
    html += `<label>Drag this</label>`;
    html += selectorRow(step, "source");
    html += `<label>Onto this</label>`;
    html += selectorRow(step, "target");
    html += hint(
      "Uses HTML5 drag events. Canvas and pointer-based editors that do not " +
        "listen for them will not respond.",
    );
    html += toggle(
      step,
      "optional",
      "Optional — keep going if this step fails",
    );
    return html;
  }

  // ── DOWNLOAD_FILE ──
  if (step.type === "DOWNLOAD_FILE") {
    html += selectorRow(step, "selector", "Files to download");
    html += hint(
      "Point it at the links or images themselves — a[href$='.pdf'], " +
        ".gallery img. Inside a loop the selector is read against the record " +
        "the loop is on, so one image per product needs no index.",
    );
    html += field(
      step,
      "attr",
      "Attribute holding the URL",
      "text",
      c.attr || "auto",
    );
    html += hint(
      "auto reads href from a link and the loaded src from an image, falling " +
        "back to the data- attributes lazy loaders use. Name one explicitly " +
        "if the file lives somewhere else, such as data-full-size.",
    );
    html += field(
      step,
      "url",
      "…or one fixed URL, with no selector",
      "text",
      c.url || "",
    );
    html += field(
      step,
      "filename",
      "Save as",
      "text",
      c.filename ?? "verquill/{{file.name}}",
    );
    html += hint(
      "A template. {{file.name}}, {{file.stem}}, {{file.ext}}, {{file.index}} " +
        "and {{file.host}} describe the file; {{extracted.*}}, {{item.*}} and " +
        "{{loop.index}} work here as anywhere else. A / makes a subfolder of " +
        "your downloads directory; a / inside a value from the page does not.",
    );
    html += field(
      step,
      "max",
      "Most files per run of this step",
      "number",
      c.max ?? 25,
    );
    html += toggle(step, "inFrame", "Look inside iframes as well");
    html += hint(
      "The run log says how many files were saved, how many failed and why. " +
        "Files land in your normal downloads folder; Chrome numbers a name " +
        "that already exists rather than replacing it.",
    );
    html += toggle(
      step,
      "optional",
      "Optional — keep going if this step fails",
    );
    return html;
  }

  // ── SCREENSHOT ──
  if (step.type === "SCREENSHOT") {
    const area = c.area || "viewport";
    html += `<label>What to capture</label>
    <select id="cfg-${step.id}-area" data-id="${step.id}" data-key="area" data-rerender="true" class="cfg-bind" style="margin-bottom:8px;">
      <option value="viewport" ${area === "viewport" ? "selected" : ""}>The visible area</option>
      <option value="full"     ${area === "full" ? "selected" : ""}>The whole page</option>
      <option value="element"  ${area === "element" ? "selected" : ""}>One element</option>
    </select>`;

    if (area === "element") {
      html += selectorRow(step, "selector");
      html += hint(
        "The element is scrolled into view and the shot is cropped to it. " +
          "An element with no size on screen fails the step rather than " +
          "quietly returning the whole page.",
      );
    } else if (area === "full") {
      html += hint(
        "The page is walked a screenful at a time and the strips are joined. " +
          "Chrome allows about two captures a second, so a long page takes a " +
          "few seconds. A fixed header repeats in each strip — that is what " +
          "stitching does, and there is no way around it from an extension. " +
          "Very long pages are truncated, and say so.",
      );
    }

    html += field(
      step,
      "quality",
      "JPEG quality (1-100)",
      "number",
      c.quality ?? 100,
    );
    html += hint(
      "100 keeps a lossless PNG, where quality means nothing. Below that it " +
        "switches to JPEG, where the number is real.",
    );
    html += hint(
      "Shots are held in memory during the run and saved with the export; a " +
        "run that fills the buffer keeps going and says how many it dropped.",
    );
    html += toggle(
      step,
      "optional",
      "Optional — keep going if this step fails",
    );
    return html;
  }

  // ── API_SNIFFER ──
  if (step.type === "API_SNIFFER") {
    html += hint(
      "Records the XHR and fetch calls the page makes, from the moment the " +
        "run starts until it ends — the step itself does nothing, so its " +
        "position in the pipeline does not matter. Captured requests appear " +
        "in the run monitor and in the export.",
    );
    html += toggle(step, "enabled", "Record network requests during this run");

    html += field(
      step,
      "urlFilter",
      "Only record URLs containing",
      "text",
      c.urlFilter || "",
    );
    const filterProblem = snifferFilterError(c.urlFilter || "");
    if (filterProblem) {
      html += `<p style="font-size:11px;color:var(--red);margin:-4px 0 8px 0;">${esc(filterProblem)}</p>`;
    } else {
      html += hint(
        "Blank records everything, which on a real site is mostly analytics, " +
          "fonts and ad auctions. Several substrings can be separated by " +
          "commas: /api/, /graphql. Start with re: for a regular expression.",
      );
    }

    html += field(
      step,
      "methods",
      "Only these methods (optional)",
      "text",
      c.methods || "",
    );
    html += hint("For example POST, or POST PUT. Blank means any method.");

    html += toggle(
      step,
      "optional",
      "Optional — keep going if this step fails",
    );
    return html;
  }

  // ── PAGE_JSON ──
  if (step.type === "PAGE_JSON") {
    const mode = c.mode || "tree";
    html += `<div style="background:rgba(14,165,233,0.10);border:1px solid rgba(14,165,233,0.35);border-radius:8px;padding:10px 12px;margin-bottom:12px;">
      <div style="font-weight:600;font-size:13px;margin-bottom:4px;">The page itself, as JSON</div>
      <div style="font-size:11px;color:var(--text-dim);line-height:1.5;">
        No selectors, no guessing about what matters — the page as it actually
        is. Use this when a site publishes no structured data, or when you want
        to look at everything before deciding what to scrape.<br><br>
        Scripts, styles and SVG path data are left out by default: a real page
        is mostly those, and they bury the content.
      </div>
    </div>`;

    html += `<label>Shape</label>
    <select id="cfg-${step.id}-mode" data-id="${step.id}" data-key="mode" data-rerender="true" class="cfg-bind" style="margin-bottom:8px;">
      <option value="tree" ${mode === "tree" ? "selected" : ""}>Tree — the page's structure, nested</option>
      <option value="text" ${mode === "text" ? "selected" : ""}>Text — every readable line, in order</option>
      <option value="flat" ${mode === "flat" ? "selected" : ""}>Flat — one row per element</option>
    </select>`;
    html += hint(
      mode === "text"
        ? "Good for reading, searching, or handing to an AI. The markup is gone."
        : mode === "flat"
          ? "One row per element with its text, link and path — the easiest way to find the selector you actually want."
          : "Keeps the nesting, so the shape of the page survives. The natural choice if something else will read the JSON.",
    );

    html += `<label>Only this part of the page <span style="color:var(--text-dim);font-weight:400;">(optional)</span></label>`;
    html += selectorRow(step, "selector");
    html += hint(
      "Blank dumps the whole page. Naming one element — a results list, a " +
        "card — is usually what you want, and keeps the output readable.",
    );

    html += field(
      step,
      "maxNodes",
      "Stop after this many elements",
      "number",
      c.maxNodes ?? 5000,
    );
    html += hint(
      "A truncated read says so rather than quietly handing back half a page.",
    );
    html += toggle(step, "includeScripts", "Include scripts and styles too");
    html += field(
      step,
      "storeAs",
      "Store it as",
      "text",
      c.storeAs || "pageJson",
    );
    html += hint(
      "Later steps can reference it. Export as JSON — a page tree does not " +
        "fit a spreadsheet cell.",
    );
    html += toggle(
      step,
      "optional",
      "Optional — keep going if this step fails",
    );
    return html;
  }

  // ── SET_HEADERS ──
  if (step.type === "SET_HEADERS") {
    html += `<div style="background:rgba(139,124,246,0.10);border:1px solid rgba(139,124,246,0.35);border-radius:8px;padding:10px 12px;margin-bottom:12px;">
      <div style="font-weight:600;font-size:13px;margin-bottom:4px;">Headers, for this run's tab only</div>
      <div style="font-size:11px;color:var(--text-dim);line-height:1.5;">
        Some sites answer <b>403</b> to anything whose User-Agent looks
        automated. A page cannot change its own request headers, so this needs
        the <b>Request headers</b> permission in Settings → Permissions.<br><br>
        The rules apply to this run's tab and are taken back when the run ends.
      </div>
    </div>`;

    html += `<label>Headers — one <code>Name: value</code> per line</label>
      <textarea id="cfg-${step.id}-headers" data-id="${step.id}" data-key="headers" class="cfg-bind" rows="4" placeholder="User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36&#10;Accept-Language: en-GB,en;q=0.9" style="margin-bottom:8px;">${esc(c.headers || "")}</textarea>`;
    html += hint(
      "Leave a value empty to remove that header instead of setting it. " +
        "Host, Content-Length and the Sec- headers are the browser's own and " +
        "will be refused by name rather than dropped quietly.",
    );

    html += toggle(
      step,
      "optional",
      "Optional — keep going if this step fails",
    );
    return html;
  }

  // ── DEDUPE ──
  if (step.type === "DEDUPE") {
    const scope = c.scope || "run";
    html += `<div style="background:rgba(79,201,168,0.10);border:1px solid rgba(79,201,168,0.35);border-radius:8px;padding:10px 12px;margin-bottom:12px;">
      <div style="font-weight:600;font-size:13px;margin-bottom:4px;">Drop rows you already have</div>
      <div style="font-size:11px;color:var(--text-dim);line-height:1.5;">
        Put this <b>before</b> the steps that extract. From here on, every row
        the run collects is checked, and one it has seen before is dropped
        rather than written.
      </div>
    </div>`;

    html += field(
      step,
      "fields",
      "Fields that identify a row (comma separated)",
      "text",
      c.fields ?? "",
    );
    html += hint(
      "Leave blank to compare whole rows — which is rarely what you mean: two " +
        "readings of the same product differ by a stock count that moved. Name " +
        "the URL, the id, the title.",
    );

    html += `<label>Remember for how long</label>
    <select id="cfg-${step.id}-scope" data-id="${step.id}" data-key="scope" data-rerender="true" class="cfg-bind" style="margin-bottom:8px;">
      <option value="run"     ${scope === "run" ? "selected" : ""}>This run only</option>
      <option value="forever" ${scope === "forever" ? "selected" : ""}>Across runs of this pipeline</option>
    </select>`;
    html += hint(
      scope === "forever"
        ? "Tomorrow's run of this pipeline on this site collects only what is " +
            "new. The keys are kept on this machine until you clear them."
        : "The memory is thrown away when the run ends.",
    );

    html += field(
      step,
      "limit",
      "Rows to remember (bound)",
      "number",
      c.limit ?? 100000,
    );
    html += hint(
      "A run cannot remember a million keys for free. Past this, the oldest " +
        "are forgotten — an old duplicate can get through, which is worth " +
        "knowing rather than assuming.",
    );

    html += toggle(
      step,
      "optional",
      "Optional — keep going if this step fails",
    );
    return html;
  }

  // ── SESSION ──
  if (step.type === "SESSION") {
    const mode = c.mode || "save";
    html += `<div style="background:rgba(59,130,246,0.10);border:1px solid rgba(59,130,246,0.35);border-radius:8px;padding:10px 12px;margin-bottom:12px;">
      <div style="font-weight:600;font-size:13px;margin-bottom:4px;">Log in once, scrape later</div>
      <div style="font-size:11px;color:var(--text-dim);line-height:1.5;">
        Log in by hand in the tab, run a <b>Save</b> step once, and every later
        run can start with <b>Restore</b> instead of logging in again.<br><br>
        For the session cookie itself to be saved, turn on the
        <b>Cookies</b> permission in Settings → Permissions. Without it only
        cookies the page can read are saved, and a restored session is usually
        a logged-out one. See <code>docs/SESSIONS_AND_HEADERS.md</code>.
      </div>
    </div>`;

    html += `<label>What to do</label>
    <select id="cfg-${step.id}-mode" data-id="${step.id}" data-key="mode" data-rerender="true" class="cfg-bind" style="margin-bottom:8px;">
      <option value="save"    ${mode === "save" ? "selected" : ""}>Save this tab's session</option>
      <option value="restore" ${mode === "restore" ? "selected" : ""}>Restore a saved session</option>
      <option value="clear"   ${mode === "clear" ? "selected" : ""}>Forget a saved session</option>
    </select>`;

    html += field(step, "name", "Called", "text", c.name || "default");
    html += hint(
      mode === "save"
        ? "Saving again under the same name replaces what was there."
        : "The name you saved it under. A session only restores onto the site it was saved from.",
    );

    if (mode !== "clear") {
      html += toggle(step, "includeCookies", "Cookies");
      html += toggle(step, "includeStorage", "Local and session storage");
      html += hint(
        "Many sites keep the login token in localStorage rather than a " +
          "cookie, so leaving both on is the safe choice.",
      );
    }

    if (mode === "restore") {
      html += hint(
        "Restoring writes the session into the browser; the site only sees it " +
          "on the next request, so put a Navigate or a Reload after this step.",
      );
    }

    html += toggle(
      step,
      "optional",
      "Optional — keep going if this step fails",
    );
    return html;
  }

  // ── PAGE_DATA ──
  if (step.type === "PAGE_DATA") {
    html += `<div style="background:rgba(16,185,129,0.10);border:1px solid rgba(16,185,129,0.35);border-radius:8px;padding:10px 12px;margin-bottom:12px;">
      <div style="font-weight:600;font-size:13px;margin-bottom:4px;">The page's own data — no selectors</div>
      <div style="font-size:11px;color:var(--text-dim);line-height:1.5;">
        Most sites publish their content as structured data for search engines:
        JSON-LD, microdata, Open Graph. This reads it straight off the page.
        It is already typed and named, and it does not break when the site
        changes its CSS.<br><br>
        Best for a <b>single record</b> — a product, an article, a job, a
        recipe — which Detect Table cannot help with, because there is nothing
        repeating to find.
      </div>
    </div>`;

    const src = c.source || "auto";
    html += `<label>Where to read from</label>
    <select id="cfg-${step.id}-source" data-id="${step.id}" data-key="source" data-rerender="true" class="cfg-bind" style="margin-bottom:8px;">
      <option value="auto"      ${src === "auto" ? "selected" : ""}>Anywhere it can (recommended)</option>
      <option value="jsonld"    ${src === "jsonld" ? "selected" : ""}>JSON-LD only</option>
      <option value="microdata" ${src === "microdata" ? "selected" : ""}>Microdata only</option>
      <option value="meta"      ${src === "meta" ? "selected" : ""}>Page tags only (Open Graph)</option>
    </select>`;
    if (src === "auto") {
      html += hint(
        "Tries JSON-LD first, then microdata. It does not merge the two — a " +
          "site publishing both publishes the same record twice, and merging " +
          "would double every row.",
      );
    }

    if (src !== "meta") {
      html += field(
        step,
        "type",
        "Keep only this type (optional)",
        "text",
        c.type || "",
      );
      html += hint(
        "A Schema.org type: Product, Article, Recipe, JobPosting, Event, " +
          "LocalBusiness. Leave blank to keep everything the page publishes.",
      );
    }

    html += toggle(step, "flatten", "Flatten into one row per record");
    html += hint(
      c.flatten === false
        ? "Off: records keep their shape. Good for the JSON export, but a " +
            "spreadsheet has no cell for a nested object."
        : "Nested values become columns like offers.price, so the rows fit a " +
            "spreadsheet. Turn off to keep the original shape for JSON.",
    );

    html += field(
      step,
      "storeAs",
      "Also store the whole reading as",
      "text",
      c.storeAs || "pageData",
    );
    html += hint(
      "Later steps can reference it — {{pageData.meta.og:title}} — alongside " +
        "the rows it produced.",
    );

    html += toggle(
      step,
      "optional",
      "Optional — keep going if this step fails",
    );
    return html;
  }

  // ── Generic fallback ──
  for (const [key, value] of Object.entries(c)) {
    if (typeof value === "boolean") {
      html += toggle(step, key, key);
    } else if (typeof value === "number") {
      html += field(step, key, key, "number", value);
    } else if (typeof value === "string") {
      if (key === "selector" || key === "source" || key === "target")
        html += selectorRow(step, key);
      else html += field(step, key, key, "text", value);
    }
  }
  return html;
}

// ── Config helpers ────────────────────────────────────────────────────────────
/**
 * Escape a value for interpolation into the config HTML.
 *
 * Previously escaped only " and <, so an & passed through raw — meaning a value
 * containing the literal text "&quot;" round-tripped as a double quote, and a
 * value in a single-quoted attribute was not escaped at all. & must be replaced
 * first or it would double-escape the entities added after it.
 */
function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function field(step, key, label, type, value) {
  return `<label>${label}</label>
    <input type="${type}" id="cfg-${step.id}-${key}" value="${esc(value)}"
      data-id="${step.id}" data-key="${key}" class="cfg-bind" style="margin-bottom:8px;">`;
}
function selectorRow(step, key, label = key) {
  const v = step.config[key] || "";
  // Same rule as the picker's default, and for the same reason: a paginating
  // LOOP's selector is one Next control, not a set of records.
  const paginating = step.type === "LOOP" && step.config?.type === "paginate";
  const isMultiSelect =
    ["EXTRACT", "LOOP"].includes(step.type) &&
    key === "selector" &&
    !paginating;
  const modeBadge = isMultiSelect ? "Bulk" : "Specific";
  return `<label>${label}</label>
    <div class="flex gap-2" style="margin-bottom:8px;">
      <input type="text" id="cfg-${step.id}-${key}" value="${esc(v)}"
        data-id="${step.id}" data-key="${key}" class="cfg-bind" style="flex:1;">
      <span class="selector-mode-badge">${modeBadge}</span>
      <button class="btn" data-action="pick-selector" data-id="${step.id}" data-key="${key}"
        title="Pick this element on the page">Pick</button>
    </div>`;
}
/**
 * A line of explanation under a control.
 *
 * Several step types had no configuration UI of their own and fell through to
 * a loop over the config object that rendered raw key names as labels: a WAIT
 * card offered a box labelled "ms", DRAG_DROP offered "source" and "target".
 * The values were editable, so the steps were configurable in principle and
 * unusable in practice.
 */
function hint(text) {
  return `<p style="font-size:11px;color:var(--text-dim);margin:-4px 0 10px;">${esc(text)}</p>`;
}

/**
 * A checkbox that adds or removes one value from an array in the config.
 *
 * `toggle` writes a boolean, which is wrong for a set: four separate booleans
 * for four modifier keys is four config keys that then have to be reassembled
 * everywhere they are read. This keeps the array the executor and both
 * emitters already expect.
 */
function memberToggle(step, key, value, label) {
  const list = Array.isArray(step.config[key]) ? step.config[key] : [];
  const checked = list.includes(value) ? "checked" : "";
  return `<div class="toggle-wrap">
    <input type="checkbox" id="cfg-${step.id}-${key}-${value}" ${checked} data-id="${step.id}" data-key="${key}" data-member="${esc(value)}" class="cfg-bind">
    <div class="toggle-switch"></div>
    <span>${label}</span>
  </div>`;
}

/**
 * A checkbox bound to one boolean in the step's config.
 *
 * `rerender` is for a switch that reveals or hides something else — the
 * dataset name, a warning about what turning a check off means. Without it the
 * box appears only after some unrelated edit redraws the card, which reads as
 * the toggle not working.
 */
function toggle(step, key, label, { rerender = false } = {}) {
  const checked = step.config[key] ? "checked" : "";
  const redraw = rerender ? ' data-rerender="true"' : "";
  return `<div class="toggle-wrap">
    <input type="checkbox" id="cfg-${step.id}-${key}" ${checked} data-id="${step.id}" data-key="${key}"${redraw} class="cfg-bind">
    <div class="toggle-switch"></div>
    <span>${label}</span>
  </div>`;
}

/**
 * Keep a step's config self-consistent after one field changes.
 *
 * Switching a LOOP from elements mode to count mode carried the "0 = every
 * match" value over, where 0 means zero iterations — the loop then ran nothing
 * and said nothing (B-22). The executor now rejects it outright, so fix it here
 * rather than letting the user hit that error.
 *
 * @param {object} step
 * @param {string} changedKey
 */
function _normalizeStepConfig(step, changedKey) {
  if (step.type !== "LOOP") return;
  if (changedKey !== "type" && changedKey !== "max") return;
  const mode = step.config.type || "count";
  // `list` joins `elements` in treating 0 as "every one": both take their
  // bound from something real — the matches, or the list — so 0 means "do not
  // cap" rather than "run nothing".
  if (!["elements", "list"].includes(mode) && !(step.config.max > 0)) {
    step.config.max = 10;
  }
}

/**
 * Save a key and then check that it works.
 *
 * Saving reported "saved" whether the key was valid, expired or a typo — the
 * six validators in api-key-manager.js existed but nothing ever called them
 * (F-03). Validation is one network call and only happens on an explicit save,
 * so it costs nothing on a normal run.
 *
 * @param {string} provider
 * @param {string} label
 * @param {string} inputId
 */
async function _saveAndValidateKey(provider, label, inputId) {
  const val = document.getElementById(inputId)?.value.trim();
  if (!val) return;

  const res = await chrome.runtime.sendMessage({
    type: "key:set",
    payload: { provider, value: val },
  });
  if (!res?.ok) {
    notify("error-log", `Failed to save ${label} key.`);
    return;
  }
  logToMonitor("info-log", `${label} key saved — checking it…`);

  const check = await chrome.runtime
    .sendMessage({
      type: "key:get",
      payload: { validate: true, provider },
    })
    .catch(() => null);

  const result = check?.result?.validation?.[provider];
  if (!result) {
    logToMonitor("warn-log", `${label} key saved; could not check it.`);
  } else if (result.valid === true) {
    notify("info-log", `${label} key saved and verified.`);
  } else if (result.valid === false) {
    notify(
      "error-log",
      `${label} key was rejected: ${result.error || "invalid"}.`,
    );
  } else {
    logToMonitor(
      "warn-log",
      `${label} key saved; validation was inconclusive (${result.error || "no validator"}).`,
    );
  }
}

// ── AI gateway settings (K-17) ────────────────────────────────────────────────

/** Read the four gateway fields as one payload — shared by save and test. */
function _readGatewayFields() {
  return {
    provider: document.getElementById("gateway-provider")?.value || "anthropic",
    apiKey: document.getElementById("gateway-key")?.value.trim() || "",
    model: document.getElementById("gateway-model")?.value.trim() || "",
    baseUrl: document.getElementById("gateway-base-url")?.value.trim() || "",
  };
}

/** Restore the saved provider/model/baseUrl on panel load — the key itself
 *  is session-only and never sent back to the panel (key:get never returns a
 *  value either — see key-validation.test.mjs). */
async function _loadGatewayConfig() {
  const res = await chrome.runtime
    .sendMessage({ type: "gateway:config-get" })
    .catch(() => null);
  const cfg = res?.result;
  if (!cfg) return;
  const providerEl = document.getElementById("gateway-provider");
  const modelEl = document.getElementById("gateway-model");
  const baseUrlEl = document.getElementById("gateway-base-url");
  if (providerEl && cfg.provider) providerEl.value = cfg.provider;
  if (modelEl && cfg.model) modelEl.value = cfg.model;
  if (baseUrlEl && cfg.baseUrl) baseUrlEl.value = cfg.baseUrl;
}

async function _saveGatewayConfig() {
  const fields = _readGatewayFields();
  const res = await chrome.runtime
    .sendMessage({ type: "gateway:save", payload: fields })
    .catch(() => null);
  if (!res?.ok) {
    notify(
      "error-log",
      `Failed to save AI gateway settings: ${res?.error || "unknown error"}.`,
    );
    return;
  }
  // The key field is cleared after a successful save so it does not sit in
  // the DOM (and a screenshot / screen share) any longer than it has to —
  // the same reasoning C-04 applies to logs applies here to the page itself.
  const keyEl = document.getElementById("gateway-key");
  if (keyEl && fields.apiKey) keyEl.value = "";
  notify("info-log", `AI gateway settings saved (${fields.provider}).`);
}

/**
 * The two optional permissions, with a button for each.
 *
 * The grant happens *here*, not in the worker: `chrome.permissions.request`
 * needs a user gesture, and a request made from a service worker is refused
 * without ever prompting — which looks exactly like the user saying no.
 */
async function _renderPermissions() {
  const host = document.getElementById("perm-list");
  if (!host) return;
  const status = await chrome.runtime
    .sendMessage({ type: "permissions:status" })
    .catch(() => null);
  const perms = status?.ok ? status.result : status;
  if (!perms) return;

  host.textContent = "";
  for (const [name, meta] of Object.entries(perms)) {
    const row = document.createElement("div");
    row.style.cssText =
      "display:flex;align-items:flex-start;gap:10px;margin-bottom:12px;";

    const text = document.createElement("div");
    text.style.flex = "1";
    const title = document.createElement("div");
    title.style.cssText = "font-size:12px;font-weight:600;";
    title.textContent = meta.label;
    const why = document.createElement("div");
    why.className = "prose";
    why.style.cssText = "font-size:11px;margin-top:2px;";
    why.textContent = meta.granted
      ? `Granted — used for ${meta.forWhat}.`
      : `For ${meta.forWhat}. Without it, ${meta.without}.`;
    text.append(title, why);

    const btn = document.createElement("button");
    btn.className = "btn";
    btn.style.cssText = "height:26px;font-size:11px;white-space:nowrap;";
    btn.textContent = meta.granted ? "Remove" : "Grant";
    btn.addEventListener("click", async () => {
      const ok = meta.granted
        ? await chrome.permissions.remove({ permissions: [name] })
        : await chrome.permissions.request({ permissions: [name] });
      logToMonitor(
        "info-log",
        ok
          ? `${meta.label}: ${meta.granted ? "removed" : "granted"}.`
          : `${meta.label}: ${meta.granted ? "still granted" : "not granted"}.`,
      );
      _renderPermissions();
    });

    row.append(text, btn);
    host.append(row);
  }
}

async function _testGatewayConnection() {
  const fields = _readGatewayFields();
  logToMonitor("info-log", `Testing ${fields.provider}…`);
  const res = await chrome.runtime
    .sendMessage({ type: "gateway:test", payload: fields })
    .catch(() => null);
  const result = res?.result;
  if (!res?.ok || !result) {
    notify("error-log", "Could not run the connection test.");
    return;
  }
  if (result.ok) {
    notify("info-log", `Connection OK (${result.model || fields.provider}).`);
  } else {
    notify("error-log", `Connection failed: ${result.error}`);
  }
}

// ── Config input binding ──────────────────────────────────────────────────────
function bindConfigInputs(container = document) {
  container.querySelectorAll(".cfg-bind").forEach((el) => {
    // This used to clone every input and swap the clone in, to shed listeners
    // it might have bound twice. Replacing a node destroys focus, caret
    // position and selection, and renderPipeline() redraws the whole canvas on
    // every expand, collapse, add and remove — so editing a selector was
    // jumpy for a reason (E-10). A marker does the same job without touching
    // the node; a re-rendered element is a new node and carries no marker.
    if (el.dataset.vqBound === "1") return;
    el.dataset.vqBound = "1";
    const newEl = el;

    newEl.addEventListener("change", (e) => {
      const step = _findStepDeep(_pipeline.steps, e.target.dataset.id);
      if (!step) return;
      const key = e.target.dataset.key;
      const member = e.target.dataset.member;
      if (member !== undefined) {
        const list = Array.isArray(step.config[key])
          ? step.config[key].filter((v) => v !== member)
          : [];
        if (e.target.checked) list.push(member);
        step.config[key] = list;
      } else if (e.target.type === "checkbox")
        step.config[key] = e.target.checked;
      else if (e.target.type === "number")
        step.config[key] = parseFloat(e.target.value) || 0;
      else step.config[key] = e.target.value;
      _normalizeStepConfig(step, key);
      saveState();

      // Re-render card config if marked (mode-switching selects)
      if (e.target.dataset.rerender === "true") _rerenderCardConfig(step);
      else {
        const sub = e.target
          .closest(".node-card")
          ?.querySelector(".node-subtitle");
        if (sub) sub.textContent = getStepSubtitle(step);
      }
    });

    if (
      newEl.type === "text" ||
      newEl.type === "number" ||
      newEl.tagName === "TEXTAREA"
    ) {
      newEl.addEventListener("input", (e) => {
        const step = _findStepDeep(_pipeline.steps, e.target.dataset.id);
        if (!step) return;
        const key = e.target.dataset.key;
        step.config[key] =
          e.target.type === "number"
            ? parseFloat(e.target.value) || 0
            : e.target.value;
        const sub = e.target
          .closest(".node-card")
          ?.querySelector(".node-subtitle");
        if (sub) sub.textContent = getStepSubtitle(step);
      });
    }
  });
}

function _rerenderCardConfig(step) {
  const configEl = document.querySelector(
    `.node-wrapper[data-id="${step.id}"] .node-config`,
  );
  if (configEl) {
    // This fires while the user is in the middle of the form — a mode select
    // changes and the whole block is rebuilt — so put the caret back where it
    // was rather than dropping it (E-10).
    const active = document.activeElement;
    const restore =
      active && configEl.contains(active) && active.dataset?.key
        ? {
            key: active.dataset.key,
            start: active.selectionStart,
            end: active.selectionEnd,
          }
        : null;

    configEl.innerHTML = generateConfigHtml(step);
    bindConfigInputs(configEl);
    _makeKeyboardAccessible(configEl);

    if (restore) {
      const again = configEl.querySelector(`[data-key="${restore.key}"]`);
      if (again) {
        again.focus();
        if (restore.start !== null && restore.start !== undefined) {
          try {
            again.setSelectionRange(restore.start, restore.end);
          } catch {
            // Not every input type supports a selection range.
          }
        }
      }
    }
  }
  // Also re-render loop body insert if LOOP mode changed
  const sub = document.querySelector(
    `.node-wrapper[data-id="${step.id}"] .node-subtitle`,
  );
  if (sub) sub.textContent = getStepSubtitle(step);
}

// ── Drag-and-drop node reorder ────────────────────────────────────────────────
function bindDragAndDrop() {
  // We attach dragstart on the card itself (it has draggable="true")
  document.querySelectorAll(".node-card[data-drag-id]").forEach((card) => {
    card.addEventListener("dragstart", (e) => {
      _dragSourceId = card.dataset.dragId;
      e.dataTransfer.effectAllowed = "move";
      card.style.opacity = "0.45";
    });
    card.addEventListener("dragend", () => {
      card.style.opacity = "1";
      _dragSourceId = null;
    });
  });
  // The inside of a loop or a branch, so an empty one can be dropped into at
  // all. Listed first: a wrapper nested inside a container would otherwise
  // swallow the event on its way up.
  document
    .querySelectorAll(".loop-body-inner[data-parent-id]")
    .forEach((body) => {
      body.addEventListener("dragover", (e) => {
        if (!_dragSourceId) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "move";
        body.classList.add("drop-inside");
      });
      body.addEventListener("dragleave", (e) => {
        if (body.contains(e.relatedTarget)) return;
        body.classList.remove("drop-inside");
      });
      body.addEventListener("drop", (e) => {
        e.preventDefault();
        e.stopPropagation();
        body.classList.remove("drop-inside");
        if (!_dragSourceId) return;
        const moved = _moveStepInto(
          _dragSourceId,
          body.dataset.parentId,
          body.dataset.branch,
        );
        _dragSourceId = null;
        if (!moved) return;
        saveState();
        renderPipeline();
      });
    });

  document.querySelectorAll(".node-wrapper").forEach((w) => {
    w.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      w.style.outline = "2px solid var(--accent)";
    });
    w.addEventListener("dragleave", () => {
      w.style.outline = "none";
    });
    w.addEventListener("drop", (e) => {
      e.preventDefault();
      w.style.outline = "none";
      if (!_dragSourceId) return;
      const targetId = w.dataset.id;
      if (!targetId || targetId === _dragSourceId) return;
      const moved = _moveStep(_dragSourceId, targetId);
      _dragSourceId = null;
      if (!moved) return;
      saveState();
      renderPipeline();
    });
  });
}

/**
 * Find the list a step lives in, and its index in it.
 *
 * @param {object[]} steps
 * @param {string} id
 * @returns {{ list: object[], index: number, parent: object|null } | null}
 */
function _locateStep(steps, id, parent = null) {
  for (let i = 0; i < steps.length; i++) {
    if (steps[i].id === id) return { list: steps, index: i, parent };
    for (const key of ["children", "ifBranch", "elseBranch"]) {
      const sub = steps[i][key];
      if (!Array.isArray(sub)) continue;
      const found = _locateStep(sub, id, steps[i]);
      if (found) return found;
    }
  }
  return null;
}

/** Is `id` inside `step`'s own subtree? */
function _containsStep(step, id) {
  for (const key of ["children", "ifBranch", "elseBranch"]) {
    for (const child of step[key] ?? []) {
      if (child.id === id || _containsStep(child, id)) return true;
    }
  }
  return false;
}

/**
 * Move a step *into* a container, at the end of its list.
 *
 * The other half of E-05. `_moveStep` puts a step where another step is, which
 * is the only thing a drop could express while drops were accepted on
 * `.node-wrapper` alone — so an empty loop had nothing to drop onto, and
 * dropping on a loop's own card moved the step to where the loop is, beside it
 * rather than inside. Both read as "dragging into a loop does not work".
 *
 * @param {string} sourceId
 * @param {string} parentId  - the LOOP or IF_ELSE to move into
 * @param {string} branchKey - "children", "ifBranch" or "elseBranch"
 * @returns {boolean} false when the move was refused
 */
function _moveStepInto(sourceId, parentId, branchKey) {
  const from = _locateStep(_pipeline.steps, sourceId);
  const target = _locateStep(_pipeline.steps, parentId);
  if (!from || !target) return false;

  const container = target.list[target.index];
  const step = from.list[from.index];

  // A container inside itself vanishes from the board, taking its children.
  if (step.id === container.id || _containsStep(step, container.id)) {
    notify(
      "warn-log",
      "A container cannot be moved inside itself — that would remove it from the board.",
    );
    return false;
  }

  if (!Array.isArray(container[branchKey])) container[branchKey] = [];
  from.list.splice(from.index, 1);
  container[branchKey].push(step);
  return true;
}

/**
 * Move a step to sit where another one is, anywhere in the tree.
 *
 * bindDragAndDrop looked both ids up in _pipeline.steps only, so dragging a
 * step inside a LOOP or an IF/ELSE branch — or between a branch and the root —
 * silently did nothing, while the drop target still drew the accent outline and
 * signalled success (E-05).
 *
 * @param {string} sourceId
 * @param {string} targetId
 * @returns {boolean} false when the move is not possible
 */
function _moveStep(sourceId, targetId) {
  const src = _locateStep(_pipeline.steps, sourceId);
  if (!src) return false;

  // A container cannot be dropped inside itself; that detaches the subtree.
  if (_containsStep(src.list[src.index], targetId)) {
    notify("warn-log", "A step cannot be moved inside itself.");
    return false;
  }

  const [moved] = src.list.splice(src.index, 1);

  // Located after the removal, so the target index is the post-removal one.
  const tgt = _locateStep(_pipeline.steps, targetId);
  if (!tgt) {
    src.list.splice(src.index, 0, moved); // put it back
    return false;
  }
  tgt.list.splice(tgt.index, 0, moved);
  return true;
}

// ── Keyboard access ───────────────────────────────────────────────────────────
/**
 * Elements that behave like buttons but are not buttons.
 *
 * The board is built from divs with click handlers — nav pills, node headers,
 * the + insert affordances, accordion headers, palette items — none of which had
 * a role, a tabindex or any keyboard activation, so the panel could not be
 * operated without a mouse (E-09). Rather than hand-editing every generation
 * site, they are stamped after each render and activated by one delegated
 * handler, which also covers markup added later.
 */
const KEYBOARD_ACTIVATABLE =
  ".nav-pill, .node-header, .insert-step, .accordion-header, .palette-item, [data-action]";

/** Anything the browser already makes focusable and Enter-activatable. */
const NATIVELY_INTERACTIVE = "button, a[href], input, select, textarea";

/**
 * Give the div-buttons in `root` a role and a tab stop.
 * @param {ParentNode} [root]
 */
function _makeKeyboardAccessible(root = document) {
  for (const el of root.querySelectorAll(KEYBOARD_ACTIVATABLE)) {
    if (el.matches(NATIVELY_INTERACTIVE)) continue;
    if (!el.hasAttribute("role")) el.setAttribute("role", "button");
    if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "0");
  }
}

/** Enter and Space activate a div-button, the way they do a real one. */
function bindKeyboardActivation() {
  document.body.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " " && e.key !== "Spacebar") return;
    const el = e.target.closest?.(KEYBOARD_ACTIVATABLE);
    if (!el || el.matches(NATIVELY_INTERACTIVE)) return;
    // Space scrolls the page by default, and Enter inside a form submits it.
    e.preventDefault();
    el.click();
  });
}

// ── Event delegation ──────────────────────────────────────────────────────────
function bindDelegatedEvents() {
  document.body.addEventListener("click", (e) => {
    const accHeader = e.target.closest(".accordion-header");
    if (accHeader) {
      accHeader.parentElement.classList.toggle("open");
      return;
    }

    const toggleWrap = e.target.closest(".toggle-wrap");
    if (toggleWrap && !e.target.matches('input[type="checkbox"]')) {
      const cb = toggleWrap.querySelector('input[type="checkbox"]');
      if (cb) {
        cb.checked = !cb.checked;
        cb.dispatchEvent(new Event("change", { bubbles: true }));
      }
      return;
    }

    const target = e.target.closest("[data-action]");
    if (!target) return;
    if (target.classList.contains("action-btn")) e.stopPropagation();

    const action = target.dataset.action;
    const id = target.dataset.id;

    switch (action) {
      case "add-step":
        _addStep(target.dataset.type);
        break;
      case "open-palette":
        _openPalette(
          parseInt(target.dataset.index, 10),
          target.dataset.parentId || "",
          target.dataset.branch || "",
        );
        break;
      case "toggle-expand":
        _toggleExpand(id);
        break;
      case "remove-step":
        _removeStep(e, id);
        break;
      case "test-step":
        _testStep(e, id);
        break;
      case "pick-selector":
        _pickSelector(id, target.dataset.key);
        break;
      case "add-extract-field":
        _addExtractField(id);
        break;
      case "remove-extract-field":
        _removeExtractField(id, parseInt(target.dataset.index, 10));
        break;
      case "set-fill-mode": {
        const step = _findStepDeep(_pipeline.steps, id);
        if (step) {
          step.config.mode = target.dataset.mode;
          saveState();
          _rerenderCardConfig(step);
        }
        break;
      }
      case "add-fill-field":
        _addFillField(id);
        break;
      case "remove-fill-field":
        _removeFillField(id, parseInt(target.dataset.index, 10));
        break;
      case "register-key":
        _registerKey(id);
        break;
      case "upload-step-select-all":
        _uploadStepSelectAll(id);
        break;
      case "upload-step-clear":
        _uploadStepClear(id);
        break;
    }
  });

  document.body.addEventListener("change", (e) => {
    const target = e.target;

    // The attestation is not step config — it belongs to the domain and
    // outlives the pipeline — so it goes to the worker rather than into the
    // step the checkbox is drawn on.
    if (target.classList?.contains("captcha-attest")) {
      _setCaptchaAttestation(
        target.checked,
        _findStepDeep(_pipeline.steps, target.dataset.id),
      );
      return;
    }

    // Extract field type. This was previously handled by the click listener,
    // which fires before the user has picked an option, so the select never
    // actually changed the stored type.
    if (
      target instanceof HTMLSelectElement &&
      target.classList.contains("extract-type-select")
    ) {
      const step = _findStepDeep(_pipeline.steps, target.dataset.id);
      const field = step?.config?.fields?.[parseInt(target.dataset.index, 10)];
      if (!field) return;
      field.type = target.value;
      if (field.type !== "attribute") delete field.attribute;
      if (field.type !== "count") delete field.countSelector;
      saveState();
      _rerenderCardConfig(step); // show or hide the type's own input
      return;
    }

    if (
      target instanceof HTMLSelectElement &&
      target.classList.contains("extract-transform-select")
    ) {
      const step = _findStepDeep(_pipeline.steps, target.dataset.id);
      const field = step?.config?.fields?.[parseInt(target.dataset.index, 10)];
      if (!field) return;
      // Stored as a list because the engine chains them. The UI offers one for
      // now; a stored list means offering a second later changes no data shape.
      if (target.value) field.transform = [target.value];
      else delete field.transform;
      if (target.value !== "regex") {
        delete field.regexPattern;
        delete field.regexGroup;
        delete field.regexFlags;
      }
      saveState();
      _rerenderCardConfig(step); // show the help, and the pattern box
      return;
    }

    if (!(target instanceof HTMLInputElement)) return;

    // Field rows used to render as `disabled` inputs — greyed out and
    // uneditable — so fixing a typo in a selector meant deleting the row and
    // re-picking the element (E-16).
    if (target.classList.contains("field-edit")) {
      const step = _findStepDeep(_pipeline.steps, target.dataset.id);
      const field = step?.config?.fields?.[parseInt(target.dataset.index, 10)];
      if (!field) return;
      field[target.dataset.prop] = target.value;
      saveState();
      return;
    }

    if (target.classList.contains("key-manual-input")) {
      const step = _findStepDeep(_pipeline.steps, target.dataset.id);
      if (!step) return;
      const before = _isBrowserReservedKey(step.config.key);
      step.config.key = target.value.trim();
      saveState();
      const disp = document.getElementById(`key-disp-${step.id}`);
      if (disp) disp.textContent = step.config.key || "Not set";
      // Only when the verdict changes, or the caret jumps on every keystroke
      // (E-10).
      if (before !== _isBrowserReservedKey(step.config.key)) {
        _rerenderCardConfig(step);
      }
      return;
    }

    if (target.classList.contains("extract-regex-input")) {
      const step = _findStepDeep(_pipeline.steps, target.dataset.id);
      const field = step?.config?.fields?.[parseInt(target.dataset.index, 10)];
      if (!field) return;
      const wasBad = field.regexPattern && !isValidRegex(field.regexPattern);
      field.regexPattern = target.value;
      saveState();
      // Only when the verdict changed: re-rendering on every keystroke would
      // take the caret with it, which is what E-10 was about.
      const isBad = target.value && !isValidRegex(target.value);
      if (Boolean(wasBad) !== Boolean(isBad)) _rerenderCardConfig(step);
      return;
    }

    // Neither of these can make a pattern invalid, so unlike the pattern box
    // they never re-render — the caret stays where the user put it.
    if (target.classList.contains("extract-regex-group")) {
      const step = _findStepDeep(_pipeline.steps, target.dataset.id);
      const field = step?.config?.fields?.[parseInt(target.dataset.index, 10)];
      if (!field) return;
      const g = normalizeRegexGroup(target.value);
      if (g === null) delete field.regexGroup;
      else field.regexGroup = g;
      saveState();
      return;
    }

    if (target.classList.contains("extract-regex-flags")) {
      const step = _findStepDeep(_pipeline.steps, target.dataset.id);
      const field = step?.config?.fields?.[parseInt(target.dataset.index, 10)];
      if (!field) return;
      const flags = normalizeRegexFlags(target.value);
      if (flags) field.regexFlags = flags;
      else delete field.regexFlags;
      saveState();
      return;
    }

    if (target.classList.contains("extract-attr-input")) {
      const step = _findStepDeep(_pipeline.steps, target.dataset.id);
      const field = step?.config?.fields?.[parseInt(target.dataset.index, 10)];
      if (!field) return;
      field.attribute = target.value.trim();
      saveState();
      return;
    }

    if (target.classList.contains("extract-count-input")) {
      const step = _findStepDeep(_pipeline.steps, target.dataset.id);
      const field = step?.config?.fields?.[parseInt(target.dataset.index, 10)];
      if (!field) return;
      field.countSelector = target.value.trim();
      saveState();
      return;
    }

    if (!target.classList.contains("upload-step-file-check")) return;

    const stepId = target.dataset.stepId;
    const fileId = target.dataset.fileId;
    if (!stepId || !fileId) return;
    _uploadStepToggleFile(stepId, fileId, target.checked);
  });
}

// ── Step actions ──────────────────────────────────────────────────────────────
/**
 * Open or close one card.
 *
 * This used to call renderPipeline(), which rebuilds the whole canvas with
 * innerHTML and then rebinds every config input and drag handler on it. That
 * was pure waste: `.node-config` is rendered for every card whether it is open
 * or not, and `.expanded` only flips a `display` rule (see the CSS). So the
 * rebuild changed nothing about what was on screen while costing the scroll
 * position, any text selection, and the identity of every node in the canvas —
 * on a forty-step pipeline, to show one card.
 *
 * Toggling the class does the same job and touches one element. renderPipeline
 * is still right for add, remove and reorder, which genuinely change the tree.
 */
function _toggleExpand(id) {
  const wasOpen = _expandedNodeIds.has(id);
  if (wasOpen) _expandedNodeIds.delete(id);
  else _expandedNodeIds.add(id);

  const card = elCanvas.querySelector(
    `.node-wrapper[data-id="${CSS.escape(id)}"] > .node-card`,
  );
  // No card in the DOM means the state and the canvas have diverged, which a
  // class toggle cannot repair. Fall back to the redraw rather than leaving a
  // card that answers clicks by doing nothing.
  if (card) card.classList.toggle("expanded", !wasOpen);
  else renderPipeline();
}
function _removeStep(e, id) {
  e.stopPropagation();
  _removeStepDeep(_pipeline.steps, id);
  // Only the removed step forgets it was open. Clearing the set here would
  // close every other card as a side effect of deleting one.
  _expandedNodeIds.delete(id);
  saveState();
  renderPipeline();
}
/** Per-step timers that clear a test outcome class. @type {Map<string, number>} */
const _testStepTimers = new Map();

/**
 * Summarise what a test run of a step returned, for the log pane.
 *
 * The result was thrown away, so testing a CLICK or an EXTRACT told you only
 * that it did not throw — never what it matched or what it read back (E-07).
 *
 * @param {*} result
 * @returns {string}
 */
function _describeStepResult(result) {
  if (result === null || result === undefined) return "no result";
  if (Array.isArray(result)) {
    if (!result.length) return "0 rows";
    const keys = Object.keys(result[0] ?? {});
    const head = JSON.stringify(result[0]);
    return `${result.length} row${result.length === 1 ? "" : "s"}, ${keys.length} field${keys.length === 1 ? "" : "s"} — first: ${_clip(head, 220)}`;
  }
  if (typeof result === "object") return _clip(JSON.stringify(result), 260);
  return _clip(String(result), 260);
}

/** @param {string} str @param {number} max */
function _clip(str, max) {
  return str.length > max ? `${str.slice(0, max)}…` : str;
}

async function _testStep(e, id) {
  e.stopPropagation();
  const step = _findStepDeep(_pipeline.steps, id);
  if (!step) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return notify("error-log", "No active tab to test against.");
  const card = document.querySelector(
    `.node-wrapper[data-id="${id}"] .node-card`,
  );

  // The outcome class used to sit on the card until the next full render, so a
  // card could still read "success" long after the pipeline had changed.
  clearTimeout(_testStepTimers.get(id));
  card?.classList.remove("success", "error");
  if (card) card.classList.add("running");

  try {
    const res = await chrome.runtime.sendMessage({
      type: "step:execute",
      payload: { step, tabId: tab.id },
    });
    if (res?.error) throw new Error(res.error);
    if (card) {
      card.classList.remove("running");
      card.classList.add("success");
    }
    notify(
      "info-log",
      `Test ${step.type}: ${_describeStepResult(res?.result)}`,
    );
  } catch (err) {
    if (card) {
      card.classList.remove("running");
      card.classList.add("error");
    }
    notify(
      "error-log",
      err.message.includes("Receiving end")
        ? `Test ${step.type}: refresh the target webpage first.`
        : `Test ${step.type} failed: ${err.message}`,
    );
  }

  if (card) {
    _testStepTimers.set(
      id,
      setTimeout(() => card.classList.remove("success", "error"), 6000),
    );
  }
}

// ── Confirmation ──────────────────────────────────────────────────────────────
/**
 * Ask before doing something that cannot be undone.
 *
 * "Clear" wiped the whole pipeline and "Clear Library" deleted every
 * stored file, both on a single click with no confirm and no undo (E-14).
 *
 * @param {{ title: string, body: string, confirmLabel: string }} opts
 * @returns {Promise<boolean>} true if the user confirmed
 */
function _confirmDestructive({ title, body, confirmLabel }) {
  return new Promise((resolve) => {
    const modal = document.createElement("div");
    modal.style.cssText = `
      position: fixed; inset: 0; background: rgba(0,0,0,0.7);
      display: flex; align-items: center; justify-content: center;
      z-index: 9999; backdrop-filter: blur(4px);
    `;

    const card = document.createElement("div");
    card.style.cssText = `
      background: var(--bg-raised); border: 1px solid var(--bg-border);
      border-radius: 12px; padding: 22px; max-width: 340px;
      box-shadow: var(--shadow-fly);
    `;

    // Built as nodes: the body can carry a file name or a step count (C-04).
    const h = document.createElement("h2");
    h.style.cssText = "margin:0 0 6px; font-size:15px;";
    h.textContent = title;

    const p = document.createElement("p");
    p.style.cssText = "margin:0 0 18px; color:var(--text-dim); font-size:12px;";
    p.textContent = body;

    const row = document.createElement("div");
    row.style.cssText = "display:flex; gap:8px;";
    const cancel = document.createElement("button");
    cancel.className = "btn";
    cancel.style.flex = "1";
    cancel.textContent = "Cancel";
    const ok = document.createElement("button");
    ok.className = "btn btn-danger";
    ok.style.flex = "1";
    ok.textContent = confirmLabel;
    row.append(cancel, ok);
    card.append(h, p, row);

    const done = (value) => {
      modal.remove();
      document.removeEventListener("keydown", onKey, true);
      resolve(value);
    };
    function onKey(e) {
      if (e.key === "Escape") done(false);
    }

    cancel.addEventListener("click", () => done(false));
    ok.addEventListener("click", () => done(true));
    modal.addEventListener("click", (e) => {
      if (e.target === modal) done(false);
    });
    document.addEventListener("keydown", onKey, true);

    modal.appendChild(card);
    document.body.appendChild(modal);
    cancel.focus(); // the safe option, not the destructive one
  });
}

// ── Ethics warning confirmation ───────────────────────────────────────────────
/**
 * Show what the ethics gates flagged and let the user decide.
 * @param {Array<{code:string,message:string}>} warnings
 * @returns {Promise<boolean>} true to run anyway
 */
/** Read the worker's attestation for whatever domain the tab is on. */
async function _refreshCaptchaAttestation() {
  _captchaAttest = { host: "", attested: false };
  if (!_tabId) return;
  try {
    const tab = await chrome.tabs.get(_tabId);
    const res = await chrome.runtime.sendMessage({
      type: "captcha:attest-get",
      payload: { origin: tab?.url },
    });
    if (res?.ok) _captchaAttest = res.result;
  } catch {
    // No tab, or a page the panel cannot read. The checkbox shows unattested,
    // which is the answer that refuses.
  }
}

/**
 * Record — or withdraw — the user's statement about a domain.
 *
 * @param {boolean} attested
 * @param {object} step - re-rendered so the card shows what was stored
 */
async function _setCaptchaAttestation(attested, step) {
  try {
    const tab = await chrome.tabs.get(_tabId);
    const res = await chrome.runtime.sendMessage({
      type: "captcha:attest",
      payload: { origin: tab?.url, attested },
    });
    if (res?.ok) _captchaAttest = res.result;
    notify(
      attested ? "info-log" : "warn-log",
      attested
        ? `Attested for ${_captchaAttest.host}: you own it, have permission, or the account is yours.`
        : `Attestation withdrawn for ${_captchaAttest.host}.`,
    );
  } catch {
    notify("error-log", "Could not record the attestation for this domain.");
  }
  if (step) _rerenderCardConfig(step);
}

function _confirmEthicsWarnings(warnings) {
  return new Promise((resolve) => {
    const modal = document.createElement("div");
    modal.style.cssText = `
      position: fixed; inset: 0; background: rgba(0,0,0,0.7);
      display: flex; align-items: center; justify-content: center;
      z-index: 9999; backdrop-filter: blur(4px);
    `;

    const card = document.createElement("div");
    card.style.cssText = `
      background: var(--bg-raised); border: 1px solid var(--bg-border);
      border-radius: 12px; padding: 22px; max-width: 400px; max-height: 80vh;
      overflow-y: auto; box-shadow: var(--shadow-fly);
    `;

    card.innerHTML = `
      <h2 style="margin:0 0 6px; font-size:15px;">⚠ Ethics check</h2>
      <p style="margin:0 0 14px; color:var(--text-dim); font-size:12px;">
        ${warnings.length} warning${warnings.length === 1 ? "" : "s"} before this run starts.
      </p>
      <div style="display:flex; flex-direction:column; gap:8px; margin-bottom:18px;">
        ${warnings
          .map(
            (
              w,
            ) => `<div style="border-left:3px solid var(--yellow, #FACC15); background:var(--bg-hover); padding:8px 10px; border-radius:4px;">
              <div class="mono" style="font-size:10px; color:var(--text-dim); letter-spacing:.04em;">${esc(w.code)}</div>
              <div style="font-size:12px; margin-top:3px;">${esc(w.message)}</div>
            </div>`,
          )
          .join("")}
      </div>
      <div style="display:flex; gap:8px;">
        <button class="btn" id="ethics-cancel" style="flex:1;">Cancel</button>
        <button class="btn btn-primary" id="ethics-proceed" style="flex:1;">Run anyway</button>
      </div>
    `;

    const done = (value) => {
      modal.remove();
      resolve(value);
    };

    card
      .querySelector("#ethics-cancel")
      .addEventListener("click", () => done(false));
    card
      .querySelector("#ethics-proceed")
      .addEventListener("click", () => done(true));
    modal.addEventListener("click", (e) => {
      if (e.target === modal) done(false);
    });

    modal.appendChild(card);
    document.body.appendChild(modal);
    card.querySelector("#ethics-proceed").focus();
  });
}

// ── Selector picker with mode toggle ──────────────────────────────────────────
/**
 * Make sure the content scripts are in the target tab before talking to them.
 *
 * They used to be declared for `<all_urls>` and were therefore always present.
 * Now they are injected on demand (C-09), so the picker has to ask for them.
 *
 * @param {number} tabId
 * @returns {Promise<boolean>} false when the page refuses injection
 */
export async function _ensureContentReady(tabId) {
  const res = await chrome.runtime
    .sendMessage({ type: "content:ensure", payload: { tabId } })
    .catch(() => null);
  if (res?.ok) return true;
  notify(
    "error-log",
    res?.error ||
      "Cannot reach that page. Chrome blocks extensions on chrome:// pages, the Web Store and PDF viewers.",
  );
  return false;
}

/**
 * Unwrap what the picker returned, and remember which document it came from.
 *
 * A selector picked inside an iframe is relative to that frame's document and
 * means nothing in the parent — which is why picking inside one appeared to
 * work and then matched nothing at run time. The frame's URL is stored on the
 * step so the run can be aimed at the same document the user was looking at,
 * instead of the user having to know to flip a toggle called "inFrame".
 *
 * Older picks came back as a bare string; still accepted.
 *
 * @returns {?{selector: string, frameUrl: string}}
 */
function _unwrapPick(result) {
  if (!result) return null;
  if (typeof result === "string") return { selector: result, frameUrl: "" };
  if (!result.selector) return null;
  return {
    selector: result.selector,
    frameUrl: result.top ? "" : (result.frameUrl ?? ""),
  };
}

/** Point a step at the frame a selector was picked in, or clear it. */
function _applyPickedFrame(step, frameUrl) {
  if (!step?.config) return "";
  if (frameUrl) {
    step.config.frameUrl = frameUrl;
    step.config.inFrame = true;
    try {
      return ` — inside the frame at ${new URL(frameUrl).pathname || frameUrl}`;
    } catch {
      return " — inside an embedded frame";
    }
  }
  delete step.config.frameUrl;
  return "";
}

/** Disarm the pickers in every frame that was not the one clicked in. */
function _cancelPickersElsewhere(tabId) {
  chrome.tabs
    .sendMessage(tabId, { type: "VQ_PICK_CANCEL", payload: {} })
    .catch(() => {});
}

async function _pickSelector(stepId, key) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return notify("error-log", "No active tab available.");

  const step = _findStepDeep(_pipeline.steps, stepId);
  const stepType = step?.type;
  // A LOOP's `selector` means two different things depending on its mode: the
  // records to iterate (bulk) or the Next control (one element). Defaulting
  // paginate mode to bulk handed PAGINATE a selector matching every link in
  // the paginator — and it clicks the first, which is page 1. The run then
  // re-scraped page 1 until "max pages" ran out.
  const paginating = stepType === "LOOP" && step?.config?.type === "paginate";
  const defaultBulk =
    key === "selector" && ["EXTRACT", "LOOP"].includes(stepType) && !paginating;

  // Show mode selector modal
  const mode = await _selectSelectorMode(defaultBulk);
  if (mode === null) return; // cancelled

  try {
    if (!(await _ensureContentReady(tab.id))) return;
    const resp = await chrome.tabs.sendMessage(tab.id, {
      type: "VQ_PICK_SELECTOR",
      payload: { bulk: mode },
    });
    _cancelPickersElsewhere(tab.id);
    const picked = _unwrapPick(resp?.ok ? resp.result : null);
    if (picked) {
      const note = _applyPickedFrame(step, picked.frameUrl);
      if (note) {
        saveState();
        notify("info-log", `Picked${note}. The step will run there.`);
      }
      const input = document.getElementById(`cfg-${stepId}-${key}`);
      if (input) {
        input.value = picked.selector;
        const badge = input.parentElement?.querySelector(
          ".selector-mode-badge",
        );
        if (badge) badge.textContent = mode ? "Bulk" : "Specific";
        input.dispatchEvent(new Event("change"));
      }
    }
  } catch {
    notify("error-log", "Refresh the target webpage to connect the picker.");
  }
}

async function _selectSelectorMode(defaultBulk) {
  const modal = document.createElement("div");
  modal.style.cssText = `
    position: fixed; top: 0; left: 0; width: 100%; height: 100%;
    background: rgba(0,0,0,0.7); display: flex; align-items: center; justify-content: center;
    z-index: 9999; backdrop-filter: blur(4px);
  `;

  const card = document.createElement("div");
  card.style.cssText = `
    background: var(--bg-raised); border: 1px solid var(--bg-border); border-radius: 12px;
    padding: 24px; max-width: 380px; box-shadow: var(--shadow-fly);
  `;

  card.innerHTML = `
    <div style="margin-bottom: 20px;">
      <h2 style="margin: 0 0 8px; font-size: 16px;">Selector Mode</h2>
      <p style="margin: 0; color: var(--text-dim); font-size: 12px;">Choose how to match elements:</p>
    </div>
    <div style="display: flex; gap: 12px; margin-bottom: 16px;">
      <button class="selector-mode-btn" data-mode="specific">
        Specific
        <div class="selector-mode-sub">This one element</div>
      </button>
      <button class="selector-mode-btn" data-mode="bulk">
        Bulk
        <div class="selector-mode-sub">The same field in every record</div>
      </button>
    </div>
    <button class="btn" style="width:100%; margin-top:16px;" id="modal-cancel">Cancel</button>
  `;

  let result = null;

  return new Promise((resolve) => {
    const buttons = card.querySelectorAll(".selector-mode-btn");
    buttons.forEach((btn) => {
      btn.addEventListener("click", () => {
        result = btn.dataset.mode === "bulk";
        modal.remove();
        resolve(result);
      });
    });

    card.querySelector("#modal-cancel").addEventListener("click", () => {
      modal.remove();
      resolve(null);
    });

    // Exactly one is marked as the suggestion. The Specific button used to
    // carry the highlight in its own inline style, so it always looked chosen —
    // and where bulk was the default, both did.
    card
      .querySelector(`[data-mode="${defaultBulk ? "bulk" : "specific"}"]`)
      ?.classList.add("suggested");

    modal.appendChild(card);
    document.body.appendChild(modal);
  });
}

// ── Detect table ──────────────────────────────────────────────────────────────
/**
 * Read the page's repeating structures and offer them as tables.
 *
 * The normal way to build a scrape is to know CSS selectors before you start:
 * name a field, pick it, repeat, hope they line up. This inverts it — the page
 * is read, and the user picks a table by looking at sample rows.
 */
async function _detectStructure() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return notify("error-log", "No active tab to read.");

  notify("info-log", "Reading the page…");
  const res = await chrome.runtime
    .sendMessage({ type: "content:detect", payload: { tabId: tab.id } })
    .catch(() => null);

  if (!res?.ok) {
    notify("error-log", res?.error || "Could not read that page.");
    return;
  }

  const { candidates = [] } = res.result ?? {};
  if (!candidates.length) {
    // A single-record page — a product, an article, a listing — has nothing
    // repeating to find, and that is most of the pages people point this at
    // after a list. Before sending them off to pick elements by hand, look for
    // the structured data the page probably already publishes: it needs no
    // selectors at all and does not break when the site's CSS changes.
    await _offerPageData(tab.id);
    return;
  }

  const chosen = await _chooseDetectedTable(candidates);
  if (!chosen) return;
  await _insertDetectedTable(chosen);
}

/**
 * The fallback when there is no repeating structure: read the page's own data.
 *
 * Only offered when there is actually something to read. Suggesting a step that
 * would come back empty is worse than saying nothing, because the user spends a
 * run finding out.
 *
 * @param {number} tabId
 */
async function _offerPageData(tabId) {
  const res = await chrome.runtime
    .sendMessage({
      type: "step:execute",
      payload: {
        step: { id: "probe", type: "PAGE_DATA", config: { source: "auto" } },
        tabId,
      },
    })
    .catch(() => null);

  const data = res?.ok ? res.result : null;
  if (!data?.found) {
    notify(
      "warn-log",
      "No repeating tables here, and the page publishes no structured data either. " +
        "Pick the fields you want by hand.",
    );
    return;
  }

  const types = [
    ...new Set(
      (data.records ?? [])
        .map((r) => (Array.isArray(r["@type"]) ? r["@type"][0] : r["@type"]))
        .filter(Boolean),
    ),
  ];
  const what = types.length
    ? `${types.join(", ")} data`
    : `${Object.keys(data.meta ?? {}).length} page tags`;

  const ok = await _confirmDestructive({
    title: "No table — but this page describes itself",
    body:
      `There is nothing repeating on this page to loop over, but it publishes ` +
      `${what} for search engines. Reading that needs no selectors, and it does ` +
      `not break when the site changes its layout.\n\nAdd a "Read the page's own data" step?`,
    confirmLabel: "Add the step",
  });
  if (!ok) return;

  const stepNode = {
    id: _nextStepId(),
    type: "PAGE_DATA",
    config: {
      ...defaultConfig("PAGE_DATA"),
      type: types.length === 1 ? types[0] : "",
    },
  };
  _pipeline.steps.push(stepNode);
  _expandedNodeIds.add(stepNode.id);
  saveState();
  renderPipeline();
  notify(
    "info-log",
    `Added a step that reads this page's ${what}. Run it to see the rows.`,
  );
}

/**
 * Show what was found and let the user pick, by reading rows rather than
 * selectors.
 *
 * @param {object[]} candidates
 * @returns {Promise<object|null>}
 */
function _chooseDetectedTable(candidates) {
  return new Promise((resolve) => {
    const modal = document.createElement("div");
    modal.style.cssText = `
      position: fixed; inset: 0; background: rgba(0,0,0,0.7);
      display: flex; align-items: center; justify-content: center;
      z-index: 9999; backdrop-filter: blur(4px);
    `;

    const card = document.createElement("div");
    card.style.cssText = `
      background: var(--bg-raised); border: 1px solid var(--bg-border);
      border-radius: 12px; padding: 20px; width: min(560px, 92vw);
      max-height: 82vh; overflow-y: auto; box-shadow: var(--shadow-fly);
    `;

    const h = document.createElement("h2");
    h.style.cssText = "margin:0 0 4px; font-size:15px;";
    h.textContent = `Found ${candidates.length} table${candidates.length === 1 ? "" : "s"}`;

    const sub = document.createElement("p");
    sub.style.cssText =
      "margin:0 0 14px; color:var(--text-dim); font-size:12px;";
    sub.textContent =
      "Pick the one whose rows look right. It becomes a loop with the columns already filled in.";
    card.append(h, sub);

    const done = (value) => {
      modal.remove();
      document.removeEventListener("keydown", onKey, true);
      resolve(value);
    };
    function onKey(e) {
      if (e.key === "Escape") done(null);
    }

    for (const c of candidates) {
      const btn = document.createElement("button");
      btn.className = "detect-card";
      btn.type = "button";

      const head = document.createElement("div");
      head.className = "detect-head";
      const count = document.createElement("span");
      count.className = "detect-count";
      count.textContent = `${c.count} rows × ${c.fields.length} columns`;
      const sel = document.createElement("code");
      sel.className = "mono";
      sel.style.cssText = "font-size:10px; color:var(--text-dim);";
      sel.textContent = c.selector;
      head.append(count, sel);
      btn.appendChild(head);

      // Built as nodes: every value here is page content (C-04).
      const scroll = document.createElement("div");
      scroll.className = "detect-scroll";
      const table = document.createElement("table");
      table.className = "detect-table";

      const thead = document.createElement("thead");
      const hrow = document.createElement("tr");
      for (const f of c.fields) {
        const th = document.createElement("th");
        th.textContent = f.name;
        th.title = `${f.selector} · ${f.coverage}% of rows`;
        hrow.appendChild(th);
      }
      thead.appendChild(hrow);
      table.appendChild(thead);

      const tbody = document.createElement("tbody");
      for (const row of c.sampleRows ?? []) {
        const tr = document.createElement("tr");
        for (const f of c.fields) {
          const td = document.createElement("td");
          const v = String(row[f.name] ?? "");
          td.textContent = v.length > 40 ? `${v.slice(0, 40)}…` : v;
          td.title = v;
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      scroll.appendChild(table);
      btn.appendChild(scroll);

      btn.addEventListener("click", () => done(c));
      card.appendChild(btn);
    }

    const cancel = document.createElement("button");
    cancel.className = "btn";
    cancel.style.cssText = "width:100%; margin-top:4px;";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => done(null));
    card.appendChild(cancel);

    modal.addEventListener("click", (e) => {
      if (e.target === modal) done(null);
    });
    document.addEventListener("keydown", onKey, true);
    modal.appendChild(card);
    document.body.appendChild(modal);
    card.querySelector(".detect-card")?.focus();
  });
}

/**
 * Turn a detected table into steps.
 *
 * A LOOP over the container with a nested EXTRACT, rather than one EXTRACT with
 * page-wide selectors. EXTRACT lines its columns up positionally, so a record
 * missing a rating shifts every later rating up a row. Scoping each iteration
 * to its own container is what makes a row a row.
 *
 * @param {object} table
 */
/**
 * The obvious clean-up for a detected column, from what its samples look like.
 *
 * The point of Detect Table is that you press one button and get usable data.
 * Handing back a price column full of "$25.50" strings, and a link column of
 * "/p/123", makes the user do the last mile by hand — which is the mile they
 * came here to avoid. Conservative on purpose: only a column that is *mostly*
 * currency gets read as a number, because guessing wrong is worse than not
 * guessing, and the choice is visible and changeable in the field's row.
 *
 * @param {{kind: string, samples: string[]}} field
 * @returns {string} a transform name, or "" to leave the value alone
 */
function _transformFor(field) {
  if (field.kind === "href" || field.kind === "src") return "url";
  const samples = (field.samples ?? [])
    .filter(Boolean)
    .map((s) => String(s).trim());
  if (samples.length === 0) return "";

  // A column that is *entirely* numbers — populations, areas, counts — is a
  // number. Every sample must qualify, not a majority: a column that is 90%
  // numbers and 10% "N/A" would otherwise turn that 10% into empty cells with
  // nothing said. Leaving it as text costs a conversion; getting it wrong
  // costs data.
  const plainNumber = /^[^\d-]{0,3}-?\d[\d.,\s]*(?:[eE][+-]?\d+)?[^\d]{0,4}$/;
  if (samples.every((s) => plainNumber.test(s))) return "number";

  // Otherwise only where the column reads as money: a currency mark, or a
  // two-decimal amount. "Ships in 2 days" has a number in it and is not one.
  const money = samples.filter(
    (s) => plainNumber.test(s) && /[$£€¥₹]|\d[.,]\d{2}\b/.test(s),
  ).length;
  return money / samples.length > 0.6 ? "number" : "";
}

/**
 * An existing element-loop over this selector, anywhere in the pipeline.
 *
 * Searched depth-first through loop bodies and branches, because a detected
 * table can be dropped inside another container and would still scrape the same
 * list twice.
 *
 * @param {object[]} steps
 * @param {string} selector
 * @returns {?object}
 */
function _findDetectedLoop(steps, selector) {
  for (const step of steps ?? []) {
    if (
      step.type === "LOOP" &&
      step.config?.type === "elements" &&
      step.config?.selector === selector
    ) {
      return step;
    }
    const nested = _findDetectedLoop(
      [
        ...(step.children ?? []),
        ...(step.ifBranch ?? []),
        ...(step.elseBranch ?? []),
      ],
      selector,
    );
    if (nested) return nested;
  }
  return null;
}

async function _insertDetectedTable(table) {
  const extract = {
    id: _nextStepId(),
    type: "EXTRACT",
    config: {
      ...defaultConfig("EXTRACT"),
      fields: table.fields.map((f) => ({
        name: f.name,
        selector: f.selector,
        // The detector's `kind` and EXTRACT's `type` are two vocabularies; this
        // is the only place they meet. A kind with no reader here would produce
        // a column the run silently returns empty, so every kind the detector
        // can emit is named.
        type:
          f.kind === "text"
            ? "text"
            : f.kind === "count"
              ? "count"
              : "attribute",
        ...(f.kind === "href" ? { attribute: "href" } : {}),
        ...(f.kind === "src" ? { attribute: "src" } : {}),
        ...(f.kind === "attr" ? { attribute: f.attribute } : {}),
        ...(f.kind === "count" ? { countSelector: f.countSelector } : {}),
        ...(_transformFor(f) ? { transform: [_transformFor(f)] } : {}),
      })),
    },
  };

  const loop = {
    id: _nextStepId(),
    type: "LOOP",
    config: {
      ...defaultConfig("LOOP"),
      type: "elements",
      selector: table.selector,
      max: 0, // every match; the page decides how many rows there are
    },
    children: [extract],
  };

  // Pressing the button again used to append a second loop over the same list,
  // say "Added a loop", and give no hint the first was still there. A real run
  // came back with every row five times over — five presses, five full scrapes,
  // no warning anywhere (J-13).
  const existing = _findDetectedLoop(_pipeline.steps, table.selector);
  if (existing) {
    const replace = await _confirmDestructive({
      title: "This list is already in the pipeline",
      body:
        `There is already a loop over ${table.selector}. Adding another would ` +
        `scrape the same list twice, and every row would appear twice in the ` +
        `export.\n\nReplace the existing one?`,
      confirmLabel: "Replace it",
    });
    if (!replace) {
      notify(
        "info-log",
        `Left the pipeline alone — ${table.selector} is already being scraped.`,
      );
      return;
    }
    _removeStepDeep(_pipeline.steps, existing.id);
  }

  _pipeline.steps.push(loop);
  _expandedNodeIds.add(extract.id);
  saveState();
  renderPipeline();
  notify(
    "info-log",
    `${existing ? "Replaced the loop" : "Added a loop"} over ${table.selector} with ${extract.config.fields.length} columns. Check the selectors, then Run.`,
  );
}

// ── Extract field management ──────────────────────────────────────────────────

/**
 * A column name guessed from the selector that produced it.
 *
 * Naming a field before you have picked it is backwards — you do not know what
 * you are about to click. The name box is optional now, and this fills it.
 *
 * @param {string} selector
 * @returns {string}
 */
function _fieldNameFromSelector(selector) {
  const last =
    String(selector)
      .split(/[\s>+~]+/)
      .filter(Boolean)
      .pop() ?? "";
  const token =
    last.match(/\.([A-Za-z][\w-]*)/)?.[1] ??
    last.match(/#([A-Za-z][\w-]*)/)?.[1] ??
    last.match(/\[data-[\w-]*=?"?([\w-]+)/)?.[1] ??
    last.replace(/[^A-Za-z]/g, "");
  const cleaned = token
    // Strip the one- or two-letter prefixes design systems put on everything.
    .replace(/^(s|p|c|js|is|ui|el)[-_]/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim()
    .toLowerCase();
  return cleaned || "field";
}

/**
 * The container of the nearest LOOP a step sits inside, if any.
 *
 * A field picked inside a loop over `.card` should be described relative to a
 * card — the loop already says what a record is. Without this the picker
 * returned a page-wide selector, so every row of the scrape got the same
 * value, or a value from whichever card happened to be first.
 *
 * @param {string} stepId
 * @returns {string} the loop's selector, or "" when there is no scope
 */
function _loopScopeFor(stepId) {
  let found = _locateStep(_pipeline.steps, stepId);
  while (found?.parent) {
    const p = found.parent;
    if (
      p.type === "LOOP" &&
      p.config?.type === "elements" &&
      p.config?.selector
    ) {
      return p.config.selector;
    }
    found = _locateStep(_pipeline.steps, p.id);
  }
  return "";
}

async function _addExtractField(stepId) {
  const nameInput = document.getElementById(`new-ex-name-${stepId}`);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  // Inside a loop, the record is already chosen and the field is a column
  // within it — so there is nothing to ask about, and the selector comes back
  // relative to the record. Outside one, extract usually wants a column, so
  // bulk stays the default.
  const scopeSelector = _loopScopeFor(stepId);
  const bulk = scopeSelector ? false : await _selectSelectorMode(true);
  if (bulk === null) return;

  try {
    if (!(await _ensureContentReady(tab.id))) return;
    const resp = await chrome.tabs.sendMessage(tab.id, {
      type: "VQ_PICK_SELECTOR",
      payload: { bulk, scopeSelector },
    });
    _cancelPickersElsewhere(tab.id);
    const picked = _unwrapPick(resp?.ok ? resp.result : null);
    if (!picked) return;

    const step = _findStepDeep(_pipeline.steps, stepId);
    if (!step) return;
    const frameNote = _applyPickedFrame(step, picked.frameUrl);
    const name =
      nameInput?.value.trim() || _fieldNameFromSelector(picked.selector);
    step.config.fields.push({ name, selector: picked.selector, type: "text" });
    if (nameInput) nameInput.value = "";
    saveState();
    renderPipeline();
    notify(
      "info-log",
      (scopeSelector
        ? `Added field "${name}" — read from each ${scopeSelector} the loop visits.`
        : `Added field "${name}" — ${bulk ? "all matches" : "this element"}.`) +
        frameNote,
    );
  } catch {
    notify("error-log", "Refresh the target webpage to connect the picker.");
  }
}
function _removeExtractField(stepId, idx) {
  const step = _findStepDeep(_pipeline.steps, stepId);
  if (step?.config?.fields) {
    step.config.fields.splice(idx, 1);
    saveState();
    renderPipeline();
  }
}

// ── Fill field management ─────────────────────────────────────────────────────
async function _addFillField(stepId) {
  const valInput = document.getElementById(`new-fill-val-${stepId}`);
  const value = valInput?.value || "";
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  try {
    if (!(await _ensureContentReady(tab.id))) return;
    const resp = await chrome.tabs.sendMessage(tab.id, {
      type: "VQ_PICK_SELECTOR",
      payload: { bulk: false },
    });
    _cancelPickersElsewhere(tab.id);
    const picked = _unwrapPick(resp?.ok ? resp.result : null);
    if (picked) {
      const step = _findStepDeep(_pipeline.steps, stepId);
      if (step) {
        _applyPickedFrame(step, picked.frameUrl);
        if (!Array.isArray(step.config.fields)) step.config.fields = [];
        step.config.fields.push({ selector: picked.selector, value });
        saveState();
        renderPipeline();
      }
    }
  } catch {
    notify("error-log", "Refresh the target webpage to connect the picker.");
  }
}
function _removeFillField(stepId, idx) {
  const step = _findStepDeep(_pipeline.steps, stepId);
  if (step?.config?.fields) {
    step.config.fields.splice(idx, 1);
    saveState();
    renderPipeline();
  }
}

function _uploadStepSelectAll(stepId) {
  const step = _findStepDeep(_pipeline.steps, stepId);
  if (!step) return;
  step.config.fileIds = _storageFiles.map((f) => f.id);
  saveState();
  _rerenderCardConfig(step);
}

function _uploadStepClear(stepId) {
  const step = _findStepDeep(_pipeline.steps, stepId);
  if (!step) return;
  step.config.fileIds = [];
  saveState();
  _rerenderCardConfig(step);
}

function _uploadStepToggleFile(stepId, fileId, checked) {
  const step = _findStepDeep(_pipeline.steps, stepId);
  if (!step) return;

  if (!Array.isArray(step.config.fileIds)) step.config.fileIds = [];
  const next = new Set(step.config.fileIds);
  if (checked) next.add(fileId);
  else next.delete(fileId);
  step.config.fileIds = [...next];

  saveState();
  const sub = document.querySelector(
    `.node-wrapper[data-id="${step.id}"] .node-subtitle`,
  );
  if (sub) sub.textContent = getStepSubtitle(step);
}

// ── Keyboard register ─────────────────────────────────────────────────────────
/** How long the panel waits for a keystroke before giving up. */
const KEY_CAPTURE_SECONDS = 15;

/**
 * Combos Chrome handles before any page or extension sees them.
 *
 * Reported from a real session: pressing Ctrl+W to register it closed the tab.
 * It always will. `preventDefault` does not reach browser-level shortcuts —
 * a page that could block Ctrl+W could trap you on itself — so these can only
 * be typed, never captured, and the step can still send them as synthetic
 * events for a page that listens for them.
 */
const BROWSER_RESERVED_KEYS = Object.freeze([
  "w",
  "t",
  "n",
  "q",
  "shift+w",
  "shift+t",
  "shift+n",
  "shift+q",
]);

/**
 * Will the browser take this combo before the page gets it?
 * @param {string} combo - e.g. "Ctrl+W"
 * @returns {boolean}
 */
function _isBrowserReservedKey(combo) {
  const parts = String(combo || "")
    .toLowerCase()
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean);
  const key = parts.pop() ?? "";
  const ctrlish = parts.includes("ctrl") || parts.includes("meta");
  if (!ctrlish) return false;
  const rest = parts.filter((p) => p !== "ctrl" && p !== "meta").join("+");
  return BROWSER_RESERVED_KEYS.includes(rest ? `${rest}+${key}` : key);
}

function _registerKey(stepId) {
  if (_keyListening) return;
  _keyListening = true;
  const btn = document.getElementById(`key-reg-${stepId}`);
  const disp = document.getElementById(`key-disp-${stepId}`);
  if (btn) {
    btn.textContent = `⏺ Press key(s)… ${KEY_CAPTURE_SECONDS}s`;
    btn.classList.add("listening");
  }

  const onKey = (e) => {
    // Ignore standalone modifier presses
    if (["Control", "Alt", "Shift", "Meta"].includes(e.key)) return;
    e.preventDefault();
    clearInterval(countdown);
    e.stopPropagation();

    // Build combo string e.g. "Ctrl+Shift+Enter"
    const parts = [];
    if (e.ctrlKey) parts.push("Ctrl");
    if (e.altKey) parts.push("Alt");
    if (e.shiftKey) parts.push("Shift");
    if (e.metaKey) parts.push("Meta");
    parts.push(e.key === " " ? "Space" : e.key);
    const combo = parts.join("+");

    const step = _findStepDeep(_pipeline.steps, stepId);
    if (step) {
      step.config.key = combo;
      saveState();
    }
    if (disp) disp.textContent = combo;
    if (btn) {
      btn.textContent = `✓ ${combo}`;
      btn.classList.remove("listening");
    }
    document.removeEventListener("keydown", onKey, true);
    _keyListening = false;
  };

  document.addEventListener("keydown", onKey, true);

  // The button used to sit on "⏺ Press key(s)..." and then silently revert
  // after 15 seconds, with nothing to say why (E-17). Count it down instead,
  // and say what happened when it runs out.
  let remaining = KEY_CAPTURE_SECONDS;
  const countdown = setInterval(() => {
    remaining -= 1;
    if (remaining > 0) {
      if (_keyListening && btn)
        btn.textContent = `⏺ Press key(s)… ${remaining}s`;
      return;
    }
    clearInterval(countdown);
    if (!_keyListening) return;
    document.removeEventListener("keydown", onKey, true);
    _keyListening = false;
    if (btn) {
      btn.textContent = "Register Key";
      btn.classList.remove("listening");
    }
    notify(
      "warn-log",
      "No key pressed — key capture timed out. Click to retry.",
    );
  }, 1000);
}

// ── System listeners ──────────────────────────────────────────────────────────
function listenToSystem() {
  // ── Marketplace "Run Now" / "Load" bridge ───────────────────────────────
  // The marketplace SPA cannot know our tab-scoped SK.PIPELINE key, so it
  // writes to a shared key vq_marketplace_load. We pick it up here and
  // immediately load it into the active canvas, then clear the bridge key.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (!changes.vq_marketplace_load) return;
    const pipeline = changes.vq_marketplace_load.newValue;
    if (
      !pipeline ||
      typeof pipeline !== "object" ||
      !Array.isArray(pipeline.steps)
    )
      return;

    _pipeline = pipeline;
    renderPipeline();
    chrome.storage.local.set({ [SK.PIPELINE]: _pipeline });
    // Clear the bridge key so this won't re-trigger
    chrome.storage.local.remove("vq_marketplace_load");
    notify(
      "info-log",
      `Pipeline "${pipeline.name || pipeline.id}" loaded from Marketplace.`,
    );
  });

  chrome.runtime.onMessage.addListener((msg) => {
    // If msg provides a tabId, only log/update if it matches our sidepanel's tab
    if (msg.payload?.tabId && msg.payload.tabId !== _tabId) return;
    if (msg.payload?.runId && msg.payload.runId !== _runState.runId) return;

    if (msg.type === "pipeline:status") {
      const info = msg.payload;
      if (info.progress?.total) {
        const pct = Math.round(
          (info.progress.current / info.progress.total) * 100,
        );
        const fill = document.getElementById("mon-progress-fill");
        if (fill) {
          fill.style.width = `${pct}%`;
          document.getElementById("mon-progress-text").textContent = `${pct}%`;
        }
      }
      // The card is labelled Rows Extracted and now reports rows. It used to
      // show progress.current, which is a step counter (E-04).
      if (typeof info.rows === "number") {
        document.getElementById("mon-rows").textContent = info.rows;
      }
      if (info.currentStepId) {
        document
          .querySelectorAll(".node-card")
          .forEach((n) => n.classList.remove("running", "success", "error"));

        const active = document.querySelector(
          `.node-wrapper[data-id="${info.currentStepId}"] .node-card`,
        );
        if (active) {
          active.classList.add("running");
          _focusNodeOnBoard(active);
        }
        document.getElementById("mon-state").textContent = "Running...";
        document.getElementById("mon-state").style.color = "var(--text-main)";
      }
      if (info.state === "completed" || info.state === "stopped") {
        stopRunUI();

        document.getElementById("mon-state").textContent =
          info.state === "completed" ? "Success" : "Stopped";
        document.getElementById("mon-state").style.color =
          info.state === "completed" ? "var(--green)" : "var(--text-dim)";
        logToMonitor(
          info.state === "completed" ? "info-log" : "warn-log",
          `Pipeline ${info.state}.`,
        );
      }
    }
    if (msg.type === "pipeline:provenance") {
      renderProvenance(msg.payload?.provenance);
    }

    if (msg.type === "pipeline:selectors") {
      offerLearnedSelectors(msg.payload);
    }

    if (msg.type === "pipeline:log") {
      logToMonitor(msg.payload.level, msg.payload.message);
      if (msg.payload.level === "error-log") {
        const el = document.getElementById("mon-errs");
        if (el) el.textContent = parseInt(el.textContent || "0") + 1;
      }
    }

    // A captcha is the one pause the user has to act on, so it says what to do
    // rather than leaving them to work out why the run stopped.
    if (msg.type === "pipeline:captcha") {
      _setPausedUI(true);
      const state = document.getElementById("mon-state");
      if (state) {
        state.textContent = "Captcha";
        state.style.color = "var(--yellow, #E8B33A)";
      }
      notify(
        "warn-log",
        `Solve the ${msg.payload.type} captcha in the page, then press Resume.`,
      );
    }

    // A live count, because the log deliberately stops naming captures after
    // the third — on a site that makes forty calls that left the panel silent
    // for the rest of the run and the sniffer looking stalled.
    if (msg.type === "pipeline:captures") {
      const card = document.getElementById("mon-apis-card");
      const val = document.getElementById("mon-apis");
      if (card) card.classList.remove("hidden");
      if (val) val.textContent = String(msg.payload.networks ?? 0);
    }
  });
}

const MAX_LOG_ENTRIES = 500;

/**
 * Say something the user needs to see now.
 *
 * Routine errors used to come out of `alert()` — a blocking, unstyled, OS-level
 * dialog for "refresh the page first" (E-06). The log pane was already there
 * for this, but it lives behind a tab the user may not be looking at, so this
 * writes to both: a transient banner, and a permanent log entry.
 *
 * @param {'info-log'|'warn-log'|'error-log'} levelClass
 * @param {string} message
 */
export function notify(levelClass, message) {
  logToMonitor(levelClass, message);

  let host = document.getElementById("vq-toasts");
  if (!host) {
    host = document.createElement("div");
    host.id = "vq-toasts";
    document.body.appendChild(host);
  }

  const el = document.createElement("div");
  el.className = `vq-toast ${levelClass}`;
  el.textContent = String(message ?? "");
  host.appendChild(el);

  const kill = () => el.remove();
  el.addEventListener("click", kill);
  setTimeout(kill, levelClass === "error-log" ? 7000 : 4000);
}

function logToMonitor(levelClass, message) {
  const logs = document.getElementById("mon-logs");
  if (!logs) return;
  const d = new Date();
  const ts = `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}:${d.getSeconds().toString().padStart(2, "0")}`;

  const div = document.createElement("div");
  div.className = `log-entry ${levelClass}`;

  // Built as nodes, not innerHTML. Log messages routinely carry page-derived
  // text — selectors, extracted values, API URLs, thrown error messages — so
  // interpolating them as markup let a page break the panel's layout or inject
  // content into it. CSP blocks inline script, but not markup injection.
  const tsEl = document.createElement("span");
  tsEl.className = "log-ts";
  tsEl.textContent = `[${ts}]`;

  const msgEl = document.createElement("span");
  msgEl.className = "log-msg";
  msgEl.textContent = String(message ?? "");

  div.append(tsEl, msgEl);
  logs.appendChild(div);

  // The pane grew without bound; a long run accumulated tens of thousands of
  // nodes and the panel got slower the longer it ran.
  while (logs.childElementCount > MAX_LOG_ENTRIES) {
    logs.removeChild(logs.firstElementChild);
  }

  logs.scrollTop = logs.scrollHeight;
}

/**
 * Schedule the pipeline currently on the board.
 *
 * The pipeline is copied into the schedule rather than referenced. A schedule
 * pointing at "whatever is on the board" would change meaning every time the
 * user edits something, and would run a half-built pipeline at 3am.
 */
async function _addSchedule() {
  const url = document.getElementById("sched-url")?.value?.trim() ?? "";
  const every = Number(document.getElementById("sched-every")?.value ?? 60);

  if (!_pipeline.steps?.length) {
    return logToMonitor(
      "warn-log",
      "There is no pipeline on the board to schedule.",
    );
  }

  const res = await chrome.runtime.sendMessage({
    type: "schedule:save",
    payload: {
      schedule: {
        name: _pipeline.name || new URL(url || "https://x.test").hostname,
        url,
        everyMinutes: every,
        pipeline: { name: _pipeline.name, steps: _pipeline.steps },
      },
    },
  });

  if (!res?.ok) {
    return logToMonitor(
      "error-log",
      res?.error ?? "Could not save the schedule.",
    );
  }
  if (res.result?.note) {
    // Said, not silently applied: a schedule firing at a rate other than the
    // number the user typed is how they conclude the feature is broken.
    logToMonitor("warn-log", res.result.note);
  }
  logToMonitor(
    "info-log",
    `Scheduled "${res.result.name}" every ${res.result.everyMinutes} minute(s). ` +
      "It only fires while Chrome is running.",
  );
  await _renderSchedules();
}

/** Draw the stored schedules, with what each one last did. */
async function _renderSchedules() {
  const box = document.getElementById("sched-list");
  if (!box) return;
  const res = await chrome.runtime
    .sendMessage({ type: "schedule:list" })
    .catch(() => null);
  box.replaceChildren();
  const list = res?.ok ? (res.result.schedules ?? []) : [];

  if (list.length === 0) {
    const none = document.createElement("p");
    none.className = "prose";
    none.textContent = "No schedules yet.";
    box.appendChild(none);
    return;
  }

  for (const s of list) {
    const row = document.createElement("div");
    row.className = "flex gap-2 mb-2";
    row.style.cssText = "align-items:baseline;font-size:11px;";

    const label = document.createElement("span");
    // Built as nodes: the name comes from a pipeline the user may have
    // imported, and the URL is theirs to type.
    label.textContent = `${s.name} — every ${s.everyMinutes} min — ${s.url}`;
    label.style.flex = "1";

    const state = document.createElement("span");
    state.textContent = s.lastRunAt
      ? `last: ${new Date(s.lastRunAt).toLocaleString()}${s.lastStatus && s.lastStatus !== "started" ? ` (${s.lastStatus})` : ""}`
      : "never run";
    state.style.color = "var(--text-dim)";

    const toggleBtn = document.createElement("button");
    toggleBtn.className = "btn";
    toggleBtn.textContent = s.enabled ? "Pause" : "Resume";
    toggleBtn.addEventListener("click", async () => {
      await chrome.runtime.sendMessage({
        type: "schedule:save",
        payload: { schedule: { ...s, enabled: !s.enabled } },
      });
      await _renderSchedules();
    });

    const del = document.createElement("button");
    del.className = "btn";
    del.textContent = "Delete";
    del.addEventListener("click", async () => {
      await chrome.runtime.sendMessage({
        type: "schedule:delete",
        payload: { id: s.id },
      });
      await _renderSchedules();
    });

    row.append(label, state, toggleBtn, del);
    box.appendChild(row);
  }
}

/**
 * Offer the selectors the model proposed and the page confirmed.
 *
 * Offered, not added. A step appearing in a pipeline nobody put there is worse
 * than not offering one, however good the selectors are — and the whole point
 * of this feature is that the user ends up with a pipeline they can read.
 *
 * What it buys them, said plainly on the button: after this the site is
 * scraped with no model at all, which also means the pipeline exports to a
 * Playwright or Python script. AUTO_EXTRACT never could.
 */
function offerLearnedSelectors(payload) {
  const logs = document.getElementById("mon-logs");
  if (!logs || !payload?.step) return;
  const fields = payload.step.config?.fields ?? [];
  if (fields.length === 0) return;

  const box = document.createElement("div");
  box.className = "log-entry info-log learned-selectors";

  const head = document.createElement("div");
  head.className = "log-msg";
  head.style.fontWeight = "600";
  head.textContent = `${fields.length} selector(s) verified against this page`;
  box.appendChild(head);

  for (const f of fields) {
    const line = document.createElement("div");
    line.style.cssText =
      "display:flex;gap:8px;font-size:11px;padding-left:8px;";
    const name = document.createElement("span");
    name.className = "mono";
    name.textContent = f.name;
    name.style.cssText = "min-width:96px;color:var(--text-main);";
    const sel = document.createElement("span");
    sel.className = "mono";
    sel.textContent = f.selector;
    sel.style.color = "var(--text-dim)";
    line.append(name, sel);
    if ((payload.fragile ?? []).includes(f.name)) {
      const warn = document.createElement("span");
      // Kept, and said out loud: it works now and will break on a redesign,
      // which is not the same as a selector that is wrong today.
      warn.textContent =
        "position-based — will break if the page is restructured";
      warn.style.color = "var(--amber,#d97706)";
      line.appendChild(warn);
    }
    box.appendChild(line);
  }

  const note = document.createElement("p");
  note.style.cssText =
    "font-size:11px;color:var(--text-dim);margin:6px 0 6px 8px;";
  note.textContent =
    "Each of these was run in the page and produced the value the model " +
    "reported. Saved as an EXTRACT step, this site is scraped with no model " +
    "at all \u2014 and the pipeline exports to a script, which AUTO_EXTRACT cannot.";
  box.appendChild(note);

  const btn = document.createElement("button");
  btn.className = "btn";
  btn.style.marginLeft = "8px";
  btn.textContent = "Save as an EXTRACT step";
  btn.addEventListener("click", () => {
    const stepNode = {
      id: _nextStepId(),
      type: "EXTRACT",
      config: { ...defaultConfig("EXTRACT"), ...payload.step.config },
    };
    _pipeline.steps.push(stepNode);
    _expandedNodeIds.add(stepNode.id);
    saveState();
    renderPipeline();
    btn.disabled = true;
    btn.textContent = "Added";
    logToMonitor(
      "info-log",
      `Added an EXTRACT step with ${fields.length} verified selector(s). ` +
        "It runs on its own, with no model.",
    );
  });
  box.appendChild(btn);

  logs.appendChild(box);
  while (logs.childElementCount > MAX_LOG_ENTRIES) {
    logs.removeChild(logs.firstElementChild);
  }
  logs.scrollTop = logs.scrollHeight;
}

/**
 * The per-field record for one AUTO_EXTRACT row.
 *
 * A row's single confidence figure says how the extraction went on average.
 * This says which cells to look at: the ones a heuristic guessed, and the
 * ones a model answered without the page backing it up.
 *
 * Built as nodes for the same reason every other log line is: every value in
 * here came off a page, and the panel's CSP stops inline script but not
 * markup injection.
 */
function renderProvenance(rows) {
  const logs = document.getElementById("mon-logs");
  if (!logs || !Array.isArray(rows) || rows.length === 0) return;

  const box = document.createElement("div");
  box.className = "log-entry info-log vq-provenance";

  const head = document.createElement("div");
  head.className = "log-msg";
  head.textContent = "Where each field came from";
  head.style.fontWeight = "600";
  box.appendChild(head);

  for (const r of rows) {
    const line = document.createElement("div");
    line.style.cssText =
      "display:flex;gap:8px;align-items:baseline;font-size:11px;padding-left:8px;";

    const name = document.createElement("span");
    name.className = "mono";
    name.textContent = r.field;
    name.style.cssText = "min-width:96px;color:var(--text-main);";

    const src = document.createElement("span");
    src.textContent = r.label;
    // A field nothing answered is dimmed rather than hidden: an absent column
    // is the thing a person spends an afternoon looking for.
    src.style.color =
      r.trust === "none"
        ? "var(--text-dim)"
        : r.trust === "model"
          ? "var(--amber,#d97706)"
          : "var(--text-dim)";

    line.append(name, src);

    if (r.trust !== "none") {
      const conf = document.createElement("span");
      conf.className = "mono";
      conf.textContent = `${r.confidence}%`;
      conf.style.cssText = "margin-left:auto;color:var(--text-dim);";
      line.appendChild(conf);
    }

    if (r.note) {
      const note = document.createElement("span");
      note.textContent = r.verified ? "\u2713 verified" : r.note;
      note.style.color = r.verified
        ? "var(--green,#16a34a)"
        : "var(--text-dim)";
      line.appendChild(note);
    }

    box.appendChild(line);
  }

  logs.appendChild(box);
  while (logs.childElementCount > MAX_LOG_ENTRIES) {
    logs.removeChild(logs.firstElementChild);
  }
  logs.scrollTop = logs.scrollHeight;
}

// ── Boot ──────────────────────────────────────────────────────────────────────
if (document.readyState === "loading")
  document.addEventListener("DOMContentLoaded", init);
else init();
