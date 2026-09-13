// Regression tests for audit findings E-04, E-06, E-07 and E-14.
//
// E-04: the "Processed" card was set from progress.current, which the executor
// increments once per step. Sitting next to a "Download Data" button it read as
// a row count and was not one — a 4-step pipeline that extracted 900 rows
// showed "4".
//
// E-06: _testStep, _pickSelector, _addExtractField and _addFillField used
// alert() for routine errors — a blocking, unstyled, OS-level dialog for
// "refresh the page first" — while the panel already had a log pane built for
// exactly this.
//
// E-07: _testStep discarded res.result, so testing a step told you only that it
// did not throw, never what a CLICK matched or what an EXTRACT read back. The
// success/error class also stayed on the card until the next full render.
//
// E-14: "🗑 Clear" wiped the pipeline and "🧹 Clear Library" deleted every
// stored file, both on one click with no confirm and no undo.
//
// pipeline-builder.js is a module with no exports that touches ~20 DOM ids at
// module scope, so functions are extracted from the source and evaluated
// against jsdom, the way tests/panel-escaping.test.mjs does.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

const src = await readFile(
  new URL("../sidepanel/pipeline-builder.js", import.meta.url),
  "utf8",
);
const htmlSrc = await readFile(
  new URL("../sidepanel/index.html", import.meta.url),
  "utf8",
);
const swSrc = await readFile(
  new URL("../background/service-worker.js", import.meta.url),
  "utf8",
);

/**
 * Strip module syntax from an extracted span.
 *
 * These tests pull real function bodies out of the panel source and evaluate
 * them with `new Function`, which is what makes them tests of the code rather
 * than of a copy of it. `export` is a syntax error inside that body, so a
 * helper becoming shared — as `notify` did when the overlay panel started using
 * it — would break the extraction rather than the behaviour. The keyword is
 * irrelevant to everything asserted below, so it is removed rather than
 * matched around.
 */
const stripExports = (s) =>
  s.replace(/\bexport (?=(async )?function |const |let )/g, "");

function extract(pattern) {
  const m = src.match(pattern);
  assert.ok(m, `could not find ${pattern}`);
  return stripExports(m[0]);
}

// ── E-04: the row count ──────────────────────────────────────────────────────

test("the executor reports rows collected, not just steps done", () => {
  const fn = swSrc.match(/async function _executeSteps\([\s\S]*?\n\}\n/)[0];
  assert.match(
    fn,
    /rows: runState\?\.results\.length \?\? 0/,
    "the status message carries a row count",
  );
});

test("an EXTRACT publishes its rows immediately", () => {
  // Without this the count only moved on the next step's status message, so the
  // last EXTRACT of a run never showed its rows at all.
  const block = swSrc.match(
    /if \(step\.type === "EXTRACT" && Array\.isArray\(resp\.result\)\) \{[\s\S]*?\n {6}\}/,
  )[0];
  assert.match(block, /rows: runState\.results\.length/);
  assert.match(block, /type: "pipeline:status"/);
});

