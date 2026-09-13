// Reading the structured data a page already publishes.
//
// Most real sites embed JSON-LD, Schema.org microdata, or Open Graph tags:
// clean, typed, already-structured data, put there deliberately for machines to
// read. Verquill ignored all of it and asked the user for CSS selectors
// instead — selectors that break the next time the site's designer touches a
// class name, describing data the site was handing out for free.
//
// smart-extractor.js does read JSON-LD, but only looking for `@type: Product`.
// Everything else on the page — a recipe, a job posting, an article, an event,
// a business's address and opening hours — was invisible.
//
// This is also the answer to "can we turn the page into JSON": for a
// single-record page, which Detect Table cannot help with at all, this is
// exactly that, with no selectors involved.
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const SOURCE = new URL("../content/page-data.js", import.meta.url);
const source = await readFile(SOURCE, "utf8");

/** Load page-data.js into a page and call it. */
function read(html, config = {}) {
  const dom = new JSDOM(
    `<!doctype html><html><head></head><body>${html}</body></html>`,
    {
      url: "https://shop.test/p/1",
      runScripts: "outside-only",
    },
  );
  vm.runInContext(source, dom.getInternalVMContext(), {
    filename: "page-data.js",
  });
  const out = dom.window.__vqReadPageData(config);
  dom.window.close();
  return out;
}

const LD = (obj) =>
  `<script type="application/ld+json">${JSON.stringify(obj)}</script>`;

// ── JSON-LD ──────────────────────────────────────────────────────────────────

test("a JSON-LD block comes back as the object the site published", () => {
  const out = read(
    LD({
      "@context": "https://schema.org",
      "@type": "Product",
      name: "Widget",
      offers: { "@type": "Offer", price: "10.00", priceCurrency: "USD" },
    }),
  );
  assert.equal(out.records.length, 1);
  assert.equal(out.records[0].name, "Widget");
  assert.equal(out.records[0].offers.price, "10.00");
  assert.equal(out.records[0]["@type"], "Product");
});

test("every type is read, not only Product", () => {
  // The existing reader in smart-extractor.js hunts for @type Product and
  // returns null for anything else, which is most of the web.
  for (const type of [
    "Recipe",
    "JobPosting",
    "Article",
    "Event",
    "LocalBusiness",
  ]) {
    const out = read(LD({ "@type": type, name: `A ${type}` }));
    assert.equal(out.records[0]["@type"], type, `${type} was not read`);
  }
});

test("a @graph is flattened into its nodes", () => {
  // WordPress and Yoast publish one block containing a graph of everything on
  // the page. Reading the wrapper and stopping finds nothing usable.
  const out = read(
    LD({
      "@context": "https://schema.org",
      "@graph": [
        { "@type": "WebSite", name: "Shop" },
        { "@type": "Product", name: "Widget" },
      ],
    }),
  );
  assert.equal(out.records.length, 2);
  // JSON round-trip: the objects come from a jsdom realm, so deepEqual
  // compares them against a foreign Array prototype and fails on identical
  // contents.
  assert.deepEqual(
    JSON.parse(JSON.stringify(out.records.map((r) => r["@type"]).sort())),
    ["Product", "WebSite"],
  );
});

test("several blocks, and arrays inside them, all come back", () => {
  const out = read(
    LD([
      { "@type": "Product", name: "A" },
      { "@type": "Product", name: "B" },
    ]) + LD({ "@type": "Organization", name: "C" }),
  );
  assert.equal(out.records.length, 3);
});

test("one malformed block does not lose the others", () => {
  // Broken JSON-LD is extremely common. Throwing would mean a page with one bad
  // block reports nothing at all.
  const out = read(
    `<script type="application/ld+json">{ not json </script>` +
      LD({ "@type": "Product", name: "Widget" }),
  );
  assert.equal(out.records.length, 1);
  assert.equal(out.records[0].name, "Widget");
  assert.equal(out.warnings.length, 1, "and it says one block was unreadable");
});

test("a type filter keeps only what was asked for", () => {
  const out = read(
    LD({ "@type": "WebSite", name: "Shop" }) +
      LD({ "@type": "Product", name: "Widget" }),
    { type: "Product" },
  );
  assert.equal(out.records.length, 1);
  assert.equal(out.records[0].name, "Widget");
});

// ── Microdata ────────────────────────────────────────────────────────────────

