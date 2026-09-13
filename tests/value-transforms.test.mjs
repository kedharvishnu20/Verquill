// Cleaning up extracted values, so the scrape does not need cleaning up after.
//
// EXTRACT returned exactly what was on the page: "$25.50" as a string with a
// currency symbol in it, "/p/123" as a relative path, "1,234 reviews" as prose.
// Every scrape therefore ended in a spreadsheet doing find-and-replace, which is
// the part of scraping people actually hate.
//
// The transforms live in a pure module so the script emitters can apply the
// same ones and an exported script produces the same values as the extension.
import test from "node:test";
import assert from "node:assert/strict";
import {
  TRANSFORMS,
  applyTransform,
  applyTransforms,
} from "../utils/value-transforms.js";

const at = (value, name, opts) => applyTransform(value, name, opts);

// ── number ───────────────────────────────────────────────────────────────────

test("number pulls a number out of the text around it", () => {
  assert.equal(at("$25.50", "number"), 25.5);
  assert.equal(at("1,234 reviews", "number"), 1234);
  assert.equal(at("Save 20%", "number"), 20);
  assert.equal(at("-4.5°C", "number"), -4.5);
  assert.equal(at("  42  ", "number"), 42);
});

test("number handles European decimals, where the comma is the point", () => {
  // "1.234,56" is one thousand two hundred and thirty four euros and change,
  // not one point two three. Reading it as 1.234 is a hundredfold error in a
  // price column, silently.
  assert.equal(at("1.234,56 €", "number"), 1234.56);
  assert.equal(at("€ 9,99", "number"), 9.99);
});

test("scientific notation is read whole, not truncated at the E", () => {
  // Found in a real scrape: scrapethissite.com gives Antarctica's area as
  // "1.4E7". The numeric run stopped at the "E", so 14 million became 1.4 —
  // a wrong number that looks entirely plausible in a column of areas, which
  // is the worst kind.
  assert.equal(at("1.4E7", "number"), 14000000);
  assert.equal(at("1.4e7", "number"), 14000000);
  assert.equal(at("-2.5E-3", "number"), -0.0025);
  assert.equal(at("6.02E23", "number"), 6.02e23);
});

test("an E that is not an exponent is not treated as one", () => {
  // "3 EUR" and "Section 4E" both have a digit near an E and neither is
  // scientific notation.
  assert.equal(at("3 EUR", "number"), 3);
  assert.equal(at("Section 4E", "number"), 4);
  assert.equal(at("12E", "number"), 12);
});

test("number gives null rather than a wrong number when there is none", () => {
  // NaN in a CSV column is noise; 0 is a lie. Null says "not there".
  assert.equal(at("Out of stock", "number"), null);
  assert.equal(at("", "number"), null);
  assert.equal(at(null, "number"), null);
});

// ── url ──────────────────────────────────────────────────────────────────────

test("url makes a relative link absolute", () => {
  const base = "https://shop.test/category/shoes?page=2";
  assert.equal(at("/p/123", "url", { base }), "https://shop.test/p/123");
  assert.equal(at("../x", "url", { base }), "https://shop.test/x");
  assert.equal(
    at("https://other.test/y", "url", { base }),
    "https://other.test/y",
  );
});

test("url does not manufacture a link out of ordinary text", () => {
  // The case above passes no base, which is why this went unnoticed: without
  // one, `new URL()` throws on prose and the value falls through untouched.
  // With a base it does not throw. It percent-encodes the spaces and returns a
  // well-formed address that goes nowhere, and a column of those is exactly
  // the "wrong answer that looks right" this module opens by ruling out.
  const base = "https://shop.test/catalog/";
  for (const v of [
    "Out of stock",
    "1,234 reviews",
    "Free shipping on orders over $50",
  ]) {
    assert.equal(at(v, "url", { base }), v, `${v} was turned into a link`);
  }
});

