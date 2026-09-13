// Regression tests for the two halves of J-25 and J-26.
//
// J-25 (second half): the detector can now find a rating rendered as four star
// icons, but a column EXTRACT cannot read back is no better than a missing one.
// "count" is the reader for it, and it has to exist in the injector, in the two
// script emitters, and in the panel's kind-to-type mapping — G-01's rule that a
// capability lives in one place and every consumer is checked against it.
//
// J-26: API_SNIFFER captured nothing on any run that navigated — which is
// nearly all of them. page-sniffer.js runs in the MAIN world, where there is no
// chrome.runtime, so it reports by posting a window message; injector.js is
// what forwards that to the worker, and injector.js is injected on demand. On a
// freshly loaded document it is simply not there, so the hook fired into a page
// with no listener and every capture was dropped.
//
// And on a URL that *is* an API — open https://fakestoreapi.com/products and
// the JSON is the document — there is no fetch or XHR to hook at all.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadInjector } from "./helpers/content-harness.mjs";

const read = (p) => readFile(new URL(`../${p}`, import.meta.url), "utf8");
const injector = await read("content/injector.js");
const worker = await read("background/service-worker.js");
const builder = await read("sidepanel/pipeline-builder.js");
const py = await read("script-gen/python-emitter.js");
const node = await read("script-gen/node-emitter.js");

const STARS = `
  <ul>
    <li class="row"><span class="t">Gut</span>
      <span class="stars"><i class="s f"></i><i class="s f"></i><i class="s f"></i><i class="s f"></i><i class="s"></i></span></li>
    <li class="row"><span class="t">Sapiens</span>
      <span class="stars"><i class="s f"></i><i class="s f"></i><i class="s f"></i><i class="s f"></i><i class="s f"></i></span></li>
    <li class="row"><span class="t">Grit</span>
      <span class="stars"><i class="s f"></i><i class="s f"></i><i class="s"></i><i class="s"></i><i class="s"></i></span></li>
  </ul>`;

// ── The count reader ─────────────────────────────────────────────────────────

test("a count field returns how many children match", async () => {
  const h = await loadInjector(STARS);
  const rows = await h.api._stepExtract({
    fields: [
      { name: "title", selector: ".t", type: "text" },
      {
        name: "rating",
        selector: ".stars",
        type: "count",
        countSelector: "i.f",
      },
    ],
  });
  // JSON round-trip: the rows come from jsdom's realm, so deepEqual on the
  // arrays themselves compares across realms and never matches.
  assert.deepEqual(
    JSON.parse(JSON.stringify(rows.map((r) => [r.title, r.rating]))),
    [
      ["Gut", "4"],
      ["Sapiens", "5"],
      ["Grit", "2"],
    ],
  );
});

test("counting nothing is zero, not a missing value", async () => {
  const h = await loadInjector(`<div class="stars"></div>`);
  const rows = await h.api._stepExtract({
    fields: [
      { name: "n", selector: ".stars", type: "count", countSelector: "i.f" },
    ],
  });
  assert.equal(rows[0].n, "0");
});

test("a count field with no selector refuses instead of returning 0", async () => {
  // Same contract as "attribute": a plausible wrong answer is worse than an
  // error, because nothing downstream can tell 0 from "never configured".
  const h = await loadInjector(STARS);
  await assert.rejects(
    () =>
      h.api._stepExtract({
        fields: [{ name: "rating", selector: ".stars", type: "count" }],
      }),
    /Count but has no selector/,
  );
});

test("a count field with a broken selector says so", async () => {
  const h = await loadInjector(STARS);
  await assert.rejects(
    () =>
      h.api._stepExtract({
        fields: [
          {
            name: "rating",
            selector: ".stars",
            type: "count",
            countSelector: "i[",
          },
        ],
      }),
    /not a valid selector/,
  );
});

// ── Every consumer knows the kind (G-01) ─────────────────────────────────────

