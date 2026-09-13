// === ethics-engine.js ===
/**
 * @module ethics-engine
 * @description Pre-run ethics gate orchestrator. Runs 7 gates before first
 *   pipeline step executes. Gate 7 is the new overlay readiness check — it
 *   runs previewAll() and shows the user the overlay state before they confirm.
 *
 *   Design decision: All hard blocks also trigger overlay-engine's 'blocked' mode
 *   on the offending element BEFORE throwing, so the user sees a visual gray
 *   crosshatch on the exact element that caused the block. This connects the
 *   ethics system directly to the visual philosophy.
 *
 * @dependencies robots-parser, pii-detector, overlay-engine (via content message), logger
 */

"use strict";

import { logger } from "../utils/logger.js";
import { parseRobots, isAllowedByRules } from "../ethics/robots-parser.js";
import { scanText } from "../ethics/pii-detector.js";

const MODULE = "ethics-engine";

// ── Constants ─────────────────────────────────────────────────────────────────
const MAX_REQUESTS_BEFORE_WARN = 100;

/**
 * Solves per hour past which gate 4 speaks up.
 *
 * A handful of challenges over a long run is a person getting through a login;
 * fifty an hour is a machine doing what the challenge exists to prevent.
 */
const CAPTCHA_SOLVES_BEFORE_WARN = 50;
const ROBOTS_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

// ── Block/warn error classes ──────────────────────────────────────────────────
export class EthicsBlock extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "EthicsBlock";
  }
}
export class EthicsWarn {
  constructor(code, message) {
    this.code = code;
    this.message = message;
  }
}

// ── robots.txt cache ──────────────────────────────────────────────────────────
const _robotsCache = new Map(); // domain → { parsed, fetchedAt }

async function _fetchRobots(origin) {
  const cached = _robotsCache.get(origin);
  if (cached && Date.now() - cached.fetchedAt < ROBOTS_CACHE_TTL_MS) {
    return cached.parsed;
  }
  try {
    const resp = await fetch(`${origin}/robots.txt`, {
      signal: AbortSignal.timeout(5000),
    });
    const text = resp.ok ? await resp.text() : "";
    const parsed = parseRobots(text, origin);
    _robotsCache.set(origin, { parsed, fetchedAt: Date.now() });
    return parsed;
  } catch {
    logger.warn(MODULE, "robots-fetch-fail", { origin });
    return null; // unreachable → allow with warning
  }
}

// ── Gate implementations ──────────────────────────────────────────────────────

async function _gate1_robots(targetOrigin, targetPath, bypass) {
  if (bypass) return null;
  const robots = await _fetchRobots(targetOrigin);
  if (!robots) {
    return new EthicsWarn(
      "RobotsTxt",
      `Could not fetch robots.txt from ${targetOrigin} — proceeding with caution`,
    );
  }
  const disallowed = !isAllowedByRules(robots, targetPath, "Verquill");
  if (disallowed) {
    return new EthicsWarn(
      "RobotsTxt",
      `robots.txt Disallows access to ${targetPath} — confirm to override`,
    );
  }
  return null;
}

/**
 * Steps that actually put a request on the network. A CLICK or an EXTRACT does
 * not; counting them made the estimate meaningless.
 */
const NETWORK_STEP_TYPES = new Set([
  "WEBSITE",
  "NAVIGATE",
  "API",
  "PDF_EXTRACTION",
]);

/**
 * Count network requests a pipeline will make, multiplying nested steps by
 * their enclosing loop counts.
 *
 * @param {object[]} steps
 * @param {number} [multiplier=1]
 * @returns {number}
 */
function _countRequests(steps, multiplier = 1) {
  let total = 0;
  for (const step of Array.isArray(steps) ? steps : []) {
    if (NETWORK_STEP_TYPES.has(step.type)) total += multiplier;

    if (step.type === "LOOP") {
      // A loop over elements has no known count until it runs; `max` is the
      // ceiling the user set, which is the honest figure to warn against.
      const max = Number(step.config?.max);
      const iterations = Number.isFinite(max) && max > 0 ? max : 10;
      total += _countRequests(step.children, multiplier * iterations);
      continue;
    }

    // Only one branch runs, so charge the more expensive of the two rather
    // than both.
    if (step.type === "IF_ELSE") {
      total += Math.max(
        _countRequests(step.ifBranch, multiplier),
        _countRequests(step.elseBranch, multiplier),
      );
      continue;
    }

    total += _countRequests(step.children, multiplier);
  }
  return total;
}

/**
 * Gate 3: warn when the pipeline would hit a site hard.
 *
 * This used to count *every* step — clicks, extracts, waits — against a
 * hardcoded 1200ms interval, so a two-step pipeline estimated 6000 req/hr and
 * essentially every run produced a warning. A gate that always fires teaches
 * people to dismiss it, which costs the gates that matter.
 *
 * @param {object[]} pipelineSteps
 * @param {object} timingConfig
 * @returns {EthicsWarn|null}
 */
