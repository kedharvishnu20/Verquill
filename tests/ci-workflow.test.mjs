// The gates, and the promise that they run.
//
// README and CONTRIBUTING both described checks running "in CI" while no CI
// existed. That is not a documentation slip on its own — it is why a rewrite
// landed on `dev` with eight tests failing and nobody noticed, and why an
// outside audit of the same tree reported 51 failures that were mostly its own
// environment. A claim about enforcement is worth nothing unless something
// enforces it.
//
// These tests are cheap and blunt on purpose. They cannot prove GitHub ran a
// workflow; they can prove the workflow exists, names every gate the project
// tells contributors to rely on, and did not quietly lose one.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const ci = read("../.github/workflows/ci.yml");
const browser = read("../.github/workflows/browser.yml");
const pkg = JSON.parse(read("../package.json"));

test("there is a CI workflow at all", () => {
  assert.ok(
    existsSync(new URL("../.github/workflows/ci.yml", import.meta.url)),
    "the docs promise CI; the workflow is gone",
  );
});

test("every gate a contributor is told to run is also run by CI", () => {
  // If a script is worth telling people to run, it is worth blocking a merge
  // on. A gate that exists only locally is a gate only the careful use.
  for (const script of ["check", "lint", "format:check", "test", "build"]) {
    assert.ok(pkg.scripts[script], `package.json lost the ${script} script`);
    assert.ok(
      ci.includes(`npm run ${script}`) || ci.includes("npm test"),
      `CI does not run ${script}`,
    );
  }
  assert.match(ci, /npm test/);
});

test("CI installs from the lockfile rather than resolving afresh", () => {
  // `npm ci` fails when package.json and the lockfile disagree. That check is
  // the point, not a side effect of a faster install.
  //
  // Read from the `run:` steps rather than the whole file, because the file
  // also explains in a comment why `npm ci` is used instead of the other one —
  // and a test that cannot tell a command from a sentence about that command
  // would forbid the workflow from documenting its own reasoning.
  const commands = [...ci.matchAll(/^\s*(?:- )?run: (.+)$/gm)].map((m) => m[1]);
  assert.ok(commands.includes("npm ci"), "CI does not install the lockfile");
  assert.ok(
    !commands.some((c) => c.startsWith("npm install")),
    "a CI step resolves dependencies instead of installing the lockfile",
  );
});

test("CI runs on Windows as well as Linux", () => {
  // Four tests spawned python3 with no guard and one guarded with `sh -c`,
  // which is itself POSIX-only. Both survived because nothing ever ran this
  // suite anywhere but Linux.
  assert.match(ci, /ubuntu-latest/);
  assert.match(ci, /windows-latest/);
  assert.match(ci, /fail-fast: false/);
});

test("CI installs Python, so the optional-dependency skips hide nothing", () => {
  // The skips are honest, but a skip on every runner is not coverage.
  assert.match(ci, /setup-python/);
});

test("CI builds the site, because it shares the security module", () => {
  // site/src/App.jsx imports utils/pipeline-capabilities.js across directories.
  // If that import stops resolving the site loses its publish gate silently,
  // which is the failure this repository has now had twice.
  assert.match(ci, /working-directory: site/);
  assert.match(ci, /npm run build/);
});

test("the browser suites run somewhere, just not on every pull request", () => {
  // Four minutes per run. A gate that slow gets worked around rather than
  // waited for — but it still has to run, because it covers what no unit test
  // can reach.
  assert.match(browser, /schedule:/);
  assert.match(browser, /cron:/);
  assert.match(browser, /npm run e2e/);
  assert.match(browser, /npm run challenges/);
  assert.ok(
    !/pull_request/.test(browser),
    "the slow suites are back on the pull-request path",
  );
});

test("the test script does not depend on the shell expanding a glob", () => {
  // `node --test tests/*.test.mjs` is expanded by the shell on Linux and not
  // at all by cmd.exe, so on Windows node received the literal pattern and ran
  // nothing. Quoted, node expands it itself and both platforms agree.
  assert.match(pkg.scripts.test, /"tests\/\*\.test\.mjs"/);
});

