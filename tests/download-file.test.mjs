// Behavioural tests for DOWNLOAD_FILE — capability review gap K-23.
//
// "Get every product image" ended as a column of URLs and no files: nothing in
// the pipeline could put a file on disk, and the `downloads` permission the
// manifest already carried was spent entirely on the export.
//
// Two things here are worth more than the rest. The first is the filename: the
// name of a downloaded file is built from values the *page* supplied, so a
// product called `../../../autostart` must not be able to write outside the
// download directory. The second is the counting: a step that saves nine of ten
// files and reports success is the failure mode this codebase is written
// against, so the failures are named and a step that saved nothing throws.
import test from "node:test";
import assert from "node:assert/strict";
import {
  calls,
  reset,
  onContentMessage,
  startRun,
  endRun,
  _dispatchStep,
  _executeStepList,
  _resolveDownloadPath,
  _safeSegment,
} from "./helpers/worker-harness.mjs";
import { loadInjector } from "./helpers/content-harness.mjs";
import { STEP_TYPES, USER_STEP_TYPES } from "../utils/step-types.js";

const step = (config, extra = {}) => ({
  id: "s_dl",
  type: "DOWNLOAD_FILE",
  config,
  ...extra,
});

const ctx = () => ({ extracted: {} });

/** Answer a DOWNLOAD_COLLECT with the URLs a page would have reported. */
function pageHas(urls, extra = {}) {
  onContentMessage((payload) => {
    if (payload.type !== "DOWNLOAD_COLLECT") return { ok: true, result: null };
    return {
      ok: true,
      result: {
        urls: urls.map((u) => (typeof u === "string" ? { url: u } : u)),
        matched: urls.length,
        skipped: [],
        ...extra,
      },
    };
  });
}

const logsMatching = (re) =>
  calls.runtimeMessages
    .map((m) => m?.payload?.message ?? "")
    .filter((m) => re.test(m));

// ── The filename, which is where the page gets a say ─────────────────────────

test("a path separator from the page cannot make a directory", () => {
  assert.equal(_safeSegment("../../etc/passwd"), "etc_passwd");
  assert.equal(_safeSegment("..\\..\\windows\\system32"), "windows_system32");
  assert.equal(_safeSegment(".."), "");
  assert.equal(_safeSegment("..."), "");
});

test("a filename template keeps the author's folders and refuses the page's", () => {
  const facts = { index: 1, name: "shot.png", stem: "shot", ext: "png" };
  const path = _resolveDownloadPath(
    "products/{{item.title}}/{{file.name}}",
    { item: { title: "../../.ssh" }, file: facts },
    facts,
  );
  assert.equal(path, "products/ssh/shot.png");
  assert.ok(!path.includes(".."), "no traversal survives");
  assert.equal(
    path.split("/").length,
    3,
    "only the two slashes the author typed",
  );
});

test("a page-supplied filename that is nothing but traversal still names a file", () => {
  const facts = { index: 4, name: "../../../evil.sh", stem: "", ext: "sh" };
  const path = _resolveDownloadPath("{{file.name}}", { file: facts }, facts);
  assert.equal(path, "evil.sh");
});

test("a template naming a field that is not there keeps the folder", () => {
  // Found by an adversarial pass over the builder rather than by a failing
  // run. Filtering empty segments out before taking the last one promoted the
  // *folder* into the filename: `shots/{{missing}}` saved every file in the
  // run as `shots.jpg`, each overwriting the last, and the folder the author
  // asked for was gone. A missing field is a typo, and a typo should cost a
  // name, not a directory and the whole set of files.
  const facts = { index: 7, name: "photo.jpg", stem: "photo", ext: "jpg" };
  const path = _resolveDownloadPath(
    "shots/{{nope.missing}}",
    { file: facts },
    facts,
  );
  assert.equal(path, "shots/photo.jpg");
});

test("a name the template left without an extension gets the URL's", () => {
  const facts = { index: 2, name: "cover.jpg", stem: "cover", ext: "jpg" };
  assert.equal(
    _resolveDownloadPath(
      "{{file.index}}-{{file.stem}}",
      { file: facts },
      facts,
    ),
    "2-cover.jpg",
  );
});

// ── The step itself ──────────────────────────────────────────────────────────

