// === overlay-engine.js ===
/**
 * @module overlay-engine
 * @description Visual scrape-zone overlay engine. Manages a shadow DOM host,
 *   zone registry, position tracker (ResizeObserver + scroll sync), and
 *   SPA re-attach via MutationObserver. This is a first-class architectural
 *   citizen in Verquill v3 — every DOM-touching step uses it.
 *
 *   Design decision: We use a shadow DOM with 'closed' mode so the host page's
 *   JS cannot introspect or manipulate our overlays. Overlays use position:fixed
 *   (not absolute) so they track correctly during scroll without needing to
 *   account for scrollTop. All position reads happen inside rAF callbacks to
 *   prevent layout thrash.
 *
 *   Position updates are throttled (scroll: 16ms / ~60fps) and debounced
 *   (resize: 120ms) to keep the main thread free during heavy runs.
 *
 * @dependencies overlay-renderer, color-utils, logger
 */

"use strict";

import {
  createOverlayElement,
  updateOverlayElement,
  updateOverlayLabel,
  repositionOverlay,
  removeOverlayElement,
  createPickerOverlay,
  injectAnimationSheet,
} from "./overlay-renderer.js";
import {
  fieldColor,
  stepColor,
  COLOR_CAPTCHA,
  COLOR_BLOCKED,
  ZONE_PALETTE,
} from "../utils/color-utils.js";
import { logger } from "../utils/logger.js";

const MODULE = "overlay-engine";

// ── Constants ─────────────────────────────────────────────────────────────────
const OVERLAY_MAX_ZONES = 200;
const OVERLAY_RESIZE_DEBOUNCE_MS = 120;
const OVERLAY_SCROLL_THROTTLE_MS = 16;
const AUTO_FADE_COMPLETED_MS = 2000;
const SPA_NAV_SETTLE_MS = 300;

// ── Zone descriptor ───────────────────────────────────────────────────────────
/**
 * @typedef {'preview'|'live'|'completed'|'error'|'blocked'|'selector'} OverlayMode
 *
 * @typedef {Object} ZoneDescriptor
 * @property {string}       zoneId
 * @property {string}       selector
 * @property {string}       color
 * @property {string}       label
 * @property {OverlayMode}  mode
 * @property {Element[]}    elements     All matched elements
 * @property {DOMRect[]}    rects        Last known rects per element
 * @property {HTMLElement[]} overlayEls  Overlay divs in shadow root
 * @property {number}       stepIndex
 * @property {number}       fieldIndex
 * @property {boolean}      isMulti
 * @property {number}       matchCount
 * @property {number}       insertedAt   Epoch ms (for LRU eviction)
 */

// ── Shadow DOM Setup ──────────────────────────────────────────────────────────
let _shadowHost = null;
let _shadowRoot = null;
let _initialized = false;

function _ensureShadowHost() {
  if (_initialized) return;
  _shadowHost = document.createElement("div");
  _shadowHost.id = "verquill-v3-overlay-host";
  _shadowHost.style.cssText = [
    "position:fixed",
    "top:0",
    "left:0",
    "width:0",
    "height:0",
    "pointer-events:none",
    "z-index:2147483647",
    "overflow:visible",
  ].join(";");
  document.documentElement.appendChild(_shadowHost);
  _shadowRoot = _shadowHost.attachShadow({ mode: "closed" });
  injectAnimationSheet(_shadowRoot);
  _initialized = true;
  logger.debug(MODULE, "shadow-host-created", {});
}

// ── Zone Registry (LRU Map) ───────────────────────────────────────────────────
/** @type {Map<string, ZoneDescriptor>} */
const _zones = new Map();

function _evictLRU() {
  if (_zones.size < OVERLAY_MAX_ZONES) return;
  // Evict oldest inserted zone
  let oldestKey = null,
    oldestTime = Infinity;
  for (const [k, z] of _zones) {
    if (z.insertedAt < oldestTime) {
      oldestTime = z.insertedAt;
      oldestKey = k;
    }
  }
  if (oldestKey) {
    _removeZoneDOM(oldestKey);
    _zones.delete(oldestKey);
    logger.warn(MODULE, "lru-evict", { zoneId: oldestKey });
  }
}

