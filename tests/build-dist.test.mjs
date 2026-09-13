// Packaging the thing so it can actually be installed by someone else.
//
// Both reviews said the same thing: no Chrome Web Store listing. That is true
// and it is the difference between a project and a product. It is also not
// something I can do — publishing needs an account, a fee and a human — so
// what is here is the part that can be done: a package that is correct, and
// the two documents a reviewer will ask for.
//
// The interesting problem is not zipping files. It is knowing which ones.
//
// A blocklist ("exclude tests, docs, e2e") fails open: rename a folder, add a
// new one, and it ships. The consequences are not cosmetic — this repository
// contains an `e2e` directory that launches browsers, a `mcp` directory with
// its own node_modules, and a `.claude` directory of working notes. Shipping
// any of that to a store review is at best embarrassing and at worst a
// rejection.
//
// So the package is built from an allowlist of what the extension actually
// loads, and then *checked*: every file the manifest names must be present,
// and every import in every shipped file must resolve to another shipped file.
// That turns "I think I excluded the right things" into something a machine
// can answer.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = new URL("../", import.meta.url);
const script = new URL("scripts/build-dist.mjs", ROOT);

const manifest = JSON.parse(
  readFileSync(new URL("manifest.json", ROOT), "utf8"),
);
const pkg = JSON.parse(readFileSync(new URL("package.json", ROOT), "utf8"));

let out;
let listing = [];

test.before(() => {
  if (!existsSync(script)) return;
  out = mkdtempSync(join(tmpdir(), "fs-dist-"));
  // fileURLToPath, not .pathname. On Windows a file:// URL's pathname is
  // "/D:/a/Verquill/scripts/build-dist.mjs" — the leading slash makes it an
  // invalid path, and passing it as `cwd` made spawnSync report ENOENT
  // against node.exe itself, which points at everything except the cause.
  const result = execFileSync(
    process.execPath,
    [fileURLToPath(script), "--out", out],
    { cwd: fileURLToPath(new URL(".", ROOT)), encoding: "utf8" },
  );
  listing = result.split("\n");
});

test.after(() => {
  if (out) rmSync(out, { recursive: true, force: true });
});

// ── It produces something ────────────────────────────────────────────────────

test("the build produces one zip, named for the version it built", () => {
  const files = readdirSync(out);
  const zips = files.filter((f) => f.endsWith(".zip"));
  assert.equal(zips.length, 1, `expected one zip, got ${files.join(", ")}`);
  assert.match(zips[0], new RegExp(manifest.version.replace(/\./g, "\\.")));
});

test("the manifest and the package agree on the version", () => {
  // They are read by different things and drift silently; a store upload
  // rejected for a duplicate version number is a slow way to find out.
  assert.equal(manifest.version, pkg.version);
});

// ── It contains what it must ─────────────────────────────────────────────────

test("every file the manifest names is in the package", () => {
  const named = [
    manifest.background.service_worker,
    manifest.side_panel.default_path,
    ...Object.values(manifest.icons),
    ...(manifest.web_accessible_resources ?? []).flatMap((r) => r.resources),
  ];
  for (const path of named) {
    assert.ok(
      listing.includes(path),
      `${path} is named by the manifest and missing from the package`,
    );
  }
});

test("nothing that only exists for development is in the package", () => {
  // Named individually rather than checked as a group: each of these is here
  // for a different reason and each would be a different kind of problem in a
  // store review.
  for (const unwanted of [
    "tests/", // the suite, including fixtures with fake keys in them
    "e2e/", // launches browsers; enormous
    ".claude/", // working notes, worktrees
    "node_modules/", // both of them
    "mcp/", // a separate Node server, not part of the extension
    "docs/", // for contributors, not for a browser
    "scripts/", // including this build script itself
    "site/", // the registry website; a separate deployment, not the extension
  ]) {
    const shipped = listing.filter((f) => f.startsWith(unwanted));
    assert.deepEqual(shipped, [], `${unwanted} was packaged`);
  }
});

test("nothing in the package imports something outside it", () => {
  // The check that makes the allowlist safe. An allowlist that misses a
  // directory produces an extension that installs and then fails at runtime
  // with a module-not-found nobody sees until a user reports it.
  const missing = listing.filter((line) => line.startsWith("MISSING "));
  assert.deepEqual(missing, [], "the build reported unresolved imports");
});

test("the icons are PNGs, at the sizes the manifest declares", () => {
  // All four were the same 1024x1024 JPEG with a .png extension: 334 KB each,
  // 1.3 MB of a 2.7 MB package, and no alpha channel, so the toolbar icon
  // would have shown as a solid rectangle. Chrome sniffs the type and would
  // have loaded them; a store review looks at the 128 and would not.
  for (const [size, path] of Object.entries(manifest.icons)) {
    const bytes = readFileSync(new URL(path, ROOT));
    assert.deepEqual(
      [...bytes.subarray(0, 8)],
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      `${path} is not a PNG`,
    );
    // Width and height live in the IHDR chunk, at a fixed offset.
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    assert.equal(width, Number(size), `${path} is ${width}px wide`);
    assert.equal(height, Number(size), `${path} is ${height}px tall`);
  }
});

// ── The documents a reviewer asks for ────────────────────────────────────────

test("there is a privacy policy, and it is specific", () => {
  const privacy = readFileSync(new URL("PRIVACY.md", ROOT), "utf8");
  // A store review rejects "we value your privacy". What it accepts is a
  // statement of what is collected, which here is genuinely nothing.
  assert.match(privacy, /no (analytics|telemetry)/i);
  assert.match(privacy, /chrome\.storage\.session/);
  // The honest caveat: a user who configures a hosted model is sending page
  // text to that provider. Leaving that out would make the rest untrue.
  assert.match(privacy, /provider/i);
});

test("every permission is justified, by name", () => {
  const doc = readFileSync(new URL("docs/STORE_LISTING.md", ROOT), "utf8");
  for (const perm of [
    ...manifest.permissions,
    ...(manifest.optional_permissions ?? []),
  ]) {
    assert.match(
      doc,
      new RegExp(`\\b${perm}\\b`),
      `${perm} is requested and not justified`,
    );
  }
  // The one a reviewer always asks about.
  assert.match(doc, /all_urls/);
});
