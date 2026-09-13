// IF_ELSE comparing one element against another.
//
// "Only take it if the sale price is under the list price" cannot be written as
// a literal, because the literal is different on every row. That was the whole
// gap: a condition could test one selector against a value you typed, and
// nothing else. Comparing against a value stored earlier in the run already
// worked — `{{extracted.field}}` is resolved before the step runs — so what was
// missing was the second element.
//
// Three things have to hold, and each has a way of going quietly wrong.
//
// Both sides must be read in the same message. Two round trips would read them
// at two moments, and on a page that updates itself that is a comparison
// between two states rather than between two elements.
//
// Both sides must be read by the same reader. "£1,299.00" is 1299 on the left,
// so it must be 1299 on the right too — `Number("£1,299.00")` is NaN, and a
// comparison that refuses half its own inputs is worse than one that does not
// exist.
//
// A missing right-hand side must not read as a match. `vqTrim(null)` is the
// empty string, so without a guard an empty left side "equals" an element that
// is not there at all.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { loadInjector } from "./helpers/content-harness.mjs";
// A namespace import, not a named one: a named import of an export that does
// not exist yet is a link-time error, which would abort the whole file rather
// than fail the tests that depend on it — and a fail-first check that reports
// one error instead of fifteen failures proves nothing.
import * as conditions from "../utils/conditions.js";
const { evaluateCondition } = conditions;
const COMPARABLE_CONDITIONS = conditions.COMPARABLE_CONDITIONS ?? [];
import { STEP_TYPES } from "../utils/step-types.js";
import { emitNode } from "../script-gen/node-emitter.js";
import { emitPython } from "../script-gen/python-emitter.js";
import {
  calls,
  reset,
  startRun,
  endRun,
  onContentMessage,
  _dispatchStep,
} from "./helpers/worker-harness.mjs";

/** What `evaluateCondition` sees when the page reported both elements. */
const seen = (text, otherText, over = {}) => ({
  exists: true,
  text,
  attrValue: null,
  other: { exists: true, text: otherText, attrValue: null },
  ...over,
});

const against = (config) => ({ compareTo: "selector", ...config });

// ── The step's shape ─────────────────────────────────────────────────────────

test("IF_ELSE carries which side it is comparing against", () => {
  const def = STEP_TYPES.IF_ELSE.def;
  assert.equal(def.compareTo, "value", "the default must not change behaviour");
  assert.ok("valueSelector" in def);
});

test("only the conditions with a right-hand side offer the choice", () => {
  assert.ok(COMPARABLE_CONDITIONS.includes("number-lt"));
  assert.ok(COMPARABLE_CONDITIONS.includes("text-equals"));
  assert.ok(
    !COMPARABLE_CONDITIONS.includes("exists"),
    "a control that changes nothing is worse than no control",
  );
  assert.ok(!COMPARABLE_CONDITIONS.includes("attr-exists"));
});

// ── Deciding ─────────────────────────────────────────────────────────────────

test("a number is compared against the number in the other element", () => {
  assert.equal(
    evaluateCondition("number-lt", seen("£40", "£50"), against({})),
    true,
  );
  assert.equal(
    evaluateCondition("number-lt", seen("£60", "£50"), against({})),
    false,
  );
});

test("the right-hand side is read the way a page writes a number", () => {
  // The point of the whole exercise: Number("£1,299.00") is NaN, so a
  // comparison built on it would refuse every real price on the page.
  assert.equal(
    evaluateCondition("number-lt", seen("£999.00", "£1,299.00"), against({})),
    true,
  );
});

test("text with no number in it does not become zero", () => {
  assert.equal(
    evaluateCondition("number-lt", seen("£40", "Out of stock"), against({})),
    false,
    '"Out of stock" as 0 would make everything "not less than" it',
  );
  assert.equal(
    evaluateCondition("number-gt", seen("£40", "Out of stock"), against({})),
    false,
  );
});

test("text is compared against the other element's text", () => {
  assert.equal(
    evaluateCondition(
      "text-equals",
      seen(" In stock ", "In  stock"),
      against({}),
    ),
    true,
    "both sides are normalised, or real markup never matches",
  );
  assert.equal(
    evaluateCondition(
      "text-contains",
      seen("Blue Widget", "Widget"),
      against({}),
    ),
    true,
  );
});

test("an attribute is compared against the other element's same attribute", () => {
  const observed = {
    exists: true,
    text: "",
    attrValue: "/p/9",
    other: { exists: true, text: "", attrValue: "/p/9" },
  };
  assert.equal(
    evaluateCondition("attr-equals", observed, against({ attr: "href" })),
    true,
  );
});

test("a missing right-hand side is not a match, however empty the left side is", () => {
  const observed = {
    exists: true,
    text: "",
    attrValue: null,
    other: { exists: false, text: "", attrValue: null },
  };
  assert.equal(
    evaluateCondition("text-equals", observed, against({})),
    false,
    "an empty element must not equal an element that is not there",
  );
  assert.equal(evaluateCondition("number-lt", observed, against({})), false);
});

