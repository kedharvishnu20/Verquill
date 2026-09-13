// Regression tests for audit finding C-02.
//
// page-sniffer.js wraps window.fetch and XMLHttpRequest and forwards every
// request and response body it sees. It was declared in the manifest as a
// MAIN-world content script on <all_urls> at document_start, so it ran on every
// site the user visited — buffering up to 500 KB per response and messaging it
// to the service worker, which discarded it unless an API_SNIFFER run happened
// to be active. The capture and the IPC happened regardless.
//
// service-worker.js registers listeners and bootstraps at module scope, and
// exports nothing, so its lifecycle is asserted at source level. The manifest
// assertions below are structural and exact.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const manifest = JSON.parse(
  await readFile(new URL("../manifest.json", import.meta.url), "utf8"),
);
const swSrc = await readFile(
  new URL("../background/service-worker.js", import.meta.url),
  "utf8",
);

test("the sniffer is not a declared content script", () => {
  const declared = (manifest.content_scripts ?? []).flatMap((c) => c.js);
  assert.ok(
    !declared.includes("content/page-sniffer.js"),
    "declaring it here runs it on every site the user visits",
  );
});

test("no MAIN-world script is declared in the manifest at all", () => {
  const mainWorld = (manifest.content_scripts ?? []).filter(
    (c) => c.world === "MAIN",
  );
  assert.deepEqual(
    mainWorld,
    [],
    "MAIN-world scripts share the page's globals and need a reason to be there",
  );
});

test("the scripting permission is present, since the sniffer now needs it", () => {
  assert.ok(manifest.permissions.includes("scripting"));
});

test("the sniffer is registered only for a run that asked for it", () => {
  assert.match(
    swSrc,
    /if \(enableSniffer\) \{\s*\n\s*await _enableSniffer\(/,
    "registration must be conditional on an API_SNIFFER step being present",
  );
  // Derived from the steps, not from a flag the panel sends: a payload the
  // page could influence must not be able to turn the sniffer on (C-02). The
  // step is now looked up rather than counted, because the run also needs its
  // URL filter — so assert what it is derived from, not how.
  assert.match(
    swSrc,
    /const enableSniffer = Boolean\(snifferStep\)/,
    "enableSniffer must come from the pipeline's own steps",
  );
  assert.match(
    swSrc,
    /const snifferStep = \(pipeline\.steps \|\| \[\]\)\.find\(\s*\(s\) => s\.type === "API_SNIFFER",/,
  );
});

test("registration is scoped to the run's origin where there is one", () => {
  const matches = swSrc.match(/function _snifferMatches\([\s\S]*?\n\}/)?.[0];
  assert.ok(matches, "found _snifferMatches");
  assert.match(
    matches,
    /\$\{targetOrigin\}\/\*/,
    "scoped to the target origin",
  );
  assert.match(
    matches,
    /<all_urls>/,
    "with a documented fallback when there is none",
  );
});

test("the sniffer is unregistered when the run ends", () => {
  assert.match(
    swSrc,
    /await finalizeBuffer\(runId\)\.catch\(\(\) => \{\}\);\s*\n\s*await _disableSniffer\(runId\);/,
    "every path out of _executePipeline must release it",
  );
  assert.match(
    swSrc,
    /_runStates\.delete\(runId\);\s*\n\s*await _disableSniffer\(runId\);/,
    "including an ethics block, which aborts before the run loop starts",
  );
});

test("concurrent runs do not unregister each other's sniffer", () => {
  const disable = swSrc.match(
    /async function _disableSniffer\([\s\S]*?\n\}/,
  )?.[0];
  assert.ok(disable, "found _disableSniffer");
  assert.match(disable, /if \(_snifferRuns\.size > 0\) return;/);
});

test("the user is told the sniffer cannot see earlier traffic", () => {
  // Injecting into an already-loaded page hooks fetch late by definition.
  assert.match(swSrc, /Requests made before this point are not captured/);
});

test("page-sniffer still guards against double-installation", async () => {
  // It can now be injected by executeScript on a page where the registered
  // script already ran, which would otherwise wrap fetch twice.
  const sniffer = await readFile(
    new URL("../content/page-sniffer.js", import.meta.url),
    "utf8",
  );
  assert.match(sniffer, /if \(window\.__vqSnifferReady\) return;/);
});
