// Which tab the panel thinks it is driving.
//
// The board is stored per tab as `vq_active_pipeline_<tabId>` (E-13), so this
// one answer decides which pipeline appears. Getting it wrong does not present
// as an error — it presents as the user's work having vanished.
//
// Boot asked `chrome.tabs.query({active, currentWindow})` exactly once and took
// whatever came back. When that resolved to an empty list — a window switch, a
// tab being replaced, the panel reloading — SK.PIPELINE stayed the bare,
// shared `vq_active_pipeline`. Three things then went wrong at once: the real
// board did not load, nothing said so, and the next edit wrote to the shared
// key, so a later boot that *did* resolve the tab read the correct key and
// silently lost that edit.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const panel = readFileSync(
  new URL("../sidepanel/pipeline-builder.js", import.meta.url),
  "utf8",
);

const resolveFn = panel.match(
  /async function _resolveTabId\([\s\S]*?\n\}/,
)?.[0];
const initFn = panel.match(/async function init\([\s\S]*?\n  \}\);/)?.[0];

test("boot no longer takes a single tab query as final", () => {
  assert.ok(resolveFn, "tab resolution should have its own function");
  assert.ok(
    !/const \[tab\] = await chrome\.tabs\.query\(\{ active: true, currentWindow: true \}\);\s*\n\s*_tabId = tab/.test(
      panel,
    ),
    "init still binds to one unchecked query",
  );
});

test("it asks both ways, because they disagree exactly when focus is moving", () => {
  // currentWindow and lastFocusedWindow resolve differently mid-switch, which
  // is precisely when the single query was returning nothing.
  assert.match(resolveFn, /currentWindow: true/);
  assert.match(resolveFn, /lastFocusedWindow: true/);
});

test("an empty answer is retried rather than believed", () => {
  // This is a race with the browser settling, not a real absence of tabs.
  assert.match(
    resolveFn,
    /for \(let attempt = 0; attempt < \d+; attempt\+\+\)/,
  );
  assert.match(resolveFn, /setTimeout/);
});

test("the retry is bounded, so an unbindable panel still opens", () => {
  // A panel that waits forever for a tab is worse than one that says it could
  // not find it.
  const bound = resolveFn.match(/attempt < (\d+)/)?.[1];
  assert.ok(Number(bound) > 1 && Number(bound) <= 5, `retries: ${bound}`);
  assert.match(resolveFn, /return null;/);
});

test("a thrown query does not take the panel down with it", () => {
  assert.match(resolveFn, /\.catch\(\(\) => \[\]\)/);
});

// ── The part that lost work ──────────────────────────────────────────────────

test("failing to bind is recorded rather than shrugged off", () => {
  assert.match(panel, /let _pipelineKeyUnbound = false;/);
  assert.match(panel, /_pipelineKeyUnbound = true;/);
});

test("failing to bind is not silent", () => {
  // The whole reason this was hard to see: an empty board and no explanation
  // is indistinguishable from deleted work.
  const warn = panel.match(
    /if \(_pipelineKeyUnbound\) \{\s*\n\s*notify\([\s\S]*?\);\s*\n\s*\}/,
  )?.[0];
  assert.ok(warn, "an unbound panel should say so");
  assert.match(warn, /warn-log/);
  // And it must not imply data loss, because there is none.
  assert.match(warn, /Nothing has been deleted/);
});

test("work done while unbound is adopted when a tab arrives, not discarded", () => {
  // The listener's normal job is to swap the board for the newly active tab's
  // saved one. Doing that to a panel that has been writing to the shared key
  // would delete exactly the work the unbound boot put at risk.
  const listener = panel.match(
    /chrome\.tabs\.onActivated\.addListener\([\s\S]*?\n  \}\);/,
  )?.[0];
  assert.ok(listener, "the tab-swap listener should still exist");

  const adopt = listener.indexOf("_pipelineKeyUnbound");
  const clear = listener.indexOf("_pipeline = saved?.steps ? saved");
  assert.ok(adopt !== -1, "the listener ignores the unbound case");
  assert.ok(
    adopt < clear,
    "it clears the board before considering the unbound case",
  );
  assert.match(listener, /!saved\?\.steps && _pipeline\.steps\.length/);
});

test("adoption does not overwrite a tab that already has a pipeline", () => {
  // Only an empty tab inherits the orphaned board. A tab with its own saved
  // work keeps it.
  const listener = panel.match(
    /chrome\.tabs\.onActivated\.addListener\([\s\S]*?\n  \}\);/,
  )?.[0];
  assert.match(listener, /if \(!saved\?\.steps && _pipeline\.steps\.length\)/);
});