function _gate3_rateLimit(pipelineSteps, timingConfig) {
  const requests = _countRequests(pipelineSteps);
  if (requests <= MAX_REQUESTS_BEFORE_WARN) return null;

  // Pace is a property of the delay between requests, not of how many there
  // are: N requests at one every 1200ms is 3000/hr whether N is 2 or 2000. The
  // old formula multiplied the two, so a two-step pipeline "estimated"
  // 6000 req/hr and every single run produced a warning.
  const minDelay = Number(timingConfig?.min) || 1200;
  const perHour = Math.round(3600000 / minDelay);
  const minutes = Math.max(1, Math.round((requests * minDelay) / 60000));

  return new EthicsWarn(
    "HighRate",
    `This pipeline makes about ${requests} requests, roughly ${perHour}/hr sustained ` +
      `for ${minutes} minute${minutes === 1 ? "" : "s"}. Add WAIT steps if that is faster than the site expects.`,
  );
}

/**
 * Gate 4: warn when a run would answer challenges in bulk.
 *
 * It used to measure FORM_FILL. Not the number of captchas, not even the
 * number of captcha steps: the delay between rows of the *first* FORM_FILL
 * step, if the pipeline happened to have one. A pipeline with no FORM_FILL
 * fell back to the 1200ms default and "estimated" 3000 solves an hour with no
 * captcha step anywhere in it; a pipeline that solved a hundred captchas
 * inside a loop and filled no forms was measured against a number that had
 * nothing to do with it.
 *
 * What it counts now is SOLVE_CAPTCHA steps, multiplied through the loops
 * containing them — the same walk gate 3 uses for requests — paced by the
 * run's own delay. A run with no SOLVE_CAPTCHA solves nothing, however
 * enabled the feature is, and does not warn.
 *
 * @param {object[]} pipelineSteps
 * @param {object} captchaConfig
 * @param {object} timingConfig
 * @returns {EthicsWarn|null}
 */
function _gate4_captcha(pipelineSteps, captchaConfig, timingConfig) {
  if (!captchaConfig?.enabled) return null;

  const solves = _countType(pipelineSteps, "SOLVE_CAPTCHA");
  if (solves === 0) return null;

  const minDelay = Number(timingConfig?.min) || 1200;
  // Two bounds, and the smaller one is the honest answer: you cannot solve
  // more than the pipeline asks for, and you cannot solve them faster than the
  // run's own pacing allows.
  const perHour = Math.min(solves, Math.round(3600000 / minDelay));
  if (perHour <= CAPTCHA_SOLVES_BEFORE_WARN) return null;

  return new EthicsWarn(
    "HighCaptchaVolume",
    `This pipeline asks for about ${solves} captcha solves, up to ~${perHour}/hr. ` +
      "Answering challenges in bulk is what a site puts them there to stop.",
  );
}

/**
 * Gate 5: warn when the proxy pool cannot honour the region you asked for.
 *
 * The old version compared "the proxy entry" against "the declared region",
 * and no caller ever passed either — so the gate could not fire, in any
 * pipeline, ever. A gate with no inputs is not a lenient gate; it is a
 * decoration that makes the list look longer.
 *
 * The question it can actually answer, at preflight, from data that exists:
 * you set the pool to pick exits in a country, and no proxy in the pool claims
 * to be there — so the run will quietly use whatever is alive instead, which
 * is the opposite of what geo rotation was turned on for.
 *
 * @param {string[]} poolCountries - country codes of the live pool
 * @param {string} declaredRegion - the region the user asked to exit through
 * @returns {EthicsWarn|null}
 */
function _gate5_proxyGeo(poolCountries, declaredRegion) {
  const want = String(declaredRegion ?? "")
    .trim()
    .toUpperCase();
  if (!want) return null;
  const have = (Array.isArray(poolCountries) ? poolCountries : [])
    .map((c) =>
      String(c ?? "")
        .trim()
        .toUpperCase(),
    )
    .filter(Boolean);
  if (have.includes(want)) return null;
  return new EthicsWarn(
    "ProxyGeoMismatch",
    have.length
      ? `No proxy in the pool is in ${want} — the pool lists ${[...new Set(have)].join(", ")}. ` +
          "The run will use whichever proxy is alive, not one in that region."
      : `No proxy in the pool says which country it is in, so ${want} cannot be honoured. ` +
          "Import the pool with a country column to make geo rotation mean something.",
  );
}

/**
 * How many steps of one type a run will execute, loops included.
 *
 * @param {object[]} steps
 * @param {string} type
 * @param {number} multiplier
 * @returns {number}
 */
