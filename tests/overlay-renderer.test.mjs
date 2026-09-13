// The badge a step draws on the page, and what happens to it when the step's
// state changes.
//
// This module had no tests at all, which is how three things survived in it:
//
//  - Labels were trimmed twice — once by _modeBadgeText against the 24-char
//    budget, and again by the caller on the whole composed string. The second
//    pass cut whatever the first had added, so a multi-match badge lost the
//    "· ×5" that was the only reason it was rendered differently.
//  - _applyModeStyle reset `animation` and nothing else, while each mode sets a
//    different subset of properties. A step that was blocked and then completed
//    kept the blocked 0.8 opacity; an element the picker had outlined kept the
//    teal ring under every later mode.
//  - Three of its eight imports were used only in the import statement.
//
// jsdom has no layout and no CSSStyleSheet in older versions, so the sheet
// injection is checked through its idempotence flag rather than through
// adoptedStyleSheets.
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import {
  createOverlayElement,
  updateOverlayElement,
  updateOverlayLabel,
  repositionOverlay,
  removeOverlayElement,
  createPickerOverlay,
  injectAnimationSheet,
} from "../content/overlay-renderer.js";

const dom = new JSDOM("<!doctype html><body></body>");
globalThis.document = dom.window.document;
globalThis.CSSStyleSheet = dom.window.CSSStyleSheet;

const RECT = { top: 10, left: 20, width: 100, height: 30 };
const BLUE = "#3B82F6";

/** A shadow root to draw into. */
function host() {
  return dom.window.document
    .createElement("div")
    .attachShadow({ mode: "open" });
}
const badgeOf = (div) => div.querySelector("[data-vq-badge]");

// ── Creating one ────────────────────────────────────────────────────────────

test("an overlay lands in the shadow root, positioned and labelled", () => {
  const root = host();
  const div = createOverlayElement(
    root,
    RECT,
    BLUE,
    "preview",
    "Price",
    false,
    1,
  );
  assert.equal(div.parentNode, root);
  assert.equal(div.style.top, "10px");
  assert.equal(div.style.left, "20px");
  assert.equal(div.style.width, "100px");
  assert.equal(div.style.height, "30px");
  assert.equal(badgeOf(div).textContent, "Price");
  assert.equal(div.dataset.vqMode, "preview");
  assert.equal(div.dataset.vqLabel, "Price");
});

test("the overlay cannot be clicked through to", () => {
  // It sits over the page the run is driving; a badge that swallowed clicks
  // would break the very page it is describing.
  const div = createOverlayElement(
    host(),
    RECT,
    BLUE,
    "preview",
    "x",
    false,
    1,
  );
  assert.equal(div.style.pointerEvents, "none");
  assert.equal(badgeOf(div).style.pointerEvents, "none");
});

// ── Labels ──────────────────────────────────────────────────────────────────

test("a long label is trimmed with an ellipsis", () => {
  const div = createOverlayElement(
    host(),
    RECT,
    BLUE,
    "preview",
    "a".repeat(60),
    false,
    1,
  );
  const text = badgeOf(div).textContent;
  assert.ok(text.length <= 24, `badge is ${text.length} chars`);
  assert.ok(text.endsWith("…"));
});

test("the match count survives a label long enough to need trimming", () => {
  // The regression this file was written for. The count is the entire reason a
  // multi badge looks different from a single one, and it was the first thing
  // the second trim removed.
  const div = createOverlayElement(
    host(),
    RECT,
    BLUE,
    "preview",
    "Product title column",
    true,
    37,
  );
  assert.match(badgeOf(div).textContent, /×37$/);
});

test("a mode prefix is not trimmed off either", () => {
  const div = createOverlayElement(
    host(),
    RECT,
    BLUE,
    "completed",
    "b".repeat(40),
    false,
    1,
  );
  assert.ok(badgeOf(div).textContent.startsWith("✓ "));
});

test("a short label is left exactly as given", () => {
  const div = createOverlayElement(
    host(),
    RECT,
    BLUE,
    "preview",
    "SKU",
    false,
    1,
  );
  assert.equal(badgeOf(div).textContent, "SKU");
});

test("a missing label draws an empty badge rather than 'undefined'", () => {
  const div = createOverlayElement(
    host(),
    RECT,
    BLUE,
    "preview",
    undefined,
    false,
    1,
  );
  assert.equal(badgeOf(div).textContent, "");
});

test("updateOverlayLabel replaces just the text", () => {
  const div = createOverlayElement(
    host(),
    RECT,
    BLUE,
    "live",
    "typing",
    false,
    1,
  );
  updateOverlayLabel(div, "typed");
  assert.equal(badgeOf(div).textContent, "typed");
});

// ── Mode transitions ────────────────────────────────────────────────────────

test("a blocked overlay that then completes does not stay dimmed", () => {
  const div = createOverlayElement(
    host(),
    RECT,
    BLUE,
    "blocked",
    "x",
    false,
    1,
  );
  assert.equal(div.style.opacity, "0.8");
  updateOverlayElement(div, BLUE, "completed", "x");
  assert.equal(div.style.opacity, "", "the blocked dimming outlived the block");
});

