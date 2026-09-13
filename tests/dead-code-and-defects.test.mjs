// Regression tests for audit findings C-09, F-01, F-02, F-07, F-09, B-33 and
// B-34 — the dead half of the tree, and the last three defects in it.
//
// C-09: content/injector.js and content/smart-extractor.js were declared for
// <all_urls>, so both ran in every page the user visited, for a tool that acts
// on one tab at a time.
//
// F-01: eight modules were imported by nothing. Some were genuine duplicates of
// live code; one was written for a caller that never called it.
//
// F-02: data-sources/csv-parser.js and json-parser.js implement ingestion for a
// data-file input path that does not exist anywhere in the product.
//
// F-07: utils/strings.js held 210 lines of UI strings. Its only importer never
// referenced anything on it, and the panel hardcodes its text in index.html.
//
// F-09: rate-limiter.js was imported for two form-fill handlers that are
// themselves unreachable. Ethics gate 3 warned about request volume and nothing
// enforced it — while the emitted Python told its reader "MIN_DELAY_MS = 800 #
// Floor enforced by Verquill ethics engine".
//
// B-33: the three captcha pollers recursed once per attempt, 25 frames deep,
// with an undocumented two-minute budget.
//
// B-34: round-robin and sticky proxy selection advanced the same cursor.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = (p) => new URL(`../${p}`, import.meta.url);
const read = (p) => readFile(root(p), "utf8");

const manifest = JSON.parse(await read("manifest.json"));
const swSrc = await read("background/service-worker.js");
const injectorSrc = await read("content/injector.js");
const panelSrc = await read("sidepanel/pipeline-builder.js");

const gone = async (path) => {
  await assert.rejects(
    () => readFile(root(path), "utf8"),
    /ENOENT/,
    `${path} is still present`,
  );
};

// ── C-09: nothing runs on every page any more ────────────────────────────────

test("no content script is declared for every page", async () => {
  assert.equal(
    manifest.content_scripts,
    undefined,
    "injector and smart-extractor ran in every page the user visited",
  );
  // The reasoning used to sit in a "_comment_content_scripts" key, which made
  // Chrome warn on every load. It is in docs/MANIFEST.md now.
  const doc = await read("docs/MANIFEST.md");
  assert.match(doc, /injected on demand/, "and it is written down somewhere");
});

test("host access is kept, because the worker still needs it", () => {
  // <all_urls> host permission is what lets the worker fetch APIs and
  // robots.txt. Dropping it would break those; it is not what C-09 is about.
  assert.deepEqual(manifest.host_permissions, ["<all_urls>"]);
  assert.ok(manifest.permissions.includes("scripting"));
});

test("the worker injects on demand, and only once per tab", () => {
  const fn = swSrc.match(
    /async function _ensureInjected\(tabId\) \{[\s\S]*?\n\}/,
  )[0];
  // Ask before injecting — but ask every frame, not just the top document.
  // Pinging frame 0 and returning on its answer meant a frame that appeared
  // after the first injection never got the script at all (K-07).
  assert.match(
    fn,
    /func: \(\) => Boolean\(globalThis\.__fsInjected\)/,
    "ask before injecting",
  );
  assert.match(fn, /allFrames: true/, "the probe must reach every frame");
  assert.match(
    fn,
    /if \(missing\.length === 0\) return;/,
    "a second injection would double every reply",
  );
  assert.match(
    fn,
    /target: \{ tabId, frameIds: missing \}/,
    "only the frames that lack it",
  );
  assert.match(fn, /chrome\.scripting\.executeScript/);

  // The four specialists no longer ride along. Each is one step's worth of
  // code and they were 82 KB of the 201 KB parsed in every frame of every
  // page, for steps most pipelines do not contain (K-31).
  const files = swSrc.match(/const CONTENT_FILES = \[[\s\S]*?\];/)[0];
  assert.match(files, /"content\/injector\.js"/);
  for (const specialist of [
    "smart-extractor",
    "structure-detector",
    "page-data",
    "page-json",
  ]) {
    assert.ok(
      !files.includes(specialist),
      `${specialist} is back in the always-injected set`,
    );
    assert.ok(
      swSrc.includes(`content/${specialist}.js`),
      `${specialist} is not injected anywhere at all`,
    );
  }
});