function _countType(steps, type, multiplier = 1) {
  let total = 0;
  for (const step of Array.isArray(steps) ? steps : []) {
    if (step.type === type) total += multiplier;
    if (step.type === "LOOP") {
      const max = Number(step.config?.max);
      const iterations = Number.isFinite(max) && max > 0 ? max : 10;
      total += _countType(step.children, type, multiplier * iterations);
      continue;
    }
    if (step.type === "IF_ELSE") {
      total += Math.max(
        _countType(step.ifBranch, type, multiplier),
        _countType(step.elseBranch, type, multiplier),
      );
      continue;
    }
    total += _countType(step.children, type, multiplier);
  }
  return total;
}

/**
 * Walk every step, including LOOP children and IF/ELSE branches.
 * @param {object[]} steps
 * @returns {object[]}
 */
function _flattenSteps(steps, out = []) {
  for (const step of Array.isArray(steps) ? steps : []) {
    out.push(step);
    _flattenSteps(step.children, out);
    _flattenSteps(step.ifBranch, out);
    _flattenSteps(step.elseBranch, out);
  }
  return out;
}

/** Config keys that carry a navigable URL, by step type. */
const URL_STEP_TYPES = Object.freeze({
  WEBSITE: "url",
  NAVIGATE: "url",
  API: "url",
  API_FETCH: "url",
});

/**
 * Origins this pipeline declares statically — i.e. that its author typed.
 *
 * A URL containing a template is deliberately excluded: its origin is not known
 * until the step runs, and if it came from the page (a `{{item.href}}` read out
 * of the DOM by QUERY_ELEMENTS) then the page, not the author, chooses it. Those
 * are checked at execution time instead, against exactly this set.
 *
 * @param {object[]} steps
 * @param {string} targetOrigin
 * @returns {Set<string>}
 */
export function collectDeclaredOrigins(steps, targetOrigin) {
  const origins = new Set();
  if (targetOrigin) origins.add(targetOrigin);

  for (const step of _flattenSteps(steps)) {
    const key = URL_STEP_TYPES[step.type];
    if (!key) continue;

    const raw = step.config?.[key];
    if (typeof raw !== "string" || !raw.trim()) continue;
    if (raw.includes("{{")) continue; // resolved at runtime; see above

    try {
      origins.add(new URL(raw, targetOrigin || undefined).origin);
    } catch {
      // Not a URL yet (a bare path with no target origin); nothing to declare.
    }
  }

  return origins;
}

/**
 * Gate 6: report the origins this pipeline will visit.
 *
 * This used to be a hard block on any step whose origin differed from the
 * tab's, and it got the risk backwards in three ways:
 *
 *   - It blocked the safe case. A cross-origin URL the author typed into a
 *     NAVIGATE or API step is visible in the step config and was chosen
 *     deliberately, yet it made multi-domain pipelines impossible and rejected
 *     every third-party API call — including the API step's own default URL.
 *   - It only walked top-level steps, so moving the same step inside a LOOP or
 *     an IF/ELSE branch bypassed it entirely.
 *   - It permitted the dangerous case. A templated URL like `{{item.href}}` is
 *     not a valid URL at gate time, so `new URL` threw and the step was waved
 *     through — and that value comes from the page's own DOM, which means the
 *     page chose where the pipeline navigates.
 *
 * Authored origins are now surfaced for the user to confirm, and the origins
 * that are not authored are enforced where they become known: at execution.
 *
 * @param {object[]} steps
 * @param {string} targetOrigin
 * @returns {EthicsWarn|null}
 */
function _gate6_crossOrigin(steps, targetOrigin) {
  const internalPrefixes = [
    "chrome",
    "about",
    "edge",
    "chrome-extension",
    "moz-extension",
  ];
  const isInternalOrigin =
    !targetOrigin ||
    targetOrigin === "null" ||
    internalPrefixes.some((p) => targetOrigin.startsWith(p));

  const declared = collectDeclaredOrigins(steps, targetOrigin);
  const others = [...declared].filter((o) => o !== targetOrigin);
  if (others.length === 0) return null;

  return new EthicsWarn(
    "CrossOrigin",
    isInternalOrigin
      ? `This pipeline will visit: ${others.join(", ")}`
      : `This pipeline leaves ${targetOrigin} for: ${others.join(", ")}`,
  );
}

/**
 * Gate 7: Overlay readiness check (SOFT WARN).
 * Sends previewAll message to content script and checks for unmatched selectors.
 * @param {object[]} steps
 * @param {number}   tabId
 * @returns {Promise<EthicsWarn|null>}
 */
