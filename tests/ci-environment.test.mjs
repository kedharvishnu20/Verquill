// The two things that were green here and red on a clean runner.
//
// Both were found by CI on its first real run, and both had the same shape: a
// check that passed because of something the development machine happened to
// have, not because the code was right. That is the entire reason CI was added,
// so these tests pin the fixes rather than leaving them to be rediscovered.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

// ── The import allowlist matched prefixes, not module names ─────────────────
//
// tests/export-parity.test.mjs runs the Python the emitter produces, having
// first stripped the imports the probe does not need — playwright and
// requests. The allowlist of imports to KEEP was written without a word
// boundary, so `re` matched the first two letters of `requests` and the line
// survived. Nine tests then quietly depended on the machine having requests
// installed. This one did. A fresh GitHub runner did not, and all nine failed.

const STRIP =
  /^(import |from )(?!(?:asyncio|os|re|sys|io|json|csv|time|random|base64|urllib)\b).*$/gm;

test("the parity test still strips third-party imports by whole name", () => {
  // Read the live regex out of the test file rather than trusting the copy
  // above, so this fails if the real one is edited back.
  const src = read("../tests/export-parity.test.mjs");
  assert.ok(
    src.includes(String(STRIP).slice(1, -3)),
    "the import-stripping regex changed; re-check it against this test",
  );
});

test("a module whose name merely starts with an allowed one is stripped", () => {
  const lines = [
    "import requests", // starts with "re"
    "from requests.adapters import HTTPAdapter",
    "from playwright.async_api import async_playwright",
    "import ioredis", // starts with "io"
    "import osmium", // starts with "os"
    "import timeit", // starts with "time"
    "import csvkit", // starts with "csv"
  ].join("\n");
  const kept = lines.replace(STRIP, "").split("\n").filter(Boolean);
  assert.deepEqual(kept, [], `these should all have been stripped: ${kept}`);
});

test("the modules the probe genuinely needs are kept", () => {
  // The other half of the assertion. A stripper that removed everything would
  // pass the test above and break every probe.
  const lines = [
    "import asyncio",
    "import os",
    "import re",
    "import sys",
    "import io",
    "import json",
    "import csv",
    "import time",
    "import random",
    "import base64",
    "from urllib.parse import quote",
  ];
  const kept = lines.join("\n").replace(STRIP, "").split("\n").filter(Boolean);
  assert.equal(
    kept.length,
    lines.length,
    `dropped: ${lines.filter((l) => !kept.includes(l))}`,
  );
});

// ── Line endings ────────────────────────────────────────────────────────────
//
// Windows runners check out with core.autocrlf=true. Prettier's endOfLine is
// "lf". With no .gitattributes the format gate reported 210 files as badly
// formatted on Windows and none on Linux — a red build with nothing in the
// diff to fix, caused entirely by the checkout.

test("line endings are settled in the repository, not per machine", () => {
  assert.ok(
    existsSync(new URL("../.gitattributes", import.meta.url)),
    ".gitattributes is gone; Windows will check out CRLF and the format gate will fail",
  );
  const attrs = read("../.gitattributes");
  assert.match(
    attrs,
    /^\*\s+text=auto\s+eol=lf$/m,
    "the catch-all eol=lf rule is missing",
  );
});

test("binary files are marked binary, so normalisation cannot corrupt them", () => {
  // eol=lf on `*` is a text rule, but git's text/binary heuristic is a guess.
  // A .woff2 it guesses wrong about is rewritten and fails as a missing glyph,
  // which looks like a CSS problem rather than a checkout problem.
  const attrs = read("../.gitattributes");
  for (const ext of ["woff2", "png", "zip"]) {
    assert.match(
      attrs,
      new RegExp(`^\\*\\.${ext}\\s+binary$`, "m"),
      `*.${ext} is not marked binary`,
    );
  }
});

// ── Paths that are only wrong on Windows ────────────────────────────────────
//
// Windows got past the format gate for the first time and immediately failed
// 17 tests that Linux passes, in two shapes and one root cause: a file:// URL
// and an OS path are not interchangeable, and on POSIX they look like they
// are.
//
//   `new URL(…).pathname` on Windows is "/D:/a/Verquill/…". The leading slash
//   makes it an invalid path — passed as `cwd`, spawnSync reported ENOENT
//   against node.exe itself, naming everything except the cause.
//
//   `import("C:\\…")` reads "c:" as a URL scheme and throws
//   ERR_UNSUPPORTED_ESM_URL_SCHEME. On POSIX the same string imports fine.
//
// Neither can be caught by running the suite on Linux, which is why this is a
// source check rather than a behavioural one. The browser suites are
// Linux-only too, so nothing else in the project would notice.

import { readdirSync as _readdir } from "node:fs";

const TEST_FILES = _readdir(new URL("../tests/", import.meta.url)).filter((f) =>
  f.endsWith(".test.mjs"),
);

test("no test converts a file URL to a path with .pathname", () => {
  // fileURLToPath() is the conversion that is correct on both platforms.
  const offences = [];
  for (const f of TEST_FILES) {
    const src = read(`../tests/${f}`);
    src.split("\n").forEach((line, i) => {
      // Skip comments — this file and two others explain the rule by naming it.
      if (/^\s*(\/\/|\*)/.test(line)) return;
      if (/\bURL\([^)]*\)\s*\.pathname\b/.test(line)) {
        offences.push(`tests/${f}:${i + 1}: ${line.trim().slice(0, 80)}`);
      }
    });
  }
  assert.deepEqual(
    offences,
    [],
    "use fileURLToPath(url) instead of url.pathname",
  );
});

test("no test imports a bare OS path", () => {
  // import() takes a URL. pathToFileURL(p).href is the portable form.
  const offences = [];
  for (const f of TEST_FILES) {
    const src = read(`../tests/${f}`);
    src.split("\n").forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line)) return;
      const m = line.match(/\bimport\((\w+)\)/);
      if (!m) return;
      // Follow the identifier to where it is declared rather than judging it
      // by its name. The first version of this check read the name, decided
      // `MODULE` did not look like a URL, and flagged
      // `const MODULE = new URL(...).href` — which is exactly right already.
      const decl = src.match(
        new RegExp(`(?:const|let|var)\\s+${m[1]}\\s*=\\s*([^;]+);`),
      );
      const holdsUrl =
        decl && /\.href\b|pathToFileURL|^\s*new URL\(/.test(decl[1]);
      if (!holdsUrl) {
        offences.push(`tests/${f}:${i + 1}: import(${m[1]})`);
      }
    });
  }
  assert.deepEqual(
    offences,
    [],
    "import() needs a URL: use pathToFileURL(p).href",
  );
});
