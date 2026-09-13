// EXPORT adding to a dataset instead of writing a new file every run.
//
// "A run per day into one dataset" produced thirty files, and stitching them
// together by hand is where the duplicate rows and the mismatched columns come
// from.
//
// The two halves do it differently, on purpose, and the difference is the thing
// most worth testing.
//
// **The extension cannot append.** `chrome.downloads` writes and never reads,
// so yesterday's file is not something it can open and add to. It keeps the
// rows instead and writes the whole set out again under one name. The file
// grows a run at a time, which is what was wanted; underneath it is a rewrite,
// which is why the panel says so.
//
// **The exported script can append,** and does — but only for a format that can
// take another line. A JSON array has to be reopened to accept an element, so
// an "append" there would leave a file no parser reads. Both halves refuse the
// same three formats, because a pipeline and the script exported from it must
// do the same thing.
import test from "node:test";
import assert from "node:assert/strict";
import * as require$fs from "node:fs";
const { readFileSync, writeFileSync, rmSync, mkdtempSync } = require$fs;
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as formatters from "../exporters/row-formatters.js";
const APPENDABLE_FORMATS = formatters.APPENDABLE_FORMATS ?? [];

import { STEP_TYPES } from "../utils/step-types.js";
import { emitNode } from "../script-gen/node-emitter.js";
import { emitPython } from "../script-gen/python-emitter.js";
import {
  calls,
  reset,
  startRun,
  endRun,
  _dispatchStep,
} from "./helpers/worker-harness.mjs";

const store = await import("../checkpoint/dataset-store.js").catch(() => null);

const exportStep = (config) => ({
  id: "x",
  type: "EXPORT",
  config: { format: "csv", ...config },
});

/** The filename of the last thing the worker downloaded. */
const lastDownload = () => calls.downloads[calls.downloads.length - 1];

/**
 * The EXPORT block out of a generated script, as runnable source.
 *
 * Brace-matched rather than sliced at a guessed marker: the block contains
 * braces of its own, and a slice that ends early produces source that does not
 * parse — which reads as a failure of the emitter rather than of the test.
 */
function exportBlock(src) {
  const start = src.indexOf("{", src.indexOf("// EXPORT →"));
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error("no EXPORT block in the generated script");
}

/** Run one EXPORT block against a real file. */
function runExport(src, file, rows) {
  return new Function(
    "fs",
    "process",
    "vqRows",
    "vqDropped",
    "vqFormatRows",
    "console",
    exportBlock(src),
  )(
    require$fs,
    { env: { VQ_OUT_FILE: file } },
    rows,
    0,
    formatters.formatRows,
    { error() {} },
  );
}

/** The CSV text inside a data: URL the worker handed to chrome.downloads. */
function downloadedText(entry) {
  const b64 = String(entry.url).split(",")[1] ?? "";
  return Buffer.from(b64, "base64")
    .toString("utf8")
    .replace(/^\uFEFF/, "");
}

// ── The step's shape ─────────────────────────────────────────────────────────

test("EXPORT carries an append switch and a dataset name", () => {
  const def = STEP_TYPES.EXPORT.def;
  assert.equal(def.append, false, "the default must not change behaviour");
  assert.ok("dataset" in def);
});

test("only the line-oriented formats can be added to", () => {
  assert.deepEqual([...APPENDABLE_FORMATS].sort(), ["csv", "jsonl", "tsv"]);
  assert.ok(
    !APPENDABLE_FORMATS.includes("json"),
    "a JSON array has to be reopened to take another element",
  );
  assert.ok(!APPENDABLE_FORMATS.includes("xml"));
  assert.ok(!APPENDABLE_FORMATS.includes("markdown"));
});

// ── The store the extension keeps ────────────────────────────────────────────