test("the panel maps every detector kind to a reader", () => {
  const map = builder.slice(
    builder.indexOf("async function _insertDetectedTable"),
    builder.indexOf("const loop = {", builder.indexOf("_insertDetectedTable")),
  );
  for (const kind of ["count", "attr", "href", "src"]) {
    assert.ok(
      map.includes(`"${kind}"`),
      `_insertDetectedTable never mentions the "${kind}" kind`,
    );
  }
  assert.match(map, /countSelector: f\.countSelector/);
  assert.match(map, /attribute: f\.attribute/);
});

test("the detector carries what makes its columns readable", () => {
  // The columns were shaped for output with only name/selector/kind, so an
  // attr column arrived without its attribute name and failed at run time.
  return read("content/structure-detector.js").then((src) => {
    const shaped = src.slice(src.indexOf("const named = columns"));
    assert.match(shaped, /attribute: c\.attribute/);
    assert.match(shaped, /countSelector: c\.countSelector/);
  });
});

test("both emitters can carry a count field", () => {
  for (const [name, src] of [
    ["python", py],
    ["node", node],
  ]) {
    assert.ok(
      src.includes('field.type === "count"'),
      `the ${name} emitter drops count fields silently`,
    );
    assert.ok(
      src.includes("countSelector"),
      `the ${name} emitter never reads countSelector`,
    );
    assert.match(
      src,
      /\.count\(\)/,
      `the ${name} emitter does not actually count anything`,
    );
  }
});

// ── The sniffer relay ────────────────────────────────────────────────────────

test("the relay is registered with the same reach as the hook", () => {
  assert.match(worker, /SNIFFER_RELAY_ID/, "no relay registration at all");
  const enable = worker.slice(
    worker.indexOf("async function _enableSniffer"),
    worker.indexOf("async function _disableSniffer"),
  );
  assert.match(enable, /id: SNIFFER_RELAY_ID/);
  assert.match(enable, /js: \[INJECTOR_FILE\]/);
  assert.match(enable, /world: "ISOLATED"/);
  // Same matches as the MAIN-world hook: a relay with narrower reach drops
  // captures just as silently as no relay at all.
  const matches = [
    ...enable.matchAll(/matches: _snifferMatches\(targetOrigin\)/g),
  ];
  assert.equal(matches.length, 2, "the two scripts do not share their matches");
});

test("the relay is unregistered when the sniffer is", () => {
  const disable = worker.slice(
    worker.indexOf("async function _disableSniffer"),
  );
  assert.match(
    disable.slice(0, 800),
    /SNIFFER_SCRIPT_ID, SNIFFER_RELAY_ID/,
    "the relay would outlive the run that asked for it",
  );
});

test("a document that is itself an API response is reported", () => {
  assert.match(injector, /_reportDataDocument/);
  const fn = injector.slice(
    injector.indexOf("function _reportDataDocument"),
    injector.indexOf('if (document.readyState === "loading")'),
  );
  assert.match(fn, /document\.contentType/);
  assert.match(fn, /type: "network:sniff"/);
  assert.match(fn, /__fsDataDocReported/, "it would report on every call");
  assert.match(
    fn,
    /querySelector\("pre"\)/,
    "the JSON viewer keeps the raw bytes in a <pre>",
  );
});

test("the data-document type test accepts what APIs actually send", () => {
  const m = injector.match(/const _DATA_DOC_TYPE =\s*(\/.*\/i);/);
  assert.ok(m, "no content-type test found");
  const re = new RegExp(m[1].slice(1, -2), "i");
  for (const t of [
    "application/json",
    "application/vnd.api+json",
    "application/ld+json",
    "text/json",
    "application/xml",
    "text/csv",
    "application/x-ndjson",
  ]) {
    assert.ok(re.test(t), `${t} is not recognised as data`);
  }
  for (const t of ["text/html", "image/png", "application/pdf"]) {
    assert.ok(!re.test(t), `${t} should not be captured as an API response`);
  }
});

// ── The relay must not break the page it is registered on ───────────────────
//
// Registering injector.js as a content script means it can now be evaluated
// twice in one document: once by that registration, once by the on-demand
// injection a page step triggers. The two genuinely race.
//
// A classic script's top-level `const` becomes a lexical binding created at
// instantiation, before any statement runs — so the second evaluation threw
// `Identifier 'VQ_ORIGIN' has already been declared` and took the content
// script down with it. No runtime guard can catch that; the bindings have to
// stop being global.

