// Publishing a pipeline to a public repository.
//
// Two separate failures met here, and they had the same root: nobody had
// checked whether the code that claimed to protect the author actually ran.
//
// `scrubCredentials` set `step.cookies` and `step.headers`. Neither exists
// anywhere in the product — a SET_HEADERS step keeps its data at
// `step.config.headers`, and a SESSION step carries no cookies at all. So it
// wrote two properties nothing reads and published the real `Authorization:`
// header verbatim into a public repo.
//
// And `site/src/analyzer.js` — a second copy of the capability rules — was
// imported by nothing, so the publish path ran no capability check either.
// That is `_gate2_pii` a third time: a control that exists, is the documented
// selling point, and is wired to nothing.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import {
  findPublishBlockers,
  analyzePipeline,
  VERDICT,
} from "../utils/pipeline-capabilities.js";

const app = readFileSync(
  new URL("../site/src/App.jsx", import.meta.url),
  "utf8",
);

const headerStep = (headers, type = "SET_HEADERS") => ({
  id: "h1",
  type,
  config: { headers },
});

// ── What must never be published ─────────────────────────────────────────────

test("a filled auth header is refused", () => {
  const found = findPublishBlockers({
    steps: [headerStep("Authorization: Bearer sk-live-abc123")],
  });
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].headers, ["Authorization"]);
  assert.equal(found[0].stepType, "SET_HEADERS");
});

test("the report names the header and never quotes the secret", () => {
  // The rule the PII detector and the capability analyser both hold to. A
  // warning about a leaked credential that repeats the credential — into a
  // toast, a log, a screenshot in a bug report — has made things worse.
  const found = findPublishBlockers({
    steps: [headerStep("Authorization: Bearer sk-live-SHOULD-NOT-APPEAR")],
  });
  const text = JSON.stringify(found);
  assert.match(text, /Authorization/);
  assert.ok(
    !text.includes("SHOULD-NOT-APPEAR"),
    "the secret is in the blocker report",
  );
});

test("the JSON form of the field is read too", () => {
  // The field accepts either shape, so checking only one is checking neither.
  const found = findPublishBlockers({
    steps: [headerStep(JSON.stringify({ "X-Api-Key": "abc123" }))],
  });
  assert.deepEqual(found[0].headers, ["X-Api-Key"]);
});

test("an API step's headers are covered as well", () => {
  // API keeps the same free-text headers field. A token typed into it is
  // exactly as public afterwards.
  const found = findPublishBlockers({
    steps: [headerStep("Authorization: Bearer abc", "API")],
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].stepType, "API");
});

test("a credential hidden inside a loop is still found", () => {
  const found = findPublishBlockers({
    steps: [
      {
        id: "l",
        type: "LOOP",
        config: {},
        children: [headerStep("Cookie: s=1")],
      },
    ],
  });
  assert.equal(found.length, 1);
});

// ── What must not be refused ─────────────────────────────────────────────────

test("a declared but empty auth header is not a leak", () => {
  // Nothing to leak, and refusing here would train people to ignore the gate.
  assert.deepEqual(
    findPublishBlockers({ steps: [headerStep("Authorization:")] }),
    [],
  );
  assert.deepEqual(
    findPublishBlockers({
      steps: [headerStep(JSON.stringify({ Authorization: "" }))],
    }),
    [],
  );
});

test("ordinary headers publish freely", () => {
  assert.deepEqual(
    findPublishBlockers({
      steps: [headerStep("Accept: application/json\nUser-Agent: Verquill")],
    }),
    [],
  );
});

test("a pipeline with no header steps at all is fine", () => {
  assert.deepEqual(
    findPublishBlockers({
      steps: [{ id: "e", type: "EXTRACT", config: { fields: [] } }],
    }),
    [],
  );
});

test("publishing is stricter than importing, on purpose", () => {
  // The two gates answer different questions. Importing asks "can this hurt me
  // if I run it", where your own token going to a site you chose is
  // survivable. Publishing asks "is this safe to make public", where the same
  // header is the entire problem. The import gate must NOT block this, and the
  // publish gate must.
  const pipeline = {
    steps: [
      { id: "w", type: "WEBSITE", config: { url: "https://shop.test" } },
      headerStep("Authorization: Bearer abc"),
    ],
  };
  assert.notEqual(analyzePipeline(pipeline).verdict, VERDICT.BLOCKED);
  assert.equal(findPublishBlockers(pipeline).length, 1);
});

// ── That the site actually calls it ──────────────────────────────────────────

