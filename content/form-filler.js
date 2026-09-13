// === form-filler.js ===
/**
 * @module form-filler
 * @description Data-driven form filling engine. Handles 8 input types with
 *   full overlay lifecycle integration (every handler calls overlayEngine at
 *   start, per-char, and completion). Ethics hard blocks enforced in execute().
 *
 *   Design decision: Every INPUT_HANDLER receives overlayEngine and zoneId so
 *   overlay updates are synchronous with fill operations — no async gaps where
 *   the UI would show a stale state. The React fiber hack is a last resort after
 *   native InputEvent dispatch fails to trigger a state change, verified by
 *   checking if the element's value updated correctly.
 *
 * @dependencies overlay-engine, logger, pii-detector
 *
 * NOT REACHABLE. executeRow is called only from _formFillRow in injector.js,
 * which fires on an VQ_FORM_FILL_ROW event that nothing dispatches. FORM_FILL
 * is not a step type: it has ethics gates and emitter cases but no registry
 * entry and no executor. See docs/ISSUE_AUDIT.md A-07.
 */

"use strict";

import { overlayEngine } from "./overlay-engine.js";
import { logger } from "../utils/logger.js";

const MODULE = "form-filler";

// ── Constants ─────────────────────────────────────────────────────────────────
const MIN_INTER_ROW_DELAY_MS = 800;
const MAX_FORM_ROWS_DEFAULT = 500;
const MAX_FORM_ROWS_CONFIRMED = 5000;
const CHAR_JITTER_MIN_MS = 30;
const CHAR_JITTER_MAX_MS = 100;

// ── Ethics blocks (must throw, not just return) ───────────────────────────────
class EthicsBlock extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// ── Transforms ────────────────────────────────────────────────────────────────
const TRANSFORMS = {
  trim: (v) => String(v).trim(),
  lowercase: (v) => String(v).toLowerCase(),
  uppercase: (v) => String(v).toUpperCase(),
  "title-case": (v) => String(v).replace(/\b\w/g, (c) => c.toUpperCase()),
  "normalize-phone": (v) => String(v).replace(/[^\d+]/g, ""),
  "strip-html": (v) => String(v).replace(/<[^>]+>/g, ""),
  "parse-number": (v) => Number(String(v).replace(/[^\d.-]/g, "")),
  boolean: (v) => ["yes", "true", "1", "y"].includes(String(v).toLowerCase()),
  "truncate-100": (v) => String(v).slice(0, 100),
  "pad-zero-5": (v) => String(v).padStart(5, "0"),
  "iso-date": (v) => new Date(v).toISOString().split("T")[0],
};

function applyTransform(value, transformKey) {
  if (!transformKey || !TRANSFORMS[transformKey]) return value;
  try {
    return TRANSFORMS[transformKey](value);
  } catch (e) {
    logger.warn(MODULE, "transform-fail", {
      transform: transformKey,
      error: e.message,
    });
    return value;
  }
}

// ── Native event helpers ──────────────────────────────────────────────────────
function _dispatch(el, eventType, opts = {}) {
  el.dispatchEvent(
    new Event(eventType, { bubbles: true, cancelable: true, ...opts }),
  );
}

function _dispatchInput(el) {
  el.dispatchEvent(
    new InputEvent("input", {
      bubbles: true,
      cancelable: true,
      composed: true,
    }),
  );
}

// React fiber hack — last resort when native events don't propagate state change
function _reactHack(el, value) {
  const proto = Object.getPrototypeOf(el);
  const fiberKey = Object.keys(el).find(
    (k) =>
      k.startsWith("__reactFiber") || k.startsWith("__reactInternalInstance"),
  );
  if (!fiberKey) return false;

  const tracker = el._valueTracker;
  if (tracker) tracker.setValue("");

  const nativeSetter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (nativeSetter) {
    nativeSetter.call(el, value);
  } else {
    el.value = value;
  }

  _dispatchInput(el);
  _dispatch(el, "change");
  return true;
}

async function _sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function _jitter(min, max) {
  return min + Math.random() * (max - min);
}

// ── Input type handlers ───────────────────────────────────────────────────────