test("injector.js can be evaluated twice in one document", async () => {
  const { JSDOM } = await import("jsdom");
  const vm = (await import("node:vm")).default;

  const dom = new JSDOM("<!doctype html><p>x</p>", {
    url: "https://x.test/",
    runScripts: "outside-only",
  });
  dom.window.chrome = {
    runtime: {
      getURL: (p) => `chrome-extension://test/${p}`,
      onMessage: { addListener() {} },
      sendMessage: () => Promise.resolve(),
      lastError: null,
    },
  };
  const src = injector.replace(
    /import\(chrome\.runtime\.getURL\("content\/overlay-engine\.js"\)\)[\s\S]*?\}\);\s*$/,
    "",
  );
  const ctx = dom.getInternalVMContext();
  vm.runInContext(src, ctx, { filename: "injector.js" });
  assert.doesNotThrow(
    () => vm.runInContext(src, ctx, { filename: "injector.js#2" }),
    "a second injection throws, so the content script is lost",
  );
  dom.window.close();
});

test("the guard runs before anything it has to protect", () => {
  // A guard placed after the declarations is decorative: the collision happens
  // at instantiation, which is before the guard exists.
  const body = injector.slice(injector.indexOf('"use strict";'));
  const guard = body.indexOf("globalThis.__fsInjected");
  const firstConst = body.indexOf("\nconst ");
  assert.ok(guard !== -1, "no re-entry guard at all");
  assert.ok(
    guard < firstConst || firstConst === -1,
    "a top-level const is declared before the guard",
  );
  assert.match(
    body.slice(guard - 200, guard + 120),
    /\(\(\) => \{/,
    "the file is not wrapped, so its bindings are still global",
  );
});

test("the sniffer does not inject blindly over a live document", () => {
  const enable = worker.slice(
    worker.indexOf("async function _enableSniffer"),
    worker.indexOf("async function _disableSniffer"),
  );
  assert.match(enable, /_ensureInjected\(tabId\)/);
  assert.ok(
    !/executeScript\(\{ target: \{ tabId \}, files: \[INJECTOR_FILE\] \}\)/.test(
      enable,
    ),
    "still injecting the relay without checking whether it is already there",
  );
});

// ── A designed refusal is not a crash ───────────────────────────────────────
//
// Pressing Test on API_SNIFFER, LOOP or EXPORT returns an explanation: these
// only mean something inside a run. The explanation is the intended answer, but
// the worker logged it through the same path as a genuine fault, so the console
// showed a red `handler-error` for a step that behaved exactly as designed —
// noise that hides the real errors beside it.

test("run-only steps refuse with an explanation, not an error", () => {
  assert.match(worker, /class ExplainedRefusal extends Error/);
  assert.match(worker, /throw new ExplainedRefusal\(RUN_ONLY_STEPS\[type\]\)/);
  const refusal = worker.slice(
    worker.indexOf("class ExplainedRefusal"),
    worker.indexOf("const RUN_ONLY_STEPS"),
  );
  assert.match(refusal, /this\.expected = true/);
});

test("the message the user reads is still the message that is sent", () => {
  // Downgrading the log level must not swallow the reply: the panel shows
  // err.message, and an empty one would leave Test looking like it did nothing.
  const katch = worker.slice(
    worker.indexOf("handler(payload ?? {}, sender)"),
    worker.indexOf("return true; // keep channel open"),
  );
  assert.match(katch, /err\.expected/);
  assert.match(katch, /handler-refused/);
  assert.match(
    katch,
    /sendResponse\(\{ ok: false, error: err\.message/,
    "the refusal must still reach the panel",
  );
});

test("a real fault is still logged as one", () => {
  // The branch that downgrades expected refusals must not swallow everything
  // else with it.
  const katch = worker.slice(
    worker.indexOf("handler(payload ?? {}, sender)"),
    worker.indexOf("return true; // keep channel open"),
  );
  assert.match(
    katch,
    /\} else \{\s*\n\s*logger\.error\(MODULE, "handler-error"/,
    "unexpected errors would now be logged nowhere",
  );
});

// ── J-30: the captures had nowhere to go ────────────────────────────────────
//
// With the relay fixed (J-26) the sniffer captures correctly — verified in a
// browser against an early fetch in <head>, an XHR, a cross-origin call and one
// fired on a timer: all four stored. It still read as broken, for two reasons
// that are both about what the user can see.
//
// The download button asked for `data:download`, which returns rows *and*
// networks, then used `rows` alone and announced "That run stored no rows" — so
// a run whose entire purpose was the sniffer reported collecting nothing while
// its captures sat unread in the reply it had just received.
//
// And the run log deliberately names only the first three captures, so on a
// site making forty calls the panel went silent for the rest of the run.

test("the download offers the captured requests, not just rows", () => {
  const fn = builder.slice(
    builder.indexOf("async function _downloadRunRows"),
    builder.indexOf("function _removeExtractField"),
  );
  assert.match(
    fn,
    /res\.result\?\.networks/,
    "the captures are still discarded",
  );
  assert.ok(
    !/if \(rows\.length === 0\) \{\s*\n\s*logToMonitor\(\s*\n?\s*"warn-log",\s*\n?\s*"That run stored no rows\."/.test(
      fn,
    ),
    "a sniffer-only run is still reported as having collected nothing",
  );
  assert.match(
    fn,
    /exportRows\(networks,/,
    "the captures are never written to a file",
  );
  // Rows and captures are different shapes; merging them would give one CSV a
  // column for every field of each.
  assert.match(fn, /_api\.csv/);
});

test("a run with captures and no rows still downloads something", () => {
  const fn = builder.slice(
    builder.indexOf("async function _downloadRunRows"),
    builder.indexOf("function _removeExtractField"),
  );
  const guard = fn.match(/if \(([^)]*length === 0[^)]*)\) \{/);
  assert.ok(guard, "no empty-run guard found");
  assert.match(
    guard[1],
    /networks\.length === 0/,
    "the guard bails out before it has looked at the captures",
  );
});

test("the capture count is broadcast as it climbs", () => {
  const intake = worker.slice(
    worker.indexOf('_registerHandler("network:sniff"'),
    worker.indexOf('_registerHandler("network:sniff"') + 3000,
  );
  assert.match(intake, /type: "pipeline:captures"/);
  assert.match(intake, /networks: n/);
});

test("the panel shows the count and reveals the readout", () => {
  assert.match(builder, /msg\.type === "pipeline:captures"/);
  const branch = builder.slice(
    builder.indexOf('msg.type === "pipeline:captures"'),
    builder.indexOf('msg.type === "pipeline:captures"') + 500,
  );
  assert.match(branch, /mon-apis-card/);
  assert.match(branch, /classList\.remove\("hidden"\)/);
  assert.match(branch, /mon-apis/);
});

test("the readout does not carry a previous run's count", async () => {
  const html = await read("sidepanel/index.html");
  assert.match(html, /id="mon-apis-card"/);
  assert.match(html, /id="mon-apis"/);
  // Hidden until a run actually captures something: a permanent "0 APIs" on
  // every run is a readout for something most pipelines never do.
  assert.match(html, /class="metric-card hidden" id="mon-apis-card"/);
  assert.match(
    builder,
    /getElementById\("mon-apis-card"\)\?\.classList\.add\("hidden"\)/,
  );
});

test("the relay listens from document_start, not document_end", () => {
  // The hook runs at document_start. With the relay at document_end there was
  // a window — the whole of parsing — where a capture was posted to a listener
  // that did not exist yet, and a page that fetches from an inline script sits
  // squarely inside it. Nothing reported an error; the capture was simply
  // gone, and the ajax challenge failed about one run in three.
  const enable = worker.slice(
    worker.indexOf("async function _enableSniffer"),
    worker.indexOf("async function _disableSniffer"),
  );
  const relay = enable.slice(enable.indexOf("id: SNIFFER_RELAY_ID"));
  assert.match(
    relay.slice(0, 400),
    /runAt: "document_start"/,
    "the relay would miss anything the page fetches while it is still parsing",
  );
});
