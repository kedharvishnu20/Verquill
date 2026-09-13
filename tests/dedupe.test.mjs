// DEDUPE — dropping rows the run already has.
//
// Duplicate rows are the normal outcome of scraping, not an exotic one: a
// paginator that repeats its last page, a feed re-rendering what is on screen,
// a run repeated tomorrow over a list that has moved on by three items. The
// file ends up with the same record several times and nothing says so.
import test from "node:test";
import assert from "node:assert/strict";
import {
  reset,
  startRun,
  endRun,
  onContentMessage,
  _executeStepList,
} from "./helpers/worker-harness.mjs";
import {
  rowKey,
  parseFields,
  filterRows,
  SeenKeys,
} from "../utils/row-dedupe.js";
import { emitNode } from "../script-gen/node-emitter.js";
import { emitPython } from "../script-gen/python-emitter.js";
import { skipWithoutPython } from "./helpers/python.mjs";

const ctx = () => ({ extracted: {} });
const step = (type, config = {}, extra = {}) => ({
  id: Math.random().toString(36).slice(2),
  type,
  config,
  ...extra,
});

// ── What counts as the same row ──────────────────────────────────────────────

test("a row is identified by the fields you name, not by all of them", () => {
  // Two readings of one product differ by a stock count that moved between
  // page loads. Whole-row equality would call them different rows, which is
  // the failure that makes people stop trusting dedupe.
  const a = { url: "/p/1", title: "Widget", stock: "3 left" };
  const b = { url: "/p/1", title: "Widget", stock: "2 left" };
  assert.equal(rowKey(a, ["url"]), rowKey(b, ["url"]));
  assert.notEqual(rowKey(a), rowKey(b));
});

test("values are compared the way a person compares them", () => {
  assert.equal(
    rowKey({ t: "  Blue   Widget " }, ["t"]),
    rowKey({ t: "blue widget" }, ["t"]),
  );
});

test("a missing field and an empty one are different facts", () => {
  assert.notEqual(rowKey({ a: null }, ["a"]), rowKey({ a: "" }, ["a"]));
  assert.notEqual(rowKey({}, ["a"]), rowKey({ a: "" }, ["a"]));
});

test("two fields cannot run together into one key", () => {
  // ["ab", "c"] and ["a", "bc"] joined with nothing are the same string, and
  // the second row would be dropped as a duplicate it never was.
  assert.notEqual(
    rowKey({ a: "ab", b: "c" }, ["a", "b"]),
    rowKey({ a: "a", b: "bc" }, ["a", "b"]),
  );
});

test("field lists are read the way people type them", () => {
  assert.deepEqual(parseFields(" url , title ,, "), ["url", "title"]);
  assert.deepEqual(parseFields(""), []);
});

// ── The bound ────────────────────────────────────────────────────────────────

test("the seen-set forgets its oldest keys rather than growing forever", () => {
  const seen = new SeenKeys(3);
  for (const k of ["a", "b", "c", "d"]) seen.add(k);
  assert.equal(seen.size, 3);
  assert.equal(seen.has("a"), false, "the oldest should have gone");
  assert.equal(seen.has("d"), true);
  assert.equal(seen.forgotten, 1);
});

test("duplicates inside one batch count too", () => {
  // A page that lists the same product twice is a duplicate the moment it is
  // read, not on the next page.
  const { kept, dropped } = filterRows(
    [{ u: "1" }, { u: "2" }, { u: "1" }],
    new SeenKeys(),
    ["u"],
  );
  assert.equal(kept.length, 2);
  assert.equal(dropped, 1);
});

// ── In a run ─────────────────────────────────────────────────────────────────

/** Three pages where page 3 repeats page 2 — a paginator that has run out. */
function pagesThatRepeat() {
  let page = 0;
  onContentMessage((payload) => {
    if (payload.type === "EXTRACT") {
      page++;
      const n = page >= 3 ? 2 : page;
      return { ok: true, result: [{ url: `/p/${n}a` }, { url: `/p/${n}b` }] };
    }
    return { ok: true, result: [] };
  });
}