test("a page that refuses injection says which pages those are", () => {
  const fn = swSrc.match(
    /async function _ensureInjected\(tabId\) \{[\s\S]*?\n\}/,
  )[0];
  assert.match(fn, /chrome:\/\/ pages, the Web Store and PDF viewers/);
});

test("the content script answers a ping", () => {
  assert.match(injectorSrc, /"fs:ping",/, "the type is owned");
  assert.match(injectorSrc, /case "fs:ping":\s*\n\s*return \{ ready: true \};/);
});

test("every path that talks to the page sets it up first", () => {
  const start = swSrc.match(
    /_registerHandler\(MSG\.PIPELINE_START[\s\S]*?\n\}\);/,
  )[0];
  assert.match(start, /await _ensureInjected\(runState\.tabId\)/);
  assert.match(
    start,
    /_runStates\.delete\(runId\)/,
    "a failed injection is not a live run",
  );

  const stepTest = swSrc.match(
    /_registerHandler\(MSG\.STEP_EXECUTE[\s\S]*?\n\}\);/,
  )[0];
  assert.match(stepTest, /await _ensureInjected\(targetTabId\)/);

  assert.match(
    swSrc,
    /_registerHandler\("content:ensure"/,
    "and the picker has a route",
  );
  assert.equal(
    (panelSrc.match(/_ensureContentReady\(tab\.id\)/g) ?? []).length,
    3,
    "all three picker entry points",
  );
});

// ── F-01 / F-02: the dead modules ────────────────────────────────────────────

test("modules that duplicated live code are gone", async () => {
  await gone("utils/deduplicator.js"); // superseded by _rowKey (D-07)
  await gone("content/smart-sleep.js"); // injector has its own waits, and
  // cannot import a module anyway
});

test("the data-source parsers are gone, with no input path to feed them", async () => {
  await gone("data-sources/csv-parser.js");
  await gone("data-sources/json-parser.js");
});

test("nothing still references the removed modules", async () => {
  for (const file of [
    "background/service-worker.js",
    "content/injector.js",
    "sidepanel/pipeline-builder.js",
    "exporters/row-formatters.js",
  ]) {
    const src = await read(file);
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    for (const name of [
      "csv-parser",
      "json-parser",
      "deduplicator",
      "smart-sleep",
    ]) {
      assert.ok(!code.includes(name), `${file} still imports ${name}`);
    }
  }
});

test("the save-dialog exporter is reached instead of deleted", async () => {
  // text-exporters.js and stream-writer.js were written for the File System
  // Access API save dialog, which a service worker cannot show and the side
  // panel can. Nothing imported either (F-01).
  assert.match(
    panelSrc,
    /import \{ exportRows \} from "\.\.\/exporters\/text-exporters\.js"/,
  );
  const fn = panelSrc.match(
    /async function _downloadRunRows\(runId\) \{[\s\S]*?\n\}/,
  )[0];
  assert.match(
    fn,
    /await exportRows\(rows, "csv", `verquill_\$\{runId\}\.csv`\)/,
  );
  assert.match(
    fn,
    /err\?\.name === "AbortError"/,
    "a cancelled dialog is not a failure",
  );

  const src = await read("exporters/text-exporters.js");
  assert.ok(!/NOT CURRENTLY REACHED/.test(src), "the header said it was dead");
});