test("microdata is read when there is no JSON-LD", () => {
  const out = read(`
    <div itemscope itemtype="https://schema.org/Product">
      <span itemprop="name">Widget</span>
      <span itemprop="sku">W-1</span>
      <div itemprop="offers" itemscope itemtype="https://schema.org/Offer">
        <span itemprop="price">10.00</span>
      </div>
    </div>`);
  assert.equal(out.records[0]["@type"], "Product");
  assert.equal(out.records[0].name, "Widget");
  assert.equal(out.records[0].sku, "W-1");
  assert.equal(out.records[0].offers.price, "10.00", "nested scopes nest");
});

test("microdata reads the machine-readable value, not the rendered one", () => {
  // <meta itemprop> and <time datetime> exist precisely because the visible
  // text is formatted for people. Reading the text gets "3 days ago".
  const out = read(`
    <div itemscope itemtype="https://schema.org/Event">
      <meta itemprop="startDate" content="2026-04-20T17:00:00Z">
      <time itemprop="endDate" datetime="2026-04-20T19:00:00Z">7pm</time>
      <a itemprop="url" href="/e/1">Details</a>
      <img itemprop="image" src="/i/1.jpg">
    </div>`);
  const r = out.records[0];
  assert.equal(r.startDate, "2026-04-20T17:00:00Z");
  assert.equal(r.endDate, "2026-04-20T19:00:00Z");
  assert.equal(r.url, "https://shop.test/e/1", "and links come back absolute");
  assert.equal(r.image, "https://shop.test/i/1.jpg");
});

test("a repeated itemprop becomes a list", () => {
  const out = read(`
    <div itemscope itemtype="https://schema.org/Recipe">
      <span itemprop="recipeIngredient">Flour</span>
      <span itemprop="recipeIngredient">Water</span>
      <span itemprop="recipeIngredient">Salt</span>
    </div>`);
  assert.deepEqual(
    JSON.parse(JSON.stringify(out.records[0].recipeIngredient)),
    ["Flour", "Water", "Salt"],
  );
});

// ── Meta tags ────────────────────────────────────────────────────────────────

test("Open Graph and friends come back as page-level facts", () => {
  const out = read(
    `<meta property="og:title" content="Widget">
     <meta property="og:image" content="/i/1.jpg">
     <meta name="twitter:card" content="summary">
     <meta name="description" content="A widget.">`,
  );
  assert.equal(out.meta["og:title"], "Widget");
  assert.equal(
    out.meta["og:image"],
    "https://shop.test/i/1.jpg",
    "URLs absolute",
  );
  assert.equal(out.meta["twitter:card"], "summary");
  assert.equal(out.meta.description, "A widget.");
});

test("the page's own identity is always reported", () => {
  const out = read(`<meta name="x" content="y">`);
  assert.equal(out.url, "https://shop.test/p/1");
  assert.equal(typeof out.title, "string");
});

// ── Nothing there ────────────────────────────────────────────────────────────

test("a page with no structured data says so, rather than inventing some", () => {
  const out = read(`<h1>Hello</h1><p>Just a page.</p>`);
  assert.equal(out.records.length, 0);
  assert.equal(out.found, false);
  assert.match(out.reason, /no structured data|nothing/i);
});

test("Open Graph alone still counts as something found", () => {
  const out = read(`<meta property="og:title" content="Widget">`);
  assert.equal(out.found, true);
});

// ── Flattening, for a CSV ────────────────────────────────────────────────────

test("a record can be flattened into one row of scalars", () => {
  // A spreadsheet has no cell type for a nested object. Left nested, an export
  // writes "[object Object]" into the price column.
  const out = read(
    LD({
      "@type": "Product",
      name: "Widget",
      offers: { price: "10.00", priceCurrency: "USD" },
      keywords: ["a", "b"],
    }),
    { flatten: true },
  );
  const row = out.records[0];
  assert.equal(row.name, "Widget");
  assert.equal(row["offers.price"], "10.00");
  assert.equal(row["offers.priceCurrency"], "USD");
  assert.equal(row.keywords, "a, b");
  assert.ok(
    Object.values(row).every((v) => typeof v !== "object" || v === null),
    "nothing nested survives flattening",
  );
});

test("flattening does not run away on a self-referential graph", () => {
  // JSON-LD graphs really do contain cycles once @id references are resolved,
  // and a naive walk hangs the tab.
  const out = read(
    `<script type="application/ld+json">
     {"@type":"Product","name":"W","brand":{"@type":"Brand","name":"B"}}
     </script>`,
    { flatten: true },
  );
  assert.equal(out.records[0]["brand.name"], "B");
});

