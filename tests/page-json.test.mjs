// The whole page, as JSON.
//
// Asked for twice: "I need an activity that returns the entire page in json
// format", and "DOM as json or any type page content to json if user
// required".
//
// PAGE_DATA reads the structured data a site *publishes* — JSON-LD, microdata,
// Open Graph. That is the clean answer when a site publishes any, and useless
// when it does not. This is the other one: the page as it actually is, turned
// into JSON, with no selectors and no guessing about what matters.
//
// The hard part is not walking the DOM. It is that a naive dump of a real page
// is several megabytes of scripts, styles, SVG path data and layout wrappers,
// and finding anything in it is worse than writing a selector. So the default
// keeps what a reader would call content, and every filter is a switch the
// user can turn off.
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const SOURCE = await readFile(
  new URL("../content/page-json.js", import.meta.url),
  "utf8",
);

function read(html, config = {}) {
  const dom = new JSDOM(
    `<!doctype html><html><head><title>T</title></head><body>${html}</body></html>`,
    {
      url: "https://shop.test/p/1",
      runScripts: "outside-only",
    },
  );
  vm.runInContext(SOURCE, dom.getInternalVMContext(), {
    filename: "page-json.js",
  });
  const out = JSON.parse(JSON.stringify(dom.window.__vqPageJson(config)));
  dom.window.close();
  return out;
}

// ── the tree ────────────────────────────────────────────────────────────────

test("the page comes back as a tree of tags, text and attributes", () => {
  const out = read(
    `<div class="card"><h3 id="t">Widget</h3><p>Nice.</p></div>`,
  );
  const card = out.tree.children[0];
  assert.equal(card.tag, "div");
  assert.equal(card.attrs.class, "card");
  assert.equal(card.children[0].tag, "h3");
  assert.equal(card.children[0].attrs.id, "t");
  assert.equal(card.children[0].text, "Widget");
});

test("scripts, styles and comments are left out by default", () => {
  // A real page is mostly these. Included, they bury the content and blow the
  // size limit before the article starts.
  const out = read(
    `<script>var a=1</script><style>.x{}</style><!-- note --><p>Real text.</p>`,
  );
  const json = JSON.stringify(out.tree);
  assert.ok(!json.includes("var a=1"), "script contents survived");
  assert.ok(!json.includes(".x{}"), "style contents survived");
  assert.ok(json.includes("Real text."));
});

test("an SVG's path data is dropped but the SVG is still there", () => {
  // One icon can carry ten kilobytes of coordinates and means nothing to a
  // reader; that the icon exists sometimes does.
  const out = read(`<svg><path d="M0 0 L1 1 L2 2 L3 3"/></svg><p>Text</p>`);
  const json = JSON.stringify(out.tree);
  assert.ok(json.includes("svg"));
  assert.ok(!json.includes("M0 0 L1 1"), "path data survived");
});

test("everything can be kept when the user asks for it", () => {
  const out = read(`<script>var a=1</script><p>Text</p>`, {
    includeScripts: true,
  });
  assert.ok(JSON.stringify(out.tree).includes("var a=1"));
});

// ── text mode ───────────────────────────────────────────────────────────────

test("text mode returns the readable text, in order, without the markup", () => {
  const out = read(
    `<nav>Home</nav><article><h1>Title</h1><p>First.</p><p>Second.</p></article>`,
    { mode: "text" },
  );
  assert.deepEqual(out.text, ["Home", "Title", "First.", "Second."]);
  assert.equal(out.tree, undefined, "text mode should not also build a tree");
});

test("text mode drops whitespace-only nodes", () => {
  const out = read(`<div>\n   \n<p>Real</p>\n  \n</div>`, { mode: "text" });
  assert.deepEqual(out.text, ["Real"]);
});

// ── flat mode ───────────────────────────────────────────────────────────────

test("flat mode returns one row per element, which a spreadsheet can hold", () => {
  const out = read(
    `<div class="card"><h3>Widget</h3><a href="/p/1">Buy</a></div>`,
    {
      mode: "flat",
    },
  );
  const row = out.rows.find((r) => r.tag === "a");
  assert.equal(row.text, "Buy");
  assert.equal(row.href, "https://shop.test/p/1", "links come back absolute");
  assert.ok(
    row.path.includes("a"),
    `no path on the row: ${JSON.stringify(row)}`,
  );
});

// ── the limits that make it usable ──────────────────────────────────────────

test("a page deeper than the depth limit is cut, and says so", () => {
  let html = "<p>deep</p>";
  for (let i = 0; i < 40; i++) html = `<div>${html}</div>`;
  const out = read(html, { maxDepth: 5 });
  assert.equal(out.truncated, true);
  assert.match(out.reason, /deeper|nested/i);
});

test("a page with more elements than the cap is cut, and says so", () => {
  const out = read(`<ul>${"<li>x</li>".repeat(500)}</ul>`, { maxNodes: 50 });
  assert.equal(out.truncated, true);
  assert.match(out.reason, /element/i);
});

test("nothing is truncated silently", () => {
  const out = read(`<p>Small</p>`);
  assert.equal(out.truncated, false);
  assert.equal(out.reason, "");
});

test("the page's own identity always comes back", () => {
  const out = read(`<p>x</p>`);
  assert.equal(out.url, "https://shop.test/p/1");
  assert.equal(out.title, "T");
});

// ── scoping ─────────────────────────────────────────────────────────────────

test("a selector narrows the dump to part of the page", () => {
  // The whole page is rarely what anyone wants; one card usually is.
  const out = read(
    `<nav>Menu</nav><div class="card"><h3>Widget</h3></div><footer>Bye</footer>`,
    { selector: ".card" },
  );
  const json = JSON.stringify(out);
  assert.ok(json.includes("Widget"));
  assert.ok(!json.includes("Menu") && !json.includes("Bye"));
});

test("a selector that matches nothing says so rather than dumping the page", () => {
  const out = read(`<p>x</p>`, { selector: ".nope" });
  assert.equal(out.found, false);
  assert.match(out.reason, /\.nope/);
});