test("the duplicate analyser is gone", () => {
  // Three copies of a security rule existed and had already begun to drift.
  // The copy that drifts is the one that stops refusing things.
  assert.ok(
    !existsSync(new URL("../site/src/analyzer.js", import.meta.url)),
    "site/src/analyzer.js is back",
  );
  assert.match(app, /from "\.\.\/\.\.\/utils\/pipeline-capabilities\.js"/);
});

test("credentials are checked before anything is sent", () => {
  // Order is the assertion. A check after the network call protects nobody,
  // and a public commit cannot be taken back.
  const fn = app.match(
    /const confirmPublish = async \(\) => \{[\s\S]*?\n  \};/,
  )?.[0];
  assert.ok(fn, "confirmPublish should still exist");
  const checkAt = fn.indexOf("findPublishBlockers(");
  const sendAt = fn.indexOf("publishToGlobal(");
  assert.ok(checkAt !== -1, "the publish path does not check for credentials");
  assert.ok(checkAt < sendAt, "it sends before checking for credentials");
});

test("the capability verdict is enforced before sending too", () => {
  const fn = app.match(
    /const confirmPublish = async \(\) => \{[\s\S]*?\n  \};/,
  )?.[0];
  const checkAt = fn.indexOf("VERDICT.BLOCKED");
  const sendAt = fn.indexOf("publishToGlobal(");
  assert.ok(checkAt !== -1, "the publish path does not check the verdict");
  assert.ok(checkAt < sendAt, "it sends before checking the verdict");
});

test("both checks read the edited JSON, not the original", () => {
  // The review box is editable. Checking the pipeline as it was offered would
  // let anyone paste a token past the gate after it had passed.
  const fn = app.match(
    /const confirmPublish = async \(\) => \{[\s\S]*?\n  \};/,
  )?.[0];
  assert.match(fn, /findPublishBlockers\(parsed\)/);
  assert.match(fn, /analyzePipeline\(parsed\)/);
});

test("the phantom scrub is gone", () => {
  // Assignments, not mentions — the docblock names both properties in order to
  // explain why they were wrong, and a test that cannot tell an explanation
  // from the code it describes would block its own fix from being documented.
  for (const dead of ["step.cookies", "step.headers"]) {
    const assigned = new RegExp(`${dead.replace(".", "\\.")}\\s*=`);
    assert.ok(
      !assigned.test(app),
      `${dead} is assigned again — it does not exist`,
    );
  }
});

test("the interface no longer claims a pull request it did not open", () => {
  // publishToGlobal commits straight to global/. Telling someone a human
  // reviewed their submission when nobody did is worse than saying nothing.
  assert.ok(
    !/Pull Request created successfully/.test(app),
    "the publish toast still claims a PR was created",
  );
});

// ── Where the token lives ────────────────────────────────────────────────────
//
// The registry token was written to chrome.storage.local, which persists
// across browser restarts. Every other API key in this extension is held in
// chrome.storage.session, encrypted, on the stated view that a scraping tool
// keeping a credential on disk forever is a worse trade than retyping it — and
// a token carrying Contents: Read & Write on the user's repositories is the
// last one that should have been the exception.

test("the token is written to session storage, never local", () => {
  const save = app.match(/const saveSettings = \(\) => \{[\s\S]*?\n  \};/)?.[0];
  assert.ok(save, "saveSettings should still exist");
  assert.match(save, /chrome\.storage\.session\.set\(\{ vq_github_pat/);
  assert.ok(
    !/local\.set\([\s\S]{0,80}vq_github_pat/.test(save),
    "the token is still being written to local storage",
  );
});

test("the repository URL still persists, because it is not a secret", () => {
  // Moving everything to session would log the user out of their own settings
  // on every restart for no gain.
  const save = app.match(/const saveSettings = \(\) => \{[\s\S]*?\n  \};/)?.[0];
  assert.match(save, /local\.set\(\{ vq_github_repo/);
});

test("a token left in local by an older version is swept, not read", () => {
  // Changing where new tokens go would otherwise leave the old one on disk
  // indefinitely — which is most of the exposure this was about.
  assert.match(app, /local\.remove\("vq_github_pat"\)/);
});

test("no session storage means no storage, not a quiet fallback", () => {
  // Falling back to local would put the token back on disk while the interface
  // reported it saved safely.
  const save = app.match(/const saveSettings = \(\) => \{[\s\S]*?\n  \};/)?.[0];
  const elseArm = save.slice(save.indexOf("chrome.storage.session"));
  assert.ok(
    !/local\.set[\s\S]{0,60}vq_github_pat/.test(elseArm),
    "it falls back to writing the token to disk",
  );
});
