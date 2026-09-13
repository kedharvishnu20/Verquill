// Regression tests for audit finding A-08.
//
// injector.js and overlay-engine.js both register chrome.runtime.onMessage
// listeners in the same content script. Chrome invokes every listener and
// delivers whichever responds first. injector's listener returned true for any
// message carrying a `type`, and _handleEvent's default branch resolved to
// null, so it answered `{ ok: true, result: null }` to overlay:* messages
// before the overlay engine could. Ethics Gate 7 read `result.unmatched` from
// that null reply and therefore never warned about missing selectors.
//
// Both modules need a DOM to import, so this file combines a static check of
// injector's routing table (which catches the realistic regression — someone
// adding a handler case without registering it) with a behavioural replay of
// Chrome's dispatch semantics.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const injectorSrc = await readFile(
  new URL("../content/injector.js", import.meta.url),
  "utf8",
);

test("injector declares an ownership set for its message listener", () => {
  assert.match(
    injectorSrc,
    /const OWNED_MESSAGE_TYPES = new Set\(/,
    "the listener must know which types are its own",
  );
  assert.match(
    injectorSrc,
    /if \(!type \|\| !OWNED_MESSAGE_TYPES\.has\(type\)\) return false;/,
    "unowned messages must fall through to the next listener",
  );
});

test("every type _handleEvent answers is registered as owned", () => {
  // Anchored on the function's own indent. `\n}` at column zero no longer ends
  // it (the file is wrapped in an IIFE), and a lazy `\n\s*\}` stops at the first
  // nested closing brace — which cut the slice to six cases and made this test
  // pass without looking at the rest.
  const handler = injectorSrc.match(
    /\n {2}async function _handleEvent\([\s\S]*?\n {2}\}/,
  )?.[0];
  assert.ok(handler, "found _handleEvent");
  // The slice must reach the switch's default, or a lazy match could stop at a
  // nested brace and this comparison would be vacuous.
  assert.match(
    handler,
    /default:\s*\n\s*throw new Error\(`Unhandled event type/,
    "the _handleEvent slice stops short of the end of its switch",
  );

  // Cases are written either as CE.NAME or as a string literal.
  const handled = new Set(
    [...handler.matchAll(/case\s+(?:CE\.([A-Z_]+)|"([^"]+)")\s*:/g)].map(
      (m) => m[1] ?? m[2],
    ),
  );

  const owned = new Set(
    [
      ...injectorSrc
        .match(/const OWNED_MESSAGE_TYPES = new Set\(\[([\s\S]*?)\]\)/)[1]
        .matchAll(/(?:CE\.([A-Z_]+)|"([^"]+)")/g),
    ].map((m) => m[1] ?? m[2]),
  );

  const missing = [...handled].filter((t) => !owned.has(t));
  assert.deepEqual(
    missing,
    [],
    "a handled type that is not owned would be dropped before reaching _handleEvent",
  );
});

test("_handleEvent surfaces an unroutable type instead of resolving null", () => {
  assert.match(
    injectorSrc,
    /default:\s*\n\s*throw new Error\(`Unhandled event type/,
    "resolving null made an unroutable step look like a successful no-op",
  );
});

// ── Behavioural replay ───────────────────────────────────────────────────────
// Registers both listener bodies as the sources have them and dispatches the
// way Chrome does: call every listener, first respond() wins, `return true`
// keeps the channel open.

function makeDispatcher() {
  const listeners = [];
  const add = (fn) => listeners.push(fn);

  const dispatch = (msg) =>
    new Promise((resolve) => {
      let done = false;
      const respond = (v) => {
        if (!done) {
          done = true;
          resolve(v);
        }
      };
      const anyAsync = listeners
        .map((fn) => fn(msg, {}, respond))
        .some((k) => k === true);
      setTimeout(() => respond(undefined), anyAsync ? 50 : 0);
    });

  return { add, dispatch };
}

function wireListeners({ add }) {
  const CE = {
    STEP_EXEC: "VQ_STEP_EXEC",
    PICK_SELECTOR: "VQ_PICK_SELECTOR",
    FORM_FILL_ROW: "VQ_FORM_FILL_ROW",
  };
  const OWNED = new Set([
    CE.STEP_EXEC,
    CE.FORM_FILL_ROW,
    CE.PICK_SELECTOR,
    "step:execute",
  ]);

  // injector.js
  add((msg, sender, respond) => {
    const { type } = msg ?? {};
    if (!type || !OWNED.has(type)) return false;
    Promise.resolve({ from: "injector", type })
      .then((result) => respond({ ok: true, result }))
      .catch((err) => respond({ ok: false, error: err.message }));
    return true;
  });

  // overlay-engine.js
  const overlayEngine = {
    async previewAll(steps) {
      return {
        matched: ["z1"],
        unmatched: steps.length > 1 ? [".missing"] : [],
      };
    },
    setMode() {},
    async reloadPrefs() {},
  };
  add((msg, sender, respond) => {
    const { type, payload } = msg ?? {};
    switch (type) {
      case "overlay:setMode":
        if (payload.action === "previewAll" && Array.isArray(payload.steps)) {
          Promise.resolve(overlayEngine.previewAll(payload.steps))
            .then((result) => respond({ ok: true, ...result }))
            .catch((err) => respond({ ok: false, error: err.message }));
          return true;
        }
        overlayEngine.setMode();
        respond({ ok: true });
        break;
      case "overlay:reloadPrefs":
        overlayEngine.reloadPrefs().then(() => respond({ ok: true }));
        return true;
      default:
        return false;
    }
    return true;
  });
}

test("injector still answers its own message types", async () => {
  const d = makeDispatcher();
  wireListeners(d);

  assert.equal(
    (await d.dispatch({ type: "step:execute", payload: {} }))?.result?.from,
    "injector",
  );
  assert.equal(
    (await d.dispatch({ type: "VQ_PICK_SELECTOR", payload: {} }))?.result?.from,
    "injector",
  );
});

test("Gate 7 receives real previewAll results", async () => {
  const d = makeDispatcher();
  wireListeners(d);

  const r = await d.dispatch({
    type: "overlay:setMode",
    payload: { action: "previewAll", steps: [{}, {}] },
  });
  assert.equal(r?.ok, true);
  assert.deepEqual(
    r.unmatched,
    [".missing"],
    "previewAll is async; spreading the promise lost this",
  );

  const clean = await d.dispatch({
    type: "overlay:setMode",
    payload: { action: "previewAll", steps: [{}] },
  });
  assert.deepEqual(
    clean.unmatched,
    [],
    "no findings is an empty array, never undefined",
  );
});

test("overlay:reloadPrefs is handled", async () => {
  const d = makeDispatcher();
  wireListeners(d);
  assert.equal(
    (await d.dispatch({ type: "overlay:reloadPrefs", payload: {} }))?.ok,
    true,
  );
});

test("a type neither listener owns draws no bogus ok:true", async () => {
  const d = makeDispatcher();
  wireListeners(d);
  assert.equal(
    await d.dispatch({ type: "totally:unknown", payload: {} }),
    undefined,
  );
});
