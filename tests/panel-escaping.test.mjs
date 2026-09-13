// Regression tests for audit findings C-04 and C-05, plus E-18.
//
// C-04: logToMonitor built each entry with innerHTML, interpolating the message
// directly. Log messages routinely carry page-derived text — selectors,
// extracted values, API URLs, thrown error messages — so a page could inject
// markup into the side panel. CSP blocks inline script; it does not block an
// <img> beacon, a layout break, or phishing content in the log pane.
//
// C-05: esc() escaped only " and <, so & passed through raw.
//
// pipeline-builder.js is an ES module with no exports that touches ~20 DOM ids
// at module scope, so the two functions are extracted from the source and
// evaluated against a jsdom document. That runs the real function bodies.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

const src = await readFile(
  new URL("../sidepanel/pipeline-builder.js", import.meta.url),
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

/** Pull a top-level function (and any consts it needs) out of the source. */
function extract(pattern) {
  const m = src.match(pattern);
  assert.ok(m, `could not find ${pattern}`);
  return stripExports(m[0]);
}

const escSrc = extract(/function esc\(s\) \{[\s\S]*?\n\}/);

// The cap is a later addition; extract with it when present so this file still
// loads — and fails per-test rather than wholesale — against the older shape.
const logSrc =
  stripExports(
    src.match(
      /const MAX_LOG_ENTRIES[\s\S]*?\nfunction logToMonitor[\s\S]*?\n\}/,
    )?.[0] ?? "",
  ) ||
  `const MAX_LOG_ENTRIES = Infinity;\n` +
    extract(/function logToMonitor\([\s\S]*?\n\}/);

const dom = new JSDOM(`<!doctype html><div id="mon-logs"></div>`);
const { document } = dom.window;

const esc = new Function(`${escSrc}; return esc;`)();
const logToMonitor = new Function(
  "document",
  `${logSrc}; return logToMonitor;`,
)(document);

const logs = () => document.getElementById("mon-logs");
const reset = () => (logs().innerHTML = "");

test("a log message is never interpreted as markup", () => {
  reset();
  logToMonitor("info-log", '<img src=x onerror="alert(1)">');

  assert.equal(
    logs().querySelectorAll("img").length,
    0,
    "no element was created",
  );
  assert.equal(
    logs().querySelector(".log-msg").textContent,
    '<img src=x onerror="alert(1)">',
    "the text is shown literally",
  );
});

test("markup in an error message cannot break the pane", () => {
  reset();
  // The shape of a real message: a thrown selector error echoing page content.
  logToMonitor(
    "error-log",
    '[CLICK] Click target not found. Selector: "</div><h1>gotcha"',
  );

  assert.equal(logs().childElementCount, 1, "still one entry");
  assert.equal(logs().querySelectorAll("h1").length, 0);
});

test("the entry still renders its timestamp and level", () => {
  reset();
  logToMonitor("warn-log", "hello");

  const entry = logs().firstElementChild;
  assert.ok(entry.className.includes("warn-log"));
  assert.match(
    entry.querySelector(".log-ts").textContent,
    /^\[\d{2}:\d{2}:\d{2}\]$/,
  );
  assert.equal(entry.querySelector(".log-msg").textContent, "hello");
});

test("null and undefined messages do not print as 'undefined' markup", () => {
  reset();
  logToMonitor("info-log", undefined);
  assert.equal(logs().querySelector(".log-msg").textContent, "");
});

test("the log pane is capped", () => {
  reset();
  for (let i = 0; i < 600; i++) logToMonitor("info-log", `line ${i}`);

  assert.ok(logs().childElementCount <= 500, `got ${logs().childElementCount}`);
  assert.equal(
    logs().lastElementChild.querySelector(".log-msg").textContent,
    "line 599",
    "the newest entry is kept",
  );
});

test("esc escapes the full set, ampersand first", () => {
  assert.equal(esc("a & b"), "a &amp; b");
  assert.equal(esc("<script>"), "&lt;script&gt;");
  assert.equal(esc('say "hi"'), "say &quot;hi&quot;");
  assert.equal(esc("it's"), "it&#39;s");
});

test("esc does not double-escape its own output", () => {
  // The old version left & raw, so a value containing the literal text &quot;
  // rendered as a double quote.
  assert.equal(esc("&quot;"), "&amp;quot;");
  assert.equal(esc("&amp;"), "&amp;amp;");
});

test("esc handles a value that would break out of an attribute", () => {
  const attacker = `" onfocus="alert(1)`;
  const escaped = esc(attacker);
  assert.ok(!escaped.includes('"'), "no raw double quote survives");

  const probe = new JSDOM(`<!doctype html><input value="${escaped}">`);
  const input = probe.window.document.querySelector("input");
  assert.equal(
    input.getAttribute("onfocus"),
    null,
    "no attribute was injected",
  );
  assert.equal(input.value, attacker, "and the literal value round-trips");
});

test("esc coerces nullish input", () => {
  assert.equal(esc(null), "");
  assert.equal(esc(undefined), "");
});

test("no interpolated innerHTML remains in logToMonitor", () => {
  assert.ok(
    !/div\.innerHTML = `<span class="log-ts">/.test(src),
    "the entry must be built as nodes",
  );
});