test("linting is a gate, not an ad-hoc npx invocation", () => {
  // `npm run check` parses; it cannot see a reference to a name that is not in
  // scope. A mechanical dead-code removal in this repository left orphaned
  // statements behind that were syntactically valid and referenced variables
  // that no longer existed. All 1420 unit tests passed. Only the browser suite
  // caught it, four minutes later and on a nightly schedule.
  //
  // The linter is pinned as a devDependency rather than run through npx so CI
  // and a contributor's machine run the same version, and so a network blip
  // cannot silently skip the gate.
  assert.equal(typeof pkg.devDependencies?.oxlint, "string");
  assert.match(
    pkg.devDependencies.oxlint,
    /^\d+\.\d+\.\d+$/,
    "the linter is on a floating range; two machines can disagree about a gate",
  );
  assert.ok(
    existsSync(new URL("../.oxlintrc.json", import.meta.url)),
    "the lint config is gone, so the rules are whatever the default is",
  );
});

test("the lint config keeps the rule that catches an undefined reference", () => {
  // no-undef is the whole reason this gate was added. Turned off, the gate
  // still passes and still catches nothing.
  const rc = JSON.parse(read("../.oxlintrc.json"));
  assert.equal(rc.rules["no-undef"], "error");
});

test("the package declares the licence it ships", () => {
  // LICENSE has always been there; the field npm and every downstream tool
  // reads was not.
  assert.equal(pkg.license, "MIT");
});

// ── Release ─────────────────────────────────────────────────────────────────

test("a release cannot ship a package whose version disagrees with its tag", () => {
  // Chrome only accepts an update whose version is higher than the installed
  // one. A release tagged v3.1.0 carrying a manifest that still says 3.0.0
  // uploads cleanly, reviews cleanly, and reaches nobody — and nothing in the
  // process says so until someone notices the install count did not move.
  const release = read("../.github/workflows/release.yml");
  assert.match(release, /manifest\.json'\)\.version/);
  assert.match(release, /package\.json'\)\.version/);
  assert.match(release, /github\.ref_name/);
});

test("manifest.json and package.json already agree", () => {
  // The workflow checks this at release time. This checks it now, because
  // discovering a mismatch while cutting a release is the expensive moment.
  const manifest = JSON.parse(read("../manifest.json"));
  assert.equal(
    manifest.version,
    pkg.version,
    "manifest.json and package.json state different versions",
  );
});

test("the release runs the same gates as CI", () => {
  // A tag is the worst moment to find out the tree was red.
  const release = read("../.github/workflows/release.yml");
  for (const script of ["check", "lint", "format:check", "build"]) {
    assert.ok(
      release.includes(`npm run ${script}`),
      `the release workflow does not run ${script}`,
    );
  }
  assert.match(release, /npm test/);
});

test("the release drafts rather than publishes", () => {
  // CHANGELOG.md is prose explaining why each change exists. A generated commit
  // list is not a substitute, so a person writes the notes.
  const release = read("../.github/workflows/release.yml");
  assert.match(release, /--draft/);
});

test("dependabot watches the tooling, the site and the actions", () => {
  // The extension ships no dependencies. Everything watched here is tooling or
  // the separate website — which is where a supply-chain problem actually
  // reaches this project.
  const dep = read("../.github/dependabot.yml");
  for (const dir of ["/", "/site"]) {
    assert.ok(
      new RegExp(`directory: ${dir === "/" ? "/\\s" : dir}`).test(dep),
      `dependabot does not watch ${dir}`,
    );
  }
  assert.match(dep, /github-actions/);
  // Monthly and grouped, on purpose: a pull request nobody reads is not a
  // security control, and that is what weekly ungrouped updates become.
  assert.match(dep, /interval: monthly/);
  assert.match(dep, /groups:/);
});
