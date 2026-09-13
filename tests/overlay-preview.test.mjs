// "Could not establish connection. Receiving end does not exist."
//
// Reported from a real install, as an uncaught promise rejection with a stack
// trace pointing at the overlay panel. Content scripts are injected on demand
// (C-09), so a tab that has never had a pipeline run against it has nothing
// listening — and the Preview All Matches button sent to it anyway, with
// nothing catching the rejection. Two failures in one: the button silently did
// nothing, and the only evidence was a console stack trace the user had to go
// looking for.
//
// The selector picker already had this right — ensure, then send, then explain.
// The overlay panel simply never adopted it.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const overlay = readFileSync(
  new URL("../sidepanel/overlay-panel.js", import.meta.url),
  "utf8",
);
const builder = readFileSync(
  new URL("../sidepanel/pipeline-builder.js", import.meta.url),
  "utf8",
);

const previewHandler = overlay.match(
  /getElementById\("ov-preview-now"\)[\s\S]*?\n    \}\);/,
)?.[0];

test("the preview button makes sure something is listening first", () => {
  assert.ok(previewHandler, "the preview handler should still exist");
  const ensureAt = previewHandler.indexOf("_ensureContentReady");
  const sendAt = previewHandler.indexOf("chrome.tabs.sendMessage");
  assert.ok(ensureAt !== -1, "it still sends without ensuring injection");
  assert.ok(
    ensureAt < sendAt,
    "it sends before ensuring the content script is there",
  );
});

test("a page that refuses injection stops the send", () => {
  assert.match(
    previewHandler,
    /if \(!\(await _ensureContentReady\([\s\S]{0,40}return;/,
  );
});

test("the send itself cannot reject into nowhere", () => {
  // Injection can succeed and the send still fail — the page navigated in
  // between, or tore the script down. That is the exact shape of the reported
  // error, so it has to be caught even after ensuring.
  const guarded =
    /try \{[\s\S]*?chrome\.tabs\.sendMessage[\s\S]*?\} catch/.test(
      previewHandler,
    );
  assert.ok(guarded, "the send is still an unhandled rejection");
});

test("a failure is reported to the user, not only to the console", () => {
  // The user pressed a button and is owed an answer either way. A console
  // stack trace is not an answer.
  assert.match(previewHandler, /notify\(\s*\n?\s*"error-log"/);
});

test("no active tab is a message, not a browser alert", () => {
  // alert() in a 400px side panel is jarring, and the panel has a log pane
  // built for exactly this.
  assert.ok(!/alert\(/.test(overlay), "overlay-panel still calls alert()");
  assert.match(previewHandler, /notify\("warn-log"/);
});

test("the injection dance is shared, not copied", () => {
  // A second copy of it is a second thing to keep correct, and this project
  // has a rule about that (G-01).
  assert.match(
    overlay,
    /import \{[\s\S]*?_ensureContentReady[\s\S]*?\} from "\.\/pipeline-builder\.js"/,
  );
  assert.match(builder, /export async function _ensureContentReady\(/);
  assert.match(builder, /export function notify\(/);
});

test("saving a preference stays silent, and says why", () => {
  // The other send in this file is deliberately quiet: it fires on every
  // preference change, and a tab with no content script is the normal case
  // rather than a fault. A bare `/* ignore */` gave no way to tell that apart
  // from the bug above.
  const save = overlay.match(/async function _savePrefs\([\s\S]*?\n\}/)?.[0];
  assert.ok(save, "_savePrefs should still exist");
  assert.match(save, /\} catch \{/);
  assert.ok(!/\/\* ignore \*\//.test(save), "the silence is still unexplained");
  assert.match(save, /normal case/);
});