test("comparing against a value still works exactly as it did", () => {
  const observed = { exists: true, text: "£40", attrValue: null };
  assert.equal(evaluateCondition("number-lt", observed, { value: "50" }), true);
  assert.equal(
    evaluateCondition("number-lt", observed, { value: "30" }),
    false,
  );
});

// ── What the page reports ────────────────────────────────────────────────────

test("the page reads both elements, in one message", async () => {
  const h = await loadInjector(
    `<div class="sale">£40</div><div class="list">£50</div>`,
  );
  const out = await h.api._stepIfElse({
    selector: ".sale",
    compareTo: "selector",
    valueSelector: ".list",
  });
  assert.equal(out.text.trim(), "£40");
  assert.equal(out.other.exists, true);
  assert.equal(out.other.text.trim(), "£50");
  h.close();
});

test("the page reports the other element as missing rather than omitting it", async () => {
  const h = await loadInjector(`<div class="sale">£40</div>`);
  const out = await h.api._stepIfElse({
    selector: ".sale",
    compareTo: "selector",
    valueSelector: ".list",
  });
  assert.equal(out.other.exists, false);
  h.close();
});

test("a branch comparing against a value asks for nothing extra", async () => {
  const h = await loadInjector(`<div class="sale">£40</div>`);
  const out = await h.api._stepIfElse({ selector: ".sale" });
  assert.equal(out.other, null, "reading a second element nobody asked about");
  h.close();
});

// ── What the run says when the comparison cannot be made ─────────────────────

test("a missing comparison element is said out loud, not silently ELSE", async () => {
  reset();
  onContentMessage(() => ({
    ok: true,
    result: {
      exists: true,
      text: "£40",
      attrValue: null,
      other: { exists: false, text: "", attrValue: null },
    },
  }));
  const { runId } = startRun();
  await _dispatchStep(
    {
      id: "b",
      type: "IF_ELSE",
      config: {
        condition: "number-lt",
        selector: ".sale",
        compareTo: "selector",
        valueSelector: ".list",
      },
      ifBranch: [],
      elseBranch: [],
    },
    1,
    runId,
    { extracted: {} },
  );
  const warned = calls.runtimeMessages.some((m) =>
    String(m?.payload?.message ?? "").includes(".list"),
  );
  assert.ok(
    warned,
    "taking ELSE because a selector matched nothing looks identical to taking ELSE because the price was higher",
  );
  await endRun(runId);
});

// ── What the exported script does ────────────────────────────────────────────

const pipeline = (config) => ({
  name: "two elements",
  steps: [
    {
      id: "b",
      type: "IF_ELSE",
      config: { selector: ".sale", ...config },
      ifBranch: [],
      elseBranch: [],
    },
  ],
});

const both = (condition, over = {}) =>
  pipeline({
    condition,
    compareTo: "selector",
    valueSelector: ".list",
    ...over,
  });

test("the Node script reads the second element before the test", () => {
  const src = emitNode(both("number-lt"));
  assert.match(src, /const _loc2 = page\.locator\('\.list'\);/);
  assert.match(src, /const _rhs = await vqText\(_loc2\);/);
  assert.match(
    src,
    /if \(_rhs !== null &&/,
    "without the guard a missing element compares as an empty string",
  );
  assert.match(
    src,
    /vqNumber\(_rhs\)/,
    "the right-hand side must go through the same number reader as the left",
  );
});

test("the Node script reads the attribute when the condition is about one", () => {
  assert.match(
    emitNode(both("attr-equals", { attr: "href" })),
    /const _rhs = await vqAttr\(_loc2, 'href'\);/,
  );
});

test("the Python script does the same thing", () => {
  const src = emitPython(both("number-lt"));
  assert.match(src, /_loc2 = page\.locator\("\.list"\)/);
  assert.match(src, /_rhs = await vq_text\(_loc2\)/);
  assert.match(src, /if _rhs is not None and/);
  assert.match(src, /vq_number\(_rhs\)/);
});

test("a branch comparing against a value exports exactly as it did", () => {
  const src = emitNode(pipeline({ condition: "number-lt", value: "50" }));
  assert.ok(!src.includes("_loc2"), "a second locator nobody asked for");
  assert.match(src, /50\)/);
});

test("every comparable condition exports rather than refusing", () => {
  for (const condition of COMPARABLE_CONDITIONS) {
    const over = condition.startsWith("attr-") ? { attr: "href" } : {};
    for (const [name, emit] of [
      ["node", emitNode],
      ["python", emitPython],
    ]) {
      const src = emit(both(condition, over));
      assert.ok(
        !src.includes("is not exportable"),
        `${name}: ${condition} against a second element came back stubbed`,
      );
    }
  }
});

// ── The panel ────────────────────────────────────────────────────────────────

test("the side panel offers the choice, or the config is unreachable", () => {
  const src = readFileSync(
    new URL("../sidepanel/pipeline-builder.js", import.meta.url),
    "utf8",
  );
  assert.match(src, /data-key="compareTo"/);
  assert.match(src, /valueSelector/);
});
