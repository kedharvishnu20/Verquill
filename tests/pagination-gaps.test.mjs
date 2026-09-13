// Three ways pagination quietly scraped the same page over and over.
//
// All three share a shape: the run keeps going, produces rows, and finishes
// without an error — while every page after the first is a copy of the first.
// The exporter's dedup used to hide the evidence, which is why these survived.
import test from "node:test";
import assert from "node:assert/strict";
import {
  reset,
  calls,
  startRun,
  endRun,
  onContentMessage,
  openTab,
  _executeStepList,
} from "./helpers/worker-harness.mjs";
import { loadInjector } from "./helpers/content-harness.mjs";
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

// ── VQ-03: a Next link that opens in a new tab ───────────────────────────────

test("the probe reports where Next leads, and whether it opens a tab", async () => {
  const page = await loadInjector(
    `<a class="next" href="/p2" target="_blank">Next</a>`,
  );
  const probe = await page.api._executeStep({
    type: "PAGINATE_PROBE",
    config: { selector: ".next" },
  });
  assert.equal(probe.newTab, true);
  assert.match(probe.href, /\/p2$/);
  page.close();
});

test("an icon wrapped in the link still finds the link", async () => {
  // Sites wrap a chevron or a <span> in the anchor, and the selector usually
  // points at the inner thing.
  const page = await loadInjector(
    `<a href="/p2" target="_blank"><span class="next">›</span></a>`,
  );
  const probe = await page.api._executeStep({
    type: "PAGINATE_PROBE",
    config: { selector: ".next" },
  });
  assert.equal(probe.newTab, true);
  page.close();
});

test("an ordinary same-tab link is not treated as a new tab", async () => {
  const page = await loadInjector(`<a class="next" href="/p2">Next</a>`);
  const probe = await page.api._executeStep({
    type: "PAGINATE_PROBE",
    config: { selector: ".next" },
  });
  assert.equal(probe.newTab, false);
  page.close();
});

test("a new-tab paginator is followed in the run's own tab", async () => {
  reset();
  const { runId } = startRun();
  let clicked = 0;
  onContentMessage((payload) => {
    if (payload.type === "PAGINATE_PROBE") {
      return {
        ok: true,
        result: {
          exhausted: false,
          reason: "",
          fingerprint: "p1",
          href: "https://shop.test/page/2",
          newTab: true,
        },
      };
    }
    if (payload.type === "PAGINATE") {
      clicked++;
      return { ok: true, result: { paginated: true } };
    }
    return { ok: true, result: [] };
  });

  await _executeStepList(
    [
      step(
        "LOOP",
        { type: "paginate", selector: ".next", max: 2, settleMs: 0 },
        { children: [step("EXTRACT", { fields: [] })] },
      ),
    ],
    1,
    runId,
    ctx(),
  );

  // Clicking would have loaded page 2 into a tab nobody is reading, leaving
  // the run to scrape page 1 twice.
  assert.equal(clicked, 0, "it clicked instead of following the href");
  assert.ok(
    calls.tabUpdates.some((u) => u.url === "https://shop.test/page/2"),
    `the run's tab never moved: ${JSON.stringify(calls.tabUpdates)}`,
  );
  await endRun(runId);
});

test("a tab a JavaScript paginator opens is adopted and closed", async () => {
  // window.open() has no anchor to read, so the href check above cannot see it
  // coming. This is the after-the-fact catch.
  reset();
  const { runId } = startRun();
  onContentMessage((payload) => {
    if (payload.type === "PAGINATE_PROBE") {
      return {
        ok: true,
        result: {
          exhausted: false,
          reason: "",
          fingerprint: "p1",
          href: "",
          newTab: false,
        },
      };
    }
    if (payload.type === "PAGINATE") {
      openTab({ id: 99, openerTabId: 1, url: "https://shop.test/page/2" });
      return { ok: true, result: { paginated: true } };
    }
    return { ok: true, result: [] };
  });

  await _executeStepList(
    [
      step(
        "LOOP",
        { type: "paginate", selector: ".next", max: 2, settleMs: 0 },
        { children: [step("EXTRACT", { fields: [] })] },
      ),
    ],
    1,
    runId,
    ctx(),
  );

  assert.ok(
    calls.tabUpdates.some((u) => u.url === "https://shop.test/page/2"),
    "the run stayed on page 1 while page 2 loaded elsewhere",
  );
  assert.ok(calls.tabsRemoved.includes(99), "the opened tab was left behind");
  await endRun(runId);
});

// ── VQ-04: paginate-url runs past the last page ──────────────────────────────

test("a URL-pattern loop stops once a page produces nothing", async () => {
  reset();
  const { runId, runState } = startRun();
  let visited = 0;
  onContentMessage((payload) => {
    if (payload.type === "EXTRACT") {
      visited++;
      // Three real pages, then the site serves an empty list.
      return { ok: true, result: visited <= 3 ? [{ page: visited }] : [] };
    }
    return { ok: true, result: [] };
  });

  await _executeStepList(
    [
      step(
        "LOOP",
        {
          type: "paginate-url",
          urlTemplate: "https://shop.test/list?page={page}",
          max: 20,
          settleMs: 0,
        },
        { children: [step("EXTRACT", { fields: [] })] },
      ),
    ],
    1,
    runId,
    ctx(),
  );

  // It used to fetch all twenty: this mode has nothing to probe, so `max` was
  // the only bound it had.
  assert.equal(runState.results.length, 3);
  assert.equal(
    visited,
    4,
    `visited ${visited} pages; 3 had rows, 1 proved the end`,
  );
  await endRun(runId);
});

