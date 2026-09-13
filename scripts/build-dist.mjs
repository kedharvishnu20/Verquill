// === build-dist.mjs ===
/**
 * Package the extension for the Chrome Web Store.
 *
 * The interesting problem here is not zipping files, it is knowing which ones.
 *
 * A blocklist — "exclude tests, docs, e2e" — fails open. Rename a folder, add
 * a new one, and it ships. That is not cosmetic in this repository: `e2e/`
 * launches browsers and is enormous, `mcp/` carries its own `node_modules`,
 * `tests/` contains fixtures with fake credentials in them, and `.claude/`
 * holds working notes and git worktrees. Any of those arriving at a store
 * review is at best embarrassing.
 *
 * So the package is built from an allowlist of what the extension actually
 * loads, and then checked twice:
 *
 *   1. Every file the manifest names must be in the package.
 *   2. Every import in every packaged file must resolve to another packaged
 *      file.
 *
 * The second is what makes the allowlist safe. An allowlist that misses a
 * directory produces an extension that installs cleanly and then fails at
 * runtime with a module-not-found that nobody sees until a user reports it.
 * Resolving the imports turns "I think I included everything" into something
 * the machine answers.
 *
 * The zip is written by hand, stored rather than deflated. Node has no zip
 * writer, the `zip` binary is not on every machine, and a build script that
 * needs a dependency to package a zero-dependency extension is its own small
 * joke. Chrome accepts stored entries.
 *
 * Usage: node scripts/build-dist.mjs [--out DIR]
 * Prints one packaged path per line, so a caller can check the contents.
 */

import {
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  mkdirSync,
} from "node:fs";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

/**
 * What the extension loads at runtime.
 *
 * Directories, not patterns: a pattern invites the same open failure a
 * blocklist has. Adding a directory here should be a decision someone makes
 * on purpose.
 */
const INCLUDE_DIRS = [
  "background",
  "checkpoint",
  "content",
  "ethics",
  "exporters",
  "icons",
  "script-gen",
  "sidepanel",
  "site/dist",
  "utils",
];

// `site/dist` belongs in the package, and the reasoning that once removed it
// was wrong in a specific way worth recording.
//
// It was excluded on the grounds that nothing in the manifest names it, so it
// could only be a separate deployment. Nothing in the manifest does name it —
// but the side panel does, at runtime:
//
//     chrome.tabs.create({ url: chrome.runtime.getURL("site/dist/index.html") })
//
// The manifest is not the only thing that can reference a packaged file, and
// checking only the manifest is how a button in the shipped extension came to
// open a chrome-extension:// URL that did not exist. It worked when loaded
// unpacked, where site/dist sits on disk from a local build, which is exactly
// the shape of bug that reaches a store review rather than a developer.
//
// It is also not optional: the registry reads chrome.storage for your local
// pipelines and writes the one it loads back there. Served from anywhere but
// the extension, `chrome` is undefined and half the page does nothing.
//
// `ensureSiteBuilt` below refuses to package a stale or missing build rather
// than shipping whatever happens to be lying around.

/** Loose files that belong in the package. */
const INCLUDE_FILES = ["manifest.json", "LICENSE", "PRIVACY.md"];

/** Never packaged, wherever they turn up inside an included directory. */
const SKIP_NAMES = new Set(["node_modules", ".git", ".DS_Store"]);

function walk(dir, out = []) {
  for (const entry of readdirSync(join(ROOT, dir))) {
    if (SKIP_NAMES.has(entry)) continue;
    const rel = posix.join(dir, entry);
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, out);
    else out.push(rel);
  }
  return out;
}

/**
 * Every relative import in a JavaScript file.
 *
 * Static and dynamic both: a service worker cannot use dynamic import, but the
 * side panel can, and a missing module is a missing module either way.
 */
function importsOf(source) {
  const found = [];
  const patterns = [
    /(?:^|\n)\s*import\s+[^;]*?from\s*["']([^"']+)["']/g,
    /(?:^|\n)\s*import\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\bexport\s+[^;]*?from\s*["']([^"']+)["']/g,
  ];
  for (const re of patterns) {
    for (const m of source.matchAll(re)) found.push(m[1]);
  }
  return found.filter((s) => s.startsWith("."));
}

