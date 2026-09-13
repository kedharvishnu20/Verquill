// Regression tests for audit finding C-01, run against a real DOM.
//
// injector's window message listener was guarded only by
// `event.source !== window`, which every script running in the page satisfies.
// The module docblock claimed events were "source-checked against
// window.location.origin"; no such check existed. Any page could post
// VQ_STEP_EXEC and drive CLICK, FILL, SELECT, DRAG_DROP, NAVIGATE,
// UPLOAD_ACTIVITY or the selector picker, then read the result off the _ACK
// reply the listener posted back with targetOrigin "*".
//
// Nothing in the extension ever sent those events — the background uses
// chrome.tabs.sendMessage — so the surface existed only for an attacker.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadInjector } from "./helpers/content-harness.mjs";

const injectorSrc = await readFile(
  new URL("../content/injector.js", import.meta.url),
  "utf8",
);

/**
 * Deliver a message exactly as a script running in the page would.
 *
 * jsdom's window.postMessage leaves event.source null, which injector's guard
 * rejects — so a test using it would pass whether or not the hole was closed.
 * The event is constructed directly with source set to the window, which is
 * what a real same-window page script produces.
 */
async function postFromPage(h, data, settleMs = 400) {
  const sent = [];
  h.window.chrome.runtime.sendMessage = (msg) => {
    sent.push(msg);
    return Promise.resolve();
  };
  h.window.dispatchEvent(
    new h.window.MessageEvent("message", {
      data,
      source: h.window,
      origin: "https://example.test",
    }),
  );
  await new Promise((r) => setTimeout(r, settleMs));
  return sent;
}

test("a page cannot drive step execution over postMessage", async () => {
  const h = await loadInjector(`<button class="danger">Click me</button>`);
  let clicked = false;
  h.document.querySelector(".danger").addEventListener("click", () => {
    clicked = true;
  });

  await postFromPage(h, {
    type: "VQ_STEP_EXEC",
    id: "1",
    payload: { type: "CLICK", config: { selector: ".danger" } },
  });

  assert.equal(
    clicked,
    false,
    "the page must not be able to click through the extension",
  );
  h.close();
});

test("a page cannot open the selector picker", async () => {
  const h = await loadInjector(`<p>page</p>`);

  // The picker's overlay goes into a *closed* shadow root, which a test cannot
  // read. Its observable side effect is the capture-phase listeners it installs
  // on document, so watch for those instead.
  const installed = [];
  const realAdd = h.document.addEventListener.bind(h.document);
  h.document.addEventListener = (type, fn, capture) => {
    installed.push(type);
    return realAdd(type, fn, capture);
  };

  await postFromPage(h, {
    type: "VQ_PICK_SELECTOR",
    id: "2",
    payload: { bulk: true },
  });

  assert.ok(
    !installed.includes("mousemove"),
    "the picker arms document listeners and hijacks the next click",
  );
  h.close();
});

test("no result is posted back to the page", () => {
  assert.ok(
    !/window\.postMessage\(/.test(injectorSrc),
    "the reply carried step results to any listener, at targetOrigin '*'",
  );
});

test("the sniffer bridge still forwards page traffic", async () => {
  const h = await loadInjector(`<p>page</p>`);
  const sent = await postFromPage(h, {
    type: "VQ_NETWORK_SNIFF",
    payload: {
      method: "post",
      url: "https://api.example.test/items",
      status: 200,
      resBody: '{"ok":true}',
      apiType: "fetch",
    },
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "network:sniff");
  assert.equal(sent[0].payload.url, "https://api.example.test/items");
  assert.equal(sent[0].payload.method, "POST", "method is normalised");
  assert.equal(sent[0].payload.status, 200);
  h.close();
});

test("sniffer payloads are clamped, not trusted", async () => {
  const h = await loadInjector(`<p>page</p>`);
  const sent = await postFromPage(h, {
    type: "VQ_NETWORK_SNIFF",
    payload: {
      method: "GET",
      url: "https://x.test/" + "a".repeat(9000),
      status: "not-a-number",
      resBody: "b".repeat(2_000_000),
      apiType: "c".repeat(500),
    },
  });

  const p = sent[0].payload;
  assert.ok(p.url.length <= 2048, `url clamped, got ${p.url.length}`);
  assert.ok(
    p.resBody.length <= 512 * 1024,
    `body clamped, got ${p.resBody.length}`,
  );
  assert.ok(p.apiType.length <= 32);
  assert.equal(
    p.status,
    0,
    "a non-numeric status becomes 0 rather than propagating",
  );
  h.close();
});

test("a malformed sniffer payload is dropped", async () => {
  const h = await loadInjector(`<p>page</p>`);
  assert.deepEqual(
    await postFromPage(h, { type: "VQ_NETWORK_SNIFF", payload: null }),
    [],
  );
  assert.deepEqual(
    await postFromPage(h, { type: "VQ_NETWORK_SNIFF", payload: { url: 42 } }),
    [],
  );
  assert.deepEqual(await postFromPage(h, { type: "VQ_NETWORK_SNIFF" }), []);
  h.close();
});

test("unknown VQ_ message types are ignored entirely", async () => {
  const h = await loadInjector(`<p>page</p>`);
  assert.deepEqual(
    await postFromPage(h, { type: "VQ_FORM_FILL_ROW", payload: {} }),
    [],
  );
  assert.deepEqual(
    await postFromPage(h, { type: "VQ_ANYTHING", payload: {} }),
    [],
  );
  h.close();
});