const INPUT_HANDLERS = {
  text: async (el, value, opts, zoneId, fieldLabel) => {
    overlayEngine.setMode(zoneId, "live");
    el.focus();
    // Clear existing value
    el.value = "";
    _dispatchInput(el);
    _dispatch(el, "change");

    let typed = "";
    const valStr = String(value ?? "");

    for (const char of valStr) {
      await _sleep(_jitter(CHAR_JITTER_MIN_MS, CHAR_JITTER_MAX_MS));
      typed += char;
      // Try native setter approach
      const nativeSetter = Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(el),
        "value",
      )?.set;
      if (nativeSetter) nativeSetter.call(el, typed);
      else el.value = typed;

      _dispatchInput(el);
      overlayEngine.updateLabel(zoneId, `${fieldLabel}: ${typed}▌`);
    }

    // Fire change + blur
    _dispatch(el, "change");
    el.blur();

    // Verify React state updated — if not, try fiber hack
    if (el.value !== valStr) {
      const hacked = _reactHack(el, valStr);
      if (!hacked)
        logger.warn(MODULE, "react-hack-unavailable", {
          selector: el.id || el.name,
        });
    }

    overlayEngine.setMode(zoneId, "completed");
  },

  email: async (el, value, opts, zoneId, fieldLabel) => {
    return INPUT_HANDLERS.text(el, value, opts, zoneId, fieldLabel);
  },

  tel: async (el, value, opts, zoneId, fieldLabel) => {
    return INPUT_HANDLERS.text(el, value, opts, zoneId, fieldLabel);
  },

  textarea: async (el, value, opts, zoneId, fieldLabel) => {
    return INPUT_HANDLERS.text(el, value, opts, zoneId, fieldLabel);
  },

  number: async (el, value, opts, zoneId, fieldLabel) => {
    return INPUT_HANDLERS.text(el, String(value), opts, zoneId, fieldLabel);
  },

  select: async (el, value, opts = {}, zoneId, fieldLabel) => {
    overlayEngine.setMode(zoneId, "live");
    const matchBy = opts.matchBy ?? "value";
    const valStr = String(value ?? "")
      .trim()
      .toLowerCase();

    const options = Array.from(el.options);
    const match = options.find((opt) => {
      return matchBy === "text"
        ? opt.textContent.trim().toLowerCase() === valStr
        : opt.value.toLowerCase() === valStr;
    });

    if (!match) {
      overlayEngine.setMode(zoneId, "error", "Option not found");
      throw new Error(
        `SelectOptionNotFound: selector="${el.id || el.name}" value="${value}"`,
      );
    }

    el.value = match.value;
    _dispatch(el, "change");
    overlayEngine.updateLabel(
      zoneId,
      `${fieldLabel}: ${match.textContent.trim()}`,
    );
    overlayEngine.setMode(zoneId, "completed");
  },

  checkbox: async (el, value, opts = {}, zoneId, fieldLabel) => {
    overlayEngine.setMode(zoneId, "live");
    const trueVals = opts.trueValues ?? ["yes", "true", "1", "y"];
    const desired = trueVals.includes(String(value ?? "").toLowerCase());
    const current = el.checked;

    if (current !== desired) {
      el.click();
      await _sleep(100);
      _dispatch(el, "change");
    }

    overlayEngine.updateLabel(zoneId, `${fieldLabel}: ${desired ? "✓" : "✗"}`);
    overlayEngine.setMode(zoneId, "completed");
  },

  radio: async (el, value, opts = {}, zoneId, fieldLabel) => {
    overlayEngine.setMode(zoneId, "live");
    const name = el.getAttribute("name");
    if (!name) {
      overlayEngine.setMode(zoneId, "error", "No name attr");
      throw new Error("Radio element missing name attribute");
    }

    const radios = Array.from(
      document.querySelectorAll(`input[type=radio][name="${name}"]`),
    );
    const target = radios.find((r) => r.value === String(value));

    if (!target) {
      overlayEngine.setMode(zoneId, "error", `Value "${value}" not found`);
      throw new Error(`RadioValueNotFound: name="${name}" value="${value}"`);
    }

    if (!target.checked) {
      target.click();
      await _sleep(80);
      _dispatch(target, "change");
    }

    overlayEngine.updateLabel(zoneId, `${fieldLabel}: ${value}`);
    overlayEngine.setMode(zoneId, "completed");
  },

  file: async (el, value, opts = {}, zoneId, fieldLabel) => {
    overlayEngine.setMode(zoneId, "live");
    // value is a data URI string
    if (!value || !String(value).startsWith("data:")) {
      overlayEngine.setMode(zoneId, "error", "Invalid data URI");
      throw new Error("File handler requires a data URI value");
    }

    const mimeMatch = value.match(/^data:([^;]+);/);
    const mime = mimeMatch?.[1] ?? "application/octet-stream";
    const base64 = value.split(",")[1];
    const arr = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const file = new File([arr], opts.filename ?? "upload", { type: mime });

    const dt = new DataTransfer();
    dt.items.add(file);
    el.files = dt.files;
    _dispatch(el, "change");

    overlayEngine.updateLabel(zoneId, `${fieldLabel}: ${file.name}`);
    overlayEngine.setMode(zoneId, "completed");
  },

  date: async (el, value, opts = {}, zoneId, fieldLabel) => {
    overlayEngine.setMode(zoneId, "live");
    let isoDate;
    try {
      isoDate = new Date(value).toISOString().split("T")[0];
    } catch {
      overlayEngine.setMode(zoneId, "error", "Invalid date");
      throw new Error(`InvalidDate: "${value}"`);
    }
    const nativeSetter = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(el),
      "value",
    )?.set;
    if (nativeSetter) nativeSetter.call(el, isoDate);
    else el.value = isoDate;
    _dispatchInput(el);
    _dispatch(el, "change");
    overlayEngine.updateLabel(zoneId, `${fieldLabel}: ${isoDate}`);
    overlayEngine.setMode(zoneId, "completed");
  },

  range: async (el, value, opts = {}, zoneId, fieldLabel) => {
    overlayEngine.setMode(zoneId, "live");
    const min = parseFloat(el.min ?? 0);
    const max = parseFloat(el.max ?? 100);
    const clamped = Math.max(min, Math.min(max, parseFloat(value)));
    el.value = String(clamped);
    _dispatchInput(el);
    _dispatch(el, "change");
    overlayEngine.updateLabel(zoneId, `${fieldLabel}: ${clamped}`);
    overlayEngine.setMode(zoneId, "completed");
  },
};