test("a picked element does not keep the teal ring once a step runs on it", () => {
  const div = createPickerOverlay(host(), RECT, "#main > h1");
  assert.ok(div.style.boxShadow);
  updateOverlayElement(div, BLUE, "live", "Click");
  assert.equal(div.style.boxShadow, "");
});

test("an animation from one mode does not run under the next", () => {
  const div = createOverlayElement(host(), RECT, BLUE, "live", "x", false, 1);
  assert.match(div.style.animation, /vq-pulse/);
  updateOverlayElement(div, BLUE, "preview", "x");
  assert.equal(div.style.animation, "none");
});

test("an error shows the message, not the label", () => {
  const div = createOverlayElement(
    host(),
    RECT,
    BLUE,
    "live",
    "Click Next",
    false,
    1,
  );
  updateOverlayElement(div, BLUE, "error", "Click Next", "no such element");
  assert.match(badgeOf(div).textContent, /no such element/);
  assert.equal(div.dataset.vqMode, "error");
});

test("an update with no label keeps the one the overlay was created with", () => {
  const div = createOverlayElement(
    host(),
    RECT,
    BLUE,
    "preview",
    "Price",
    false,
    1,
  );
  updateOverlayElement(div, BLUE, "live", undefined);
  assert.match(badgeOf(div).textContent, /Price/);
});

test("completed and error badges do not wear the step's own colour", () => {
  // Success and failure have to read the same whatever step they happened to.
  const a = createOverlayElement(
    host(),
    RECT,
    BLUE,
    "completed",
    "x",
    false,
    1,
  );
  const b = createOverlayElement(host(), RECT, BLUE, "error", "x", false, 1);
  assert.notEqual(badgeOf(a).style.background, badgeOf(b).style.background);
  assert.notEqual(badgeOf(a).style.background, "");
});

test("the badge text colour is chosen against the badge's own background", () => {
  // Not the overlay's. A completed badge is green regardless of the step
  // colour passed in, so reading the step colour here would be wrong.
  const div = createOverlayElement(
    host(),
    RECT,
    "#111827",
    "completed",
    "x",
    false,
    1,
  );
  const badge = badgeOf(div);
  assert.ok(badge.style.color);
  assert.notEqual(badge.style.color, "");
});

// ── Moving and removing ─────────────────────────────────────────────────────

test("repositioning moves the box and leaves the badge alone", () => {
  const div = createOverlayElement(
    host(),
    RECT,
    BLUE,
    "preview",
    "Price",
    false,
    1,
  );
  repositionOverlay(div, { top: 5, left: 6, width: 7, height: 8 });
  assert.equal(div.style.top, "5px");
  assert.equal(div.style.left, "6px");
  assert.equal(div.style.width, "7px");
  assert.equal(badgeOf(div).textContent, "Price");
});

test("removing an overlay takes it out of the shadow root", () => {
  const root = host();
  const div = createOverlayElement(root, RECT, BLUE, "preview", "x", false, 1);
  removeOverlayElement(root, div);
  assert.equal(root.children.length, 0);
});

test("a completed overlay fades before it goes", () => {
  // Deliberate: a step that finished is worth seeing finish. The element is
  // still there immediately after the call, which is the part worth pinning so
  // nobody 'fixes' the fade by removing it synchronously.
  const root = host();
  const div = createOverlayElement(
    root,
    RECT,
    BLUE,
    "completed",
    "x",
    false,
    1,
  );
  removeOverlayElement(root, div);
  assert.equal(root.children.length, 1);
  assert.match(div.style.animation, /fadeout/);
});

test("removing an overlay that is not in this root does nothing", () => {
  const a = host();
  const b = host();
  const div = createOverlayElement(a, RECT, BLUE, "preview", "x", false, 1);
  removeOverlayElement(b, div);
  assert.equal(a.children.length, 1);
});

// ── The stylesheet ──────────────────────────────────────────────────────────

test("the animation sheet is injected once per shadow root", () => {
  const root = host();
  injectAnimationSheet(root);
  const after = root.adoptedStyleSheets?.length ?? root.children.length;
  injectAnimationSheet(root);
  injectAnimationSheet(root);
  assert.equal(root.adoptedStyleSheets?.length ?? root.children.length, after);
});

test("a root without adoptedStyleSheets still gets the animations", () => {
  // The fallback path: some embedders and older engines have no adopted
  // sheets, and an overlay with no keyframes is a live step that looks idle.
  const root = host();
  Object.defineProperty(root, "adoptedStyleSheets", {
    set() {
      throw new Error("unsupported");
    },
    get() {
      return undefined;
    },
  });
  injectAnimationSheet(root);
  const style = root.querySelector("style");
  assert.ok(style, "no animations reached the root");
  assert.match(style.textContent, /vq-pulse/);
});