/** Files the side panel's HTML pulls in — scripts, styles, fonts. */
function assetsOf(html, from) {
  const found = [];
  for (const m of html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/g)) {
    const ref = m[1];
    if (/^(https?:|data:|#|mailto:)/i.test(ref)) continue;
    found.push(posix.normalize(posix.join(posix.dirname(from), ref)));
  }
  // Fonts arrive through CSS `url(...)` rather than an attribute.
  for (const m of html.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) {
    const ref = m[1];
    if (/^(https?:|data:)/i.test(ref)) continue;
    found.push(posix.normalize(posix.join(posix.dirname(from), ref)));
  }
  return found;
}

// ── Minimal stored-entry zip ─────────────────────────────────────────────────

function crc32(bytes) {
  let c = -1;
  for (const b of bytes) {
    c ^= b;
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  }
  return (~c >>> 0) >>> 0;
}

function buildZip(entries) {
  const enc = new TextEncoder();
  const u16 = (n) => [n & 0xff, (n >> 8) & 0xff];
  const u32 = (n) => [
    n & 0xff,
    (n >> 8) & 0xff,
    (n >> 16) & 0xff,
    (n >>> 24) & 0xff,
  ];

  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const { name, bytes } of entries) {
    const nameBytes = enc.encode(name);
    const sum = crc32(bytes);
    const local = [
      ...u32(0x04034b50),
      ...u16(20),
      ...u16(0),
      ...u16(0), // stored
      ...u16(0),
      ...u16(0),
      ...u32(sum),
      ...u32(bytes.length),
      ...u32(bytes.length),
      ...u16(nameBytes.length),
      ...u16(0),
      ...nameBytes,
      ...bytes,
    ];
    locals.push(Uint8Array.from(local));

    centrals.push(
      Uint8Array.from([
        ...u32(0x02014b50),
        ...u16(20),
        ...u16(20),
        ...u16(0),
        ...u16(0),
        ...u16(0),
        ...u16(0),
        ...u32(sum),
        ...u32(bytes.length),
        ...u32(bytes.length),
        ...u16(nameBytes.length),
        ...u16(0),
        ...u16(0),
        ...u16(0),
        ...u16(0),
        ...u32(0),
        ...u32(offset),
        ...nameBytes,
      ]),
    );
    offset += local.length;
  }

  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = Uint8Array.from([
    ...u32(0x06054b50),
    ...u16(0),
    ...u16(0),
    ...u16(entries.length),
    ...u16(entries.length),
    ...u32(centralSize),
    ...u32(offset),
    ...u16(0),
  ]);

  const total = offset + centralSize + end.length;
  const zip = new Uint8Array(total);
  let at = 0;
  for (const part of [...locals, ...centrals, end]) {
    zip.set(part, at);
    at += part.length;
  }
  return zip;
}

// ── Build ────────────────────────────────────────────────────────────────────

const argOut = process.argv.indexOf("--out");
const outDir = argOut === -1 ? join(ROOT, "dist") : process.argv[argOut + 1];
mkdirSync(outDir, { recursive: true });

const manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));

/**
 * Build the registry site if its output is missing or older than its source.
 *
 * The package needs `site/dist`, but that directory is gitignored and absent
 * on a clean clone, so packaging cannot simply assume it. Nor can it ship
 * whatever happens to be lying around: a `dist` left over from an earlier
 * commit is worse than none, because it packages cleanly and then serves a
 * registry that disagrees with the extension beside it.
 *
 * So: rebuild when stale, and let a build failure stop the package rather than
 * degrade it. `npm ci` is not run here — if the site's dependencies are not
 * installed, that is a setup problem the error should say out loud rather than
 * something a packaging script quietly fixes.
 */
function ensureSiteBuilt() {
  const site = join(ROOT, "site");
  const dist = join(site, "dist", "index.html");

  const newestSource = ["src", "index.html", "vite.config.js", "public"]
    .map((p) => join(site, p))
    .filter(existsSync)
    .flatMap((p) =>
      statSync(p).isDirectory()
        ? walk(posix.join("site", p.slice(site.length + 1))).map((f) =>
            join(ROOT, f),
          )
        : [p],
    )
    .reduce((max, f) => Math.max(max, statSync(f).mtimeMs), 0);

  if (existsSync(dist) && statSync(dist).mtimeMs >= newestSource) return;

  process.stderr.write("site/dist is missing or stale — building it\n");
  try {
    execFileSync("npm", ["run", "build"], { cwd: site, stdio: "inherit" });
  } catch {
    throw new Error(
      "the registry site failed to build, so the package would ship a " +
        "registry button that opens nothing. Run `npm ci` in site/ and retry.",
    );
  }
}

ensureSiteBuilt();

const files = new Set(INCLUDE_FILES);
for (const dir of INCLUDE_DIRS) for (const f of walk(dir)) files.add(f);

const problems = [];

// 1. Everything the manifest names has to be there. A manifest pointing at a
//    file the package does not contain is an extension that will not load.
const named = [
  manifest.background?.service_worker,
  manifest.side_panel?.default_path,
  ...Object.values(manifest.icons ?? {}),
  ...(manifest.web_accessible_resources ?? []).flatMap((r) => r.resources),
].filter(Boolean);
for (const path of named) {
  if (!files.has(path)) problems.push(`MISSING ${path} (named by manifest)`);
}

// 2. Every import in every packaged file has to resolve inside the package.
for (const file of files) {
  if (file.endsWith(".js") || file.endsWith(".mjs")) {
    const src = readFileSync(join(ROOT, file), "utf8");
    for (const ref of importsOf(src)) {
      const target = posix.normalize(posix.join(posix.dirname(file), ref));
      if (!files.has(target)) {
        problems.push(`MISSING ${target} (imported by ${file})`);
      }
    }
  } else if (file.endsWith(".html")) {
    const html = readFileSync(join(ROOT, file), "utf8");
    for (const target of assetsOf(html, file)) {
      if (!files.has(target)) {
        problems.push(`MISSING ${target} (referenced by ${file})`);
      }
    }
  }
}

const sorted = [...files].sort();
const entries = sorted.map((name) => ({
  name,
  bytes: new Uint8Array(readFileSync(join(ROOT, name))),
}));

const zipName = `verquill-${manifest.version}.zip`;
writeFileSync(join(outDir, zipName), buildZip(entries));

// Printed rather than only summarised: the check that this packaged the right
// things belongs to the caller, and a list is what makes that checkable.
for (const name of sorted) console.log(name);
for (const problem of problems) console.log(problem);

const kb = Math.round(entries.reduce((n, e) => n + e.bytes.length, 0) / 1024);
console.error(
  `${zipName}: ${entries.length} files, ${kb} KB${problems.length ? ` — ${problems.length} PROBLEM(S)` : ""}`,
);

if (problems.length) process.exitCode = 1;

// === END build-dist.mjs ===