test("every matched URL is downloaded, under the name the template asks for", async () => {
  reset();
  const { runId } = startRun();
  pageHas([
    "https://cdn.shop.test/img/widget.jpg",
    "https://cdn.shop.test/img/gadget.png",
  ]);

  const context = ctx();
  await _dispatchStep(
    step({
      selector: ".gallery img",
      filename: "shots/{{file.index}}-{{file.name}}",
    }),
    1,
    runId,
    context,
  );

  assert.deepEqual(
    calls.downloads.map((d) => d.filename),
    ["shots/1-widget.jpg", "shots/2-gadget.png"],
  );
  assert.equal(calls.downloads[0].url, "https://cdn.shop.test/img/widget.jpg");
  assert.equal(context.downloads.saved, 2);
  assert.equal(context.downloads.failed, 0);
  await endRun(runId);
});

test("the selector is sent to the page with the loop's record in context", async () => {
  reset();
  const { runId } = startRun();
  pageHas(["https://cdn.shop.test/a.jpg"]);

  await _executeStepList(
    [step({ selector: "img", filename: "{{file.name}}" })],
    1,
    runId,
    { extracted: {}, loop: { selector: ".product", index0: 3, index: 4 } },
  );

  const sent = calls.contentMessages.find(
    (m) => m.payload.type === "DOWNLOAD_COLLECT",
  );
  assert.ok(sent, "the page was asked which URLs the selector matches");
  assert.equal(sent.payload.config.selector, "img");
  assert.equal(
    sent.payload.__vqContext.loop.index0,
    3,
    "so _queryScoped resolves it against the record the loop is on",
  );
  await endRun(runId);
});

test("the filename template survives the run's own template pass", async () => {
  // _resolveConfig runs over every step before dispatch, and {{file.name}}
  // names something that does not exist until a file is picked — so resolving
  // it there blanked it, and every file landed under the same name.
  reset();
  const { runId } = startRun();
  pageHas(["https://cdn.shop.test/a.jpg", "https://cdn.shop.test/b.jpg"]);

  await _executeStepList(
    [step({ selector: "img", filename: "verquill/{{file.name}}" })],
    1,
    runId,
    ctx(),
  );

  assert.deepEqual(
    calls.downloads.map((d) => d.filename),
    ["verquill/a.jpg", "verquill/b.jpg"],
  );
  await endRun(runId);
});

test("a URL the browser will not fetch is refused rather than handed over", async () => {
  reset();
  const { runId } = startRun();
  pageHas(["javascript:alert(1)", "https://cdn.shop.test/real.pdf"]);

  const context = ctx();
  await _dispatchStep(step({ selector: "a" }), 1, runId, context);

  assert.equal(calls.downloads.length, 1, "only the http one was downloaded");
  assert.equal(context.downloads.failed, 1);
  assert.match(context.downloads.failures[0].reason, /http, https and data/);
  await endRun(runId);
});

test("a failed download is counted and named, not swallowed", async () => {
  reset();
  const { runId } = startRun();
  pageHas(["https://cdn.shop.test/a.jpg", "https://cdn.shop.test/b.jpg"]);
  const real = chrome.downloads.download;
  chrome.downloads.download = async (opts) => {
    if (opts.url.endsWith("b.jpg")) throw new Error("Network failed");
    return real(opts);
  };

  const context = ctx();
  try {
    await _dispatchStep(step({ selector: "img" }), 1, runId, context);
  } finally {
    chrome.downloads.download = real;
  }

  assert.equal(context.downloads.saved, 1);
  assert.equal(context.downloads.failed, 1);
  assert.equal(logsMatching(/b\.jpg — Network failed/).length, 1);
  assert.equal(logsMatching(/Downloaded 1 file, 1 failed/).length, 1);
  await endRun(runId);
});

test("finding files and saving none of them fails the step", async () => {
  reset();
  const { runId } = startRun();
  pageHas(["https://cdn.shop.test/a.jpg"]);
  const real = chrome.downloads.download;
  chrome.downloads.download = async () => {
    throw new Error("Download interrupted");
  };

  try {
    await assert.rejects(
      () => _dispatchStep(step({ selector: "img" }), 1, runId, ctx()),
      /saved none of the 1 file/,
    );
  } finally {
    chrome.downloads.download = real;
  }
  await endRun(runId);
});

test("a selector that matches nothing warns and does not fail the run", async () => {
  reset();
  const { runId } = startRun();
  pageHas([]);

  const context = ctx();
  await _dispatchStep(step({ selector: ".nope" }), 1, runId, context);

  assert.equal(calls.downloads.length, 0);
  assert.equal(context.downloads.saved, 0);
  assert.equal(logsMatching(/nothing matched "\.nope"/).length, 1);
  await endRun(runId);
});