test("the panel reads the row count from rows, not from progress", () => {
  const handler = src.match(
    /if \(msg\.type === "pipeline:status"\) \{[\s\S]*?\n {6}\}/,
  )[0];
  assert.ok(
    !/mon-rows"\)\.textContent = info\.progress\.current/.test(src),
    "the step counter is no longer wired to the row card",
  );
  assert.match(src, /if \(typeof info\.rows === "number"\) \{/);
  assert.match(handler, /mon-progress-text/, "progress still drives the bar");
});

test("the card says what it now shows", () => {
  assert.match(htmlSrc, /<div class="metric-label">Rows Extracted<\/div>/);
  assert.ok(
    !/<div class="metric-label">Processed<\/div>/.test(htmlSrc),
    "the old label implied rows while showing steps",
  );
});

// ── E-06: no more alert() ────────────────────────────────────────────────────

test("no routine error goes through alert()", () => {
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/\balert\(/.test(code), "alert() blocks the whole panel");
});

test("notify writes to the log pane and shows a banner", () => {
  const dom = new JSDOM(
    `<!doctype html><body><div id="mon-logs"></div></body>`,
  );
  const { document } = dom.window;

  const notifySrc = stripExports(
    src.match(
      /const MAX_LOG_ENTRIES[\s\S]*?\nfunction logToMonitor[\s\S]*?\n\}/,
    )[0],
  );
  const notify = new Function(
    "document",
    "setTimeout",
    `${notifySrc}; return notify;`,
  )(document, () => 0);

  notify("error-log", "Refresh the target webpage first.");

  const logs = document.getElementById("mon-logs");
  assert.equal(logs.childElementCount, 1, "it is still recorded permanently");
  const toast = document.querySelector("#vq-toasts .vq-toast");
  assert.ok(toast, "and shown where the user is actually looking");
  assert.equal(toast.textContent, "Refresh the target webpage first.");
  assert.ok(
    toast.classList.contains("error-log"),
    "the level is carried through",
  );
});

test("a toast carries page text as text, never as markup", () => {
  const dom = new JSDOM(
    `<!doctype html><body><div id="mon-logs"></div></body>`,
  );
  const notifySrc = stripExports(
    src.match(
      /const MAX_LOG_ENTRIES[\s\S]*?\nfunction logToMonitor[\s\S]*?\n\}/,
    )[0],
  );
  const notify = new Function(
    "document",
    "setTimeout",
    `${notifySrc}; return notify;`,
  )(dom.window.document, () => 0);

  notify("error-log", '<img src=x onerror="alert(1)">');
  const toast = dom.window.document.querySelector(".vq-toast");
  assert.equal(toast.querySelectorAll("img").length, 0);
  assert.equal(toast.textContent, '<img src=x onerror="alert(1)">');
});

