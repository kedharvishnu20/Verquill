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
  "#F59E0B", // 2 — amber   (entering data)
  "#8558EC", // 3 — violet  (pointer work). Darkened 4% from #8B5CF6,
  //          which could not reach WCAG AA against either text colour.
  "#EF4444", // 4 — red     (errors)
  "#06B6D4", // 5 — cyan    (SCROLL)
  "#EC4899", // 6 — pink    (WAIT)
  "#84CC16", // 7 — lime    (PAGINATE)
];

/** The near-black this module offers as badge text. Named, because badgeTextColor
 * compares against its luminance rather than against a magic threshold. */
export const BADGE_DARK = "#111827";

export const COLOR_CAPTCHA = "#F97316"; // orange
export const COLOR_BLOCKED = "#6B7280"; // gray
export const COLOR_SUCCESS = "#22C55E"; // green
export const COLOR_WARNING = "#FACC15"; // yellow
export const COLOR_ERROR = "#EF4444"; // red

// Step-type-to-palette-index map
/**
 * Which palette slot each step type paints its overlay with.
 *
 * Rebuilt from utils/step-types.js, because it had drifted badly from it. Ten
 * of its keys named types the registry does not have — FORM_FILL, API_FETCH,
 * OPEN_MODAL, CONDITIONAL, SCROLL_TO_CLICK, API_AUTH, API_PAGINATE,
 * CAPTCHA_SOLVE, PROXY_ROTATE, API_EXTRACT — and nineteen types that do exist
 * were absent, so `?? 0` painted FILL, HOVER, SELECT, EXPORT, AUTO_EXTRACT and
 * fourteen others the same blue as NAVIGATE. Overlays exist to tell steps
 * apart on the page; most of them were the same colour.
 *
 * There are more step types than palette slots, so grouping is deliberate
 * rather than incidental: the eye needs to separate *kinds* of work — going
 * somewhere, reading something, changing something — more than it needs a
 * unique hue per step. Types that commonly appear together on one page get
 * different slots; types that rarely co-occur may share.
 *
 * A step type missing from here is a bug in one of two files, and
 * tests/color-contrast.test.mjs fails rather than letting it default quietly.
 */
export const STEP_COLOR_INDEX = {
  // 0 blue — going somewhere
  WEBSITE: 0,
  NAVIGATE: 0,
  PAGE_JSON: 0,

  // 1 green — reading something out
  EXTRACT: 1,
  PAGE_DATA: 1,
  AUTO_EXTRACT: 1,
  PDF_EXTRACTION: 1,

  // 2 amber — putting something in
  FILL: 2,
  SELECT: 2,
  KEYBOARD: 2,
  UPLOAD_ACTIVITY: 2,

  // 3 violet — pointer work
  CLICK: 3,
  HOVER: 3,
  DRAG_DROP: 3,

  // 4 red — reserved for error state, never a resting step colour

  // 5 cyan — moving the viewport, or capturing it
  SCROLL: 5,
  SCREENSHOT: 5,

  // 6 pink — control flow, where a step decides rather than acts
  WAIT: 6,
  IF_ELSE: 6,
  LOOP: 6,
  ASSERT: 6,

  // 7 lime — walking a sequence, or the data that comes back from one
  PAGINATE: 7,
  API: 7,
  API_SNIFFER: 7,
  DEDUPE: 7,
  EXPORT: 7,
  DOWNLOAD_FILE: 7,

  // Their own colours, set below rather than from the palette.
  SOLVE_CAPTCHA: -1,
  SET_HEADERS: -2,
  SESSION: -2,
};

/**
 * Get the color for a step type.
 * @param {string} stepType
 * @returns {string} CSS color
 */
export function stepColor(stepType) {
  const idx = STEP_COLOR_INDEX[stepType];
  // The special cases first, and by the registry's own names. This used to
  // test for "CAPTCHA_SOLVE"; the step is SOLVE_CAPTCHA, so the captcha colour
  // never once applied.
  if (idx === -1) return COLOR_CAPTCHA;
  if (idx === -2) return COLOR_BLOCKED;
  // An unknown type still has to paint something — an overlay that threw would
  // take the page down — but blue is NAVIGATE's colour and borrowing it hides
  // the gap. Grey says "this step has no colour yet", which is true.
  if (idx === undefined) return COLOR_BLOCKED;
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
  // Both ratios, then the better one. Not a luminance threshold.
  //
  // This used to be `lum > 0.5 ? dark : white`, which reads like a sensible
  // midpoint and is not one. WCAG contrast is a ratio between two luminances,
  // (lighter + 0.05) / (darker + 0.05), so the luminance at which dark text
  // overtakes white depends on how dark the dark is — and this palette's dark
  // is #111827, not black. The crossover sits near 0.18, not 0.5.
  //
  // Measured against the palette in this file, the old threshold chose wrong
  // for ten of thirteen colours and left eleven of them under WCAG AA. Amber
  // #F59E0B rendered white-on-amber at 2.15:1 where dark text would have given
  // 8.26:1. The docblock claimed WCAG 2.1 conformance throughout.
  //
  // Comparing the two ratios needs no threshold at all, cannot drift as the
  // palette changes, and is what "maximum contrast" meant in the first place.
  // Where neither option reaches 4.5:1 — a saturated mid-tone like the violet
  // — it still returns the better of the two, which is all a text colour can
  // do about a background that was never going to work.
  const bg = relativeLuminance(backgroundHex);
  return contrastRatio(bg, relativeLuminance(BADGE_DARK)) > contrastRatio(bg, 1)
    ? BADGE_DARK
    : "#ffffff";
}

/**
 * WCAG 2.1 contrast ratio between two relative luminances.
 *
 * Exported because it is the thing worth asserting: a test that pins the
 * chosen colour pins today's palette, and a test that pins the ratio pins the
 * property the choice exists to serve.
 *
 * @param {number} a relative luminance, 0–1
 * @param {number} b relative luminance, 0–1
 * @returns {number} ratio from 1 (identical) to 21 (black on white)
 */
export function contrastRatio(a, b) {
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
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