async function _gate7_overlayReadiness(steps, tabId) {
  try {
    const result = await chrome.tabs.sendMessage(tabId, {
      type: "overlay:setMode",
      payload: { action: "previewAll", steps },
    });
    if (result?.unmatched?.length > 0) {
      return new EthicsWarn(
        "SelectorNotFound",
        `${result.unmatched.length} selector(s) not found on page: ${result.unmatched.slice(0, 3).join(", ")}${result.unmatched.length > 3 ? "…" : ""}`,
      );
    }
  } catch (err) {
    logger.warn(MODULE, "gate7-overlay-check-fail", { error: err.message });
    // Non-fatal: content script may not be loaded yet
  }
  return null;
}

// ── Main orchestrator ─────────────────────────────────────────────────────────

/**
 * @typedef {Object} EthicsResult
 * @property {boolean}        blocked    Any hard block found
 * @property {EthicsBlock|null} blocker  The blocking error if blocked
 * @property {EthicsWarn[]}   warnings   Soft warnings requiring user confirm
 */

/**
 * Run all 7 pre-run ethics gates.
 * @param {object} opts
 * @param {object[]} opts.steps          - Pipeline steps
 * @param {string}   opts.targetOrigin   - Declared pipeline origin
 * @param {string}   [opts.targetPath='/'] - Path for robots.txt check
 * @param {object}   [opts.timing]       - Timing configuration
 * @param {string[]} [opts.proxyCountries] - country codes in the live proxy pool
 * @param {string}   [opts.region]       - the region the pool was asked to exit through
 * @param {object}   [opts.captcha]      - Captcha config
 * @param {number}   [opts.tabId]        - Active tab for Gate 7
 * @returns {Promise<EthicsResult>}
 */
export async function runEthicsGates(opts = {}) {
  const {
    steps = [],
    targetOrigin = "",
    targetPath = "/",
    timing = {},
    proxyCountries = [],
    region = null,
    captcha = {},
    tabId = null,
    bypassRobots = false,
  } = opts;

  const warnings = [];

  // Gate 1: robots.txt
  const w1 = await _gate1_robots(targetOrigin, targetPath, bypassRobots);
  if (w1) warnings.push(w1);

  // Gate 2 used to sit here. It filtered the pipeline for steps of type
  // FORM_FILL — a type the registry does not have; it is FILL — so it matched
  // nothing on every pipeline ever run, and returned null regardless. The
  // deeper problem was where it sat rather than what it filtered: rows do not
  // exist at preflight, because the page has not been read yet, so nothing
  // here can know whether a scrape will come back carrying personal data.
  //
  // The check now runs where the rows are, at `_collectRows()` in the service
  // worker — the single path every row takes to storage, whatever step
  // produced it. A gate that reports having run without being able to look at
  // anything is worse than no gate.

  // Gate 3: Rate limit
  const w3 = _gate3_rateLimit(steps, timing);
  if (w3) warnings.push(w3);

  // Gate 4: Captcha volume
  const w4 = _gate4_captcha(steps, captcha, timing);
  if (w4) warnings.push(w4);

  // Gate 5: Proxy geo
  const w5 = _gate5_proxyGeo(proxyCountries, region);
  if (w5) warnings.push(w5);

  // Gate 6: cross-origin reporting. Enforcement of *unauthored* origins happens
  // at execution time, where the resolved URL is actually known.
  const w6 = _gate6_crossOrigin(steps, targetOrigin);
  if (w6) warnings.push(w6);

  // The FORM_FILL hard constraints used to sit here, and they were the same
  // defect as gate 2 above, surviving the fix that was looking straight at it.
  //
  // They filtered `s.type === "FORM_FILL"`. The registry has no such type —
  // the step is FILL — so four hard blocks (DelayFloor, SubmitCapExceeded,
  // PasswordField, HiddenField) matched nothing on every pipeline ever run,
  // while ethics-engine's own docblock and SECURITY.md both listed "password
  // fields in form filling" as something this engine refuses.
  //
  // The one that mattered is now enforced where it fires: `_typeInto` in
  // content/injector.js, the single function both fill modes go through,
  // refuses a password field outright. That is a better home for it than a
  // preflight gate — preflight reads the config a user typed, and the page
  // decides what an element actually is.
  //
  // Of the other three: the delay floor is the rate limiter's job and it does
  // it per host for every acting step; the row cap and the hidden-field check
  // described a bulk row-by-row submitter that no registry step exposes.
  // Deleting a gate that cannot fire is not a loss of protection — it is the
  // removal of a claim that was never true.

  // Gate 7: Overlay readiness (SOFT — needs tabId)
  if (tabId) {
    const w7 = await _gate7_overlayReadiness(steps, tabId);
    if (w7) warnings.push(w7);
  }

  logger.info(MODULE, "gates-complete", {
    blocked: false,
    warnings: warnings.map((w) => w.code),
  });

  return { blocked: false, blocker: null, warnings };
}

// === END ethics-engine.js ===