function _removeZoneDOM(zoneId) {
  const zone = _zones.get(zoneId);
  if (!zone) return;
  for (const el of zone.overlayEls) {
    removeOverlayElement(_shadowRoot, el);
  }
  zone.overlayEls = [];
}

// ── Preferences ───────────────────────────────────────────────────────────────
let _prefs = {
  enabled: true,
  showInPreviewMode: true,
  showDuringRun: true,
  opacity: 0.28,
  showLabels: true,
  showMatchCount: true,
  pulseAnimation: true,
  autoFadeCompleted: true,
  fadeDelayMs: 2000,
  customPalette: null,
};

async function _loadPrefs() {
  try {
    const { vq_overlay_prefs: p } = await chrome.storage.local.get([
      "vq_overlay_prefs",
    ]);
    if (p) _prefs = { ..._prefs, ...p };
  } catch {
    /* storage may not be available in all contexts */
  }
}

// ── Public API Object ─────────────────────────────────────────────────────────
export const overlayEngine = {
  /**
   * Initialize the engine. Call once on content script load.
   */
  async init() {
    _ensureShadowHost();
    await _loadPrefs();
    _startScrollListener();
    _startResizeObserver();
    _startSPAWatcher();
    logger.info(MODULE, "initialized", { prefs: _prefs.enabled });
  },

  /**
   * Register a new overlay zone.
   * @param {{ selector, label, stepIndex, fieldIndex, mode, color? }} opts
   * @returns {string} zoneId
   */
  register({
    selector,
    label,
    stepIndex = 0,
    fieldIndex = 0,
    mode = "preview",
    color,
  }) {
    if (!_prefs.enabled) return "";
    _ensureShadowHost();
    _evictLRU();

    const zoneId = `zone_${stepIndex}_${fieldIndex}_${Date.now()}`;
    const resolvedColor =
      color ??
      _prefs.customPalette?.[fieldIndex % ZONE_PALETTE.length] ??
      fieldColor(fieldIndex, _prefs.customPalette ?? undefined);

    const elements = _queryAll(selector);
    const rects = elements.map((el) => el.getBoundingClientRect());
    const isMulti = elements.length > 1;

    /** @type {HTMLElement[]} */
    const overlayEls = elements.map((el, i) => {
      // For multi-element zones, suppress individual badges for index > 0
      const showLabel = _prefs.showLabels && (i === 0 || !isMulti);
      const lbl =
        i === 0 && isMulti && _prefs.showMatchCount
          ? `${label} · ×${elements.length}`
          : label;
      return createOverlayElement(
        _shadowRoot,
        rects[i],
        resolvedColor,
        mode,
        showLabel ? lbl : "",
        isMulti,
        elements.length,
      );
    });

    /** @type {ZoneDescriptor} */
    const zone = {
      zoneId,
      selector,
      color: resolvedColor,
      label,
      mode,
      elements,
      rects,
      overlayEls,
      stepIndex,
      fieldIndex,
      isMulti,
      matchCount: elements.length,
      insertedAt: Date.now(),
    };
    _zones.set(zoneId, zone);
    logger.debug(MODULE, "zone-registered", {
      zoneId,
      selector,
      matchCount: elements.length,
    });
    return zoneId;
  },

  /**
   * Change the mode of a zone (preview → live → completed → error → blocked).
   * @param {string}      zoneId
   * @param {OverlayMode} mode
   * @param {string}      [errorMessage]
   */
  setMode(zoneId, mode, errorMessage) {
    const zone = _zones.get(zoneId);
    if (!zone) return;
    zone.mode = mode;

    for (const div of zone.overlayEls) {
      updateOverlayElement(
        div,
        zone.color,
        mode,
        zone.label,
        errorMessage,
        zone.isMulti,
        zone.matchCount,
      );
    }

    if (mode === "completed" && _prefs.autoFadeCompleted) {
      setTimeout(
        () => this.unregister(zoneId),
        _prefs.fadeDelayMs ?? AUTO_FADE_COMPLETED_MS,
      );
    }
  },

  /**
   * Update the badge label text of a zone (used during char-by-char typing).
   * @param {string} zoneId
   * @param {string} labelText
   */
  updateLabel(zoneId, labelText) {
    const zone = _zones.get(zoneId);
    if (!zone || !_prefs.showLabels) return;
    for (const div of zone.overlayEls) {
      updateOverlayLabel(div, labelText);
    }
  },

  /**
   * Unregister a zone: removes overlay divs.
   * @param {string} zoneId
   */
  unregister(zoneId) {
    _removeZoneDOM(zoneId);
    _zones.delete(zoneId);
  },

  /**
   * Clear all zones (or all zones for a specific step).
   * @param {number} [stepIndex] - If provided, only clear this step's zones
   */
  clearAll(stepIndex) {
    for (const [zoneId, zone] of _zones) {
      if (stepIndex === undefined || zone.stepIndex === stepIndex) {
        _removeZoneDOM(zoneId);
        _zones.delete(zoneId);
      }
    }
  },

  /**
   * Alias for clearAll(stepIndex).
   * @param {number} stepIndex
   */
  clearStep(stepIndex) {
    this.clearAll(stepIndex);
  },

  /**
   * Preview all zones for a pipeline: given an array of { selector, label, fieldIndex },
   * clear existing preview zones and register new ones.
   * @param {{ selector, label, fieldIndex }[]} zones
   * @param {number} stepIndex
   * @returns {{ matched: string[], unmatched: string[] }}
   */
  previewStep(zones, stepIndex) {
    this.clearStep(stepIndex);
    const matched = [];
    const unmatched = [];
    for (const { selector, label, fieldIndex, color } of zones) {
      const zoneId = this.register({
        selector,
        label,
        stepIndex,
        fieldIndex,
        mode: "preview",
        color,
      });
      const zone = _zones.get(zoneId);
      if (!zone || zone.matchCount === 0) unmatched.push(selector);
      else matched.push(zoneId);
    }
    return { matched, unmatched };
  },

  /**
   * Preview all steps in a pipeline simultaneously (Gate 7 overlay readiness check).
   * @param {object[]} steps
   * @returns {{ matched: string[], unmatched: string[] }}
   */
  async previewAll(steps) {
    this.clearAll();
    const matched = [];
    const unmatched = [];
    for (const [stepIdx, step] of steps.entries()) {
      const zones = _extractStepZones(step, stepIdx);
      for (const zone of zones) {
        const zoneId = this.register({
          ...zone,
          stepIndex: stepIdx,
          mode: "preview",
        });
        const z = _zones.get(zoneId);
        if (!z || z.matchCount === 0) unmatched.push(zone.selector);
        else matched.push(zoneId);
      }
    }
    return { matched, unmatched };
  },

  // ── Selector Pick Mode ────────────────────────────────────────────────────

  /** @type {HTMLElement|null} */
  _pickOverlay: null,
  _pickActive: false,
  _pickHandler: null,

  /**
   * Enable interactive selector-pick mode.
   * @param {function(string): void} onSelect
   */
  enableSelectorPick(onSelect) {
    if (this._pickActive) return;
    this._pickActive = true;
    _shadowHost.style.pointerEvents = "none";

    let currentEl = null;

    const onMove = (e) => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el || el === _shadowHost || el === document.body) return;
      if (el === currentEl) return;
      currentEl = el;

      // Remove previous pick overlay
      if (this._pickOverlay?.parentNode === _shadowRoot) {
        _shadowRoot.removeChild(this._pickOverlay);
      }
      const rect = el.getBoundingClientRect();
      const sel = _buildSelector(el);
      this._pickOverlay = createPickerOverlay(_shadowRoot, rect, sel);
    };

    const onClick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const sel = currentEl ? _buildSelector(currentEl) : null;
      this.disableSelectorPick();
      if (sel) onSelect(sel);
    };

    const onEsc = (e) => {
      if (e.key === "Escape") this.disableSelectorPick();
    };

    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onEsc, true);
    document.body.style.cursor = "crosshair";

    this._pickHandler = () => {
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onEsc, true);
    };
  },

  /** Disable selector-pick mode and restore cursor. */
  disableSelectorPick() {
    if (!this._pickActive) return;
    this._pickActive = false;
    if (this._pickOverlay?.parentNode === _shadowRoot) {
      _shadowRoot.removeChild(this._pickOverlay);
    }
    this._pickOverlay = null;
    this._pickHandler?.();
    this._pickHandler = null;
    document.body.style.cursor = "";
  },

  /** Update preferences from storage. */
  async reloadPrefs() {
    await _loadPrefs();
  },

  /** Expose zone stats for dashboard. */
  getStats() {
    let live = 0,
      preview = 0,
      completed = 0,
      error = 0,
      blocked = 0;
    for (const z of _zones.values()) {
      switch (z.mode) {
        case "live":
          live++;
          break;
        case "preview":
          preview++;
          break;
        case "completed":
          completed++;
          break;
        case "error":
          error++;
          break;
        case "blocked":
          blocked++;
          break;
      }
    }
    return { total: _zones.size, live, preview, completed, error, blocked };
  },
};

