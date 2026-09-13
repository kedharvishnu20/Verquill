// Where each field actually came from.
//
// A row carried one `_extractionMethod` for all of it. On a real page that is
// a plain untruth: `name` comes from the site's JSON-LD, `price` from a
// heuristic reading of the markup, `brand` from a model — and the row says
// "json-ld", because layer 1 answered first and the label was taken from the
// layer, not from the field.
//
// That matters more here than it would elsewhere, because the layers are not
// equally trustworthy. A publisher's own structured data is an assertion about
// its own page. A heuristic is this extension guessing which `<span>` looked
// like a price. A model's answer is a model's answer, verified against the page
// text or not. Averaging those into one number and one word throws away the
// only thing that tells a user which cells to check.
//
// So: every field says what answered it, how sure that source was, and — for
// the model — whether the value was found on the page.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import * as prov from "../utils/extraction-provenance.js";
import {
  GROUND_EXACT,
  GROUND_UNPROVEN,
} from "../utils/extraction-grounding.js";

const {
  buildProvenance,
  describeSource,
  summarise,
  provenanceColumn,
  SOURCE_FREE,
  SOURCE_MODEL,
  SOURCE_NONE,
} = prov;

// ── Naming a source ──────────────────────────────────────────────────────────

test("a source keeps the site's own key, not just the layer that read it", () => {
  // "json-ld" tells you the layer. `datePublished` tells you what the site
  // actually claimed, which is the part a person can go and check.
  const d = describeSource("json-ld:datePublished");
  assert.equal(d.kind, "json-ld");
  assert.equal(d.detail, "datePublished");
  assert.match(d.label, /datePublished/);
  assert.equal(d.trust, SOURCE_FREE);
});

test("a meta key with colons in it survives", () => {
  // `og:title`, `article:published_time` — splitting on every colon would
  // report the source as `og`.
  const d = describeSource("meta:og:title");
  assert.equal(d.kind, "meta");
  assert.equal(d.detail, "og:title");
});

test("a guess is described as a guess", () => {
  const d = describeSource("heuristic");
  assert.equal(d.trust, SOURCE_FREE);
  assert.match(
    d.label,
    /guess/i,
    "'heuristic' is this extension deciding which element looked like a price",
  );
});

test("a model is not filed with the page's own data", () => {
  assert.equal(describeSource("llm").trust, SOURCE_MODEL);
  assert.equal(describeSource("none").trust, SOURCE_NONE);
  assert.equal(
    describeSource(undefined).trust,
    SOURCE_NONE,
    "a field with no recorded source must not be reported as a free one",
  );
});

// ── The record ───────────────────────────────────────────────────────────────

const ROW = {
  fields: ["name", "price", "brand", "sku"],
  result: { name: "Blue Widget", price: "10.00", brand: "Acme", sku: null },
  perField: { name: 98, price: 60, brand: 88, sku: 0 },
  from: { name: "json-ld:name", price: "heuristic", brand: "llm", sku: "none" },
  grounding: { brand: GROUND_EXACT },
};

test("one row, four fields, four different answers", () => {
  const rows = buildProvenance(ROW);
  assert.deepEqual(
    rows.map((r) => r.field),
    ["name", "price", "brand", "sku"],
    "in the order asked for, so the record lines up with the columns",
  );
  assert.equal(rows[0].kind, "json-ld");
  assert.equal(rows[1].kind, "heuristic");
  assert.equal(rows[2].kind, "llm");
  assert.equal(rows[3].kind, "none");
  assert.equal(rows[1].confidence, 60);
});

test("a model answer found on the page is marked verified; nothing else claims it", () => {
  const rows = buildProvenance(ROW);
  const brand = rows.find((r) => r.field === "brand");
  assert.equal(brand.verified, true);
  // The free layers read the page directly. Calling them "verified" would put
  // the same badge on two different claims.
  assert.equal(rows.find((r) => r.field === "name").verified, false);
});

test("a value too short to prove is not badged as proven", () => {
  const rows = buildProvenance({
    ...ROW,
    grounding: { brand: GROUND_UNPROVEN },
  });
  const brand = rows.find((r) => r.field === "brand");
  assert.equal(brand.verified, false);
  assert.match(
    brand.note,
    /not proven|too short/i,
    "silence here reads as 'unverified'; it is 'unprovable', which is different",
  );
});

test("an empty field is empty, not a low-confidence value", () => {
  const rows = buildProvenance(ROW);
  const sku = rows.find((r) => r.field === "sku");
  assert.equal(sku.value, null);
  assert.equal(sku.confidence, 0);
});

// ── What it is for ───────────────────────────────────────────────────────────

test("the summary says how much of the row was free", () => {
  // The question a user actually has: how much of this did the page tell us,
  // and how much did something guess?
  const text = summarise(buildProvenance(ROW));
  assert.match(text, /2 from the page/);
  assert.match(text, /1 from a model/);
  assert.match(text, /1 empty/);
});