test("a URL the author typed is held to the pipeline's declared origins", async () => {
  reset();
  const { runId } = startRun();

  await assert.rejects(
    () =>
      _dispatchStep(
        step({ url: "https://evil.test/payload.exe" }),
        1,
        runId,
        ctx(),
      ),
    /UndeclaredOrigin|evil\.test/,
  );
  assert.equal(calls.downloads.length, 0);
  await endRun(runId);
});

test("files from an origin the pipeline never declared are named in the log", async () => {
  reset();
  const { runId } = startRun();
  pageHas(["https://cdn.elsewhere.test/a.jpg"]);

  await _dispatchStep(step({ selector: "img" }), 1, runId, ctx());

  assert.equal(calls.downloads.length, 1, "a CDN is normal and is not blocked");
  assert.equal(logsMatching(/cdn\.elsewhere\.test.*never declared/s).length, 1);
  await endRun(runId);
});

test("the step stops at the limit it was given", async () => {
  reset();
  const { runId } = startRun();
  pageHas([
    "https://cdn.shop.test/1.jpg",
    "https://cdn.shop.test/2.jpg",
    "https://cdn.shop.test/3.jpg",
  ]);

  await _dispatchStep(step({ selector: "img", max: 2 }), 1, runId, ctx());

  assert.equal(calls.downloads.length, 2);
  assert.equal(logsMatching(/3 files matched, 2 downloaded/).length, 1);
  await endRun(runId);
});

// ── The half that runs in the page ───────────────────────────────────────────

const collect = (config, context = {}) => ({
  type: "DOWNLOAD_COLLECT",
  config,
  __vqContext: context,
});

test("the page reports absolute URLs from links and images alike", async () => {
  const h = await loadInjector(`
    <a class="dl" href="/files/report.pdf">Report</a>
    <img class="dl" src="img/photo.jpg" alt="A photo">
    <span class="dl">nothing here</span>
  `);
  const r = await h.api._executeStep(collect({ selector: ".dl" }));

  assert.deepEqual(
    [...r.urls].map((u) => String(u.url)),
    [
      "https://example.test/files/report.pdf",
      "https://example.test/img/photo.jpg",
    ],
    "relative URLs are resolved against the page, which is the only place that can",
  );
  assert.equal(r.matched, 3);
  assert.equal(r.skipped.length, 1);
  assert.match(r.skipped[0].reason, /<span> carries no URL/);
  h.close();
});

test("a lazy-loaded image reports the real file, not the placeholder", async () => {
  // The common shape on any gallery worth scraping: src holds a spacer until
  // the image scrolls in, and the file is parked in a data- attribute.
  const h = await loadInjector(
    `<img id="lazy" data-src="https://cdn.test/full/widget.jpg">`,
  );
  const r = await h.api._executeStep(collect({ selector: "#lazy" }));
  assert.equal(String(r.urls[0].url), "https://cdn.test/full/widget.jpg");
  h.close();
});

test("an attribute the user names is read instead of the guess", async () => {
  const h = await loadInjector(
    `<img id="p" src="/thumb.jpg" data-full="/full.jpg">`,
  );
  const r = await h.api._executeStep(
    collect({ selector: "#p", attr: "data-full" }),
  );
  assert.equal(String(r.urls[0].url), "https://example.test/full.jpg");
  h.close();
});

test("inside a loop only the current record's files are reported", async () => {
  const h = await loadInjector(`
    <div class="product"><img src="/a.jpg"></div>
    <div class="product"><img src="/b.jpg"></div>
  `);
  const r = await h.api._executeStep(
    collect({ selector: "img" }, { loop: { selector: ".product", index0: 1 } }),
  );
  assert.deepEqual(
    [...r.urls].map((u) => String(u.url)),
    ["https://example.test/b.jpg"],
  );
  h.close();
});

// ── The registry ─────────────────────────────────────────────────────────────

test("DOWNLOAD_FILE is a user step that runs in the worker", () => {
  assert.ok(USER_STEP_TYPES.includes("DOWNLOAD_FILE"));
  assert.equal(STEP_TYPES.DOWNLOAD_FILE.runsIn, "background");
  assert.equal(
    STEP_TYPES.DOWNLOAD_COLLECT.runsIn,
    "page",
    "the half that reads the URLs belongs to the page",
  );
  assert.ok(STEP_TYPES.DOWNLOAD_COLLECT.internal);
});