test("url still resolves every relative form markup actually uses", () => {
  // The other half of the guard: refusing anything that merely looks unusual
  // would cost real links, which is the more expensive mistake.
  const base = "https://shop.test/catalog/";
  assert.equal(at("p/123", "url", { base }), "https://shop.test/catalog/p/123");
  assert.equal(at("./x", "url", { base }), "https://shop.test/catalog/x");
  assert.equal(at("?q=1", "url", { base }), "https://shop.test/catalog/?q=1");
  assert.equal(at("#frag", "url", { base }), "https://shop.test/catalog/#frag");
  assert.equal(
    at("//cdn.test/a.png", "url", { base }),
    "https://cdn.test/a.png",
  );
});

test("url trims before it decides, so padded markup still resolves", () => {
  // Whitespace *around* a link is what markup leaves behind; whitespace
  // *inside* it is what prose has. Only the second one disqualifies a value.
  assert.equal(
    at("  /p/123\n ", "url", { base: "https://shop.test/" }),
    "https://shop.test/p/123",
  );
});

test("url leaves a value alone when it cannot be resolved", () => {
  assert.equal(at("not a url", "url", {}), "not a url");
  assert.equal(at("", "url", { base: "https://shop.test/" }), "");
});

// ── regex ────────────────────────────────────────────────────────────────────

test("regex returns the first capture group, or the whole match", () => {
  assert.equal(
    at("SKU: ABC-123", "regex", { pattern: "SKU: (\\S+)" }),
    "ABC-123",
  );
  assert.equal(
    at("SKU: ABC-123", "regex", { pattern: "[A-Z]+-\\d+" }),
    "ABC-123",
  );
});

test("a regex that matches nothing yields null, not the original", () => {
  // Returning the untouched string would look like the pattern worked.
  assert.equal(at("no code here", "regex", { pattern: "SKU: (\\S+)" }), null);
});

test("an invalid pattern comes back empty, the same as no match", () => {
  // Every other transform in this file degrades to null on bad input rather
  // than throwing — "Out of stock" as a number, a string that is not base64.
  // A typo'd pattern is the same kind of bad input, and failing the whole
  // EXTRACT step over it would take a multi-field, multi-page run down for
  // one field. The panel already tells the user this in the moment.
  assert.equal(at("x", "regex", { pattern: "([unclosed" }), null);
  assert.equal(at("x", "regex", {}), null); // no pattern configured yet
});

test("a chosen group index is read, not just the first", () => {
  const url = "/product/1234-blue-widget";
  assert.equal(
    at(url, "regex", { pattern: "/product/(\\d+)-([a-z]+)-", group: 2 }),
    "blue",
  );
});

test("group 0 always means the whole match, even when the pattern has groups", () => {
  assert.equal(
    at("SKU: ABC-123", "regex", { pattern: "SKU: (\\S+)", group: 0 }),
    "SKU: ABC-123",
  );
});

test("an explicit group the pattern does not have is null, not a guess", () => {
  // Group 1 alone falls back to the whole match (see the test above this
  // section) because that is the common, no-groups-at-all case. Asking for
  // group 2 on a pattern with only one group is a real mistake, and guessing
  // group 1 or the whole match instead would hide it.
  assert.equal(
    at("SKU: ABC-123", "regex", { pattern: "SKU: (\\S+)", group: 2 }),
    null,
  );
});

test("flags reach the pattern the same way the browser's regex would use them", () => {
  assert.equal(
    at("Product SKU", "regex", { pattern: "sku", flags: "i" }),
    "SKU",
  );
  assert.equal(at("Product SKU", "regex", { pattern: "sku" }), null);
});