// ── Field filling ─────────────────────────────────────────────────────────────

async function _fillField(mapping, value, zoneId) {
  const {
    selector,
    inputType = "text",
    transform,
    matchBy,
    trueValues,
  } = mapping;
  const el = document.querySelector(selector);

  if (!el) {
    overlayEngine.setMode(zoneId, "error", "Not found");
    logger.warn(MODULE, "field-not-found", { selector });
    return { ok: false, error: `Element not found: ${selector}` };
  }

  // Hard blocks
  const elType = el.type?.toLowerCase();
  if (elType === "password") {
    overlayEngine.setMode(zoneId, "blocked");
    throw new EthicsBlock(
      "PasswordField",
      `Cannot fill password field: ${selector}`,
    );
  }
  if (elType === "hidden") {
    overlayEngine.setMode(zoneId, "blocked");
    throw new EthicsBlock(
      "HiddenField",
      `Cannot fill hidden field: ${selector}`,
    );
  }

  const transformed = applyTransform(value, transform);
  const handler = INPUT_HANDLERS[inputType] ?? INPUT_HANDLERS.text;
  const opts = { matchBy, trueValues };
  const fieldLabel = mapping.column ?? selector;

  try {
    await handler(el, transformed, opts, zoneId, fieldLabel);
    return { ok: true };
  } catch (err) {
    if (!(err instanceof EthicsBlock)) {
      overlayEngine.setMode(zoneId, "error", err.message);
    }
    throw err;
  }
}

// ── Row execution ─────────────────────────────────────────────────────────────

/**
 * Execute a single FORM_FILL row.
 * @param {object} config       - Step config from pipeline JSON
 * @param {object} row          - Data row object
 * @param {number} rowIndex     - 0-based row index
 * @param {object} [context]    - Runtime context (proxyHost, tabId, etc.)
 * @returns {Promise<object>}   - Result row with __status etc.
 */