// ── Selector helpers ──────────────────────────────────────────────────────────
function _queryAll(selector) {
  if (!selector) return [];
  try {
    return Array.from(document.querySelectorAll(selector));
  } catch {
    return [];
  }
}

function _buildSelector(el) {
  if (el.id) return `#${CSS.escape(el.id)}`;
  if (el.getAttribute("name"))
    return `${el.tagName.toLowerCase()}[name="${el.getAttribute("name")}"]`;
  const tag = el.tagName.toLowerCase();
  const parent = el.parentElement;
  if (parent) {
    const sibs = Array.from(parent.querySelectorAll(tag));
    const idx = sibs.indexOf(el) + 1;
    return `${_buildSelector(parent)} > ${tag}:nth-of-type(${idx})`;
  }
  return tag;
}

/**
 * Extract zone descriptors from a pipeline step for preview.
 */
function _extractStepZones(step, stepIdx) {
  const zones = [];
  const { type, config = {} } = step;

  switch (type) {
    case "FORM_FILL":
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
      break;
    case "EXTRACT":
      for (const [fi, f] of (config.fields ?? config.schema ?? []).entries()) {
        zones.push({ selector: f.selector, label: f.name, fieldIndex: fi });
      }
      break;
    case "CLICK":
    case "SCROLL_TO_CLICK":
      zones.push({ selector: config.selector, label: type, fieldIndex: 0 });
      break;
    case "WEBSITE":
    case "NAVIGATE":
    case "API":
      // No DOM selector to preview — NAVIGATE opens a URL
      break;
    default:
      if (config.selector) {
        zones.push({ selector: config.selector, label: type, fieldIndex: 0 });
      }
  }
  return zones;
}