test("a pattern shaped for catastrophic backtracking is refused, not run", () => {
  // (\S+)+ against a string with no trailing match forces the engine through
  // an exponential number of ways to partition the run before it can give up
  // — the classic ReDoS shape. Forty-odd characters is already enough to hang
  // a naive backtracking engine for a very long time; this must return
  // instead of ever trying.
  const evil = "a".repeat(40) + "!";
  const started = Date.now();
  assert.equal(at(evil, "regex", { pattern: "(a+)+$" }), null);
  assert.ok(
    Date.now() - started < 1000,
    "a catastrophic pattern must be refused up front, not executed",
  );
});

// ── text tidying ─────────────────────────────────────────────────────────────

test("trim collapses the whitespace real markup leaves behind", () => {
  assert.equal(at("\n   Add to\n   cart  \n", "trim"), "Add to cart");
});

test("lower and upper do what they say", () => {
  assert.equal(at("Widget", "lower"), "widget");
  assert.equal(at("Widget", "upper"), "WIDGET");
});

// ── chaining and safety ──────────────────────────────────────────────────────

test("transforms chain in the order given", () => {
  assert.equal(
    applyTransforms(" Price: 1,299.00 USD ", ["trim", "number"]),
    1299,
  );
});

test("a chain stops once a step yields null", () => {
  // Feeding null onward would make the next transform's failure look like the
  // cause, and "number" on null must not become 0.
  assert.equal(applyTransforms("sold out", ["number", "upper"]), null);
});

test("an unknown transform name is refused, not ignored", () => {
  // Ignoring it means a pipeline that silently does not do what it says.
  assert.throws(() => at("x", "nonsense"), /unknown|unsupported/i);
});

test("no transform, or 'none', returns the value untouched", () => {
  assert.equal(applyTransforms("$25.50", []), "$25.50");
  assert.equal(applyTransforms("$25.50", ["none"]), "$25.50");
  assert.equal(applyTransforms("$25.50", undefined), "$25.50");
});

test("every transform in the registry is documented for the UI", () => {
  for (const [name, meta] of Object.entries(TRANSFORMS)) {
    assert.ok(meta.label, `${name} has no label`);
    assert.ok(meta.help, `${name} has no help text`);
    assert.equal(typeof meta.fn, "function", `${name} has no implementation`);
  }
  assert.ok(Object.keys(TRANSFORMS).length >= 6);
});

// ── applied where the rows are made ──────────────────────────────────────────

import {
  calls,
  reset,
  onContentMessage,
  startRun,
  endRun,
  _dispatchStep,
} from "./helpers/worker-harness.mjs";

const step = (type, config = {}) => ({ id: `s_${type}`, type, config });
const ctx = () => ({ extracted: {} });

test("EXTRACT applies each field's transforms to the rows it produces", async () => {
  reset();
  const { runId, runState } = startRun();
  onContentMessage(() => ({
    ok: true,
    result: [
      { name: "  Widget  ", price: "$25.50", link: "/p/1" },
      { name: "Gadget", price: "1.234,56 €", link: "/p/2" },
    ],
  }));

  await _dispatchStep(
    step("EXTRACT", {
      fields: [
        { name: "name", selector: ".n", transform: ["trim"] },
        { name: "price", selector: ".p", transform: ["number"] },
        {
          name: "link",
          selector: "a",
          type: "attribute",
          attribute: "href",
          transform: ["url"],
        },
      ],
    }),
    1,
    runId,
    ctx(),
  );

  assert.deepEqual(runState.results, [
    { name: "Widget", price: 25.5, link: "https://shop.test/p/1" },
    { name: "Gadget", price: 1234.56, link: "https://shop.test/p/2" },
  ]);
  await endRun(runId);
});

test("a field with no transform is left exactly as the page had it", async () => {
  reset();
  const { runId, runState } = startRun();
  onContentMessage(() => ({ ok: true, result: [{ price: "$25.50" }] }));

  await _dispatchStep(
    step("EXTRACT", { fields: [{ name: "price", selector: ".p" }] }),
    1,
    runId,
    ctx(),
  );
  assert.equal(runState.results[0].price, "$25.50");
  await endRun(runId);
});

