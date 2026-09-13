// Regression tests for audit finding B-09, run against a real DOM.
//
// Inside a LOOP, a CLICK whose selector matched nothing fell back to clicking
// the loop item's root element. That is a real pattern — "click the row itself"
// — but it happened unconditionally and silently, so a mistyped selector
// produced a confident successful click on the wrong element and the run
// carried on as though it had worked.
import test from "node:test";
import assert from "node:assert/strict";
import { loadInjector } from "./helpers/content-harness.mjs";

const PAGE = `
  <ul>
    <li class="row"><a class="open">Open A</a></li>
    <li class="row"><a class="open">Open B</a></li>
  </ul>
`;

/** Context shaped like the one the service worker builds for a LOOP child. */
const loopCtx = (index0) => ({
  loop: { selector: ".row", index0, index: index0 + 1 },
});

test("a matching selector clicks the intended element", async () => {
  const h = await loadInjector(PAGE);
  const clicked = [];
  h.document
    .querySelectorAll(".open")
    .forEach((el, i) =>
      el.addEventListener("click", () => clicked.push(`open-${i}`)),
    );

  const r = await h.api._executeStep({
    type: "CLICK",
    config: { selector: ".open" },
    __vqContext: loopCtx(1),
  });

  assert.equal(r.clicked, 1);
  assert.deepEqual(clicked, ["open-1"], "scoped to the second loop item");
  h.close();
});

test("a missing selector inside a loop is an error, not a click on the row", async () => {
  const h = await loadInjector(PAGE);
  const clicked = [];
  h.document
    .querySelectorAll(".row")
    .forEach((el, i) =>
      el.addEventListener("click", () => clicked.push(`row-${i}`)),
    );

  await assert.rejects(
    () =>
      h.api._executeStep({
        type: "CLICK",
        config: { selector: ".typo-does-not-exist" },
        __vqContext: loopCtx(0),
      }),
    /Click target not found/,
    "this used to resolve successfully, having clicked the wrong element",
  );

  assert.deepEqual(clicked, [], "nothing was clicked");
  h.close();
});

test("the error tells you the fallback exists", async () => {
  const h = await loadInjector(PAGE);
  await assert.rejects(
    () =>
      h.api._executeStep({
        type: "CLICK",
        config: { selector: ".nope" },
        __vqContext: loopCtx(0),
      }),
    /Fall back to the loop item/,
  );
  h.close();
});

test("opting in restores the fallback", async () => {
  const h = await loadInjector(PAGE);
  const clicked = [];
  h.document
    .querySelectorAll(".row")
    .forEach((el, i) =>
      el.addEventListener("click", () => clicked.push(`row-${i}`)),
    );

  const r = await h.api._executeStep({
    type: "CLICK",
    config: { selector: ".nope", fallbackToLoopItem: true },
    __vqContext: loopCtx(1),
  });

  assert.equal(r.usedRootFallback, true, "and it reports that it did so");
  assert.deepEqual(clicked, ["row-1"], "clicked the current loop item");
  h.close();
});

test("an empty selector still targets the loop item", async () => {
  // Documented behaviour in JinjaTemplateGuide: leave the selector blank to
  // target the current item root. Unaffected by the fallback change.
  const h = await loadInjector(PAGE);
  const clicked = [];
  h.document
    .querySelectorAll(".row")
    .forEach((el, i) =>
      el.addEventListener("click", () => clicked.push(`row-${i}`)),
    );

  const r = await h.api._executeStep({
    type: "CLICK",
    config: { selector: "" },
    __vqContext: loopCtx(0),
  });

  assert.equal(
    r.usedRootFallback,
    false,
    "this is the intended path, not a fallback",
  );
  assert.deepEqual(clicked, ["row-0"]);
  h.close();
});

test("outside a loop, a missing selector errors without mentioning loops", async () => {
  const h = await loadInjector(PAGE);
  await assert.rejects(
    () => h.api._executeStep({ type: "CLICK", config: { selector: ".nope" } }),
    (err) => {
      assert.match(err.message, /Click target not found/);
      assert.ok(
        !/loop item/.test(err.message),
        "advice about loops is noise when there is no loop",
      );
      return true;
    },
  );
  h.close();
});
