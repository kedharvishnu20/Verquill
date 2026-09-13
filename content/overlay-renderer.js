// === overlay-renderer.js ===
/**
 * @module overlay-renderer
 * @description Per-zone overlay div factory. Creates and updates positioned
 *   overlay elements in the shadow root. Handles all visual modes, badge
 *   rendering, animations, and multi-element group badges.
 *
 *   Design decision: All DOM-written styles use inline CSS (no class manipulation
 *   against the host page's stylesheet) and adopted CSSStyleSheet for animations.
 *   Shadow root 'closed' mode prevents host JS from reading our overlay state.
 *   We batch all rAF writes to avoid layout thrash.
 *
 * @dependencies color-utils
 */

"use strict";

import {
  hexToRGBA,
  badgeTextColor,
  ZONE_PALETTE,
  COLOR_CAPTCHA,
  COLOR_BLOCKED,
  COLOR_SUCCESS,
  COLOR_WARNING,
  COLOR_ERROR,
} from "../utils/color-utils.js";

// ── Constants from canonical registry ────────────────────────────────────────
const OVERLAY_OPACITY = 0.28;
const OVERLAY_BORDER_RADIUS = "4px";
const OVERLAY_LABEL_FONT = '"JetBrains Mono", monospace';
const OVERLAY_LABEL_SIZE = "11px";
const OVERLAY_LABEL_PADDING = "2px 6px";
const OVERLAY_Z_INDEX = 2147483647;
const OVERLAY_PULSE_DURATION = "600ms";
const OVERLAY_TRANSITION = "180ms ease";
const OVERLAY_LABEL_MAX_CHARS = 24;

// Crosshatch SVG for 'blocked' mode (data URI, no remote fetch)
const CROSSHATCH_SVG = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='8'%3E%3Cpath d='M0 8L8 0M-1 1L1-1M7 9L9 7' stroke='%236B7280' stroke-width='1.5'/%3E%3C/svg%3E")`;

/**
 * @typedef {'preview'|'live'|'completed'|'error'|'blocked'|'selector'} OverlayMode
 */

// ── Animation stylesheet ──────────────────────────────────────────────────────
const ANIM_CSS = `
@keyframes vq-pulse {
  0%, 100% { opacity: 0.15; }
  50%       { opacity: 0.35; }
}
@keyframes vq-error-dash {
  to { stroke-dashoffset: -20; }
}
@keyframes vq-fadeout {
  from { opacity: 1; }
  to   { opacity: 0; }
}
@keyframes vq-blink-cursor {
  0%, 49%  { opacity: 1; }
  50%, 100% { opacity: 0; }
}
`;

/**
 * Inject animation stylesheet into a shadow root (idempotent).
 * @param {ShadowRoot} shadowRoot
 */
export function injectAnimationSheet(shadowRoot) {
  if (shadowRoot._fsAnimInjected) return;
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(ANIM_CSS);
    shadowRoot.adoptedStyleSheets = [
      ...(shadowRoot.adoptedStyleSheets ?? []),
      sheet,
    ];
    shadowRoot._fsAnimInjected = true;
  } catch {
    // Fallback for browsers without adoptedStyleSheets
    const style = document.createElement("style");
    style.textContent = ANIM_CSS;
    shadowRoot.appendChild(style);
    shadowRoot._fsAnimInjected = true;
  }
}

// ── Truncate label ────────────────────────────────────────────────────────────
function _truncLabel(label) {
  if (!label) return "";
  return label.length > OVERLAY_LABEL_MAX_CHARS
    ? label.slice(0, OVERLAY_LABEL_MAX_CHARS - 1) + "…"
    : label;
}

