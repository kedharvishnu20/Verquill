// The AI paying for itself once instead of every run.
//
// Every other AI scraper charges per page, forever, because the model is in
// the loop on every page. It does not have to be. Ask the model for a **CSS
// selector** alongside each value, check the selector in the page, and keep it
// only if it produces the value the model reported — then the pipeline can
// scrape that site deterministically, for free, with no model involved at all.
//
// The check is what makes this honest rather than a second guess stacked on
// the first. A model asked for a selector will always produce one; most of
// them are wrong. But a wrong selector is *detectable* — run it, and it gives
// nothing, or something else. So a selector that survives has been tested
// against the page, and one that does not is dropped without a word, which is
// no worse than never having asked.
//
// The payoff is the project's existing story applied to AI: AUTO_EXTRACT
// cannot be exported to a Playwright script, because the first two layers are
// an in-page extractor with no standalone equivalent and the third needs a
// model the script has no configuration for. An EXTRACT step can. So the step
// stays unexportable and its *output* is a step that is not.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import * as learning from "../utils/selector-learning.js";
import { STEP_TYPES } from "../utils/step-types.js";

const {
  judgeSelectors,
  toExtractStep,
  isFragile,
  VERIFIED,
  WRONG_VALUE,
  NOT_FOUND,
  AMBIGUOUS,
  BAD_SELECTOR,
} = learning;

/**
 * Stand in for the page.
 *
 * The real one runs `querySelectorAll` in the tab. The judgement is here so it
 * can be tested without a browser, and so the page — which cannot import a
 * module — has nothing to decide.
 */
const probeFrom = (map) => (selector) => {
  const entry = map[selector];
  if (entry === undefined) return { count: 0, text: null };
  if (entry === "throw") return { error: "not a valid selector" };
  if (Array.isArray(entry)) return { count: entry.length, text: entry[0] };
  return { count: 1, text: entry };
};

// ── Keeping the ones that work ───────────────────────────────────────────────

test("a selector that produces the reported value is kept", () => {
  const out = judgeSelectors({
    selectors: { name: "h1.product-title" },
    values: { name: "Blue Widget" },
    probe: probeFrom({ "h1.product-title": "Blue Widget" }),
  });
  assert.equal(out.verified.name, "h1.product-title");
  assert.equal(out.how.name, VERIFIED);
});

test("the page's own whitespace is not a mismatch", () => {
  // Markup is full of it, and a model answering "Blue Widget" for a heading
  // written across three lines is right.
  const out = judgeSelectors({
    selectors: { name: "h1" },
    values: { name: "Blue Widget" },
    probe: probeFrom({ h1: "\n   Blue   Widget\n " }),
  });
  assert.equal(out.how.name, VERIFIED);
});

// ── Dropping the ones that do not ────────────────────────────────────────────

test("a selector pointing at the wrong thing is discarded", () => {
  // The failure this exists to catch. Saved unchecked, it would produce a
  // pipeline that runs, reports success, and fills a column with the site's
  // navigation.
  const out = judgeSelectors({
    selectors: { name: "nav a" },
    values: { name: "Blue Widget" },
    probe: probeFrom({ "nav a": "Home" }),
  });
  assert.equal(out.verified.name, undefined);
  assert.equal(out.how.name, WRONG_VALUE);
});

test("a selector that finds nothing is discarded", () => {
  const out = judgeSelectors({
    selectors: { name: ".product__title" },
    values: { name: "Blue Widget" },
    probe: probeFrom({}),
  });
  assert.equal(out.how.name, NOT_FOUND);
});

test("a selector that is not valid CSS is discarded, not thrown", () => {
  // A model will occasionally answer with something that is not a selector at
  // all. That is a dropped field, never a failed run.
  const out = judgeSelectors({
    selectors: { name: "h1[" },
    values: { name: "Blue Widget" },
    probe: probeFrom({ "h1[": "throw" }),
  });
  assert.equal(out.how.name, BAD_SELECTOR);
  assert.deepEqual(out.verified, {});
});

test("a selector matching twelve elements is not this field's selector", () => {
  // AUTO_EXTRACT reads one page as one row. A selector matching every card on
  // a listing happens to contain the right text in its first match and is
  // still the wrong answer — saved, it would produce twelve values in a column
  // built for one.
  const out = judgeSelectors({
    selectors: { name: ".card h3" },
    values: { name: "Blue Widget" },
    probe: probeFrom({ ".card h3": Array(12).fill("Blue Widget") }),
  });
  assert.equal(out.how.name, AMBIGUOUS);
  assert.equal(out.verified.name, undefined);
});

test("a field with no value to check against gets no selector", () => {
  // Includes every field grounding dropped. A selector "verified" against a
  // value the model invented has been checked against nothing.
  const out = judgeSelectors({
    selectors: { name: "h1", ghost: ".made-up" },
    values: { name: "Blue Widget", ghost: null },
    probe: probeFrom({ h1: "Blue Widget", ".made-up": "anything" }),
  });
  assert.equal(out.verified.ghost, undefined);
  assert.ok(
    !("ghost" in out.how),
    "a field with nothing to prove is not judged",
  );
});

