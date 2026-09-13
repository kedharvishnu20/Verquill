// Regression tests for audit findings E-13, E-10, B-29, B-30 and C-12.
//
// E-13: chrome.tabs.onActivated reassigned _tabId, loaded a different per-tab
// pipeline and re-rendered — while a run was in flight against the previous
// tab. Stop still pointed at the right runId, but the board showed an unrelated
// pipeline and the monitor filled with lines about steps that were not on it.
//
// E-10: bindConfigInputs cloned every .cfg-bind element and swapped the clone
// in, to shed listeners it might have bound twice. Replacing a node destroys
// focus, caret and selection, and renderPipeline() redraws the whole canvas on
// every expand, collapse, add and remove.
//
// B-29: _captureScreenshot called tabs.update({active: true}) unconditionally
// and slept 400ms, so a loop with a screenshot step yanked focus away from
// whatever the user was doing, repeatedly.
//
// B-30: it passed `quality` with `format: "png"`, which Chrome ignores. The UI
// offered a quality control that did nothing.
//
// C-12: files are held as base64 data URLs in chrome.storage.local, capped at
// ~10 MB without `unlimitedStorage` (not requested), and base64 inflates by a
// third. Two 4 MB PDFs are already over. A try/catch logged a quota message
// after the fact; nothing checked before writing, and the failed write left the
// panel showing files that were never persisted.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const panelSrc = await readFile(
  new URL("../sidepanel/pipeline-builder.js", import.meta.url),
  "utf8",
);
const swSrc = await readFile(
  new URL("../background/service-worker.js", import.meta.url),
  "utf8",
);

const extract = (src, re) => {
  const m = src.match(re);
  assert.ok(m, `could not find ${re}`);
  return m[0];
};

// ── E-13: the board and the run agree on a tab ───────────────────────────────

test("a tab switch during a run leaves the board on the running tab", () => {
  const fn = extract(
    panelSrc,
    /chrome\.tabs\.onActivated\.addListener\(async \(activeInfo\) => \{[\s\S]*?\n  \}\);/,
  );
  assert.match(fn, /if \(_runState\.active && activeInfo\.tabId !== _tabId\)/);
  assert.match(fn, /return;/);
  assert.ok(
    fn.indexOf("_runState.active") < fn.indexOf("_tabId = activeInfo.tabId"),
    "the guard has to come before the reassignment",
  );
});

test("the user is told why the board did not follow", () => {
  const fn = extract(
    panelSrc,
    /chrome\.tabs\.onActivated\.addListener\(async \(activeInfo\) => \{[\s\S]*?\n  \}\);/,
  );
  assert.match(fn, /A run is in flight on another tab/);
});

test("switching with no run still swaps the pipeline", () => {
  const fn = extract(
    panelSrc,
    /chrome\.tabs\.onActivated\.addListener\(async \(activeInfo\) => \{[\s\S]*?\n  \}\);/,
  );
  assert.match(fn, /SK\.PIPELINE = `vq_active_pipeline_\$\{_tabId\}`/);
  assert.match(fn, /renderPipeline\(\)/);
});

// ── E-10: editing without losing the caret ───────────────────────────────────

test("config inputs are not replaced to rebind them", () => {
  const fn = extract(
    panelSrc,
    /function bindConfigInputs\(container = document\) \{[\s\S]*?\n\}/,
  );
  assert.ok(
    !/cloneNode\(true\)/.test(fn),
    "cloning and swapping destroyed focus, caret and selection",
  );
  assert.ok(!/replaceChild/.test(fn));
  assert.match(fn, /if \(el\.dataset\.vqBound === "1"\) return;/, "bound once");
  assert.match(fn, /el\.dataset\.vqBound = "1";/);
});

test("a targeted re-render puts the caret back", () => {
  const fn = extract(
    panelSrc,
    /function _rerenderCardConfig\(step\) \{[\s\S]*?\n\}/,
  );
  assert.match(fn, /const active = document\.activeElement/);
  assert.match(fn, /selectionStart/);
  assert.match(fn, /again\.focus\(\)/);
  assert.match(fn, /setSelectionRange\(restore\.start, restore\.end\)/);
  assert.ok(
    fn.indexOf("const active") < fn.indexOf("configEl.innerHTML ="),
    "the position has to be read before the rebuild",
  );
});

