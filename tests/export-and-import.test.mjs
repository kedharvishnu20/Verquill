// Regression tests for audit findings B-12, B-14, B-16 and D-09.
//
// B-12: pipeline-builder.js hardcoded `const format = "python"` with the
// comment "prompt() is blocked in sidepanel". There was no format control, so
// the 193-line Node emitter could only ever be reached through MCP.
//
// B-14: README §Script Export claimed "credentials are always redacted —
// replaced with os.environ.get(...)". Only the *proxy* was. serializePipeline
// had a REDACT regex the emitters never called, so a FILL step holding a
// password or an API step with an Authorization header was written into the
// downloaded file in plaintext.
//
// B-16: templates are resolved by the extension's executor at run time. The
// emitters copy config strings verbatim, so the generated script requested a
// URL with literal braces in it and said nothing about it.
//
// D-09: _normalizeImportedStep accepted any uppercase string as a step type. It
// rendered with a "?" icon and an undefined CSS colour, then failed at run time
// with "Unknown step type". Import also did not merge registry defaults, so a
// step missing keys rendered a half-empty config form.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
// Imported as a namespace, not by name: a named import of a function that does
// not exist yet is a load-time error, which would make the whole file fail as
// one test instead of failing per behaviour.
import * as compiler from "../script-gen/pipeline-compiler.js";
import { emitPython } from "../script-gen/python-emitter.js";
import { emitNode } from "../script-gen/node-emitter.js";

const panelSrc = await readFile(
  new URL("../sidepanel/pipeline-builder.js", import.meta.url),
  "utf8",
);
const htmlSrc = await readFile(
  new URL("../sidepanel/index.html", import.meta.url),
  "utf8",
);
const swSrc = await readFile(
  new URL("../background/service-worker.js", import.meta.url),
  "utf8",
);

const { compilePipeline } = compiler;
const redactSecrets = (ast) => compiler.redactSecrets(ast);
const findUnresolvedTemplates = (ast) => compiler.findUnresolvedTemplates(ast);

const compile = (steps) =>
  compilePipeline({ name: "t", targetOrigin: "https://shop.test", steps }).ast;
const step = (type, config = {}, extra = {}) => ({
  id: `s_${type}`,
  type,
  config,
  ...extra,
});

// ── B-14: credentials ────────────────────────────────────────────────────────

test("a password typed into a password field becomes an environment lookup", () => {
  const ast = compile([
    step("FILL", { selector: "input[type=password]", text: "hunter2" }),
  ]);
  const secrets = redactSecrets(ast);

  assert.equal(secrets.length, 1);
  assert.equal(secrets[0].env, "VQ_SECRET_1");
  assert.equal(secrets[0].type, "FILL");

  const py = emitPython(ast);
  assert.ok(!py.includes("hunter2"), "the password is not in the file");
  assert.match(py, /vq_env\("__VQ_ENV__VQ_SECRET_1__"\)/);
  assert.match(py, /def vq_env\(s\)/, "and the script can resolve it");
  assert.match(py, /os\.environ\.get\(m\.group\(1\), ""\)/);
});

