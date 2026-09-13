// Documentation that can go stale without anything noticing.
//
// This repository's docs drifted badly and quietly. The README claimed 660
// tests when there were 1422, described three modules as unreachable when all
// three had since been wired up or deleted, and told the reader the script
// emitters covered "21 of the 29 step types" when the registry held 38. None
// of that is a typo — each one was true when written, and nothing existed to
// notice when it stopped being true.
//
// A number in prose that is derived from the code should be checked against
// the code. These tests check only the claims that have a single, mechanical
// source of truth. Prose that requires judgement is left to review, where it
// belongs.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const readme = read("../README.md");

// The README's step-type counts are NOT checked here. They already are, by
// tests/dead-code-and-defects.test.mjs, and that version is the better one: it
// knows that nine step types are marked `internal` and never shown to a user,
// so the sentence "21 of the 29" is about the user-facing 29 rather than the
// registry's 38.
//
// Writing a second check here got that wrong and "corrected" a correct README.
// One definition, including for the tests that enforce one definition.

test("the README's test counts are not wildly out of date", () => {
  // Not exact — a count in prose that has to be updated on every added test is
  // a count nobody updates. But the gap that actually happened was 660 against
  // 1422, and a claim off by more than about a fifth is misleading rather
  // than merely stale.
  const claimed = Number(readme.match(/\*\*(\d+) unit tests\*\*/)?.[1]);
  assert.ok(claimed, "the README stopped stating a unit-test count");

  const files = readdirSync(new URL("../tests/", import.meta.url)).filter((f) =>
    f.endsWith(".test.mjs"),
  );
  // Counting `test(` calls undercounts loop-generated cases, so this is a
  // floor, and the assertion is one-sided on purpose: a README claiming fewer
  // tests than exist is modest, one claiming more is a lie.
  const floor = files.reduce(
    (n, f) => n + (read(`../tests/${f}`).match(/^test\(/gm)?.length ?? 0),
    0,
  );
  assert.ok(
    claimed <= floor * 1.2,
    `the README claims ${claimed} tests; at most ~${Math.round(floor * 1.2)} exist`,
  );
});

test("no current-state document points at a file that was deleted", () => {
  // The failure this catches: a module is deleted, the CHANGELOG correctly
  // records the deletion, and a reference-style document goes on describing it
  // as though a reader could open it.
  //
  // CHANGELOG.md and docs/ISSUE_AUDIT.md are deliberately excluded. They are
  // historical records — naming a file in order to say it was removed is their
  // entire job, and a check that forbade it would forbid the project from
  // recording its own history.
  const CURRENT = [
    "../README.md",
    "../CONTRIBUTING.md",
    "../docs/ARCHITECTURE.md",
    "../docs/KNOWN_LIMITATIONS.md",
    "../docs/TEST_CHECKLIST.md",
    "../docs/verquill-master-manual.md",
  ];
  const GONE = [
    "content/field-auto-mapper.js",
    "content/captcha-detector.js",
    "utils/shadow-walker.js",
    "utils/deduplicator.js",
    "data-sources/csv-parser.js",
    "data-sources/json-parser.js",
    "site/src/analyzer.js",
  ];

  for (const path of GONE) {
    assert.ok(
      !existsSync(new URL(`../${path}`, import.meta.url)),
      `${path} is back; this list is out of date, not the docs`,
    );
  }

  // A Set: one line naming two deleted files is one mistake, not two.
  const offences = new Set();
  for (const doc of CURRENT) {
    if (!existsSync(new URL(doc, import.meta.url))) continue;
    const lines = read(doc).split("\n");
    for (const path of GONE) {
      const base = path.split("/").pop();
      // A bare mention is allowed when the prose is explaining that the file
      // is gone; anything else is describing something that is not there.
      //
      // The window is the mentioning line plus its neighbours, not the line
      // alone, because a sentence explaining a deletion routinely wraps — the
      // README's own "have since been resolved" is split across two lines, and
      // a line-at-a-time check flagged the very paragraph that fixed this.
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].includes(base)) continue;
        const window = lines.slice(Math.max(0, i - 1), i + 3).join(" ");
        if (
          /\b(deleted|removed|gone|replaced|used to|no longer|since been)\b/i.test(
            window,
          )
        )
          continue;
        offences.add(
          `${doc.replace("../", "")}:${i + 1}: ${lines[i].trim().slice(0, 90)}`,
        );
      }
    }
  }
  assert.deepEqual(
    [...offences],
    [],
    "documents describe files that do not exist",
  );
});

// ── The master manual, checked against the tree rather than by hand ──────────
//
// docs/verquill-master-manual.md is a hand-maintained API reference: a list of
// source files and, under each, the functions it exports. That shape drifts by
// construction — nothing about deleting an export makes anyone open the manual.
// It had accumulated six links to files that no longer existed and sixteen
// entries for functions that had been removed, while carrying a note at the top
// admitting it was "partly stale" instead of being fixed.
//
// These two checks are the reason it can stop saying that. They are mechanical:
// a link either resolves or it does not, and a documented export either appears
// in the file it claims to come from or it does not.

const MANUAL = "../docs/verquill-master-manual.md";
const manual = read(MANUAL);

test("every source link in the manual resolves", () => {
  const dead = [...manual.matchAll(/\]\(\.\.\/([^)#]+)\)/g)]
    .map((m) => m[1])
    .filter((p) => !existsSync(new URL(`../${p}`, import.meta.url)));
  assert.deepEqual(
    [...new Set(dead)],
    [],
    "the manual links to files that do not exist",
  );
});

test("every export the manual documents exists in the file it cites", () => {
  // Deliberately a mention check, not a parse. The manual writes signatures
  // (`exportRows(rows, format, filename)`) that do not match the source
  // verbatim, so the assertion is the weaker, honest one: the name appears in
  // the file it is attributed to. That is enough to catch a deleted export,
  // which is the failure that actually happened, without pretending to a
  // precision this document does not have.
  const sections = manual.split(/\nSource: \[[^\]]+\]\(\.\.\/([^)]+)\)\n/);
  const missing = [];
  for (let i = 1; i < sections.length; i += 2) {
    const path = sections[i];
    const body = sections[i + 1];
    if (!existsSync(new URL(`../${path}`, import.meta.url))) continue;
    const src = read(`../${path}`);
    for (const m of body.matchAll(/^- `(\w+)\(/gm)) {
      if (!new RegExp(`\\b${m[1]}\\b`).test(src)) {
        missing.push(`${path}: ${m[1]}`);
      }
    }
  }
  assert.deepEqual(
    missing,
    [],
    "the manual documents functions that no longer exist",
  );
});

test("a section that documents a file lists at least one export", () => {
  // Removing the sixteen dead entries emptied one section's list entirely,
  // leaving a heading, a "Main exports:" label and nothing under it. That reads
  // as a module with no exports rather than as an edit that was not finished.
  const orphans = [
    ...manual.matchAll(/\n(Main exports|Important exports):\n+(?=#|$)/g),
  ];
  assert.equal(orphans.length, 0, "a section promises exports and lists none");
});