test("an input type with no selection range does not throw", () => {
  const fn = extract(
    panelSrc,
    /function _rerenderCardConfig\(step\) \{[\s\S]*?\n\}/,
  );
  assert.match(fn, /try \{\s*\n\s*again\.setSelectionRange/);
});

// ── B-29 / B-30: screenshots ─────────────────────────────────────────────────

test("a tab that is already active is not re-activated", () => {
  // The activation lives in _takeShot now — the one place every screenshot
  // area goes through — so _captureScreenshot can be reused by the single-step
  // "Test" path without storing anything.
  const fn = extract(swSrc, /async function _takeShot\([\s\S]*?\n\}\n/);
  assert.match(fn, /const before = await chrome\.tabs\.get\(tabId\);/);
  assert.match(fn, /if \(!before\.active\) \{/);
  assert.ok(
    !/^\s*await chrome\.tabs\.update\(tabId, \{ active: true \}\);\s*$/m.test(
      fn.replace(/if \(!before\.active\) \{[\s\S]*?\n {4}\}/, ""),
    ),
    "the unconditional activation is gone",
  );
});

test("the 400ms settle only happens when the tab actually changed", () => {
  const fn = extract(swSrc, /async function _takeShot\([\s\S]*?\n\}\n/);
  const guarded = fn.match(/if \(!before\.active\) \{[\s\S]*?\n {4}\}/)[0];
  assert.match(guarded, /_sleep\(400\)/);
});

test("quality selects a format where quality means something", () => {
  // The B-30 logic now lives in _captureViewport: every area — visible, full
  // page, single element — takes its photographs through it, so there is still
  // one place that decides the format.
  const fn = extract(swSrc, /async function _captureViewport\([\s\S]*?\n\}\n/);
  assert.match(fn, /const format = quality >= 100 \? "png" : "jpeg";/);
  assert.match(
    fn,
    /format === "png" \? \{ format \} : \{ format, quality \}/,
    "Chrome ignores quality for PNG, so it must not be sent with it",
  );
});

test("the archive names each file by what it actually is", () => {
  assert.match(swSrc, /ext: format === "png" \? "png" : "jpg"/);
  assert.match(
    swSrc,
    /screenshot_\$\{i \+ 1\}_\$\{s\.ts\}\.\$\{s\.ext \|\| "png"\}/,
  );
});

// ── C-12: the storage quota ──────────────────────────────────────────────────

test("the budget is under the quota and accounts for base64 inflation", () => {
  assert.match(panelSrc, /const STORAGE_QUOTA_BYTES = 10 \* 1024 \* 1024;/);
  assert.match(
    panelSrc,
    /const STORAGE_BUDGET_BYTES = Math\.floor\(STORAGE_QUOTA_BYTES \* 0\.8\)/,
  );
  assert.match(panelSrc, /const BASE64_OVERHEAD = 4 \/ 3;/);
});

test("a file is rejected before it is read, not after the write fails", () => {
  const fn = extract(
    panelSrc,
    /async function _stageFilesInStorage\(files\) \{[\s\S]*?\n\}/,
  );
  assert.match(
    fn,
    /const projected = Math\.ceil\(file\.size \* BASE64_OVERHEAD\);/,
  );
  assert.match(fn, /if \(used \+ projected > STORAGE_BUDGET_BYTES\)/);
  assert.ok(
    fn.indexOf("used + projected") <
      fn.indexOf("await _readFileAsDataUrl(file)"),
    "the check must come before the read",
  );
  assert.match(fn, /rejected\.push\(file\.name\)/);
});

test("what was rejected is named, and the activity says it was partial", () => {
  const fn = extract(
    panelSrc,
    /async function _stageFilesInStorage\(files\) \{[\s\S]*?\n\}/,
  );
  assert.match(fn, /file\(s\) not added/);
  assert.match(fn, /rejected\.join\(", "\)/);
  assert.match(fn, /status: rejected\.length \? "partial" : "completed"/);
});

test("a refused write resyncs the panel with what is on disk", () => {
  const fn = extract(
    panelSrc,
    /async function _saveStorageFiles\(\) \{[\s\S]*?\n\}/,
  );
  assert.match(fn, /chrome\.storage\.local\.get\(SK\.STORAGE_FILES\)/);
  assert.match(
    fn,
    /_storageFiles = Array\.isArray\(onDisk\) \? onDisk : \[\];/,
  );
  assert.match(fn, /renderStoragePanel\(\)/);
  assert.match(fn, /throw error;/, "the caller still learns it failed");
});

test("usage is measured from the encoded size, falling back to the raw size", () => {
  const used = new Function(
    "_storageFiles",
    `${extract(panelSrc, /const BASE64_OVERHEAD = 4 \/ 3;/)}
     ${extract(panelSrc, /function _storageBytesUsed\(\) \{[\s\S]*?\n\}/)}
     return _storageBytesUsed();`,
  );

  assert.equal(
    used([{ dataUrl: "x".repeat(1000) }]),
    1000,
    "the encoded length",
  );
  assert.equal(
    used([{ size: 300 }]),
    400,
    "or 4/3 of the raw size when absent",
  );
  assert.equal(used([]), 0);
});