test("a run with DEDUPE keeps only what it has not seen", async () => {
  reset();
  const { runId, runState } = startRun();
  pagesThatRepeat();

  await _executeStepList(
    [
      step("DEDUPE", { fields: "url", scope: "run" }),
      step(
        "LOOP",
        { type: "count", max: 3 },
        { children: [step("EXTRACT", { fields: [] })] },
      ),
    ],
    1,
    runId,
    ctx(),
  );

  // Six rows read, four distinct.
  assert.equal(runState.results.length, 4);
  assert.equal(runState.dedupe.dropped, 2);
  await endRun(runId);
});

test("without the step nothing is dropped", async () => {
  reset();
  const { runId, runState } = startRun();
  pagesThatRepeat();

  await _executeStepList(
    [
      step(
        "LOOP",
        { type: "count", max: 3 },
        { children: [step("EXTRACT", { fields: [] })] },
      ),
    ],
    1,
    runId,
    ctx(),
  );
  assert.equal(runState.results.length, 6);
  await endRun(runId);
});

test("rows collected before the step are not checked", async () => {
  // It is a gate, not a filter over what came before: those rows are already
  // written, and pretending otherwise would be the lie.
  reset();
  const { runId, runState } = startRun();
  pagesThatRepeat();

  await _executeStepList(
    [
      step("EXTRACT", { fields: [] }),
      step("EXTRACT", { fields: [] }),
      step("DEDUPE", { fields: "url" }),
      step("EXTRACT", { fields: [] }), // page 3 repeats page 2
      step("EXTRACT", { fields: [] }),
    ],
    1,
    runId,
    ctx(),
  );
  // 4 before the gate (both pages kept, duplicates or not), then page 3 and 4
  // are checked against each other only.
  assert.equal(runState.results.length, 6);
  await endRun(runId);
});

// ── The exported script ──────────────────────────────────────────────────────

const pipeline = (steps) => ({
  name: "t",
  targetOrigin: "https://x.test",
  steps: steps.map((s, i) => ({ id: `s${i}`, ...s })),
});

const WITH_DEDUPE = pipeline([
  { type: "DEDUPE", config: { fields: "url", scope: "forever", limit: 500 } },
  { type: "EXTRACT", config: { fields: [{ name: "url", selector: "a" }] } },
  { type: "EXPORT", config: { format: "csv" } },
]);

test("the exported script carries the same gate", () => {
  for (const src of [emitNode(WITH_DEDUPE), emitPython(WITH_DEDUPE)]) {
    assert.match(src, /500/);
    assert.match(src, /url/);
  }
  assert.match(emitNode(WITH_DEDUPE), /vqCollect\(row\)/);
  assert.match(emitPython(WITH_DEDUPE), /vq_collect\(row\)/);
});

test("'across runs' becomes a file the script reads and rewrites", () => {
  assert.match(emitNode(WITH_DEDUPE), /VQ_SEEN_FILE/);
  assert.match(emitPython(WITH_DEDUPE), /VQ_SEEN_FILE/);
  // And a run-scoped one does not touch the disk.
  const runScoped = pipeline([
    { type: "DEDUPE", config: { fields: "url", scope: "run" } },
  ]);
  assert.ok(!/VQ_SEEN_FILE/.test(emitNode(runScoped)));
  assert.ok(!/VQ_SEEN_FILE/.test(emitPython(runScoped)));
});

test("both generated scripts are still programs", async (t) => {
  const { execFileSync } = await import("node:child_process");
  const { writeFileSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "vq-dedupe-"));

  const jsFile = join(dir, "run.mjs");
  writeFileSync(jsFile, emitNode(WITH_DEDUPE));
  execFileSync(process.execPath, ["--check", jsFile]);

  const pyFile = join(dir, "run.py");
  writeFileSync(pyFile, emitPython(WITH_DEDUPE));
  // Python is an optional test dependency. Skipped rather than failed when
  // it is absent, and skipped visibly rather than passing quietly.
  const python = skipWithoutPython(t);
  if (!python) return;
  execFileSync(python, ["-m", "py_compile", pyFile]);
});
