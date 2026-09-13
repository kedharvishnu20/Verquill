// === color-utils.js ===
/**
 * @module color-utils
 * @description Color utility functions for the overlay engine.
 *   Provides luminance checking, contrast auto-switching, and palette cycling.
 *   All colors are sourced from the canonical registry CSS variable tokens.
 *
 *   Design decision: We compute relative luminance per WCAG 2.1 spec to
 *   determine whether badge text should be white or dark. This prevents
 *   unreadable white-on-yellow or black-on-dark-blue combinations.
 *
 * @dependencies none
 */

"use strict";

// ── Canonical palette (mirrors CSS variable registry) ────────────────────────
export const ZONE_PALETTE = [
  "#3B82F6", // 0 — blue    (NAVIGATE)
  "#10B981", // 1 — green   (EXTRACT)
  "#F59E0B", // 2 — amber   (FORM_FILL)
  "#8B5CF6", // 3 — violet  (CLICK)
  "#EF4444", // 4 — red     (errors)
  "#06B6D4", // 5 — cyan    (SCROLL)
  "#EC4899", // 6 — pink    (WAIT)
  "#84CC16", // 7 — lime    (PAGINATE)
];

export const COLOR_CAPTCHA = "#F97316"; // orange
export const COLOR_BLOCKED = "#6B7280"; // gray
export const COLOR_SUCCESS = "#22C55E"; // green
export const COLOR_WARNING = "#FACC15"; // yellow
export const COLOR_ERROR = "#EF4444"; // red

// Step-type-to-palette-index map
export const STEP_COLOR_INDEX = {
  WEBSITE: 0,
  NAVIGATE: 0,
  API: 0,
  API_FETCH: 0,
  LOOP: 0,
  EXTRACT: 1,
  API_EXTRACT: 1,
  FORM_FILL: 2,
  OPEN_MODAL: 2,
  CONDITIONAL: 2,
  CLICK: 3,
  SCROLL_TO_CLICK: 3,
  API_AUTH: 3,
  SCROLL: 5,
  SCREENSHOT: 5,
  WAIT: 6,
  PAGINATE: 7,
  API_PAGINATE: 7,
  CAPTCHA_SOLVE: -1, // uses COLOR_CAPTCHA
  PROXY_ROTATE: 0,
};

/**
 * Get the color for a step type.
 * @param {string} stepType
 * @returns {string} CSS color
 */
export function stepColor(stepType) {
  if (stepType === "CAPTCHA_SOLVE") return COLOR_CAPTCHA;
  const idx = STEP_COLOR_INDEX[stepType] ?? 0;
  return ZONE_PALETTE[idx];
}

/**
 * Get the color for a field index within a step (cycles through palette).
 * @param {number} fieldIndex
 * @param {string[]} [customPalette]
 * @returns {string} CSS color
 */
export function fieldColor(fieldIndex, customPalette) {
  const palette = customPalette ?? ZONE_PALETTE;
  return palette[fieldIndex % palette.length];
}

/**
 * Parse a CSS hex color string to RGB components.
 * Supports #RGB, #RRGGBB.
 * @param {string} hex
 * @returns {{ r: number, g: number, b: number }}
 */
export function hexToRGB(hex) {
  let h = hex.replace("#", "");
  if (h.length === 3)
    h = h
      .split("")
      .map((c) => c + c)
      .join("");
  const n = parseInt(h, 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

/**
 * Compute relative luminance per WCAG 2.1 (IEC 61966-2-1).
 * @param {string} hex - CSS hex color
 * @returns {number} luminance in [0, 1]
 */
export function relativeLuminance(hex) {
  const { r, g, b } = hexToRGB(hex);
  const toLinear = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/**
 * Choose badge text color for maximum contrast against a background.
 * @param {string} backgroundHex
 * @returns {'#ffffff'|'#111827'} white or near-black
 */
export function badgeTextColor(backgroundHex) {
  const lum = relativeLuminance(backgroundHex);
  return lum > 0.5 ? "#111827" : "#ffffff";
}

/**
 * Blend a color with white at a given opacity (for fill calculation).
 * @param {string} hex
 * @param {number} opacity - 0 to 1
 * @returns {string} rgba string
 */
export function hexToRGBA(hex, opacity) {
  const { r, g, b } = hexToRGB(hex);
  return `rgba(${r},${g},${b},${opacity})`;
}

// === END color-utils.js ===