test("a dataset name is made safe, because it becomes a filename", async (t) => {
  if (!store) return t.skip("dataset-store.js does not exist yet");
  const safe = store.datasetName("../../etc/passwd");
  assert.ok(!safe.includes("/"), `a separator survived: ${safe}`);
  assert.ok(!safe.startsWith("."), `a leading dot survived: ${safe}`);
  assert.match(safe, /passwd/, "made unrecognisable rather than made safe");
  assert.equal(
    store.datasetName(""),
    "default",
    "a blank name is still the behaviour that was asked for, not an error",
  );
});

test("rows survive the run that produced them", async (t) => {
  if (!store) return t.skip("dataset-store.js does not exist yet");
  const name = `t_${Math.random().toString(36).slice(2, 8)}`;
  await store.appendRows(name, [{ a: 1 }, { a: 2 }]);
  await store.appendRows(name, [{ a: 3 }]);
  const rows = await store.readDataset(name);
  assert.deepEqual(
    JSON.parse(JSON.stringify(rows)),
    [{ a: 1 }, { a: 2 }, { a: 3 }],
    "oldest first, so the file reads as a history rather than a shuffle",
  );
  await store.clearDataset(name);
  assert.equal(await store.countRows(name), 0);
});

test("two datasets do not see each other", async (t) => {
  if (!store) return t.skip("dataset-store.js does not exist yet");
  const a = `t_a_${Math.random().toString(36).slice(2, 8)}`;
  const b = `t_b_${Math.random().toString(36).slice(2, 8)}`;
  await store.appendRows(a, [{ x: 1 }]);
  await store.appendRows(b, [{ x: 2 }]);
  assert.deepEqual(JSON.parse(JSON.stringify(await store.readDataset(a))), [
    { x: 1 },
  ]);
  await store.clearDataset(a);
  await store.clearDataset(b);
});

// ── What a run writes ────────────────────────────────────────────────────────

test("a second run writes one file holding both runs' rows", async (t) => {
  if (!store) return t.skip("dataset-store.js does not exist yet");
  const dataset = `t_run_${Math.random().toString(36).slice(2, 8)}`;

  for (const rows of [[{ name: "a" }], [{ name: "b" }]]) {
    reset();
    const { runId, runState } = startRun();
    runState.results.push(...rows);
    await _dispatchStep(exportStep({ append: true, dataset }), 1, runId, {
      extracted: {},
    });
    await endRun(runId);
  }

  const text = downloadedText(lastDownload());
  assert.match(text, /\ba\b/);
  assert.match(
    text,
    /\bb\b/,
    "the second run's file must still hold the first run's rows",
  );
  await store.clearDataset(dataset);
});

test("a growing dataset replaces its file rather than piling up copies", async (t) => {
  if (!store) return t.skip("dataset-store.js does not exist yet");
  const dataset = `t_conf_${Math.random().toString(36).slice(2, 8)}`;
  reset();
  const { runId, runState } = startRun();
  runState.results.push({ a: 1 });
  await _dispatchStep(exportStep({ append: true, dataset }), 1, runId, {
    extracted: {},
  });
  const entry = lastDownload();
  assert.equal(
    entry.conflictAction,
    "overwrite",
    '"dataset (3).csv" beside "dataset (2).csv" is the pile this exists to avoid',
  );
  assert.match(entry.filename, new RegExp(dataset));
  await endRun(runId);
  await store.clearDataset(dataset);
});

test("a plain export is untouched — new file, unique name", async () => {
  reset();
  const { runId, runState } = startRun();
  runState.results.push({ a: 1 });
  await _dispatchStep(exportStep({}), 1, runId, { extracted: {} });
  const entry = lastDownload();
  assert.equal(entry.conflictAction, "uniquify");
  assert.match(entry.filename, /verquill_export_\d+\.csv/);
  await endRun(runId);
});

test("a format that cannot be appended to fails before it writes a broken file", async () => {
  reset();
  const { runId, runState } = startRun();
  runState.results.push({ a: 1 });
  await assert.rejects(
    () =>
      _dispatchStep(
        exportStep({ format: "json", append: true, dataset: "d" }),
        1,
        runId,
        { extracted: {} },
      ),
    /cannot be added to a file a run at a time/i,
  );
  await endRun(runId);
});

