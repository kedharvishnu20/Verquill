// Regression tests for audit findings B-11 and B-22.
//
// B-11: _resolveConfig mapped only the top-level string values of step.config.
// _resolveAny, which recurses, existed but was used for API headers alone. So
// {{item.href}} inside FILL.fields[].value, or inside an EXTRACT field, reached
// the page verbatim and got typed into the form as the literal text
// "{{item.href}}". docs/JinjaTemplateGuide.md §3 says nested resolution works.
// EXTRACT selectors survived by accident — injector.js re-renders those from
// __vqContext — which is why this went unnoticed.
//
// B-22: LOOP max:0 means "every match" in elements mode, which the UI says and
// the code did. In count and paginate mode the same 0 ran the body zero times
// and reported nothing at all.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  _executeSteps,
  _resolveStr,
  startRun,
  endRun,
  calls,
  reset,
  onContentMessage,
} from "./helpers/worker-harness.mjs";

const swSrc = await readFile(
  new URL("../background/service-worker.js", import.meta.url),
  "utf8",
);
const panelSrc = await readFile(
  new URL("../sidepanel/pipeline-builder.js", import.meta.url),
  "utf8",
);

const plain = (v) => JSON.parse(JSON.stringify(v));
const sent = () => calls.contentMessages.map((m) => m.payload);

test.beforeEach(() => {
  reset();
  onContentMessage(() => ({ ok: true, result: null }));
});

// ── B-11: nested templates ───────────────────────────────────────────────────

test("a template inside FILL.fields[] is resolved", async () => {
  const { runId } = startRun();
  await _executeSteps(
    [
      {
        id: "f",
        type: "FILL",
        config: {
          mode: "multi",
          fields: [
            { selector: "#name", value: "{{item.text}}" },
            { selector: "#url", value: "{{item.href}}" },
          ],
        },
      },
    ],
    1,
    runId,
    { item: { text: "Widget", href: "https://shop.test/w" }, extracted: {} },
  );

  const fill = sent().find((p) => p.type === "FILL");
  assert.deepEqual(plain(fill.config.fields), [
    { selector: "#name", value: "Widget" },
    { selector: "#url", value: "https://shop.test/w" },
  ]);
  await endRun(runId);
});

test("templates resolve at any depth, not just one level down", async () => {
  const { runId } = startRun();
  await _executeSteps(
    [
      {
        id: "e",
        type: "EXTRACT",
        config: {
          fields: [
            { name: "t", selector: ".p-{{loop.index}} .title", attribute: "" },
          ],
          nested: { deep: { deeper: "{{loop.index}}" } },
        },
      },
    ],
    1,
    runId,
    { loop: { index: 3 }, extracted: {} },
  );

  const step = sent().find((p) => p.type === "EXTRACT");
  assert.equal(step.config.fields[0].selector, ".p-3 .title");
  assert.equal(step.config.nested.deep.deeper, "3");
  await endRun(runId);
});

test("top-level strings still resolve, and non-strings are left alone", async () => {
  const { runId } = startRun();
  await _executeSteps(
    [
      {
        id: "c",
        type: "CLICK",
        config: { selector: ".row-{{loop.index}}", all: false, retries: 3 },
      },
    ],
    1,
    runId,
    { loop: { index: 2 }, extracted: {} },
  );
  const step = sent().find((p) => p.type === "CLICK");
  assert.equal(step.config.selector, ".row-2");
  assert.equal(step.config.all, false, "a boolean survives as a boolean");
  assert.equal(step.config.retries, 3, "and a number as a number");
  await endRun(runId);
});

test("an unknown path resolves to empty rather than leaving the braces", () => {
  assert.equal(
    _resolveStr("a-{{nope.missing}}-b", { loop: { index: 1 } }),
    "a--b",
  );
  assert.equal(_resolveStr("no braces here", {}), "no braces here");
});

