// Regression tests for J-24: "Specific is working as Bulk and Bulk is working
// as Specific" in the EXTRACT activity.
//
// Neither mode did what it said.
//
// Specific: _buildSelector tried the element's own candidates, then walked up
// building an ancestor chain, and returned the *best* one — the chain that
// matched fewest elements — whether or not that was one element. A positional
// path was only used if the best had degraded to a bare tag. In a table every
// level has a class, so the walk never reached a count of 1 and "this one
// element" came back as `td.price`: every price on the page.
//
// Bulk: on finding that the target's siblings share its tag, _buildBulkSelector
// treated that level as the repetition and dropped the element's own class —
// so picking a price cell returned `td`, which is every cell of every column,
// names and authors and prices interleaved. That is what "bulk extract gives
// wrong answers" was.
import test from "node:test";
import assert from "node:assert/strict";
import { loadInjector } from "./helpers/content-harness.mjs";

// A books table: three columns, five rows, no ids anywhere — the shape the
// practice sites use, and the one both modes got wrong.
const TABLE = `
  <table class="books">
    <thead><tr><th>Name</th><th>Author</th><th>Price</th></tr></thead>
    <tbody>
      <tr class="book"><td class="name"><a href="/b/1">Gut</a></td><td class="author">Giulia Enders</td><td class="price">10.49</td></tr>
      <tr class="book"><td class="name"><a href="/b/2">Sapiens</a></td><td class="author">Y N Harari</td><td class="price">18.20</td></tr>
      <tr class="book"><td class="name"><a href="/b/3">Educated</a></td><td class="author">Tara Westover</td><td class="price">14.60</td></tr>
      <tr class="book"><td class="name"><a href="/b/4">Quiet</a></td><td class="author">Susan Cain</td><td class="price">9.75</td></tr>
      <tr class="book"><td class="name"><a href="/b/5">Grit</a></td><td class="author">A Duckworth</td><td class="price">13.10</td></tr>
    </tbody>
  </table>
`;

const count = (h, sel) => h.document.querySelectorAll(sel).length;

test("Specific returns a selector matching exactly one element", async () => {
  const h = await loadInjector(TABLE);
  for (const target of [
    "tbody tr:nth-of-type(2) td.price",
    "tbody tr:nth-of-type(4) td.name",
    "tbody tr:nth-of-type(3) td.name a",
    "tbody tr:nth-of-type(1) td.author",
  ]) {
    const el = h.document.querySelector(target);
    const sel = h.api._buildSelector(el, false);
    assert.equal(
      count(h, sel),
      1,
      `Specific on ${target} produced "${sel}", which matches ${count(h, sel)}`,
    );
    assert.equal(
      h.document.querySelector(sel),
      el,
      `"${sel}" resolves to a different element`,
    );
  }
});

test("Bulk returns the same field in every record, not every sibling", async () => {
  const h = await loadInjector(TABLE);
  const rows = count(h, "tbody tr");

  for (const target of [
    "tbody tr:nth-of-type(2) td.price",
    "tbody tr:nth-of-type(2) td.name",
    "tbody tr:nth-of-type(2) td.author",
  ]) {
    const el = h.document.querySelector(target);
    const sel = h.api._buildSelector(el, true);
    const hits = [...h.document.querySelectorAll(sel)];
    assert.equal(
      hits.length,
      rows,
      `Bulk on ${target} produced "${sel}" matching ${hits.length}, wanted one per row (${rows})`,
    );
    // And the right column: every match must be the same cell of its row.
    const wantedIndex = [...el.parentElement.children].indexOf(el);
    for (const hit of hits) {
      assert.equal(
        [...hit.parentElement.children].indexOf(hit),
        wantedIndex,
        `"${sel}" crosses columns — it matched a cell at a different index`,
      );
    }
  }
});

test("Bulk never returns a bare tag that sweeps up other columns", async () => {
  const h = await loadInjector(TABLE);
  const el = h.document.querySelector("tbody tr:nth-of-type(2) td.price");
  const sel = h.api._buildSelector(el, true);
  assert.notEqual(sel, "td", "the bare tag is every cell in the table");
});

test("the two modes actually differ", async () => {
  // They were indistinguishable on an anchor: both returned a selector matching
  // all five, which is how "bulk behaves like specific" looked from outside.
  const h = await loadInjector(TABLE);
  const el = h.document.querySelector("tbody tr:nth-of-type(3) td.name a");
  const specific = h.api._buildSelector(el, false);
  const bulk = h.api._buildSelector(el, true);
  assert.equal(count(h, specific), 1);
  assert.ok(
    count(h, bulk) > 1,
    `bulk produced "${bulk}", matching ${count(h, bulk)}`,
  );
});

test("a structural path names levels rather than counting every one", async () => {
  // `body:nth-of-type(1) > table:nth-of-type(1) > tbody:nth-of-type(1) > ...`
  // is unique and useless: it breaks when the page gains a second table, and no
  // one reading it can tell what it points at.
  const h = await loadInjector(TABLE);
  const el = h.document.querySelector("tbody tr:nth-of-type(2) td.price");
  const path = h.api._buildNthPath(el);
  assert.equal(count(h, path), 1);
  assert.ok(!/\bbody\b/.test(path), `"${path}" still walks up through body`);
  assert.ok(
    path.includes(".price"),
    `"${path}" dropped the name the page gave the cell`,
  );
});

