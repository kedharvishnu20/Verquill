// Does the exported script do what the pipeline did?
//
// This is the question the tracker kept answering "no" to, and the answers were
// not small ones: an EXTRACT that produced thirty rows in the panel produced
// one in the script; an EXPORT step wrote no file at all; a scraped "1.4E7"
// became 1.4 in Node and fourteen million in the extension.
//
// So these tests do not check how the emitted code is *spelled*. They pull the
// generated helpers out of the generated file, run them, and compare the answer
// to the extension's own module — which is the only comparison that can catch a
// re-implementation drifting from its original.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { emitNode } from "../script-gen/node-emitter.js";
import { emitPython } from "../script-gen/python-emitter.js";
import { formatRows } from "../exporters/row-formatters.js";
import { pythonBin, skipWithoutPython } from "./helpers/python.mjs";

const dir = mkdtempSync(join(tmpdir(), "fs-parity-"));

const pipeline = (steps) => ({
  name: "t",
  targetOrigin: "https://x.test",
  steps: steps.map((s, i) => ({ id: `s${i}`, ...s })),
});

const EXTRACT_AND_EXPORT = pipeline([
  {
    type: "EXTRACT",
    config: { fields: [{ name: "title", selector: ".t" }] },
  },
  { type: "EXPORT", config: { format: "csv" } },
]);

const js = emitNode(EXTRACT_AND_EXPORT);
const py = emitPython(EXTRACT_AND_EXPORT);

// ── The helpers, lifted out and actually run ─────────────────────────────────
//
// Both generated files are whole programs that launch a browser, so the run is
// the header: everything above the first line of pipeline code, which is where
// the shared helpers live.

/** Import the generated helpers as a module. Lazy, so a test that does not
 * need them still reports its own failure rather than the whole file's. */
let _runtime = null;
async function runtime() {
  if (_runtime) return _runtime;
  const helpers = js.slice(0, js.indexOf("const sleep = ms =>"));
  const harness = join(dir, "helpers.mjs");
  writeFileSync(
    harness,
    helpers.replace(/^import .*$/gm, "") +
      "\nexport { fsFormatRows, fsNumber, fsB64, fsCell, fsHeaders };\n",
  );
  // An absolute Windows path is not a URL: import("C:\\...") is read as the
  // scheme "c:" and rejected with ERR_UNSUPPORTED_ESM_URL_SCHEME. On POSIX the
  // path happens to be a valid relative-free specifier, so this only ever
  // failed on Windows.
  _runtime = await import(pathToFileURL(harness).href);
  return _runtime;
}

/** Run the generated Python helpers and hand back what they printed. */
/**
 * Run a snippet against the emitted Python helpers.
 *
 * Callers guard with skipWithoutPython first; this throws rather than skipping
 * because it has no test context to skip with, and a helper that silently
 * returned an empty string would turn a missing interpreter into a wrong
 * assertion about the emitter.
 */
function runPy(body) {
  const head = py.slice(0, py.indexOf("# What an IF_ELSE branch reads"));
  const file = join(dir, `probe-${Math.random().toString(36).slice(2)}.py`);
  writeFileSync(
    file,
    // The pipeline's own imports pull in playwright and requests; the helpers
    // below need neither, and this box need not have them installed to answer
    // the question being asked.
    //
    // The \b matters more than it looks. Without it the allowlist matches a
    // prefix rather than a name: `re` matches the start of `requests`, so
    // `import requests` was kept rather than stripped, and every one of these
    // tests then depended on the machine happening to have requests installed.
    // Locally it did; a clean CI runner did not, and nine tests failed there
    // while passing here. The allowlist has to name whole modules.
    head.replace(
      /^(import |from )(?!(?:asyncio|os|re|sys|io|json|csv|time|random|base64|urllib)\b).*$/gm,
      "",
    ) +
      "\n" +
      body,
  );
  const python = pythonBin();
  if (!python) throw new Error("no Python 3 on this machine");
  return execFileSync(python, [file], { encoding: "utf8" });
}

const ROWS = [
  { name: "Widget, large", price: 10.49, note: 'He said "hi"' },
  { name: "Line\nbreak", extra: "only here" },
  { name: "", price: 0, note: null },
];