// ── Position Tracker ──────────────────────────────────────────────────────────

// Scroll: throttled at OVERLAY_SCROLL_THROTTLE_MS
let _scrollThrottle = false;

function _startScrollListener() {
  window.addEventListener(
    "scroll",
    () => {
      if (_scrollThrottle) return;
      _scrollThrottle = true;
      setTimeout(() => {
        _scrollThrottle = false;
        requestAnimationFrame(_syncAllPositions);
      }, OVERLAY_SCROLL_THROTTLE_MS);
    },
    { passive: true, capture: true },
  );
}

function _syncAllPositions() {
  for (const zone of _zones.values()) {
    for (let i = 0; i < zone.elements.length; i++) {
      const el = zone.elements[i];
      if (!el.isConnected) continue;
      const rect = el.getBoundingClientRect();
      if (zone.overlayEls[i]) repositionOverlay(zone.overlayEls[i], rect);
    }
  }
}

// Resize: debounced at OVERLAY_RESIZE_DEBOUNCE_MS
let _resizeTimer = null;

function _startResizeObserver() {
  const ro = new ResizeObserver(() => {
    clearTimeout(_resizeTimer);
    _resizeTimer = setTimeout(() => {
      requestAnimationFrame(_syncAllPositions);
    }, OVERLAY_RESIZE_DEBOUNCE_MS);
  });
  ro.observe(document.documentElement);
}