test("the summary counts what was verified, because that is the claim", () => {
  assert.match(summarise(buildProvenance(ROW)), /verified/);
  const unchecked = summarise(buildProvenance({ ...ROW, grounding: {} }));
  assert.ok(
    !/verified/.test(unchecked),
    "with the check off, the summary must not imply it ran",
  );
});

// ── Export shape ─────────────────────────────────────────────────────────────

test("the export gains no column unless asked for", () => {
  const src = readFileSync(
    new URL("../background/service-worker.js", import.meta.url),
    "utf8",
  );
  // Provenance is per-field and a CSV cell is not. Adding a JSON blob to every
  // row by default would change the shape of every existing export for a
  // detail most runs do not need.
  assert.match(src, /config\.provenance/);
  assert.match(src, /_confidence: extraction\.overallConfidence/);
  assert.match(src, /_extractionMethod: extraction\.method/);
});

test("the optional column is one cell a person can read", () => {
  const cell = provenanceColumn(buildProvenance(ROW));
  assert.match(cell, /name=json-ld/);
  assert.match(cell, /brand=llm/);
  assert.match(cell, /verified/);
  assert.ok(
    !/\n/.test(cell),
    "a newline inside a CSV cell is a support ticket",
  );
});

// ── Wiring ───────────────────────────────────────────────────────────────────

test("the page reports which layer answered each field, not one label for the row", () => {
  const src = readFileSync(
    new URL("../content/smart-extractor.js", import.meta.url),
    "utf8",
  );
  assert.match(src, /from\[field\]/, "the L1/L2 merge should record a source");
  assert.match(src, /\bfrom,/, "and hand it back");
});

test("a field the model won says so", () => {
  const src = readFileSync(
    new URL("../background/service-worker.js", import.meta.url),
    "utf8",
  );
  // Without this the merge silently keeps layer 1's label on a value layer 3
  // replaced — the exact lie this item exists to remove.
  assert.match(src, /mergedFrom\[field\] = "llm"/);
});

test("the panel is sent the record and renders it", () => {
  const worker = readFileSync(
    new URL("../background/service-worker.js", import.meta.url),
    "utf8",
  );
  assert.match(worker, /pipeline:provenance/);
  const panel = readFileSync(
    new URL("../sidepanel/pipeline-builder.js", import.meta.url),
    "utf8",
  );
  assert.match(panel, /pipeline:provenance/);
  // Built as nodes: these values are page-derived, and the panel's own rule
  // about innerHTML applies to them.
  assert.ok(
    !/provenance[\s\S]{0,400}innerHTML/.test(panel),
    "provenance rows must not be interpolated as markup",
  );
});

// ── The panel actually draws it ──────────────────────────────────────────────
//
// Asserting that the source mentions `pipeline:provenance` proves the wiring
// exists, not that it renders. These run the real function in a real DOM,
// which is also where the "built as nodes" rule gets checked rather than
// grepped for.

import { JSDOM } from "jsdom";

const panelSrc = readFileSync(
  new URL("../sidepanel/pipeline-builder.js", import.meta.url),
  "utf8",
);
const renderSrc = panelSrc.match(
  /function renderProvenance\([\s\S]*?\n\}/,
)?.[0];

const dom = new JSDOM(`<!doctype html><div id="mon-logs"></div>`);
const renderProvenance = renderSrc
  ? new Function(
      "document",
      `const MAX_LOG_ENTRIES = Infinity;\n${renderSrc}; return renderProvenance;`,
    )(dom.window.document)
  : () => {
      throw new Error("renderProvenance does not exist yet");
    };
const logsEl = () => dom.window.document.getElementById("mon-logs");

test("the record reaches the pane as one entry, one line per field", () => {
  logsEl().innerHTML = "";
  renderProvenance(buildProvenance(ROW));
  const box = logsEl().querySelector(".vq-provenance");
  assert.ok(box, "nothing was drawn");
  const text = box.textContent;
  for (const field of ["name", "price", "brand", "sku"]) {
    assert.match(text, new RegExp(field));
  }
  assert.match(text, /JSON-LD/i);
  assert.match(text, /guess/i, "a heuristic has to read as a guess in the UI");
});

test("a field name off a page cannot inject markup into the pane", () => {
  // Field names come from a schema the user typed, but values and matched keys
  // come off the page. The panel's own rule applies.
  logsEl().innerHTML = "";
  renderProvenance(
    buildProvenance({
      fields: ["x"],
      result: { x: "v" },
      perField: { x: 10 },
      from: { x: 'json-ld:<img src=x onerror="alert(1)">' },
    }),
  );
  assert.equal(logsEl().querySelectorAll("img").length, 0);
  assert.match(logsEl().textContent, /<img src=x/);
});

test("an empty record draws nothing rather than an empty box", () => {
  logsEl().innerHTML = "";
  renderProvenance([]);
  assert.equal(logsEl().childElementCount, 0);
});
