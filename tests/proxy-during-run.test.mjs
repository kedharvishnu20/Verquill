// A-05: the proxy pool parsed, health-checked, deduped and rotated, and no run
// ever consulted it. `selectProxy` was reachable from one message nothing sent.
//
// The wiring is the small part. What shapes this file is a fact about Chrome:
// `chrome.proxy.settings.set` is **browser-wide**. An extension cannot proxy
// one tab. So a run that takes a proxy takes the user's whole browser with it —
// their other tabs, their mail, their bank — and the dangerous failure is not
// "the proxy did not apply", it is "the run ended and the browser is still
// going through somebody's proxy". Most of what follows tests the giving back.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  calls,
  reset,
  startRun,
  endRun,
  _startRunProxy,
  _maybeRotateProxy,
  _endRunProxy,
} from "./helpers/worker-harness.mjs";
import {
  addToPool,
  clearPool,
  setRotationMode,
} from "../background/proxy-manager.js";

const logs = () =>
  calls.runtimeMessages
    .filter((m) => m.type === "pipeline:log")
    .map((m) => m.payload.message);

const POOL = [
  { host: "10.0.0.1", port: 8080, type: "http" },
  { host: "10.0.0.2", port: 8080, type: "http" },
  { host: "10.0.0.3", port: 8080, type: "http" },
];

/** Health checks are a separate concern; mark the pool alive directly. */
async function pool(alive = true) {
  await clearPool();
  addToPool(POOL.map((p) => ({ ...p })));
  const { getPool } = await import("../background/proxy-manager.js");
  for (const entry of getPool()) entry.alive = alive;
  setRotationMode("round-robin");
}

test("a run that did not ask for a proxy does not touch the browser's setting", async () => {
  // The ordinary case, and the one that must never surprise anyone.
  await pool();
  reset();
  const { runId, runState } = startRun();
  await _startRunProxy(runState);
  assert.equal(calls.proxySets.length, 0, "it proxied a run that never asked");
  await _endRunProxy(runState);
  assert.equal(calls.proxyClears.length, 0);
  await endRun(runId);
});

test("a run that asks gets a proxy, and is told the browser is going with it", async () => {
  await pool();
  reset();
  const { runId, runState } = startRun({ useProxy: true });
  await _startRunProxy(runState);

  assert.equal(calls.proxySets.length, 1, "no proxy was applied");
  const pac = calls.proxySets[0].value.pacScript.data;
  assert.match(pac, /PROXY 10\.0\.0\.\d:8080/);
  // The warning is not decoration. Somebody whose browser is about to route
  // through a third party should be told in the log they are already reading.
  const said = logs().join("\n");
  assert.match(said, /whole browser|every tab/i);
  await _endRunProxy(runState);
  await endRun(runId);
});

test("the proxy is released when the run ends", async () => {
  await pool();
  reset();
  const { runId, runState } = startRun({ useProxy: true });
  await _startRunProxy(runState);
  await _endRunProxy(runState);
  assert.equal(calls.proxyClears.length, 1, "the browser was left proxied");
  await endRun(runId);
});

test("a run with no live proxy goes direct and says so", async () => {
  // Silently proxying nothing would be fine; silently *claiming* to proxy
  // would not. The run continues, because a dead pool is not a reason to throw
  // away the rows.
  await pool(false);
  reset();
  const { runId, runState } = startRun({ useProxy: true });
  await _startRunProxy(runState);
  assert.equal(calls.proxySets.length, 0);
  assert.match(logs().join("\n"), /no proxy .* is alive|going direct/i);
  await endRun(runId);
});

test("rotation happens every N page loads, not every step", async () => {
  // A step is not a visit. Rotating between a click and the response it is
  // waiting for changes the proxy mid-request, which is how a session breaks.
  await pool();
  reset();
  const { runId, runState } = startRun({
    useProxy: true,
    proxyRotateEvery: 2,
  });
  await _startRunProxy(runState);
  const applied = () => calls.proxySets.length;
  const afterStart = applied();

  await _maybeRotateProxy(runState); // 1st navigation
  assert.equal(applied(), afterStart, "it rotated after one page load");
  await _maybeRotateProxy(runState); // 2nd — this one rotates
  assert.equal(applied(), afterStart + 1, "it did not rotate on the 2nd");
  await _maybeRotateProxy(runState);
  assert.equal(applied(), afterStart + 1);
  await _maybeRotateProxy(runState); // 4th
  assert.equal(applied(), afterStart + 2);

  await _endRunProxy(runState);
  await endRun(runId);
});

test("rotate-every 0 keeps one proxy for the whole run", async () => {
  await pool();
  reset();
  const { runId, runState } = startRun({ useProxy: true, proxyRotateEvery: 0 });
  await _startRunProxy(runState);
  const afterStart = calls.proxySets.length;
  for (let i = 0; i < 5; i++) await _maybeRotateProxy(runState);
  assert.equal(calls.proxySets.length, afterStart);
  await _endRunProxy(runState);
  await endRun(runId);
});