// ── What the exported script does, run for real ──────────────────────────────

test("the Node script appends CSV rows without repeating the header", () => {
  const dir = mkdtempSync(join(tmpdir(), "vq-append-"));
  const file = join(dir, "daily.csv");
  try {
    const src = emitNode({
      name: "d",
      steps: [exportStep({ append: true, dataset: "daily" })],
    });
    // Slice out the EXPORT block and run it against a real file, twice — the
    // point of the test is the second write, and pattern-matching the source
    // would not tell us whether the header came out once or twice.
    runExport(src, file, [{ name: "a" }]);
    runExport(src, file, [{ name: "b" }]);
    const out = readFileSync(file, "utf8");
    assert.equal(
      out.split(/\r?\n/).filter((l) => l === "name").length,
      1,
      `the header came out more than once:\n${out}`,
    );
    assert.match(out, /\ba\b/);
    assert.match(out, /\bb\b/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the Node script refuses to append under a header that does not match", () => {
  const dir = mkdtempSync(join(tmpdir(), "vq-append-"));
  const file = join(dir, "daily.csv");
  try {
    writeFileSync(file, "price\r\n10\r\n", "utf8");
    const src = emitNode({
      name: "d",
      steps: [exportStep({ append: true, dataset: "daily" })],
    });
    assert.throws(
      () => runExport(src, file, [{ name: "a" }]),
      /different columns/,
      "rows landing under the wrong headings is silent, and the file looks fine",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the Node script opens the file in append mode for JSONL", () => {
  const src = emitNode({
    name: "d",
    steps: [exportStep({ format: "jsonl", append: true, dataset: "log" })],
  });
  assert.match(src, /fs\.appendFileSync\(_out, _text, 'utf8'\)/);
  assert.match(src, /'log\.jsonl'/);
});

test("the Python script does the same thing", () => {
  const src = emitPython({
    name: "d",
    steps: [exportStep({ append: true, dataset: "daily" })],
  });
  assert.match(src, /_had = os\.path\.exists\(_out\)/);
  assert.match(src, /_head = _lines\[0\]\.rstrip\("\\r"\)/);
  assert.match(src, /different columns/);
  assert.match(src, /open\(_out, "a"/);

  const jsonl = emitPython({
    name: "d",
    steps: [exportStep({ format: "jsonl", append: true })],
  });
  assert.match(jsonl, /open\(_out, "a"/);
  assert.ok(
    !jsonl.includes("_head ="),
    "JSONL has no header to reconcile, so it must not read one",
  );
});

test("both emitters refuse a format that cannot be appended to", () => {
  for (const fmt of ["json", "xml", "markdown"]) {
    assert.match(
      emitNode({
        name: "d",
        steps: [exportStep({ format: fmt, append: true })],
      }),
      /cannot be appended to a file a run at a time/i,
      `node accepted ${fmt}`,
    );
    assert.match(
      emitPython({
        name: "d",
        steps: [exportStep({ format: fmt, append: true })],
      }),
      /cannot be appended to a file a run at a time/i,
      `python accepted ${fmt}`,
    );
  }
});

test("a plain export exports exactly as it did", () => {
  const src = emitNode({ name: "d", steps: [exportStep({})] });
  assert.match(src, /fs\.writeFileSync\(_out, vqFormatRows\(vqRows, 'csv'\)/);
  assert.ok(!src.includes("appendFileSync"));
});

// ── The panel ────────────────────────────────────────────────────────────────

test("the side panel offers it, and says what it really does", () => {
  const src = readFileSync(
    new URL("../sidepanel/pipeline-builder.js", import.meta.url),
    "utf8",
  );
  assert.match(src, /"append",/);
  // Built through the generic `field` helper, so the source names the key
  // rather than spelling out the attribute.
  assert.match(src, /"dataset",\s*\n?\s*"Dataset name"/);
  // The rewrite is the surprising part, so it has to be on screen.
  assert.match(src, /replaced each time rather than added to/i);
});
