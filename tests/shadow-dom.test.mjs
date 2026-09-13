// Shadow DOM support (capability review §3).
//
// _queryScoped — the resolver behind CLICK, FILL, EXTRACT, HOVER, SELECT,
// IF_ELSE, PAGINATE, SCROLL and the picker — used plain querySelectorAll.
// That does not cross a shadow root, so on a site built from web components
// every selector matched nothing and the tool reported "not found" for
// elements plainly on the screen. The same shape of failure as the iframe gap
// (J-14): a boundary selectors cannot cross.
//
// Two halves to the fix. CSS has no piercing combinator — `>>>` was specified
// and removed — so a selector into a component cannot be *written*. The picker
// emits `host >>> .inner` and the resolver understands it. And because a
// selector copied from devtools carries no boundary, a plain selector that
// matches nothing falls back to searching open shadow roots.
import test from "node:test";
import assert from "node:assert/strict";
import { loadInjector } from "./helpers/content-harness.mjs";

/** Build a page with a component whose guts live behind a shadow boundary. */
function withShadow(h, { closed = false, nested = false } = {}) {
  const { document } = h;
  const host = document.createElement("shop-card");
  host.className = "card";
  document.body.appendChild(host);
  const root = host.attachShadow({ mode: closed ? "closed" : "open" });
  root.innerHTML = `
    <h3 class="title">Backpack</h3>
    <span class="price">109.95</span>
    <button class="buy">Add</button>`;
  if (nested) {
    const inner = document.createElement("shop-badge");
    root.appendChild(inner);
    inner.attachShadow({ mode: "open" }).innerHTML =
      `<span class="rating">4</span>`;
  }
  return { host, root };
}

const PLAIN = `<div class="outside"><span class="price">1.00</span></div>`;

test("a selector inside a shadow root resolves", async () => {
  const h = await loadInjector("");
  withShadow(h);
  const found = h.api._queryScoped(".title", {}, true);
  assert.equal(found.length, 1);
  assert.equal(found[0].textContent, "Backpack");
});

test("the explicit piercing combinator walks the boundary", async () => {
  const h = await loadInjector("");
  withShadow(h);
  const found = h.api._queryScoped("shop-card >>> .price", {}, true);
  assert.equal(found.length, 1);
  assert.equal(found[0].textContent, "109.95");
});

test("it chains through nested components", async () => {
  const h = await loadInjector("");
  withShadow(h, { nested: true });
  const found = h.api._queryScoped(
    "shop-card >>> shop-badge >>> .rating",
    {},
    true,
  );
  assert.equal(found.length, 1);
  assert.equal(found[0].textContent, "4");
});

test("the light DOM still wins when it matches", async () => {
  // The shadow walk is a fallback, not a widening: a selector that already
  // matches must not start picking up extra elements from inside components.
  const h = await loadInjector(PLAIN);
  withShadow(h);
  const found = h.api._queryScoped(".price", {}, true);
  assert.equal(found.length, 1, "the shadow copy was swept in as well");
  assert.equal(found[0].textContent, "1.00");
});

test("a closed shadow root stays unreachable", async () => {
  // Closed roots are unreachable by design — element.shadowRoot is null and no
  // API hands one over. Finding nothing is the correct answer.
  const h = await loadInjector("");
  withShadow(h, { closed: true });
  assert.equal(h.api._queryScoped(".title", {}, true).length, 0);
});

test("a host with no open root is not searched in its light DOM", async () => {
  // `a >>> b` says "inside a". Falling back to a's light DOM would match
  // something else entirely and report success.
  const h = await loadInjector(
    `<shop-card class="card"><span class="price">DECOY</span></shop-card>`,
  );
  assert.equal(h.api._queryScoped("shop-card >>> .price", {}, true).length, 0);
});

test("an invalid selector is not thrown once per shadow root", async () => {
  const h = await loadInjector("");
  withShadow(h);
  assert.doesNotThrow(() => h.api._queryScoped("div[", {}, true));
  assert.equal(h.api._queryScoped("div[", {}, true).length, 0);
});