// ── Badge element ─────────────────────────────────────────────────────────────
function _createBadge(text, bgColor) {
  const badge = document.createElement("div");
  const textColor = badgeTextColor(bgColor);
  badge.style.cssText = [
    `position:absolute`,
    `top:-20px`,
    `left:0`,
    `background:${bgColor}`,
    `color:${textColor}`,
    `font-family:${OVERLAY_LABEL_FONT}`,
    `font-size:${OVERLAY_LABEL_SIZE}`,
    `padding:${OVERLAY_LABEL_PADDING}`,
    `border-radius:3px`,
    `white-space:nowrap`,
    `pointer-events:none`,
    `line-height:1.4`,
    `z-index:${OVERLAY_Z_INDEX}`,
    `user-select:none`,
    `will-change:transform`,
  ].join(";");
  badge.textContent = _truncLabel(text);
  badge.dataset.vqBadge = "1";
  return badge;
}

// ── Base overlay div ──────────────────────────────────────────────────────────
function _createOverlayDiv(rect, color, mode) {
  const div = document.createElement("div");
  _applyOverlayBase(div, rect, color, mode);
  return div;
}

function _applyOverlayBase(div, rect, color, mode) {
  const { top, left, width, height } = rect;
  div.style.cssText = [
    `position:fixed`,
    `top:${top}px`,
    `left:${left}px`,
    `width:${width}px`,
    `height:${height}px`,
    `pointer-events:none`,
    `z-index:${OVERLAY_Z_INDEX}`,
    `border-radius:${OVERLAY_BORDER_RADIUS}`,
    `will-change:opacity,transform`,
    `transition:${OVERLAY_TRANSITION}`,
    `box-sizing:border-box`,
  ].join(";");
  _applyModeStyle(div, color, mode);
}

function _applyModeStyle(div, color, mode) {
  // Remove any existing animation
  div.style.animation = "none";

  switch (mode) {
    case "preview":
      div.style.background = hexToRGBA(color, OVERLAY_OPACITY);
      div.style.border = `2px solid ${color}`;
      break;

    case "live":
      div.style.background = hexToRGBA(color, 0.15);
      div.style.border = `2px solid ${color}`;
      div.style.animation = `vq-pulse ${OVERLAY_PULSE_DURATION} ease-in-out infinite`;
      break;

    case "completed":
      div.style.background = hexToRGBA(COLOR_SUCCESS, 0.15);
      div.style.border = `2px solid ${COLOR_SUCCESS}`;
      break;

    case "error":
      div.style.background = hexToRGBA(COLOR_ERROR, 0.35);
      div.style.border = `2px dashed ${COLOR_ERROR}`;
      div.style.animation = `vq-pulse 400ms ease-in-out 4`;
      break;

    case "blocked":
      div.style.background = CROSSHATCH_SVG;
      div.style.backgroundColor = hexToRGBA(COLOR_BLOCKED, 0.15);
      div.style.border = `2px solid ${COLOR_BLOCKED}`;
      div.style.opacity = "0.8";
      break;

    case "selector":
      div.style.background = "transparent";
      div.style.border = `2px solid #06B6D4`; // teal
      div.style.boxShadow = `0 0 0 1px rgba(6,182,212,0.3)`;
      break;

    default:
      div.style.background = hexToRGBA(color, OVERLAY_OPACITY);
      div.style.border = `2px solid ${color}`;
  }
}

// ── Badge label for mode ──────────────────────────────────────────────────────
function _modeBadgeText(mode, label, message, isMulti, matchCount) {
  switch (mode) {
    case "completed":
      return `✓ ${_truncLabel(label)}`;
    case "error":
      return `❌ ${_truncLabel(message ?? "Error")}`;
    case "blocked":
      return `⛔ Blocked`;
    case "live":
      return `⟳ ${_truncLabel(label)}`;
    case "selector":
      return `🖱 ${_truncLabel(label)}`;
    default:
      if (isMulti && matchCount > 1)
        return `${_truncLabel(label)} · ×${matchCount}`;
      return _truncLabel(label);
  }
}

