// Steps that need to reach inside an iframe.
//
// Reported from a real session: "this tool cannot interact with the elements in
// the iframe". It could not, and the reason was one line — the content script
// was injected with `allFrames` left at its default of false, so it only ever
// existed in the top document. Every selector was resolved against a document
// that does not contain the iframe's contents, because an iframe is a separate
// document, not a branch of its parent's DOM.
//
// The user asked for a per-step toggle rather than always searching frames,
// which is right: searching every frame changes what an ambiguous selector
// matches, and a page can carry a dozen advertising iframes that happen to have
// a `.title` in them.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { STEP_TYPES, USER_STEP_TYPES } from "../utils/step-types.js";

const sw = await readFile(
  new URL("../background/service-worker.js", import.meta.url),
  "utf8",
);
const panel = await readFile(
  new URL("../sidepanel/pipeline-builder.js", import.meta.url),
  "utf8",
);
const injector = await readFile(
  new URL("../content/injector.js", import.meta.url),
  "utf8",
);

test("the content script is injected into every frame, not only the top one", () => {
  const fn = sw.match(/async function _ensureInjected\([\s\S]*?\n\}\n/)[0];
  assert.match(
    fn,
    /allFrames: true/,
    "injection is still limited to the top document",
  );
});

test("injecting twice does not double-register the page's listener", () => {
  // With allFrames the same file lands in several documents, and a frame that
  // was already set up gets it again on the next _ensureInjected. Two
  // listeners in one document means every reply is sent twice, and the second
  // one loses — which is how A-08 broke the ethics gate.
  assert.match(
    injector,
    /__vqInjected/,
    "injector.js has no guard against being evaluated twice",
  );
});

test("every page step can be told to look inside frames", () => {
  const pageSteps = USER_STEP_TYPES.filter(
    (t) => STEP_TYPES[t].runsIn === "page",
  );
  const missing = pageSteps.filter(
    (t) => !("inFrame" in (STEP_TYPES[t].def ?? {})),
  );
  assert.deepEqual(
    missing,
    [],
    "these act on the page but cannot be pointed at a frame",
  );
});

test("the toggle is off by default, so nothing changes for pages without frames", () => {
  for (const t of USER_STEP_TYPES) {
    const def = STEP_TYPES[t].def ?? {};
    if ("inFrame" in def) {
      assert.equal(def.inFrame, false, `${t} searches frames by default`);
    }
  }
});

test("a step with the toggle on is offered to each frame in turn", () => {
  const send = sw.match(/async function _sendToFrames\([\s\S]*?\n\}\n/);
  assert.ok(send, "no _sendToFrames");
  // It walks the frames and addresses each one.
  assert.match(send[0], /_frameIds\(tabId\)/);
  assert.match(send[0], /\{ frameId \}/);

  // Frame ids are discovered by running a trivial script in every frame.
  // chrome.webNavigation would also do it and would cost another permission —
  // C-07 cut four unused ones, and adding one back for a list this cheap
  // would be a poor trade.
  const ids = sw.match(/async function _frameIds\([\s\S]*?\n\}\n/);
  assert.ok(ids, "no _frameIds");
  assert.match(ids[0], /allFrames: true/);
  assert.match(ids[0], /frameId/);
});

test("the toggle appears in the config UI", () => {
  const body = panel.slice(panel.indexOf("function generateConfigHtml"));
  assert.match(body, /inFrame/, "no way to turn it on");
});