test("EXTRACT reads fields from inside a component", async () => {
  const h = await loadInjector("");
  withShadow(h);
  const rows = await h.api._stepExtract({
    fields: [
      { name: "title", selector: ".title", type: "text" },
      { name: "price", selector: "shop-card >>> .price", type: "text" },
    ],
  });
  assert.deepEqual(JSON.parse(JSON.stringify(rows)), [
    { title: "Backpack", price: "109.95" },
  ]);
});

// ── The picker has to be able to write one ──────────────────────────────────

test("the picker describes an element behind a boundary", async () => {
  const h = await loadInjector("");
  const { root } = withShadow(h);
  const el = root.querySelector(".price");
  const sel = h.api._buildSelector(el, false);
  assert.match(sel, />>>/, `"${sel}" cannot address a shadow element`);
  // And it must resolve back to the element it described.
  const back = h.api._queryScoped(sel, {}, true);
  assert.equal(back.length, 1);
  assert.equal(back[0], el);
});

test("the picker chains for a nested component", async () => {
  const h = await loadInjector("");
  const { root } = withShadow(h, { nested: true });
  const el = root
    .querySelector("shop-badge")
    .shadowRoot.querySelector(".rating");
  const sel = h.api._buildSelector(el, false);
  assert.equal(
    (sel.match(/>>>/g) ?? []).length,
    2,
    `"${sel}" does not cross both boundaries`,
  );
  assert.equal(h.api._queryScoped(sel, {}, true)[0], el);
});

test("an element in the light DOM is unaffected", async () => {
  const h = await loadInjector(PLAIN);
  const el = h.document.querySelector(".price");
  const sel = h.api._buildSelector(el, false);
  assert.ok(
    !sel.includes(">>>"),
    `"${sel}" gained a boundary it does not have`,
  );
});

// ── The emitted scripts have to mean the same thing ─────────────────────────
//
// Playwright's CSS engine pierces open shadow roots, and its `>>` chains one
// selector inside another — exactly the semantics of `>>>` here. Without the
// translation the emitted script carries a selector Playwright reads as
// malformed CSS and matches nothing, so an exported scrape would quietly
// return empty rows where the run returned data.
import { readFile } from "node:fs/promises";

const pySrc = await readFile(
  new URL("../script-gen/python-emitter.js", import.meta.url),
  "utf8",
);
const nodeSrc = await readFile(
  new URL("../script-gen/node-emitter.js", import.meta.url),
  "utf8",
);
const { emitPython } = await import("../script-gen/python-emitter.js");
const { emitNode } = await import("../script-gen/node-emitter.js");

const PIPE = {
  name: "shadow",
  steps: [
    { id: "1", type: "WEBSITE", config: { url: "https://shop.test/" } },
    { id: "2", type: "CLICK", config: { selector: "shop-card >>> .buy" } },
    {
      id: "3",
      type: "EXTRACT",
      config: {
        fields: [
          { name: "price", selector: "shop-card >>> .price", type: "text" },
        ],
      },
    },
  ],
};