// ── Saying which ones will not last ──────────────────────────────────────────

test("a selector that is only a position is kept, and marked", () => {
  // It verifies today and breaks when the site adds a banner. Dropping it
  // would throw away a working selector; saying nothing would hand over a
  // fragile one as though it were solid.
  assert.equal(
    isFragile("body > div:nth-child(7) > div:nth-child(3) > span"),
    true,
  );
  assert.equal(isFragile("div > div > div > span"), true);
  assert.equal(isFragile("h1.product-title"), false);
  assert.equal(isFragile("#price"), false);
  assert.equal(isFragile('[itemprop="price"]'), false);

  const out = judgeSelectors({
    selectors: { name: "div > div > div > span" },
    values: { name: "Blue Widget" },
    probe: probeFrom({ "div > div > div > span": "Blue Widget" }),
  });
  assert.equal(out.verified.name, "div > div > div > span");
  assert.equal(out.fragile.includes("name"), true);
});

// ── What comes out of it ─────────────────────────────────────────────────────

test("verified selectors become a step the pipeline can actually run", () => {
  const step = toExtractStep({ name: "h1.title", price: ".price" });
  assert.equal(step.type, "EXTRACT");
  assert.deepEqual(step.config.fields, [
    { name: "name", selector: "h1.title", type: "text" },
    { name: "price", selector: ".price", type: "text" },
  ]);
  // The shape EXTRACT actually reads, not one invented for this.
  for (const key of Object.keys(STEP_TYPES.EXTRACT.def)) {
    assert.ok(key in step.config, `EXTRACT expects ${key}`);
  }
});

test("nothing verified means no step, rather than an empty one", () => {
  assert.equal(toExtractStep({}), null);
});

test("the step it produces is exportable, which is the whole point", () => {
  // AUTO_EXTRACT cannot become a Playwright script: two of its layers are an
  // in-page extractor and the third needs a model the script has no
  // configuration for. EXTRACT can. So the AI is paid for once and the site is
  // scraped for free after that — in this extension or outside it.
  assert.equal(STEP_TYPES.AUTO_EXTRACT.exportable, false);
  assert.notEqual(STEP_TYPES.EXTRACT.exportable, false);
});

// ── Wiring ───────────────────────────────────────────────────────────────────

test("the model is asked for selectors, and told what a good one is", () => {
  const src = readFileSync(
    new URL("../background/llm-extractor.js", import.meta.url),
    "utf8",
  );
  assert.match(src, /"selectors"/);
  assert.match(
    src,
    /stable/i,
    "asking for any selector gets nth-child chains that break next week",
  );
});

test("the page is asked to run them, and the worker decides", () => {
  const injector = readFileSync(
    new URL("../content/injector.js", import.meta.url),
    "utf8",
  );
  // The page reads the DOM; the judging is in the worker, where the module
  // lives. Same split as IF_ELSE and ASSERT.
  assert.match(injector, /VQ_PROBE_SELECTORS/);
  const worker = readFileSync(
    new URL("../background/service-worker.js", import.meta.url),
    "utf8",
  );
  assert.match(worker, /judgeSelectors\(/);
  assert.match(worker, /VQ_PROBE_SELECTORS/);
});

test("the probe is not sent down the step path, which rewrites its type", () => {
  // Found in the browser, invisible to every unit test here: `_sendToPage`
  // sets the outer type to "step:execute" because everything it carries is a
  // step. A probe sent through it arrives as a step of type
  // VQ_PROBE_SELECTORS, the page rejects it, and the whole feature does
  // nothing at all — quietly, because a probe that fails is meant to be a
  // dropped selector rather than a failed run.
  const worker = readFileSync(
    new URL("../background/service-worker.js", import.meta.url),
    "utf8",
  );
  const fn = worker.match(/async function _learnSelectors\([\s\S]*?\n\}/)?.[0];
  assert.ok(fn, "the helper should exist");
  assert.ok(!/_sendToPage\(/.test(fn), "it is back on the step path");
  assert.match(fn, /_ensureInjected\(/, "the script still has to be there");
  assert.match(
    fn,
    /probe-failed/,
    "a probe that could not run must at least say so",
  );
});

test("the panel offers the step rather than adding it behind your back", () => {
  const panel = readFileSync(
    new URL("../sidepanel/pipeline-builder.js", import.meta.url),
    "utf8",
  );
  assert.match(panel, /pipeline:selectors/);
  // A step appearing in a pipeline nobody added is worse than not offering it.
  assert.match(panel, /learned-selectors/);
});

test("the step can be told not to ask", () => {
  assert.equal(STEP_TYPES.AUTO_EXTRACT.def.learnSelectors, true);
});