test("an element the page names uniquely keeps that name", async () => {
  const h = await loadInjector(
    `<div id="only"><span class="lonely">x</span></div>`,
  );
  const el = h.document.querySelector(".lonely");
  assert.equal(count(h, h.api._buildSelector(el, false)), 1);
});

// ── The paginate mode's Next control (J-27) ─────────────────────────────────
//
// A LOOP's `selector` means two different things depending on its mode: the
// records to iterate over (many) or the Next control (one). The picker keyed
// its default off the step type alone, so a paginating loop opened in Bulk —
// and a bulk pick of a paginator returns every page link. PAGINATE clicks the
// first, which is "1", so the run re-scraped page one until Max pages ran out.
import { readFile } from "node:fs/promises";

const builder = await readFile(
  new URL("../sidepanel/pipeline-builder.js", import.meta.url),
  "utf8",
);

test("a paginating loop picks its Next control in Specific mode", () => {
  const fn = builder.slice(
    builder.indexOf("const defaultBulk =") - 700,
    builder.indexOf("const mode = await _selectSelectorMode(defaultBulk);"),
  );
  assert.match(fn, /config\?\.type === "paginate"/);
  assert.match(fn, /!paginating/, "paginate mode still defaults to bulk");
});

test('the field says it wants the Next button, not "selector"', () => {
  assert.match(builder, /selectorRow\(step, "selector", "Next button"\)/);
  const row = builder.slice(
    builder.indexOf("function selectorRow("),
    builder.indexOf("function selectorRow(") + 700,
  );
  assert.match(row, /paginating/, "the badge would still read Bulk");
});

test("the paginate knobs the worker reads are reachable from the panel", () => {
  // _executePaginate honours settleMs and requireChange; the UI offered
  // neither, so a paginator whose Next is never disabled could not be stopped.
  // Checked inside the paginate branch, not the whole file: both names occur
  // in the worker-facing code regardless.
  const branch = builder.slice(
    builder.indexOf('html += selectorRow(step, "selector", "Next button");') -
      900,
    builder.indexOf("html += `<label>On iteration failure</label>"),
  );
  assert.match(branch, /"settleMs"/);
  assert.match(branch, /"requireChange"/);
});

test("exactly one mode is marked as the suggestion", () => {
  // The Specific button carried the highlight in its own inline style, so it
  // always looked chosen — and where bulk was the default, both did.
  const modal = builder.slice(
    builder.indexOf("async function _selectSelectorMode"),
    builder.indexOf("// \u2500\u2500 Detect table"),
  );
  assert.ok(
    !/data-mode="specific"[^>]*border:2px solid var\(--accent\)/.test(modal),
    "the Specific button is still hardcoded as highlighted",
  );
  assert.match(modal, /classList\.add\("suggested"\)/);
});

// ── VQ-01 / K-32: bulk on a repeating element that carries no class ──────────
//
// Reported from real use, twice: "I am trying to use bulk in the extract
// activity but it is still finding only 1 image, not all of them —
// `div.grid > img:nth-of-type(1)` instead of `div.grid > img`."
//
// The grid of bare <img> is the shape that broke it. _buildBulkSelector only
// treated repetition as bulk-worthy when the siblings shared a class, or when
// the tag was one of li/tr/td/article/section. A repeating <img>, <a>, <p> or
// <span> with no class matched neither test, so the path it had built was
// thrown away and the *specific* selector returned — positional, one match,
// which is the opposite of what Bulk means.

const GRID = `
  <div class="grid">
    <img src="/1.jpg" alt="one">
    <img src="/2.jpg" alt="two">
    <img src="/3.jpg" alt="three">
    <img src="/4.jpg" alt="four">
  </div>
`;

test("Bulk on a repeating element with no class matches all of them", async () => {
  const h = await loadInjector(GRID);
  const el = h.document.querySelector(".grid img:nth-of-type(2)");
  const sel = h.api._buildSelector(el, true);

  assert.ok(
    !sel.includes(":nth-of-type("),
    `Bulk produced a positional selector: "${sel}"`,
  );
  assert.equal(
    count(h, sel),
    4,
    `Bulk produced "${sel}", matching ${count(h, sel)} of 4 images`,
  );
});

test("Bulk on a bare repeating tag is anchored to its container", async () => {
  // "img" would match all four too, and would also match every image
  // elsewhere on the page. The container is what makes it this grid's images.
  const h = await loadInjector(`
    <img src="/logo.png" alt="site logo">
    ${GRID}
    <footer><img src="/badge.png" alt="badge"></footer>
  `);
  const el = h.document.querySelector(".grid img:nth-of-type(2)");
  const sel = h.api._buildSelector(el, true);

  assert.equal(
    count(h, sel),
    4,
    `"${sel}" matched ${count(h, sel)} — the logo and the badge are not grid images`,
  );
  assert.ok(sel.includes(".grid"), `"${sel}" is not anchored to the grid`);
});

test("Bulk still keeps one field per record on a table", async () => {
  // The guard on the fix: a <td> among differing <td> siblings must not become
  // a bare tag matching every cell of every column (the J-x regression).
  const h = await loadInjector(TABLE);
  const el = h.document.querySelector("tbody tr:nth-of-type(2) td.price");
  const sel = h.api._buildSelector(el, true);
  assert.equal(
    count(h, sel),
    count(h, "tbody tr"),
    `"${sel}" is not one per row`,
  );
});