function _modeBadgeColor(mode, color) {
  switch (mode) {
    case "completed":
      return COLOR_SUCCESS;
    case "error":
      return COLOR_ERROR;
    case "blocked":
      return COLOR_BLOCKED;
    case "live":
      return color;
    case "selector":
      return "#06B6D4";
    default:
      return color;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Create an overlay element and append to shadow root.
 * Returns the overlay div element.
 * @param {ShadowRoot} shadowRoot
 * @param {DOMRect} rect
 * @param {string}  color
 * @param {OverlayMode} mode
 * @param {string}  label
 * @param {boolean} isMulti
 * @param {number}  matchCount
 * @returns {HTMLElement}
 */
export function createOverlayElement(
  shadowRoot,
  rect,
  color,
  mode,
  label,
  isMulti,
  matchCount,
) {
  const div = _createOverlayDiv(rect, color, mode);

  const badgeText = _modeBadgeText(mode, label, null, isMulti, matchCount);
  const badgeColor = _modeBadgeColor(mode, color);
  const badge = _createBadge(badgeText, badgeColor);
  div.appendChild(badge);
  div.dataset.vqLabel = label;
  div.dataset.vqColor = color;
  div.dataset.vqMode = mode;

  shadowRoot.appendChild(div);
  return div;
}

/**
 * Update an existing overlay element to a new mode and/or label.
 * @param {HTMLElement} div
 * @param {string}      color
 * @param {OverlayMode} mode
 * @param {string}      label
 * @param {string}      [errorMessage]
 * @param {boolean}     [isMulti]
 * @param {number}      [matchCount]
 */
export function updateOverlayElement(
  div,
  color,
  mode,
  label,
  errorMessage,
  isMulti,
  matchCount,
) {
  _applyModeStyle(div, color, mode);
  div.dataset.vqMode = mode;

  const badge = div.querySelector("[data-vq-badge]");
  if (badge) {
    const badgeText = _modeBadgeText(
      mode,
      label ?? div.dataset.vqLabel,
      errorMessage,
      isMulti,
      matchCount,
    );
    const badgeColor = _modeBadgeColor(mode, color);
    badge.textContent = _truncLabel(badgeText);
    badge.style.background = badgeColor;
    badge.style.color = badgeTextColor(badgeColor);
  }
}

/**
 * Update only the label text in the badge (used during char-by-char typing).
 * @param {HTMLElement} div
 * @param {string}      labelText
 */
export function updateOverlayLabel(div, labelText) {
  const badge = div.querySelector("[data-vq-badge]");
  if (badge) badge.textContent = _truncLabel(labelText);
}

/**
 * Reposition an overlay to a new DOMRect (called on scroll/resize rAF).
 * @param {HTMLElement} div
 * @param {DOMRect}     rect
 */
export function repositionOverlay(div, rect) {
  div.style.top = `${rect.top}px`;
  div.style.left = `${rect.left}px`;
  div.style.width = `${rect.width}px`;
  div.style.height = `${rect.height}px`;
}

/**
 * Remove overlay element from shadow root.
 * @param {ShadowRoot}  shadowRoot
 * @param {HTMLElement} div
 */
export function removeOverlayElement(shadowRoot, div) {
  if (div.parentNode === shadowRoot) {
    // Completed overlays fade out then remove
    if (div.dataset.vqMode === "completed") {
      div.style.animation = "vq-fadeout 400ms ease forwards";
      setTimeout(() => {
        if (div.parentNode === shadowRoot) shadowRoot.removeChild(div);
      }, 420);
    } else {
      shadowRoot.removeChild(div);
    }
  }
}

/**
 * Create a selector-pick hover outline (no fill, just teal border).
 * @param {ShadowRoot} shadowRoot
 * @param {DOMRect}    rect
 * @param {string}     selectorText
 * @returns {HTMLElement}
 */
export function createPickerOverlay(shadowRoot, rect, selectorText) {
  return createOverlayElement(
    shadowRoot,
    rect,
    "#06B6D4",
    "selector",
    selectorText,
    false,
    1,
  );
}

// === END overlay-renderer.js ===
