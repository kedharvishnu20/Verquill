// Regression tests for J-25: Detect Table missed a star-rating column.
//
// Reported against a books table that came back "10 rows x 3 columns" — name,
// author, price — with the ratings column simply absent.
//
// columnsOf read an element's text, href and src, and `continue`d past
// anything that had none of the three. But a rating is the canonical example
// of a value a page shows without writing down: four filled star icons, a
// class of `star-rating Three`, an `aria-label`, a `data-rating`. All of them
// hit that `continue`.
//
// A second, quieter bug hid the cell even from the code that might have looked:
// the "sole child carrying all its parent's text" wrapper guard compared two
// empty strings and matched, so any single-child wrapper with no text at all
// was skipped before its contents were considered.
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(
  new URL("../content/structure-detector.js", import.meta.url),
  "utf8",
);

const BOOKS = [
  ["Gut", "Giulia Enders", "10.49", 4],
  ["Sapiens", "Y N Harari", "18.20", 5],
  ["Educated", "Tara Westover", "14.60", 3],
  ["Quiet", "Susan Cain", "9.75", 5],
  ["Grit", "A Duckworth", "13.10", 2],
  ["Becoming", "M Obama", "21.00", 4],
];

/** The four ways a page renders a rating without writing the number down. */
const STARS = {
  icons: (n) =>
    `<td class="rating"><span class="stars">${'<i class="icon-star filled"></i>'.repeat(n)}${'<i class="icon-star"></i>'.repeat(5 - n)}</span></td>`,
  klass: (n) =>
    `<td><p class="star-rating ${["One", "Two", "Three", "Four", "Five"][n - 1]}">${'<i class="icon-star"></i>'.repeat(5)}</p></td>`,
  aria: (n) =>
    `<td><span class="rating" aria-label="${n} out of 5 stars" role="img">${'<i class="icon-star"></i>'.repeat(n)}</span></td>`,
  data: (n) =>
    `<td><div class="rating" data-rating="${n}">${'<i class="icon-star"></i>'.repeat(n)}</div></td>`,
};

function detect(html) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
    url: "https://books.test/list",
    runScripts: "outside-only",
  });
  vm.runInContext(source, dom.getInternalVMContext(), {
    filename: "structure-detector.js",
  });
  const out = dom.window.__vqDetectStructure();
  dom.window.close();
  return out;
}

const tableFor = (kind) => `
  <table class="books">
    <thead><tr><th>Name</th><th>Author</th><th>Price</th><th>Stars</th></tr></thead>
    <tbody>${BOOKS.map(
      ([t, a, p, s]) =>
        `<tr><td class="name">${t}</td><td class="author">${a}</td><td class="price">${p}</td>${STARS[kind](s)}</tr>`,
    ).join("")}</tbody>
  </table>`;

for (const kind of Object.keys(STARS)) {
  test(`a rating rendered as ${kind} is found as a column`, () => {
    const table = detect(tableFor(kind)).candidates[0];
    assert.ok(table, "no table detected at all");
    assert.equal(table.count, BOOKS.length);

    const plain = table.fields.filter((f) => f.kind === "text");
    assert.ok(
      plain.length >= 3,
      "the three text columns should still be found",
    );

    const rating = table.fields.find((f) => f.kind !== "text");
    assert.ok(
      rating,
      `only ${table.fields.length} columns (${table.fields.map((f) => f.name).join(", ")}) — the rating was dropped`,
    );

    // Whatever it found must be usable: a column EXTRACT cannot read back is
    // no better than a missing one.
    if (rating.kind === "attr") {
      assert.ok(rating.attribute, "an attr column with no attribute name");
    } else if (rating.kind === "count") {
      assert.ok(rating.countSelector, "a count column with nothing to count");
    } else {
      assert.fail(`unexpected column kind "${rating.kind}"`);
    }

    // And it must vary with the data, not be the same string every row.
    assert.ok(
      new Set(rating.samples).size > 1,
      `the rating column is constant: ${JSON.stringify(rating.samples)}`,
    );
  });
}

test("plain text stars are still read as text", () => {
  const html = `
    <table><thead><tr><th>Name</th><th>Stars</th></tr></thead><tbody>${BOOKS.map(
      ([t, , , s]) =>
        `<tr><td class="name">${t}</td><td class="rating">${"*".repeat(s)}</td></tr>`,
    ).join("")}</tbody></table>`;
  const table = detect(html).candidates[0];
  const rating = table.fields.find(
    (f) => f.name.includes("star") || f.name.includes("rating"),
  );
  assert.ok(rating);
  assert.equal(rating.kind, "text");
});

test("a decorative wrapper that is the same in every row is not a column", () => {
  // The guard against over-eagerness: an icon that never changes carries no
  // data, and the constancy filter has to keep dropping it.
  const html = `
    <ul>${BOOKS.map(
      ([t, a]) =>
        `<li class="row"><span class="t">${t}</span><span class="a">${a}</span><span class="chev"><i class="arrow"></i><i class="arrow"></i></span></li>`,
    ).join("")}</ul>`;
  const table = detect(html).candidates[0];
  const names = table.fields.map((f) => f.name);
  assert.ok(
    !names.some((n) => n.includes("chev")),
    `a constant decoration became a column: ${names.join(", ")}`,
  );
});