// ── FS-07: an EXPORT step writes a file ──────────────────────────────────────

test("EXPORT emits code that writes a file, in both languages", () => {
  // It used to emit "// EXPORT → csv (implement write here)": a script that
  // runs, exits 0, and leaves nothing on disk.
  assert.match(js, /fs\.writeFileSync\(_out, fsFormatRows\(fsRows, 'csv'\)/);
  assert.match(py, /_fh\.write\(fs_format_rows\(fs_rows, "csv"\)\)/);
  assert.ok(!/implement write here/.test(js));
  assert.ok(!/Write to file here/.test(py));
});

test("an unknown export format refuses instead of writing nothing", (t) => {
  // runPy spawns an interpreter, so these skip where there is none rather than
  // failing. Linux CI installs Python, so the skip never hides a regression on
  // the runner that gates merges.
  const python = skipWithoutPython(t);
  if (!python) return;
  const bad = pipeline([{ type: "EXPORT", config: { format: "parquet" } }]);
  assert.match(emitNode(bad), /unknown export format 'parquet'/);
  assert.match(emitPython(bad), /unknown export format 'parquet'/);
});

for (const fmt of ["csv", "json", "jsonl", "tsv", "xml", "markdown"]) {
  test(`the emitted ${fmt} is byte-for-byte what the extension writes`, async (t) => {
    // Generated inside a loop, so the guard has to be inside it too — these
    // reach Python through runPy like the rest.
    const python = skipWithoutPython(t);
    if (!python) return;
    const expected = formatRows(ROWS, fmt);
    assert.equal((await runtime()).fsFormatRows(ROWS, fmt), expected);

    // json.loads rather than a Python literal: JSON's null is not None, and
    // the rows are the same bytes both languages are being asked about.
    const printed = runPy(
      `rows = json.loads(${JSON.stringify(JSON.stringify(ROWS))})\n` +
        `sys.stdout.write(fs_format_rows(rows, "${fmt}"))`,
    );
    assert.equal(printed, expected);
  });
}

// ── FS-06: a bulk EXTRACT is more than one row ───────────────────────────────

test("EXTRACT reads every match, not the first", () => {
  // page.innerText(sel) and .first are one element. A pipeline extracting a
  // grid of thirty products exported a script that returned one, and said
  // nothing about the other twenty-nine.
  assert.ok(!/page\.innerText\('\.t'\)/.test(js));
  assert.match(js, /\.all\(\)\)\.map\(async _el =>/);
  assert.match(js, /fsRows\.push\(row\)/);
  assert.match(py, /for _el in await page\.locator\("\.t"\)\.all\(\)/);
  assert.match(py, /fs_rows\.append\(row\)/);
});

test("the row assembly rules are the extension's", () => {
  // One match is a page-level value repeated on every row; n > 1 is
  // positional and short fields get null rather than a repeat of the first
  // match, which would put data on rows it was never read from.
  assert.match(
    js,
    /_v\.length === 1 \? _v\[0\] : \(_i < _v\.length \? _v\[_i\] : null\)/,
  );
  assert.match(
    py,
    /_v\[0\] if len\(_v\) == 1 else \(_v\[_i\] if _i < len\(_v\) else None\)/,
  );
});

test("an element is read the way the extension reads it", () => {
  // An <img> answers with its src and a bare <a> with its href. innerText()
  // for those is the empty string — a grid of images exported as empty cells.
  assert.match(js, /tag === 'img'\) return node\.src/);
  assert.match(py, /FS_READ_JS = """/);
  assert.match(py, /await el\.evaluate\(FS_READ_JS, f\)/);
});

// ── FS-09: scientific notation ───────────────────────────────────────────────

test("a number in scientific notation survives both scripts", async (t) => {
  // runPy spawns an interpreter, so these skip where there is none rather than
  // failing. Linux CI installs Python, so the skip never hides a regression on
  // the runner that gates merges.
  const python = skipWithoutPython(t);
  if (!python) return;
  // scrapethissite.com reports Antarctica's area as "1.4E7". The general
  // numeric pattern stopped at the E and turned fourteen million into 1.4 — a
  // wrong number that looks entirely plausible in a column of areas.
  assert.equal((await runtime()).fsNumber("1.4E7"), 14000000);
  assert.equal(runPy(`print(fs_number("1.4E7"))`).trim(), "14000000");

  // And the things that are not exponents still are not.
  assert.equal((await runtime()).fsNumber("3 EUR"), 3);
  assert.equal(runPy(`print(fs_number("3 EUR"))`).trim(), "3");
});

test("a non-breaking space between thousands is not a separator", async (t) => {
  // runPy spawns an interpreter, so these skip where there is none rather than
  // failing. Linux CI installs Python, so the skip never hides a regression on
  // the runner that gates merges.
  const python = skipWithoutPython(t);
  if (!python) return;
  assert.equal((await runtime()).fsNumber("1 234,56"), 1234.56);
  assert.equal(runPy(`print(fs_number("1\\u00a0234,56"))`).trim(), "1234.56");
});

// ── FS-11: base64 that is not text ───────────────────────────────────────────

test("base64 that decodes to invalid UTF-8 is null, not mangled text", async (t) => {
  // runPy spawns an interpreter, so these skip where there is none rather than
  // failing. Linux CI installs Python, so the skip never hides a regression on
  // the runner that gates merges.
  const python = skipWithoutPython(t);
  if (!python) return;
  // Buffer.toString('utf8') replaces bad bytes with U+FFFD and hands back a
  // string, where the in-page decoder uses { fatal: true } and returns null.
  // A plausible wrong answer is worse than an empty cell.
  assert.equal((await runtime()).fsB64("///+"), null);
  assert.equal(runPy(`print(fs_b64("///+"))`).trim(), "None");
  // Real base64 still decodes in both.
  assert.equal((await runtime()).fsB64("aGVsbG8="), "hello");
  assert.equal(runPy(`print(fs_b64("aGVsbG8="))`).trim(), "hello");
});

// ── FS-10: LOOP max = 0 ──────────────────────────────────────────────────────

test("a LOOP with max 0 runs over every element, as the panel says", () => {
  const unbounded = pipeline([
    {
      type: "LOOP",
      config: { type: "elements", selector: ".row", max: 0 },
      children: [],
    },
  ]);
  const j = emitNode(unbounded);
  const p = emitPython(unbounded);
  // Math.min(len, 0) and elements[:0] both ran the loop zero times.
  assert.match(j, /for \(let i = 0; i < elements\.length; i\+\+\)/);
  assert.match(p, /for i, el in enumerate\(elements\):/);

  const bounded = pipeline([
    {
      type: "LOOP",
      config: { type: "elements", selector: ".row", max: 3 },
      children: [],
    },
  ]);
  assert.match(emitNode(bounded), /Math\.min\(elements\.length, 3\)/);
  assert.match(emitPython(bounded), /enumerate\(elements\[:3\]\)/);
});

// ── FS-12: what ASSERT compares ──────────────────────────────────────────────

test("ASSERT and IF_ELSE read textContent, the way the extension does", () => {
  // _stepAssert and _stepIfElse both return el.textContent. innerText drops
  // whatever CSS has hidden, so an assertion could pass in the panel and fail
  // in the script, with neither able to explain why.
  assert.match(
    js,
    /fsTrim\(await loc\.first\(\)\.evaluate\(n => n\.textContent\)\)/,
  );
  assert.match(py, /fs_trim\(await loc\.first\.text_content\(\)\)/);
  assert.ok(!/loc\.first\(\)\.innerText\(\)/.test(js));
  assert.ok(!/loc\.first\.inner_text\(\)/.test(py));
});

// ── and both files are still programs ────────────────────────────────────────

test("the generated files parse", (t) => {
  const jsFile = join(dir, "run.mjs");
  writeFileSync(jsFile, js);
  execFileSync(process.execPath, ["--check", jsFile]);
  const pyFile = join(dir, "run.py");
  writeFileSync(pyFile, py);
  // Python is an optional test dependency. Skipped rather than failed when
  // it is absent, and skipped visibly rather than passing quietly.
  const python = skipWithoutPython(t);
  if (!python) return;
  execFileSync(python, ["-m", "py_compile", pyFile]);
});