test("Levenshtein has one implementation, not two", async () => {
  // This used to assert that content/field-auto-mapper.js imported the shared
  // module rather than carrying its own copy. That file has since been removed
  // outright: it was never reachable — no manifest entry, no injection-map
  // entry, and its own header said so — so the duplication it was policed for
  // cannot recur there.
  //
  // The rule it existed to enforce still holds, and now has a real consumer to
  // enforce it against: utils/extraction-schema.js uses fieldMatchScore to map
  // a model's returned keys onto the field names the user asked for.
  await gone("content/field-auto-mapper.js");

  const schema = await read("utils/extraction-schema.js");
  assert.match(schema, /from "\.\/levenshtein\.js"/);

  // And nothing anywhere has grown a second copy.
  const files = [
    "utils/extraction-schema.js",
    "sidepanel/pipeline-builder.js",
    "background/service-worker.js",
    "content/smart-extractor.js",
  ];
  for (const f of files) {
    const code = (await read(f))
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    assert.ok(
      !/function levenshteinDistance\(/.test(code),
      `${f} has grown its own Levenshtein`,
    );
  }
});

// ── F-07: the strings module ─────────────────────────────────────────────────

test("the unused strings module is gone, and its dead import with it", async () => {
  await gone("utils/strings.js");
  const proxy = await read("background/proxy-manager.js");
  assert.ok(
    !/utils\/strings\.js/.test(proxy),
    "its only importer never used it",
  );
});

// ── F-09: rate limiting that actually limits ─────────────────────────────────

test("steps that touch the page or the network are paced", () => {
  const fn = swSrc.match(/async function _executeSteps\([\s\S]*?\n\}\n/)[0];
  assert.match(fn, /if \(RATE_LIMITED_STEPS\.has\(resolvedStep\.type\)\)/);
  assert.match(fn, /await acquire\(_runDomain\(runState\)\)/);
});

test("the pacing excludes the steps that would double-count", () => {
  const set = swSrc.match(
    /const RATE_LIMITED_STEPS = new Set\([\s\S]*?\n\);/,
  )[0];
  for (const type of ["WAIT", "EXPORT", "LOOP", "IF_ELSE"]) {
    assert.ok(set.includes(`"${type}"`), `${type} should be excluded`);
  }
  assert.match(
    set,
    /ALL_STEP_TYPES\.filter/,
    "built from the registry, not a list",
  );
});

test("the bucket is keyed on the run's host", () => {
  const fn = swSrc.match(/function _runDomain\(runState\) \{[\s\S]*?\n\}/)[0];
  assert.match(fn, /new URL\(runState\?\.targetOrigin \?\? ""\)\.hostname/);
  assert.match(fn, /"default"/, "a run with no origin still gets a bucket");

  const run = new Function(`${fn}; return _runDomain;`)();
  assert.equal(run({ targetOrigin: "https://shop.test/x" }), "shop.test");
  assert.equal(run({ targetOrigin: "not a url" }), "default");
  assert.equal(run({}), "default");
  assert.equal(run(null), "default");
});

test("acquire loops instead of recursing", async () => {
  const src = await read("background/rate-limiter.js");
  const fn = src.match(/export async function acquire\([\s\S]*?\n\}/)[0];
  assert.match(fn, /for \(;;\) \{/);
  assert.ok(
    !/return acquire\(domain, count\)/.test(fn),
    "the recursion is gone",
  );
});

test("the token bucket really does block a burst", async () => {
  const { acquire, initBucket } = await import("../background/rate-limiter.js");
  initBucket("burst.test", { capacity: 2, refillRate: 1000 });

  const started = Date.now();
  await acquire("burst.test");
  await acquire("burst.test");
  assert.ok(Date.now() - started < 50, "the first two come from the bucket");

  await acquire("burst.test"); // has to wait for a refill
  assert.ok(
    Date.now() - started >= 1,
    "the third waited for the bucket to refill",
  );
});

// ── B-33 / B-34 ──────────────────────────────────────────────────────────────

test("captcha polling loops, and says how long it waited", async () => {
  const src = await read("background/api-key-manager.js");
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  for (const poller of [
    "_poll2captcha",
    "_pollAnticaptcha",
    "_pollCapsolver",
  ]) {
    const fn = code.match(
      new RegExp(`async function ${poller}\\([\\s\\S]*?\\n\\}`),
    )[0];
    assert.match(
      fn,
      /for \(let attempt = 0; attempt <= POLL_MAX_ATTEMPTS/,
      poller,
    );
    assert.ok(
      !new RegExp(`return ${poller}\\(`).test(fn),
      `${poller} still recurses`,
    );
    assert.match(
      fn,
      /POLL_TIMEOUT_MESSAGE\(/,
      `${poller} timeout is unexplained`,
    );
  }

  assert.match(src, /const POLL_INTERVAL_MS = 5000;/);
  assert.match(src, /const POLL_MAX_ATTEMPTS = 24;/);

  // The message states the real budget rather than leaving it to arithmetic.
  const msg = new Function(
    `${src.match(/const POLL_INTERVAL_MS[\s\S]*?POLL_TIMEOUT_MESSAGE = [\s\S]*?;/)[0]}
     return POLL_TIMEOUT_MESSAGE;`,
  )();
  assert.equal(
    msg("2captcha"),
    "2captcha did not return a solution within 125s.",
  );
});

test("round-robin and sticky proxy selection keep separate cursors", async () => {
  const src = await read("background/proxy-manager.js");
  assert.match(src, /let _stickyIndex = 0;/);

  const sticky = src.match(/case "sticky": \{[\s\S]*?\n {4}\}/)[0];
  assert.match(sticky, /alive\[_stickyIndex % alive\.length\]/);
  assert.ok(
    !/_rrIndex/.test(sticky),
    "sticky used to advance the round-robin cursor",
  );

  const rr = src.match(/case "round-robin": \{[\s\S]*?\n {4}\}/)[0];
  assert.match(rr, /_rrIndex = \(_rrIndex \+ 1\) % alive\.length/);

  assert.match(src, /_stickyIndex = 0;/, "and both reset together");
});

// ── Counts the docs quote ────────────────────────────────────────────────────
//
// Both numbers were stale by four steps and two steps respectively, which is
// what a hand-maintained count does. They are worth stating — a reader wants to
// know how much of a pipeline survives export — so they are checked here rather
// than dropped.

test("the README's export count matches the registry", async () => {
  const { STEP_TYPES } = await import("../utils/step-types.js");
  const facing = Object.values(STEP_TYPES).filter((t) => t.internal !== true);
  const unexportable = facing.filter((t) => t.exportable === false);

  const readme = await readFile(
    new URL("../README.md", import.meta.url),
    "utf8",
  );
  const claim = readme.match(
    /emitters cover \*\*(\d+) of the (\d+) step types\*\*/,
  );
  assert.ok(claim, "the README no longer states an export count");
  assert.equal(
    Number(claim[2]),
    facing.length,
    "the README's step-type total is stale",
  );
  assert.equal(
    Number(claim[1]),
    facing.length - unexportable.length,
    "the README's exportable count is stale",
  );

  // And every unexportable step has a row saying why, or the table is a list
  // that quietly lost one.
  for (const [name, meta] of Object.entries(STEP_TYPES)) {
    if (meta.internal === true || meta.exportable !== false) continue;
    assert.ok(
      readme.includes(`\`${name}\``),
      `${name} cannot be exported and the README does not say so`,
    );
  }
});

test("the capability review's step count matches the registry", async () => {
  const { STEP_TYPES } = await import("../utils/step-types.js");
  const all = Object.values(STEP_TYPES);
  const internal = all.filter((t) => t.internal === true).length;

  const doc = await readFile(
    new URL("../docs/CAPABILITY_REVIEW.md", import.meta.url),
    "utf8",
  );
  const claim = doc.match(
    /(\d+) user-facing step types.*?plus (\d+) internal/s,
  );
  assert.ok(claim, "the review no longer states a step count");
  assert.equal(Number(claim[1]), all.length - internal);
  assert.equal(Number(claim[2]), internal);
});