// ── as a step ────────────────────────────────────────────────────────────────

import {
  reset,
  onContentMessage,
  startRun,
  endRun,
  _dispatchStep,
} from "./helpers/worker-harness.mjs";

const step = (type, config = {}) => ({ id: `s_${type}`, type, config });
const ctx = () => ({ extracted: {} });

test("PAGE_DATA's records become rows, like EXTRACT's", async () => {
  // The whole point is that it produces data you can export. Storing it only
  // in the template context would mean a step that finds a product and exports
  // an empty file.
  reset();
  const { runId, runState } = startRun();
  onContentMessage(() => ({
    ok: true,
    result: {
      found: true,
      url: "https://shop.test/p/1",
      title: "Widget",
      records: [{ name: "Widget", "offers.price": "10.00" }],
      meta: { "og:title": "Widget" },
      sources: ["json-ld"],
      warnings: [],
      reason: "",
    },
  }));

  const context = ctx();
  await _dispatchStep(step("PAGE_DATA", { flatten: true }), 1, runId, context);

  assert.equal(runState.results.length, 1);
  assert.equal(runState.results[0].name, "Widget");
  assert.equal(
    context.extracted.name,
    "Widget",
    "and later steps can template off it",
  );
  await endRun(runId);
});

test("PAGE_DATA stores the whole reading under its configured name", async () => {
  reset();
  const { runId } = startRun();
  onContentMessage(() => ({
    ok: true,
    result: {
      found: true,
      records: [{ name: "W" }],
      meta: { "og:title": "W" },
      sources: ["json-ld"],
      warnings: [],
    },
  }));

  const context = ctx();
  await _dispatchStep(step("PAGE_DATA", { storeAs: "ld" }), 1, runId, context);
  assert.equal(context.ld.meta["og:title"], "W");
  assert.equal(context.ld.records[0].name, "W");
  await endRun(runId);
});

test("a page with nothing on it does not fail the run, and says why", async () => {
  // Failing would stop a pipeline that reads many pages when one of them has
  // no markup. Silently producing nothing would leave the user guessing.
  reset();
  const { runId, runState } = startRun();
  onContentMessage(() => ({
    ok: true,
    result: {
      found: false,
      records: [],
      meta: {},
      sources: [],
      warnings: [],
      reason: "This page publishes no structured data",
    },
  }));

  await _dispatchStep(step("PAGE_DATA", {}), 1, runId, ctx());
  assert.equal(runState.results.length, 0);
  await endRun(runId);
});

test("PAGE_DATA is offered in the palette and has its own config UI", async () => {
  const { STEP_TYPES } = await import("../utils/step-types.js");
  assert.ok(STEP_TYPES.PAGE_DATA, "it is in the registry");
  assert.ok(!STEP_TYPES.PAGE_DATA.internal, "and users can add it");

  const panel = await readFile(
    new URL("../sidepanel/pipeline-builder.js", import.meta.url),
    "utf8",
  );
  const body = panel.slice(panel.indexOf("function generateConfigHtml"));
  assert.match(body, /step\.type === "PAGE_DATA"/);
});

test("page-data.js is injected when a PAGE_DATA step asks for it", async () => {
  // It used to ride along with every injection, into every frame of every
  // page, for a step most pipelines do not contain. Now the message that needs
  // it brings it (K-31) — and the injector already had the "not loaded in this
  // page" error for the case where it is missing, which is what made splitting
  // it safe.
  const sw = await readFile(
    new URL("../background/service-worker.js", import.meta.url),
    "utf8",
  );
  const map = sw.match(
    /const ON_DEMAND_FILES = Object\.freeze\(\{[\s\S]*?\}\);/,
  )[0];
  assert.match(map, /PAGE_DATA: "content\/page-data\.js"/);

  const always = sw.match(/const CONTENT_FILES = \[[\s\S]*?\];/)[0];
  assert.ok(
    !always.includes("page-data"),
    "page-data.js is still injected into every page",
  );

  // Every frame, like the injector itself: a selector picked inside an iframe
  // is answered by that frame, and a reader present only in the top document
  // would leave it saying "not loaded".
  const fn = sw.match(/async function _ensureOnDemand\([\s\S]*?\n\}/)[0];
  assert.match(fn, /allFrames: true/);
});