// ── SPA Navigation Watcher ────────────────────────────────────────────────────
function _startSPAWatcher() {
  let _lastHref = location.href;

  const onNavChange = () => {
    if (location.href === _lastHref) return;
    _lastHref = location.href;
    logger.info(MODULE, "spa-navigation", { href: location.href });
    overlayEngine.clearAll();
    // Re-register after SPA renders (wait for settle)
    setTimeout(() => {
      requestAnimationFrame(_syncAllPositions);
    }, SPA_NAV_SETTLE_MS);
  };

  // History API
  const patchHistory = (fn) => {
    const orig = history[fn];
    history[fn] = function (...args) {
      const ret = orig.apply(this, args);
      onNavChange();
      return ret;
    };
  };
  patchHistory("pushState");
  patchHistory("replaceState");
  window.addEventListener("popstate", onNavChange);

  // Catch SPA DOM mutations (adds body children)
  const mo = new MutationObserver(onNavChange);
  mo.observe(document.documentElement, { childList: true, subtree: false });
}

// ── Message handler (from injector.js runtime bridge) ────────────────────────
// These are called by injector.js when it receives overlay messages from the SW

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  const { type, payload } = msg ?? {};
  switch (type) {
    case "overlay:show": {
      const zoneId = overlayEngine.register(payload);
      respond({ ok: true, zoneId });
      break;
    }
    case "overlay:hide":
      overlayEngine.unregister(payload.zoneId);
      respond({ ok: true });
      break;
    case "overlay:setMode":
      if (payload.action === "previewAll" && Array.isArray(payload.steps)) {
        // previewAll is async — spreading the promise used to send
        // { ok: true } with no matched/unmatched, so ethics Gate 7 always saw
        // `undefined` and reported no missing selectors. Await it and keep the
        // channel open by returning true below.
        Promise.resolve(
          overlayEngine.previewAll
            ? overlayEngine.previewAll(payload.steps)
            : { matched: [], unmatched: [] },
        )
          .then((result) => respond({ ok: true, ...result }))
          .catch((err) => {
            logger.error(MODULE, "preview-all-fail", { error: err.message });
            respond({ ok: false, error: err.message });
          });
        return true;
      }
      overlayEngine.setMode(payload.zoneId, payload.mode, payload.message);
      respond({ ok: true });
      break;
    case "overlay:pulse":
      overlayEngine.updateLabel(payload.zoneId, payload.value ?? "");
      respond({ ok: true });
      break;
    case "overlay:clearAll":
      overlayEngine.clearAll(payload?.stepIndex);
      respond({ ok: true });
      break;
    case "scrapeZone:preview": {
      const result = overlayEngine.previewStep(
        payload.zones,
        payload.stepIndex,
      );
      respond({ ok: true, ...result });
      break;
    }
    case "scrapeZone:register": {
      const zoneId = overlayEngine.register(payload);
      respond({ ok: true, zoneId });
      break;
    }
    case "overlay:reloadPrefs": {
      // Sent by sidepanel/overlay-panel.js when the user changes a preference.
      // Nothing handled it before, so overlay settings only took effect on the
      // next page load.
      // reloadPrefs re-reads chrome.storage.local, which overlay-panel.js has
      // already written by the time it sends this.
      overlayEngine
        .reloadPrefs()
        .then(() => respond({ ok: true }))
        .catch((err) => respond({ ok: false, error: err.message }));
      return true;
    }
    default:
      return false; // not handled here
  }
  return true;
});

// ── Auto-init ─────────────────────────────────────────────────────────────────
overlayEngine.init().catch((err) => {
  logger.error(MODULE, "init-failed", { error: err.message });
});

// === END overlay-engine.js ===