test("_resolveConfig recurses instead of mapping one level", () => {
  const fn = swSrc.match(
    /function _resolveConfig\(step, ctx\) \{[\s\S]*?\n\}/,
  )[0];
  assert.match(fn, /_resolveAny\(step\.config/);
  assert.ok(
    !/typeof v === "string" \? _resolveStr/.test(fn),
    "the top-level-only map is gone",
  );
});

// ── B-22: loop bounds ────────────────────────────────────────────────────────

async function runLoop(config, children, responder) {
  const { runId } = startRun();
  if (responder) onContentMessage(responder);
  let error = null;
  try {
    await _executeSteps(
      [{ id: "L", type: "LOOP", config, children }],
      1,
      runId,
      { extracted: {} },
    );
  } catch (e) {
    error = e;
  }
  const bodyRuns = sent().filter((p) => p.type === "CLICK").length;
  await endRun(runId);
  return { bodyRuns, error };
}

const body = [{ id: "b", type: "CLICK", config: { selector: ".x" } }];

test("count mode with max 0 fails loudly instead of running nothing", async () => {
  const { bodyRuns, error } = await runLoop({ type: "count", max: 0 }, body);
  assert.equal(bodyRuns, 0);
  assert.match(error.message, /at least 1/, "it used to skip silently");
  assert.match(error.message, /elements/, "and it says where 0 does work");
});

test("count mode runs exactly max times", async () => {
  assert.equal((await runLoop({ type: "count", max: 3 }, body)).bodyRuns, 3);
});

test("elements mode with max 0 means every match, as the UI says", async () => {
  const { bodyRuns } = await runLoop(
    { type: "elements", selector: ".card", max: 0 },
    body,
    (p) =>
      p.type === "QUERY_ELEMENTS"
        ? {
            ok: true,
            result: [{ index: 1 }, { index: 2 }, { index: 3 }, { index: 4 }],
          }
        : { ok: true, result: null },
  );
  assert.equal(bodyRuns, 4);
});

test("elements mode still honours a positive safety max", async () => {
  const { bodyRuns } = await runLoop(
    { type: "elements", selector: ".card", max: 2 },
    body,
    (p) =>
      p.type === "QUERY_ELEMENTS"
        ? { ok: true, result: [{}, {}, {}, {}, {}] }
        : { ok: true, result: null },
  );
  assert.equal(bodyRuns, 2);
});

test("a failed element query skips the loop instead of running it blind", async () => {
  // It used to fall through with iters still set to max and no element data,
  // running the body N times against empty items.
  const { bodyRuns, error } = await runLoop(
    { type: "elements", selector: ".card", max: 5 },
    body,
    (p) => {
      if (p.type === "QUERY_ELEMENTS") throw new Error("page went away");
      return { ok: true, result: null };
    },
  );
  assert.equal(bodyRuns, 0);
  assert.equal(error, null, "a missing list is a skip, not a run failure");
});

test("no matches skips the loop", async () => {
  const { bodyRuns } = await runLoop(
    { type: "elements", selector: ".card", max: 0 },
    body,
    (p) =>
      p.type === "QUERY_ELEMENTS"
        ? { ok: true, result: [] }
        : { ok: true, result: null },
  );
  assert.equal(bodyRuns, 0);
});

test("there is a hard ceiling on iterations", () => {
  const fn = swSrc.match(/async function _executeLoop\([\s\S]*?\n\}\n/)[0];
  assert.match(swSrc, /const LOOP_HARD_CAP = 10000;/);
  assert.match(fn, /iters > LOOP_HARD_CAP/);
  assert.match(fn, /exceeds the \$\{LOOP_HARD_CAP\} cap/, "and it says so");
});

test("the loop body sees item and loop context", async () => {
  const { runId } = startRun();
  onContentMessage((p) =>
    p.type === "QUERY_ELEMENTS"
      ? { ok: true, result: [{ href: "/a" }, { href: "/b" }] }
      : { ok: true, result: null },
  );
  await _executeSteps(
    [
      {
        id: "L",
        type: "LOOP",
        config: { type: "elements", selector: ".c", max: 0 },
        children: [
          {
            id: "b",
            type: "CLICK",
            config: { selector: "a[href='{{item.href}}']" },
          },
        ],
      },
    ],
    1,
    runId,
    { extracted: {} },
  );
  const clicks = sent().filter((p) => p.type === "CLICK");
  assert.deepEqual(
    clicks.map((c) => c.config.selector),
    ["a[href='/a']", "a[href='/b']"],
  );
  await endRun(runId);
});

// ── the panel side of B-22 ───────────────────────────────────────────────────

test("switching a loop to count mode does not carry 0 across", () => {
  const fn = panelSrc.match(
    /function _normalizeStepConfig\(step, changedKey\) \{[\s\S]*?\n\}/,
  )[0];
  // The guard grew a second exempt mode when `list` arrived — it takes its
  // bound from the list the same way `elements` takes it from the matches — so
  // the assertions name what has to hold rather than one spelling of it.
  assert.match(fn, /!\(step\.config\.max > 0\)/, `no max guard: ${fn}`);
  assert.match(fn, /"elements"/, `elements is no longer exempt: ${fn}`);
  assert.match(fn, /"list"/, `list must be exempt too: ${fn}`);
  assert.match(fn, /step\.config\.max = 10/);
  assert.match(
    panelSrc,
    /_normalizeStepConfig\(step, key\);/,
    "and it is called",
  );
});

test("the two modes are labelled differently", () => {
  assert.match(panelSrc, /"Safety max \(0 = every match\)"/);
  assert.match(panelSrc, /"Repeat N times \(at least 1\)"/);
  assert.ok(
    !/0 = unlimited/.test(panelSrc),
    "the old label promised something count mode never did",
  );
});