for (const [name, emit] of [
  ["python", emitPython],
  ["node", emitNode],
]) {
  test(`the ${name} emitter translates >>> into Playwright's >>`, () => {
    const out = emit(PIPE);
    const code =
      typeof out === "string" ? out : (out.code ?? JSON.stringify(out));
    // Comments may echo the original selector — that is useful. What must not
    // survive is a >>> Playwright is asked to parse.
    const executable = code
      .split("\n")
      .filter((l) => !/^\s*(#|\/\/)/.test(l))
      .join("\n");
    assert.ok(
      !executable.includes(">>>"),
      `the ${name} script still passes >>> to Playwright`,
    );
    assert.match(
      code,
      /shop-card >> \.buy/,
      `the ${name} script lost the boundary`,
    );
    assert.match(code, /shop-card >> \.price/);
  });
}

test("both emitters define the translation once", () => {
  for (const [name, src] of [
    ["python", pySrc],
    ["node", nodeSrc],
  ]) {
    assert.match(src, /function _sel\(selector\)/, `${name} has no translator`);
    assert.match(
      src,
      /\.join\(" >> "\)/,
      `${name} does not join for Playwright`,
    );
  }
});

// ── Detect Table across the boundary ────────────────────────────────────────
//
// A record built from web components has no children in the light DOM at all:
// `<shop-card>` is an empty tag and its title and price live in its shadow
// root. columnsOf walked `record.querySelectorAll("*")`, got nothing, and the
// record was dropped for having fewer than two columns — so Detect Table, the
// headline feature, reported "no tables found" on a whole class of modern site.
import { JSDOM } from "jsdom";
import vm from "node:vm";

const detectorSrc = await readFile(
  new URL("../content/structure-detector.js", import.meta.url),
  "utf8",
);

function detectComponents({ nested = true } = {}) {
  const dom = new JSDOM(
    `<!doctype html><html><body><div id="grid"></div></body></html>`,
    { url: "https://shop.test/", runScripts: "outside-only" },
  );
  const { document } = dom.window;
  const items = [
    ["Backpack", "109.95", 4],
    ["T-Shirt", "22.30", 5],
    ["Jacket", "55.99", 3],
    ["Boots", "88.00", 2],
  ];
  for (const [title, price, n] of items) {
    const card = document.createElement("shop-card");
    document.getElementById("grid").appendChild(card);
    const root = card.attachShadow({ mode: "open" });
    root.innerHTML = `<h3 class="title">${title}</h3><span class="price">${price}</span><button class="buy">Add</button>`;
    if (nested) {
      const badge = document.createElement("shop-badge");
      root.appendChild(badge);
      badge.attachShadow({ mode: "open" }).innerHTML =
        `<span class="rating">${n}</span>`;
    }
  }
  vm.runInContext(detectorSrc, dom.getInternalVMContext(), {
    filename: "structure-detector.js",
  });
  const out = dom.window.__vqDetectStructure();
  dom.window.close();
  return out;
}

test("Detect Table finds a grid of web components", () => {
  const table = detectComponents().candidates[0];
  assert.ok(table, "no table detected — the records looked empty");
  assert.equal(table.count, 4);
  assert.equal(table.selector, "shop-card");

  const byName = Object.fromEntries(table.fields.map((f) => [f.name, f]));
  assert.ok(byName.title, "the title column is missing");
  assert.ok(byName.price, "the price column is missing");
  assert.deepEqual(
    JSON.parse(JSON.stringify(byName.title.samples.slice(0, 2))),
    ["Backpack", "T-Shirt"],
  );
});

test("it reaches a column two boundaries deep", () => {
  const table = detectComponents().candidates[0];
  const rating = table.fields.find((f) => f.name === "rating");
  assert.ok(rating, "the nested component's column is missing");
  assert.deepEqual(JSON.parse(JSON.stringify(rating.samples.slice(0, 3))), [
    "4",
    "5",
    "3",
  ]);
});

test("the shadow host itself is not a column", () => {
  // The host has no text of its own — its content is a separate tree already
  // walked in its own right — so offering its attributes duplicates a column.
  const names = detectComponents().candidates[0].fields.map((f) => f.name);
  assert.ok(
    !names.some((n) => n.includes("badge")),
    `the host became a column of its own: ${names.join(", ")}`,
  );
});

test("an ordinary table is detected exactly as before", () => {
  // The shadow walk must not change the result on a page that has none.
  const dom = new JSDOM(
    `<!doctype html><table><thead><tr><th>Name</th><th>Price</th></tr></thead><tbody>
      <tr><td class="name">Gut</td><td class="price">10.49</td></tr>
      <tr><td class="name">Sapiens</td><td class="price">18.20</td></tr>
      <tr><td class="name">Educated</td><td class="price">14.60</td></tr>
    </tbody></table>`,
    { url: "https://books.test/", runScripts: "outside-only" },
  );
  vm.runInContext(detectorSrc, dom.getInternalVMContext(), {
    filename: "structure-detector.js",
  });
  const table = dom.window.__vqDetectStructure().candidates[0];
  assert.equal(table.selector, "tr");
  assert.equal(table.count, 3);
  assert.deepEqual(
    JSON.parse(JSON.stringify(table.fields.map((f) => f.name))),
    ["name", "price"],
  );
  dom.window.close();
});
