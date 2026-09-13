// === logger.js ===
/**
 * @module logger
 * @description Structured, levelled logger for Verquill v3.
 *   NEVER logs secrets, API keys, proxy credentials, or PII.
 *   All output is JSON-structured for easy parsing.
 * @dependencies none
 */

"use strict";

const LEVELS = Object.freeze({ debug: 0, info: 1, warn: 2, error: 3 });

/**
 * Default level.
 *
 * This was pinned to `debug` with no way to change it, so every call in every
 * module wrote to the console and to a 2000-entry buffer, always, in a shipped
 * extension (audit C-10). An unpacked extension is a development build and
 * debug output is what you want there; a packed one is not.
 *
 * `chrome.runtime.getManifest().update_url` is absent for an unpacked load and
 * present for anything installed from the Web Store, which is the only signal
 * available synchronously at module load.
 */
function _defaultLevel() {
  try {
    const packed = Boolean(chrome?.runtime?.getManifest?.().update_url);
    return packed ? LEVELS.info : LEVELS.debug;
  } catch {
    return LEVELS.info;
  }
}

let CURRENT_LEVEL = _defaultLevel();

/** @type {Array<{level:string, module:string, event:string, data:object, ts:string}>} */
const _buffer = [];
const MAX_BUFFER = 2000;

/**
 * Sanitize a data object to strip any keys that look like secrets.
 * @param {object} data
 * @returns {object}
 */
function _sanitize(data) {
  if (!data || typeof data !== "object") return data;
  if (data instanceof Error) {
    return { name: data.name, message: data.message, stack: data.stack };
  }
  const REDACT_KEYS =
    /pass(word)?|secret|token|key|cred|auth|apikey|api_key|bearer/i;
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    if (REDACT_KEYS.test(k)) {
      out[k] = "[REDACTED]";
    } else if (Array.isArray(v)) {
      // Arrays were skipped, so a secret inside an array of objects was logged
      // in full.
      out[k] = v.map((item) =>
        item && typeof item === "object" ? _sanitize(item) : item,
      );
    } else if (v && typeof v === "object") {
      out[k] = _sanitize(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Core log function.
 * @param {'debug'|'info'|'warn'|'error'} level
 * @param {string} module
 * @param {string} event
 * @param {object} [data]
 */
function _log(level, module, event, data = {}) {
  if (LEVELS[level] < CURRENT_LEVEL) return;
  const entry = {
    level,
    module,
    event,
    data: _sanitize(data),
    ts: new Date().toISOString(),
  };
  _buffer.push(entry);
  if (_buffer.length > MAX_BUFFER) _buffer.shift();

  const style =
    {
      debug: "color:#888",
      info: "color:#4fc3f7",
      warn: "color:#ffb74d",
      error: "color:#ef5350;font-weight:bold",
    }[level] ?? "";

  const prefix = `[VQ:${level.toUpperCase()}][${module}] ${event}`;
  const outStr = Object.keys(entry.data).length
    ? JSON.stringify(entry.data)
    : "";
  if (level === "error") {
    console.error(`%c${prefix}`, style, outStr);
  } else if (level === "warn") {
    console.warn(`%c${prefix}`, style, outStr);
  } else {
    console.log(`%c${prefix}`, style, outStr);
  }
}

export const logger = Object.freeze({
  debug: (module, event, data) => _log("debug", module, event, data),
  info: (module, event, data) => _log("info", module, event, data),
  warn: (module, event, data) => _log("warn", module, event, data),
  error: (module, event, data) => _log("error", module, event, data),

  /** Retrieve buffered log entries for export/debugging */
  getLogs: () => [..._buffer],

  /** Clear the in-memory buffer */
  clearLogs: () => {
    _buffer.length = 0;
  },

  /** Serialize log buffer to JSON string */
  exportJSON: () => JSON.stringify(_buffer, null, 2),

  /**
   * Raise or lower the threshold at run time.
   *
   * The buffer exists so a user can hand over what happened without having to
   * reproduce it with devtools open; the panel's Settings tab exposes this and
   * the export below.
   *
   * @param {'debug'|'info'|'warn'|'error'} level
   * @returns {string} the level actually in force
   */
  setLevel: (level) => {
    if (level in LEVELS) CURRENT_LEVEL = LEVELS[level];
    return Object.keys(LEVELS).find((k) => LEVELS[k] === CURRENT_LEVEL);
  },

  /** @returns {string} the current threshold */
  getLevel: () => Object.keys(LEVELS).find((k) => LEVELS[k] === CURRENT_LEVEL),
});

// === END logger.js ===