test("a transform that cannot run fails the step by name", async () => {
  // A misspelled transform name is a different mistake than a bad regex
  // pattern (see "an invalid pattern comes back empty" above): there is no
  // sensible "empty" to fall back to for a transform that does not exist at
  // all, so this must still fail loudly rather than pass the value through
  // untouched and pretend the transform ran.
  reset();
  const { runId } = startRun();
  onContentMessage(() => ({ ok: true, result: [{ sku: "x" }] }));

  await assert.rejects(
    () =>
      _dispatchStep(
        step("EXTRACT", {
          fields: [
            {
              name: "sku",
              selector: ".s",
              transform: ["bogus-transform"],
            },
          ],
        }),
        1,
        runId,
        ctx(),
      ),
    /sku/,
  );
  await endRun(runId);
});

// ── what Detect Table guesses ────────────────────────────────────────────────

import { readFile } from "node:fs/promises";

const panelSrc = await readFile(
  new URL("../sidepanel/pipeline-builder.js", import.meta.url),
  "utf8",
);

/** _transformFor, lifted out of the panel module, which cannot be imported. */
function makeGuesser() {
  const m = panelSrc.match(/function _transformFor\(field\) \{[\s\S]*?\n\}/);
  assert.ok(m, "could not find _transformFor");
  return new Function(`${m[0]}; return _transformFor;`)();
}

test("a detected link column is made absolute", () => {
  const guess = makeGuesser();
  assert.equal(guess({ kind: "href", samples: ["/p/1"] }), "url");
  assert.equal(guess({ kind: "src", samples: ["/img/1.jpg"] }), "url");
});

test("a detected price column is read as a number", () => {
  const guess = makeGuesser();
  for (const samples of [
    ["$25.50", "$7.99", "$120.00"],
    ["£10.00", "£9.99", "£3.50"],
    ["€ 9,99", "€ 24,50", "€ 5,00"],
    ["1,299.00", "899.00", "1,450.00"],
    ["₹1,299", "₹899", "₹2,450"],
  ]) {
    assert.equal(
      guess({ kind: "text", samples }),
      "number",
      `not read as a price: ${samples.join(" ")}`,
    );
  }
});

test("a column of plain numbers is read as numbers", () => {
  // Populations and areas carry no currency symbol, so the currency rule alone
  // left them as text — which was the state of the real country scrape.
  const guess = makeGuesser();
  assert.equal(
    guess({ kind: "text", samples: ["84000", "4975593", "29121286"] }),
    "number",
  );
  assert.equal(
    guess({ kind: "text", samples: ["468.0", "82880.0", "647500.0"] }),
    "number",
  );
});

test("one non-numeric sample stops the whole column being converted", () => {
  // A column that is 90% numbers and 10% "N/A" must not turn that 10% into
  // empty cells silently. Conservative on purpose: leaving it as text costs a
  // conversion; getting it wrong costs data.
  const guess = makeGuesser();
  assert.equal(
    guess({ kind: "text", samples: ["84000", "N/A", "29121286"] }),
    "",
  );
  assert.equal(
    guess({ kind: "text", samples: ["84000", "about 5 million"] }),
    "",
  );
});

test("a column of prose is left exactly as it is", () => {
  // Guessing wrong here is worse than not guessing: it turns a product name
  // into null and the user has no idea why the column emptied.
  const guess = makeGuesser();
  for (const samples of [
    ["Widget", "Gadget", "Doohickey"],
    ["In stock", "Out of stock", "In stock"],
    ["Ships in 2 days", "Ships in 5 days", "Ships tomorrow"],
    ["4.5 out of 5 stars", "3.9 out of 5 stars", "5 out of 5 stars"],
    [],
  ]) {
    assert.equal(
      guess({ kind: "text", samples }),
      "",
      `wrongly transformed: ${samples.join(" ")}`,
    );
  }
});