test("the toast layer is styled and sits above the board", () => {
  assert.match(htmlSrc, /#vq-toasts \{[\s\S]*?z-index: 10000/);
  assert.match(
    htmlSrc,
    /\.vq-toast\.error-log \{\s*border-left-color: var\(--red\)/,
  );
});

// ── E-07: what the test actually did ─────────────────────────────────────────

// Built lazily: extracting at module scope makes a missing function abort the
// whole file, so every later test disappears instead of failing.
const describe = (...args) =>
  new Function(
    `${extract(/function _clip\(str, max\) \{[\s\S]*?\n\}/)};
     ${extract(/function _describeStepResult\(result\) \{[\s\S]*?\n\}/)};
     return _describeStepResult;`,
  )()(...args);

test("an EXTRACT result is summarised, not swallowed", () => {
  const out = describe([
    { title: "Widget", price: "$4" },
    { title: "Gadget", price: "$9" },
  ]);
  assert.match(out, /2 rows/);
  assert.match(out, /2 fields/);
  assert.match(out, /Widget/, "the user can see what it actually read");
});

test("an empty match is reported as empty, not as success", () => {
  assert.equal(describe([]), "0 rows");
});

test("singulars read correctly and a scalar comes through", () => {
  assert.match(describe([{ a: 1 }]), /1 row, 1 field/);
  assert.equal(describe(7), "7");
  assert.equal(describe(null), "no result");
  assert.equal(describe(undefined), "no result");
});

test("a huge result is clipped rather than flooding the pane", () => {
  const out = describe({ blob: "x".repeat(5000) });
  assert.ok(out.length < 300, `still ${out.length} chars`);
  assert.match(out, /…$/);
});

test("_testStep logs the result and clears its outcome class", () => {
  const fn = extract(/async function _testStep\(e, id\) \{[\s\S]*?\n\}\n/);
  assert.match(
    fn,
    /_describeStepResult\(res\?\.result\)/,
    "the result is shown",
  );
  assert.match(
    fn,
    /notify\(\s*\n?\s*"error-log"/,
    "failures go to the log, not alert()",
  );
  assert.match(
    fn,
    /card\.classList\.remove\("success", "error"\)/,
    "a stale outcome class used to sit there until the next render",
  );
  assert.match(
    fn,
    /clearTimeout\(_testStepTimers\.get\(id\)\)/,
    "re-testing resets it",
  );
});

// ── E-14: destructive actions ────────────────────────────────────────────────

test("clearing the pipeline asks first, and says how much is going", async () => {
  const fn = extract(
    /\.getElementById\("btn-clear-pipeline"\)\n[\s\S]*?\n {4}\}\);/,
  );
  assert.match(fn, /await _confirmDestructive\(/);
  assert.match(fn, /if \(!ok\) return;/, "cancel must not clear anything");
  assert.match(fn, /\$\{n\} step/, "the count is in the prompt");
  assert.ok(
    fn.indexOf("_confirmDestructive") < fn.indexOf("_pipeline.steps = []"),
    "the confirm has to come before the wipe",
  );
});

test("clearing the file library asks first", () => {
  const fn = extract(
    /\.getElementById\("btn-storage-clear"\)\n[\s\S]*?\n {4}\}\);/,
  );
  assert.match(fn, /await _confirmDestructive\(/);
  assert.match(fn, /if \(!ok\) return;/);
  assert.match(fn, /UPLOAD_ACTIVITY/, "it says what else breaks");
  assert.ok(
    fn.indexOf("_confirmDestructive") < fn.indexOf("_storageFiles = []"),
  );
});

test("an empty pipeline or library does not prompt at all", () => {
  for (const id of ["btn-clear-pipeline", "btn-storage-clear"]) {
    const fn = extract(
      new RegExp(`\\.getElementById\\("${id}"\\)\\n[\\s\\S]*?\\n {4}\\}\\);`),
    );
    assert.match(fn, /if \(!n\) return;/, `${id} prompts over nothing`);
  }
});

test("the dialog defaults to the safe option and takes Escape", () => {
  const fn = extract(/function _confirmDestructive\(\{[\s\S]*?\n\}\n/);
  assert.match(fn, /cancel\.focus\(\)/, "Enter must not confirm a delete");
  assert.match(fn, /if \(e\.key === "Escape"\) done\(false\)/);
  assert.ok(!/innerHTML/.test(fn), "the body carries counts and file names");
  assert.match(
    fn,
    /removeEventListener\("keydown", onKey, true\)/,
    "no leaked listener",
  );
});

test("the dialog resolves false when dismissed by the backdrop", async () => {
  const dom = new JSDOM(`<!doctype html><body></body>`);
  const g = dom.window;
  const confirmFn = new Function(
    "document",
    `${extract(/function _confirmDestructive\(\{[\s\S]*?\n\}\n/)}; return _confirmDestructive;`,
  )(g.document);

  const p = confirmFn({ title: "t", body: "b", confirmLabel: "Delete" });
  const modal = g.document.body.firstElementChild;
  modal.dispatchEvent(new g.MouseEvent("click", { bubbles: true }));
  assert.equal(await p, false);
  assert.equal(g.document.body.childElementCount, 0, "and it cleans itself up");
});

test("the dialog resolves true only on the confirm button", async () => {
  const dom = new JSDOM(`<!doctype html><body></body>`);
  const g = dom.window;
  const confirmFn = new Function(
    "document",
    `${extract(/function _confirmDestructive\(\{[\s\S]*?\n\}\n/)}; return _confirmDestructive;`,
  )(g.document);

  const p = confirmFn({ title: "t", body: "9 steps", confirmLabel: "Clear" });
  const buttons = [...g.document.querySelectorAll("button")];
  assert.deepEqual(
    buttons.map((b) => b.textContent),
    ["Cancel", "Clear"],
  );
  assert.match(g.document.body.textContent, /9 steps/);
  buttons[1].click();
  assert.equal(await p, true);
});