test("turning the stop off fetches every page that was asked for", async () => {
  reset();
  const { runId } = startRun();
  let visited = 0;
  onContentMessage((payload) => {
    if (payload.type === "EXTRACT") {
      visited++;
      return { ok: true, result: visited <= 1 ? [{ page: 1 }] : [] };
    }
    return { ok: true, result: [] };
  });

  await _executeStepList(
    [
      step(
        "LOOP",
        {
          type: "paginate-url",
          urlTemplate: "https://shop.test/list?page={page}",
          max: 4,
          settleMs: 0,
          stopWhenEmpty: false,
        },
        { children: [step("EXTRACT", { fields: [] })] },
      ),
    ],
    1,
    runId,
    ctx(),
  );
  assert.equal(visited, 4);
  await endRun(runId);
});

test("a first page with no rows does not end the loop", async () => {
  // A pipeline whose rows come from a later page, or whose first page is
  // genuinely empty, must not be cut off at page one.
  reset();
  const { runId, runState } = startRun();
  let visited = 0;
  onContentMessage((payload) => {
    if (payload.type === "EXTRACT") {
      visited++;
      return { ok: true, result: visited === 1 ? [] : [{ page: visited }] };
    }
    return { ok: true, result: [] };
  });

  await _executeStepList(
    [
      step(
        "LOOP",
        {
          type: "paginate-url",
          urlTemplate: "https://shop.test/list?page={page}",
          max: 3,
          settleMs: 0,
        },
        { children: [step("EXTRACT", { fields: [] })] },
      ),
    ],
    1,
    runId,
    ctx(),
  );
  assert.equal(visited, 3);
  assert.equal(runState.results.length, 2);
  await endRun(runId);
});

// ── VQ-08: the exported script's idea of "last page" ─────────────────────────

const pipeline = (steps) => ({
  name: "t",
  targetOrigin: "https://x.test",
  steps: steps.map((s, i) => ({ id: `s${i}`, ...s })),
});

const PAGINATE = pipeline([
  {
    type: "LOOP",
    config: { type: "paginate", selector: ".next", max: 5 },
    children: [
      {
        id: "e",
        type: "EXTRACT",
        config: { fields: [{ name: "t", selector: ".t" }] },
      },
    ],
  },
]);

test("the exported script knows every way a paginator says 'last page'", () => {
  // It asked only "does it exist and is it enabled", which misses
  // aria-disabled, a disabled class on a <span>, an <a> with no href, and a
  // control the site hides with CSS. The script kept clicking a dead control
  // and re-scraped the final page until the count ran out.
  for (const src of [emitNode(PAGINATE), emitPython(PAGINATE)]) {
    assert.match(src, /aria-disabled/);
    assert.match(src, /is-disabled/);
    assert.match(src, /the Next link has no target/);
    assert.match(src, /visibility === 'hidden'/);
  }
  assert.ok(!/is_enabled\(\)/.test(emitPython(PAGINATE)));
  assert.ok(!/isEnabled\(\)/.test(emitNode(PAGINATE)));
});

test("the exported script follows a new-tab paginator too", () => {
  assert.match(emitNode(PAGINATE), /_st\.newTab && _st\.href/);
  assert.match(emitPython(PAGINATE), /_st\["newTab"\] and _st\["href"\]/);
});

test("the exported URL-pattern loop stops on an empty page", () => {
  const urlLoop = pipeline([
    {
      type: "LOOP",
      config: {
        type: "paginate-url",
        urlTemplate: "https://x.test/l?p={page}",
        max: 20,
      },
      children: [
        {
          id: "e",
          type: "EXTRACT",
          config: { fields: [{ name: "t", selector: ".t" }] },
        },
      ],
    },
  ]);
  assert.match(
    emitNode(urlLoop),
    /_rowsBefore > 0 && vqRows\.length === _rowsBefore/,
  );
  assert.match(
    emitPython(urlLoop),
    /_rows_before > 0 and len\(vq_rows\) == _rows_before/,
  );
});

test("both paginating scripts are still programs", async (t) => {
  // The emitters build source by concatenating strings, and the paginate
  // branches now carry a block of JavaScript inside a Python triple-quote.
  const { execFileSync } = await import("node:child_process");
  const { writeFileSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "vq-page-"));

  const jsFile = join(dir, "run.mjs");
  writeFileSync(jsFile, emitNode(PAGINATE));
  execFileSync(process.execPath, ["--check", jsFile]);

  const pyFile = join(dir, "run.py");
  writeFileSync(pyFile, emitPython(PAGINATE));
  // Python is an optional test dependency. Skipped rather than failed when
  // it is absent, and skipped visibly rather than passing quietly.
  const python = skipWithoutPython(t);
  if (!python) return;
  execFileSync(python, ["-m", "py_compile", pyFile]);
});