test("an Authorization header becomes an environment lookup", () => {
  const ast = compile([
    step("API", {
      url: "https://api.shop.test/v1",
      method: "GET",
      headers:
        '{"Accept":"application/json","Authorization":"Bearer sk-live-123"}',
    }),
  ]);
  const secrets = redactSecrets(ast);

  assert.equal(secrets.length, 1);
  assert.equal(secrets[0].where, "headers.Authorization");

  const py = emitPython(ast);
  const js = emitNode(ast);
  for (const [lang, code] of [
    ["python", py],
    ["node", js],
  ]) {
    assert.ok(!code.includes("sk-live-123"), `${lang} leaked the token`);
    assert.ok(code.includes("__VQ_ENV__VQ_SECRET_1__"), `${lang} marker`);
  }
  assert.match(py, /json\.loads\(vq_env\(/);
  assert.match(js, /JSON\.parse\(vqEnv\(/);
});

test("credential-named config keys are caught wherever they sit", () => {
  const ast = compile([
    step("API", { url: "https://a.test", apiKey: "abc123", token: "t-9" }),
  ]);
  const secrets = redactSecrets(ast);
  assert.equal(secrets.length, 2);
  assert.ok(!emitPython(ast).includes("abc123"));
});

test("ordinary values are left alone", () => {
  const ast = compile([
    step("FILL", { selector: "#search", text: "blue running shoes" }),
    step("API", {
      url: "https://a.test",
      headers: '{"Accept":"application/json"}',
    }),
  ]);
  assert.deepEqual(redactSecrets(ast), []);
  assert.match(emitPython(ast), /blue running shoes/);
});

test("the Node script can resolve markers too", () => {
  const ast = compile([step("FILL", { selector: "#pwd", text: "s3cret" })]);
  redactSecrets(ast);
  const js = emitNode(ast);
  assert.ok(!js.includes("s3cret"));
  assert.match(js, /const vqEnv = s =>/);
  assert.match(js, /process\.env\[n\] \?\? ''/);
});

test("a header block that is not JSON is left alone rather than mangled", () => {
  const ast = compile([
    step("API", { url: "https://a.test", headers: "not: json" }),
  ]);
  assert.deepEqual(redactSecrets(ast), []);
  assert.equal(ast.steps[0].config.headers, "not: json");
});

// ── B-16: templates ──────────────────────────────────────────────────────────

test("templates left in a pipeline are found, with where they are", () => {
  const found = findUnresolvedTemplates(
    compile([
      step("NAVIGATE", { url: "https://shop.test/p/{{loop.index}}" }),
      step(
        "LOOP",
        { max: 2 },
        { children: [step("CLICK", { selector: ".x{{item.id}}" })] },
      ),
    ]),
  );
  assert.equal(found.length, 2);
  assert.deepEqual(found.map((f) => f.template).sort(), [
    "{{item.id}}",
    "{{loop.index}}",
  ]);
  assert.equal(found[0].where, "config.url");
  assert.equal(found[1].type, "CLICK", "nested steps are scanned too");
});

test("a pipeline with no templates reports none", () => {
  assert.deepEqual(
    findUnresolvedTemplates(
      compile([step("NAVIGATE", { url: "https://shop.test" })]),
    ),
    [],
  );
});

test("the export handler reports templates and secrets alongside the code", () => {
  const handler = swSrc.match(
    /_registerHandler\("script:export"[\s\S]*?\n\}\);/,
  )[0];
  assert.match(handler, /findUnresolvedTemplates\(ast\)/);
  assert.match(handler, /redactSecrets\(ast\)/);
  assert.match(handler, /return \{ code, unexportable, templates, secrets \}/);
  assert.ok(
    handler.indexOf("findUnresolvedTemplates") <
      handler.indexOf("redactSecrets"),
    "the scans must read the original values, before redaction rewrites them",
  );
});

test("the panel says what it found before handing the file over", () => {
  assert.match(panelSrc, /Unresolved template in \$\{t\.type\} \$\{t\.where\}/);
  assert.match(panelSrc, /credential\(s\) replaced with environment variables/);
  assert.match(panelSrc, /Set them before running the script/);
});

// ── B-12: the format selector ────────────────────────────────────────────────

test("the Node emitter is reachable from the UI", () => {
  assert.match(htmlSrc, /id="sel-export-format"/);
  assert.match(htmlSrc, /<option value="node">Node<\/option>/);

  const code = panelSrc
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.ok(
    !/const format = "python";/.test(code),
    "the format was pinned to python in code",
  );
  assert.match(
    panelSrc,
    /getElementById\("sel-export-format"\)\?\.value === "node"/,
  );
});

test("the worker honours the requested format", () => {
  const handler = swSrc.match(
    /_registerHandler\("script:export"[\s\S]*?\n\}\);/,
  )[0];
  assert.match(
    handler,
    /payload\.format === "node" \? emitNode\(ast\) : emitPython\(ast\)/,
  );
});

// ── D-09: import validation ──────────────────────────────────────────────────

const normalize = (...args) => {
  const src = panelSrc.match(
    /function _normalizeImportedStep\(step, where, seenIds\) \{[\s\S]*?\n\}/,
  )[0];
  const helpers = panelSrc.match(/function _nextStepId\(\) \{[\s\S]*?\n\}/)[0];
  return new Function(
    "STEP_TYPES",
    "USER_STEP_TYPES",
    "defaultConfig",
    "isKnownStepType",
    `${helpers}\n${src}\nreturn _normalizeImportedStep;`,
  )(
    STEP_TYPES_REF,
    USER_STEP_TYPES_REF,
    defaultConfigRef,
    isKnownStepTypeRef,
  )(...args);
};

const {
  STEP_TYPES: STEP_TYPES_REF,
  USER_STEP_TYPES: USER_STEP_TYPES_REF,
  defaultConfig: defaultConfigRef,
  isKnownStepType: isKnownStepTypeRef,
} = await import("../utils/step-types.js");

test("an unknown step type is refused at import, not at run time", () => {
  assert.throws(
    () => normalize({ type: "TELEPORT", config: {} }, "steps[0]", new Set()),
    /unknown step type "TELEPORT"/,
  );
});

test("an internal dispatch type cannot be imported as a step", () => {
  assert.throws(
    () => normalize({ type: "QUERY_COUNT", config: {} }, "steps[0]", new Set()),
    /dispatches internally/,
  );
});

test("a known type is accepted and gets the registry defaults", () => {
  const out = normalize(
    { type: "CLICK", config: { selector: ".buy" } },
    "steps[0]",
    new Set(),
  );
  assert.equal(out.type, "CLICK");
  assert.equal(out.config.selector, ".buy", "the file's value wins");
  assert.equal(out.config.all, false, "and the missing keys are filled in");
  assert.equal(out.config.fallbackToLoopItem, false);
});

test("a step with no config at all is still usable", () => {
  const out = normalize({ type: "SCROLL" }, "steps[0]", new Set());
  assert.equal(out.config.mode, "pixel");
  assert.equal(out.config.amount, 500);
});

test("lowercase types are still accepted, as they always were", () => {
  assert.equal(normalize({ type: "click" }, "s", new Set()).type, "CLICK");
});

test("a missing type still fails with its own message", () => {
  assert.throws(
    () => normalize({ config: {} }, "steps[3]", new Set()),
    /missing a step type/,
  );
});