export async function executeRow(config, row, rowIndex, context = {}) {
  const {
    fieldMappings = [],
    submitSelector = "button[type=submit]",
    submitStrategy = "click",
    waitAfterSubmit = { mode: "DOM-stable" },
    onSuccess = {},
    onError = { action: "log-and-continue", retryCount: 1 },
    interRowDelay = { min: 1200, max: 3000 },
  } = config;

  // Delay floor enforcement
  if ((interRowDelay.min ?? 0) < MIN_INTER_ROW_DELAY_MS) {
    throw new EthicsBlock(
      "DelayFloor",
      `Inter-row delay ${interRowDelay.min}ms < floor ${MIN_INTER_ROW_DELAY_MS}ms`,
    );
  }

  const startedAt = new Date().toISOString();

  // Fill each field
  for (const [fi, mapping] of fieldMappings.entries()) {
    const value = row[mapping.column] ?? "";
    const zoneId = `zone_0_${fi}_${rowIndex}`;
    try {
      await _fillField(mapping, value, zoneId);
    } catch (err) {
      if (err instanceof EthicsBlock) throw err; // always rethrow hard blocks
      logger.error(MODULE, "field-fill-error", {
        selector: mapping.selector,
        error: err.message,
      });
      // Non-ethics errors: log and continue per onError policy
    }
  }

  // Submit
  const submitEl = document.querySelector(submitSelector);
  if (!submitEl) {
    logger.warn(MODULE, "submit-not-found", { submitSelector });
    return _buildResult(
      row,
      rowIndex,
      "error",
      "Submit button not found",
      startedAt,
      context,
    );
  }

  submitEl.scrollIntoView({ behavior: "smooth", block: "center" });
  await _sleep(200);
  submitEl.click();

  // Wait after submit
  await _waitAfterSubmit(waitAfterSubmit);

  // Check success/error selectors
  if (onSuccess.selector) {
    const successEl = document.querySelector(onSuccess.selector);
    if (successEl) {
      logger.info(MODULE, "row-success", { rowIndex });
      return _buildResult(
        row,
        rowIndex,
        "success",
        null,
        new Date().toISOString(),
        context,
      );
    }
  }
  if (onError.selector) {
    const errorEl = document.querySelector(onError.selector);
    if (errorEl) {
      const errTxt = errorEl.textContent.trim();
      logger.warn(MODULE, "row-error", { rowIndex, errorText: errTxt });
      return _buildResult(
        row,
        rowIndex,
        "error",
        errTxt,
        new Date().toISOString(),
        context,
      );
    }
  }

  return _buildResult(
    row,
    rowIndex,
    "success",
    null,
    new Date().toISOString(),
    context,
  );
}

async function _waitAfterSubmit(waitConfig) {
  const {
    mode = "DOM-stable",
    ms = 1000,
    selector,
    timeout = 8000,
  } = waitConfig;
  switch (mode) {
    case "fixed":
      await _sleep(ms);
      break;
    case "selector-visible":
      if (selector) await _waitForSelector(selector, timeout);
      break;
    case "DOM-stable":
      await _waitDOMStable(300, timeout);
      break;
    case "AUTO":
    default:
      await _sleep(500);
      await _waitDOMStable(250, 6000);
      break;
  }
}

async function _waitForSelector(selector, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (document.querySelector(selector)) return;
    await _sleep(200);
  }
}

async function _waitDOMStable(quietMs = 300, timeout = 8000) {
  return new Promise((resolve) => {
    let timer;
    const obs = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        obs.disconnect();
        resolve();
      }, quietMs);
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    timer = setTimeout(() => {
      obs.disconnect();
      resolve();
    }, timeout);
  });
}

function _buildResult(row, rowIndex, status, errorText, submittedAt, context) {
  return {
    ...row,
    __status: status,
    __error_text: errorText ?? null,
    __submitted_at: submittedAt,
    __proxy_host: context?.proxyHost ?? null,
    __page_url: location.href,
    __row_index: rowIndex,
  };
}

// ── highlight / clearHighlight (step interface contract) ──────────────────────

/**
 * Register preview overlays for this FORM_FILL step.
 * @param {object}         config    - Step config
 * @param {number}         stepIndex
 * @returns {{ matched: string[], unmatched: string[] }}
 */
export function highlight(config, stepIndex) {
  const zones = [];
  for (const [fi, mapping] of (config.fieldMappings ?? []).entries()) {
    zones.push({
      selector: mapping.selector,
      label: mapping.column,
      fieldIndex: fi,
    });
  }
  if (config.submitSelector) {
    zones.push({
      selector: config.submitSelector,
      label: "Submit ▶",
      fieldIndex: zones.length,
      color: "#10B981",
    });
  }
  return overlayEngine.previewStep(zones, stepIndex);
}

/**
 * Remove all overlays for this step.
 * @param {number} stepIndex
 */
export function clearHighlight(stepIndex) {
  overlayEngine.clearStep(stepIndex);
}

// === END form-filler.js ===