test("a run that never held a proxy does not clear one on the way out", async () => {
  // Clearing indiscriminately would wipe a proxy the *user* set for their own
  // browsing, which the tool has no business touching.
  reset();
  const { runId, runState } = startRun({ useProxy: false });
  await _endRunProxy(runState);
  assert.equal(calls.proxyClears.length, 0);
  await endRun(runId);
});

test("the browser is not left proxied when a run is cut off", async () => {
  // A service worker terminated mid-run loses _runStates, and with it the only
  // record that a proxy is held. The flag lives in storage for exactly this,
  // and bootstrap reads it — so the note must actually be written.
  await pool();
  reset();
  const { runId, runState } = startRun({ useProxy: true });
  await _startRunProxy(runState);

  const held = await globalThis.chrome.storage.local.get("vq_proxy_held_v1");
  assert.ok(
    held.vq_proxy_held_v1,
    "nothing recorded that this run holds the browser's proxy",
  );
  assert.equal(held.vq_proxy_held_v1.runId, runId);

  await _endRunProxy(runState);
  const after = await globalThis.chrome.storage.local.get("vq_proxy_held_v1");
  assert.ok(!after.vq_proxy_held_v1, "the note outlived the run holding it");
  await endRun(runId);
});

// ── Failures the pool never heard about ─────────────────────────────────────
//
// `markProxyFailure` counted failures and wrote a proxy off at the third one.
// The service worker imported it and called it from nowhere. So the pool's
// health only ever changed when someone pressed Test in Settings, and a proxy
// that started refusing connections mid-run went on being selected for every
// run after it.
//
// It also only mutated the in-memory pool. An MV3 worker is torn down whenever
// it idles, so even a proxy that had been marked dead was alive again minutes
// later, its failCount restarting from zero — the threshold could never be
// reached across restarts.

test("a failure survives the pool being reloaded", async () => {
  // The property that matters, asserted by round-tripping rather than by
  // counting storage writes: an MV3 worker is torn down whenever it idles, so
  // a failCount that lives only in `_pool` restarts from zero every time and
  // the dead-at-three threshold can never be reached.
  const { clearPool, addToPool, markProxyFailure, loadPool, getPool } =
    await import("../background/proxy-manager.js");
  reset();
  await clearPool();
  addToPool([{ host: "10.0.0.1", port: 8080, type: "http", alive: true }]);

  await markProxyFailure("10.0.0.1", 8080);
  assert.equal(getPool()[0].failCount, 1, "the failure was not counted");

  // Stand in for the worker restarting: drop the in-memory pool and read it
  // back from storage, which is all a fresh worker has.
  await loadPool();
  assert.equal(
    getPool()[0]?.failCount,
    1,
    "the failure was forgotten when the pool was reloaded",
  );
});

test("three failures kill a proxy, one does not", async () => {
  const { clearPool, addToPool, markProxyFailure, getPool } =
    await import("../background/proxy-manager.js");
  reset();
  await clearPool();
  addToPool([{ host: "10.0.0.1", port: 8080, type: "http", alive: true }]);

  assert.equal(await markProxyFailure("10.0.0.1", 8080), false);
  assert.equal(getPool()[0].alive, true, "one timeout is not proof");
  assert.equal(await markProxyFailure("10.0.0.1", 8080), false);
  assert.equal(await markProxyFailure("10.0.0.1", 8080), true);
  assert.equal(
    getPool()[0].alive,
    false,
    "three failures did not write it off",
  );
});

test("a failure against a proxy not in the pool is ignored, not thrown", async () => {
  const { clearPool, addToPool, markProxyFailure } =
    await import("../background/proxy-manager.js");
  reset();
  await clearPool();
  addToPool([{ host: "10.0.0.1", port: 8080, type: "http", alive: true }]);
  assert.equal(await markProxyFailure("203.0.113.9", 1080), false);
});

test("the run reports a failed navigation against the proxy carrying it", () => {
  // Source-read rather than a full run: the wiring is the thing that was
  // missing, and it is what a future refactor would drop again.
  const worker = readFileSync(
    new URL("../background/service-worker.js", import.meta.url),
    "utf8",
  );
  assert.match(
    worker,
    /await _noteProxyFailure\(runState, what\)/,
    "a navigation that never loaded no longer tells the pool",
  );
  assert.match(
    worker,
    /runState\.proxyEntry = \{ host: entry\.host, port: entry\.port \}/,
    "the run no longer records which proxy it holds, so nothing can be blamed",
  );
  const fn = worker.match(
    /async function _noteProxyFailure\([\s\S]*?\n\}/,
  )?.[0];
  assert.ok(fn, "_noteProxyFailure is gone");
  assert.match(fn, /markProxyFailure\(/);
  assert.match(fn, /rotateProxy\(/, "a dead proxy is not replaced");
  assert.match(
    fn,
    /goes direct/,
    "an empty pool leaves the run silently proxied through nothing",
  );
});
