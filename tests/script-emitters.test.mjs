// Regression tests for audit findings B-13 and B-15.
//
// B-13: the emitters covered 11 of 21 step types. Everything else fell through
// to `# TODO: implement step type "X"` — a comment. The exported script looked
// complete, ran, and silently did less than the pipeline it came from. FILL was
// among the missing ones, so a form-filling pipeline exported as a script that
// filled nothing.
//
// B-15: SCROLL read config.value, but the UI writes config.amount, so every
// exported scroll used the hardcoded default of 300px.
import test from "node:test";
import assert from "node:assert/strict";
import {
  compilePipeline,
  findUnexportableSteps,
} from "../script-gen/pipeline-compiler.js";
import { emitPython } from "../script-gen/python-emitter.js";
import { emitNode } from "../script-gen/node-emitter.js";
import {
  EXPORTABLE_STEP_TYPES,
  USER_STEP_TYPES,
  STEP_TYPES,
} from "../utils/step-types.js";

const compile = (steps) =>
  compilePipeline({ name: "t", targetOrigin: "https://shop.test", steps }).ast;

const emit = (steps) => ({
  py: emitPython(compile(steps)),
  js: emitNode(compile(steps)),
});

const step = (type, config = {}, extra = {}) => ({
  id: `s_${type}`,
  type,
  config,
  ...extra,
});

test("FILL is emitted, in both languages", () => {
  const { py, js } = emit([
    step("FILL", { selector: "#email", text: "a@b.test" }),
  ]);
  // Values pass through vq_env/vqEnv so a credential marker (B-14) resolves at
  // run time; an ordinary value comes back from it unchanged.
  assert.match(py, /await page\.fill\("#email", vq_env\("a@b\.test"\)\)/);
  assert.match(js, /await page\.fill\('#email', vqEnv\('a@b\.test'\)\)/);
});

test("multi-field FILL emits every field and the submit click", () => {
  const { py } = emit([
    step("FILL", {
      mode: "multi",
      fields: [
        { selector: "#first", value: "Ada" },
        { selector: "#last", value: "Lovelace" },
      ],
      submitSelector: "#go",
    }),
  ]);
  assert.match(py, /page\.fill\("#first", vq_env\("Ada"\)\)/);
  assert.match(py, /page\.fill\("#last", vq_env\("Lovelace"\)\)/);
  assert.match(py, /page\.click\("#go"\)/);
});

test("HOVER, SELECT, KEYBOARD, PAGINATE, DRAG_DROP and SCREENSHOT all emit", () => {
  const { py, js } = emit([
    step("HOVER", { selector: ".menu" }),
    step("SELECT", { selector: "#size", value: "L" }),
    step("KEYBOARD", { key: "Enter" }),
    step("PAGINATE", { selector: ".next" }),
    step("ASSERT", {
      assertion: "count-at-least",
      selector: ".card",
      count: 3,
    }),
    step("CLICK", { selector: ".flaky", retries: 2, retryDelayMs: 250 }),
    step("DRAG_DROP", { source: ".a", target: ".b" }),
    step("SCREENSHOT", {}),
  ]);

  for (const [lang, code] of [
    ["python", py],
    ["node", js],
  ]) {
    assert.ok(!/TODO/.test(code), `${lang} emitted a TODO`);
    assert.ok(/hover/i.test(code), `${lang} hover`);
    assert.ok(/select_option|selectOption/.test(code), `${lang} select`);
    assert.ok(/keyboard\.press/.test(code), `${lang} keyboard`);
    assert.ok(/drag/i.test(code), `${lang} drag`);
    assert.ok(/screenshot/i.test(code), `${lang} screenshot`);
  }
});

test("a Ctrl combo becomes Playwright's key name", () => {
  const { py } = emit([step("KEYBOARD", { key: "Ctrl+Enter" })]);
  assert.match(py, /keyboard\.press\("Control\+Enter"\)/);
});

test("SCROLL uses the amount the UI actually writes", () => {
  const { py, js } = emit([step("SCROLL", { mode: "pixel", amount: 1200 })]);
  assert.match(
    py,
    /scrollBy\(0, 1200\)/,
    "config.amount, not the 300px default",
  );
  assert.match(js, /scrollBy\(0, 1200\)/);
});

test("SCROLL honours its other modes", () => {
  assert.match(
    emit([step("SCROLL", { mode: "selector", selector: "#footer" })]).py,
    /scroll_into_view_if_needed/,
  );
  assert.match(
    emit([step("SCROLL", { mode: "percent", amount: 50 })]).py,
    /scrollHeight \* 0\.5/,
  );
});

// ── K-26: a named container is scrolled, not the document ──────────────────

test("a container scroll targets the container's own locator, not window", () => {
  const { py, js } = emit([
    step("SCROLL", { mode: "pixel", amount: 250, container: "#feed" }),
  ]);
  for (const src of [py, js]) {
    assert.match(src, /locator\(['"]#feed['"]\)/, "the container is a locator");
    assert.match(src, /scrollBy\(0, (250|amt)\)/);
    assert.match(
      src,
      /250/,
      "the amount travels with the step even if not inline",
    );
    assert.doesNotMatch(src, /window\.scrollBy/);
  }
});

test("percent scroll against a container reads the container's own scrollHeight", () => {
  const { py, js } = emit([
    step("SCROLL", { mode: "percent", amount: 50, container: "#feed" }),
  ]);
  for (const src of [py, js]) {
    assert.match(src, /locator\(['"]#feed['"]\)/);
    assert.match(src, /el\.scrollTo\(0, el\.scrollHeight \* (0\.5|pct)\)/);
    assert.match(src, /0\.5/, "the percentage travels with the step");
    assert.doesNotMatch(src, /window\.scrollTo/);
  }
});

test("infinite scroll against a container loops on the container's own height", () => {
  const { py, js } = emit([
    step("SCROLL", {
      mode: "infinite",
      maxScrolls: 5,
      settleMs: 200,
      container: "#feed",
    }),
  ]);
  for (const src of [py, js]) {
    assert.match(src, /locator\(['"]#feed['"]\)/);
    assert.match(src, /5/, "the scroll limit is still carried over");
    assert.match(src, /scrollHeight/);
    assert.doesNotMatch(
      src,
      /window\.scrollTo|document\.documentElement\.scrollHeight/,
    );
  }
});

// ── what cannot be exported ──────────────────────────────────────────────────

test("an unexportable step fails loudly instead of becoming a comment", () => {
  const { py, js } = emit([step("AUTO_EXTRACT", {})]);

  assert.match(
    py,
    /raise NotImplementedError/,
    "python refuses to run past it",
  );
  assert.match(js, /throw new Error/, "node refuses to run past it");
  assert.ok(!/# TODO/.test(py), "a comment let the script run and do nothing");
});

test("unexportable steps are reported, including nested ones", () => {
  const ast = compile([
    step("NAVIGATE", { url: "https://shop.test" }),
    step("LOOP", { max: 3 }, { children: [step("AUTO_EXTRACT", {})] }),
    step(
      "IF_ELSE",
      {},
      {
        ifBranch: [step("API_SNIFFER", {})],
        elseBranch: [step("CLICK", { selector: ".x" })],
      },
    ),
  ]);

  const found = findUnexportableSteps(ast)
    .map((s) => s.type)
    .sort();
  assert.deepEqual(found, ["API_SNIFFER", "AUTO_EXTRACT"]);
});

test("a fully exportable pipeline reports nothing", () => {
  const ast = compile([
    step("NAVIGATE", { url: "https://shop.test" }),
    step("CLICK", { selector: ".a" }),
    step("EXTRACT", { fields: [{ name: "t", selector: "h1" }] }),
    step("EXPORT", { format: "csv" }),
  ]);
  assert.deepEqual(findUnexportableSteps(ast), []);
});

test("each unexportable step says why", () => {
  const ast = compile([step("UPLOAD_ACTIVITY", {})]);
  const [found] = findUnexportableSteps(ast);
  assert.equal(found.type, "UPLOAD_ACTIVITY");
  assert.ok(found.reason.length > 0);
  assert.equal(found.id, "s_UPLOAD_ACTIVITY");
});

// ── registry agreement ───────────────────────────────────────────────────────

test("every step the registry calls exportable really is emitted", () => {
  // Closes the drift loop: marking a type exportable without teaching the
  // emitters about it fails here rather than in a user's downloaded script.
  const missing = [];
  for (const type of EXPORTABLE_STEP_TYPES) {
    if (STEP_TYPES[type].internal) continue;
    const code = emitPython(compile([step(type, STEP_TYPES[type].def)]));
    if (/NotImplementedError|# TODO/.test(code)) missing.push(type);
  }
  assert.deepEqual(
    missing,
    [],
    "these are marked exportable but emit a failure",
  );
});

test("the unexportable types are the ones that need the extension", () => {
  const notExportable = USER_STEP_TYPES.filter(
    (t) => STEP_TYPES[t].exportable === false,
  );
  assert.deepEqual(notExportable.sort(), [
    "API_SNIFFER",
    "AUTO_EXTRACT",
    // PAGE_JSON's DOM walker is two hundred lines with its own budgets and
    // filters; a second copy inlined into every emitted script would drift
    // from it, and a script that dumps a *different* JSON than the pipeline
    // is worse than one that refuses.
    "PAGE_JSON",
    "PDF_EXTRACTION",
    // SOLVE_CAPTCHA's gates are the step: an emitted script carries neither
    // the run's authorisation nor the domain attestation, so exporting it
    // would be exporting the act with the consent taken out.
    // A saved session lives encrypted inside the extension, and a shared
    // pipeline must not carry someone's cookies out with it. Playwright's own
    // storageState is the right tool on that side.
    "SESSION",
    // Scoped to the run's tab and taken back when it ends; a standalone script
    // sets its headers when it creates the browser context instead.
    "SET_HEADERS",
    "SOLVE_CAPTCHA",
    "UPLOAD_ACTIVITY",
  ]);
});

test("the exportable flag sits on the step, not inside its defaults", () => {
  // It is easy to nest this by accident, and JS stays valid when you do.
  for (const type of USER_STEP_TYPES) {
    assert.ok(
      !("exportable" in STEP_TYPES[type].def),
      `${type} has exportable inside def`,
    );
  }
});

test("generated Python and Node are structurally complete", () => {
  const { py, js } = emit([
    step("NAVIGATE", { url: "https://shop.test" }),
    step("FILL", { selector: "#q", text: "hi" }),
  ]);

  assert.match(py, /async def run_pipeline\(\)/);
  assert.match(py, /asyncio\.run\(run_pipeline\(\)\)/);
  assert.match(js, /await chromium\.launch/);
  assert.match(js, /await browser\.close\(\)/);
});

// ── The new step modes ───────────────────────────────────────────────────────
//
// WAIT, SCROLL and PAGINATE gained real behaviour (task #40). An exported
// script that still emits a fixed sleep where the pipeline waits for an element
// — or a bare click where the pipeline detects the last page — is the same
// class of defect the audit was about: an artefact that looks complete and does
// less than the thing it was generated from.

test("waiting for an element to disappear is emitted, not turned into a sleep", () => {
  const { py, js } = emit([
    step("WAIT", {
      mode: "selector-gone",
      selector: ".spinner",
      timeout: 9000,
    }),
  ]);
  assert.match(
    js,
    /waitForSelector\('\.spinner',\s*\{[^}]*hidden|state:\s*'hidden'/,
  );
  assert.match(py, /wait_for_selector\("\.spinner"[\s\S]*?hidden/);
  assert.doesNotMatch(js, /sleep\(1000\)/);
});

test("waiting for the DOM to settle becomes a network-idle wait", () => {
  const { py, js } = emit([
    step("WAIT", { mode: "DOM-stable", timeout: 9000 }),
  ]);
  assert.match(js, /waitForLoadState\('networkidle'/);
  assert.match(py, /wait_for_load_state\("networkidle"/);
});

test("a wait's timeout is carried into the script", () => {
  const { py, js } = emit([
    step("WAIT", { mode: "selector-visible", selector: ".r", timeout: 9000 }),
  ]);
  assert.match(js, /9000/);
  assert.match(py, /9000/);
});

test("infinite scroll is emitted as a loop, not as one scroll", () => {
  const { py, js } = emit([
    step("SCROLL", { mode: "infinite", maxScrolls: 7, settleMs: 900 }),
  ]);
  for (const src of [py, js]) {
    assert.match(src, /7/, "the scroll limit is carried over");
    assert.match(src, /scrollHeight/);
  }
  assert.match(js, /for \(/);
  assert.match(py, /for _ in range/);
});

test("PAGINATE stops at the last page in an exported script too", () => {
  const { py, js } = emit([step("PAGINATE", { selector: ".next" })]);
  // A bare click is what this used to emit. The script has to make the same
  // decision the extension makes: is there another page?
  assert.match(js, /count\(\)|isDisabled|is_disabled/);
  assert.match(py, /count\(\)|is_disabled/);
});

// ── value transforms travel with the pipeline ────────────────────────────────

test("an exported script cleans values the way the pipeline does", () => {
  // Otherwise the export is a new instance of the old lie: it runs, it produces
  // a file, and the numbers in it are strings with currency symbols.
  const { py, js } = emit([
    step("EXTRACT", {
      fields: [
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
  ]);
  assert.match(js, /vqNumber|_fs_number/i);
  assert.match(py, /vq_number/i);
  // A relative link is resolved against the page it came from.
  assert.match(js, /page\.url\(\)/);
  assert.match(py, /page\.url/);
});

test("a field with no transform is emitted with no wrapper", () => {
  const { js } = emit([
    step("EXTRACT", { fields: [{ name: "name", selector: ".n" }] }),
  ]);
  // One column per field, read element by element: a grid of thirty products
  // exports as thirty rows, not as the first one.
  assert.match(js, /_cols\['name'\] = await Promise\.all\(/);
  assert.match(js, /await page\.locator\('\.n'\)\.all\(\)/);
  assert.match(js, /\(await vqReadEl\(_el, \{"type":"text"[^)]*\)\)\)/);
});

// ── the generated scripts are valid programs ─────────────────────────────────
//
// The emitters build source by concatenating string literals, which is exactly
// where an unbalanced brace or a bad escape hides: every assertion above
// pattern-matches the output, and a pattern match is happy with source that
// will not parse. So parse it.

import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { skipWithoutPython } from "./helpers/python.mjs";

const dir = mkdtempSync(join(tmpdir(), "vq-emit-"));

/** Every construct the emitters can produce, in one pipeline. */
const KITCHEN_SINK = [
  step("NAVIGATE", { url: "https://shop.test/", wait: true }),
  step("WAIT", { mode: "selector-visible", selector: ".r", timeout: 9000 }),
  step("WAIT", { mode: "selector-gone", selector: ".spin" }),
  step("WAIT", { mode: "DOM-stable" }),
  step("WAIT", { mode: "fixed", ms: 500 }),
  step("SCROLL", { mode: "infinite", maxScrolls: 5, settleMs: 800 }),
  step("SCROLL", { mode: "percent", amount: 80 }),
  step("CLICK", { selector: ".buy" }),
  step("FILL", { selector: "#q", text: "shoes" }),
  step("SELECT", { selector: "#size", value: "l" }),
  step("HOVER", { selector: ".menu" }),
  step("KEYBOARD", { key: "Enter" }),
  step("DRAG_DROP", { source: ".a", target: ".b" }),
  step("PAGINATE", { selector: ".next" }),
  step("EXTRACT", {
    fields: [
      { name: "name", selector: ".n" },
      { name: "price", selector: ".p", transform: ["number"] },
      { name: "tidy", selector: ".t", transform: ["trim"] },
      { name: "loud", selector: ".l", transform: ["upper"] },
      { name: "quiet", selector: ".q", transform: ["lower"] },
      {
        name: "sku",
        selector: ".s",
        transform: ["regex"],
        regexPattern: "SKU: (\\S+)",
      },
      {
        name: "link",
        selector: "a",
        type: "attribute",
        attribute: "href",
        transform: ["url"],
      },
    ],
  }),
  step("PAGE_DATA", { source: "auto", type: "Product", flatten: true }),
  step("PAGE_DATA", { source: "jsonld", type: "", flatten: false }),
  step("API", { url: "https://shop.test/api/items", rowsPath: "items" }),
  step("API", {
    url: "https://shop.test/api/items",
    rowsPath: "items",
    pagination: { mode: "cursor", cursorPath: "next_cursor" },
  }),
  step("API", {
    url: "https://shop.test/api/items",
    rowsPath: "items",
    pagination: { mode: "page", pageParam: "page", startPage: 1 },
  }),
  step("API", {
    url: "https://shop.test/api/items",
    rowsPath: "items",
    pagination: { mode: "link" },
  }),
  step("SCREENSHOT", { quality: 90 }),
  step("DOWNLOAD_FILE", {
    selector: ".gallery img",
    filename: "images/{{file.index}}-{{file.stem}}.{{file.ext}}",
    max: 5,
  }),
  step("EXPORT", { format: "csv" }),
];

const NESTED = [
  {
    id: "loop",
    type: "LOOP",
    config: { type: "paginate", selector: ".next", max: 5 },
    children: [step("EXTRACT", { fields: [{ name: "t", selector: "h1" }] })],
  },
  {
    id: "loop2",
    type: "LOOP",
    config: { type: "elements", selector: ".card", max: 0 },
    children: [step("CLICK", { selector: ".open" })],
  },
];

test("the emitted Node script parses", () => {
  const file = join(dir, "out.mjs");
  writeFileSync(file, emit([...KITCHEN_SINK, ...NESTED]).js);
  execFileSync(process.execPath, ["--check", file]);
});

test("the emitted Python script compiles", (t) => {
  // This guard used to shell out to `sh -c "command -v python3"`, which needs
  // a POSIX shell — so on the Windows machines it existed to protect, the
  // guard itself failed before the thing it was guarding could.
  const python = skipWithoutPython(t);
  if (!python) return;
  const file = join(dir, "out.py");
  writeFileSync(file, emit([...KITCHEN_SINK, ...NESTED]).py);
  execFileSync(python, ["-m", "py_compile", file]);
});

test("a user's regex pattern reaches the script intact", () => {
  // Both scripts parsed and both patterns were wrong, which is why the parse
  // check above is not enough on its own.
  //
  //   JS:     '\\S' inside a single-quoted literal is just 'S'
  //   Python: '\\\\S' inside an r"" raw string is a literal backslash then S
  //
  // Either way "SKU: (\\S+)" silently became a pattern that matches nothing,
  // and the column came back empty with no error anywhere.
  const { py, js } = emit([
    step("EXTRACT", {
      fields: [
        {
          name: "sku",
          selector: ".s",
          transform: ["regex"],
          regexPattern: "SKU: (\\S+)",
        },
      ],
    }),
  ]);

  // Read the emitted pattern back out and check what it actually matches,
  // rather than checking how it is spelled.
  const jsPattern = js.match(
    /vqRegex\(await vqReadEl\(_el, \{[^}]*\}\), '(.*)'\)/,
  )?.[1];
  assert.ok(jsPattern, `no vqRegex call emitted:\n${js}`);
  const jsSource = new Function(`return '${jsPattern}'`)();
  assert.equal("SKU: ABC-1".match(new RegExp(jsSource))?.[1], "ABC-1");

  const pyPattern = py.match(
    /vq_regex\(await vq_read_el\(_el, \{[^}]*\}\), r"(.*)"\)/,
  )?.[1];
  assert.ok(pyPattern, `no vq_regex call emitted:\n${py}`);
  // r"" is raw: what is between the quotes is the pattern, verbatim.
  assert.equal("SKU: ABC-1".match(new RegExp(pyPattern))?.[1], "ABC-1");
});

test("a quote in a regex pattern cannot break out of the string", () => {
  const { py, js } = emit([
    step("EXTRACT", {
      fields: [
        {
          name: "q",
          selector: ".q",
          transform: ["regex"],
          regexPattern: `it's "(\\w+)"`,
        },
      ],
    }),
  ]);
  const file = join(dir, "quote.mjs");
  writeFileSync(file, js);
  execFileSync(process.execPath, ["--check", file]);
  assert.ok(py.includes("vq_regex"));
});

test("an invalid regex pattern makes the script refuse to run, not quietly differ", () => {
  // A lone trailing backslash is not a regex. Stripping it to make the emitted
  // literal well-formed would produce a script that runs and extracts
  // something other than what the pipeline extracts — the exact class of
  // defect the audit was about.
  const { py, js } = emit([
    step("EXTRACT", {
      fields: [
        {
          name: "q",
          selector: ".q",
          transform: ["regex"],
          regexPattern: "abc\\",
        },
      ],
    }),
  ]);
  assert.match(js, /INVALID|throw new Error/);
  assert.match(py, /INVALID|raise /);
});

test("the JavaScript PAGE_DATA hands to the browser is itself valid JavaScript", (t) => {
  // Both scripts compile with this broken, because to Python and Node the
  // browser snippet is just a string. Python's """...""" treats \\' as an
  // escape, so a single-quoted selector inside it arrives at the browser
  // unterminated — a run-time SyntaxError in a page, which no parse check
  // above can see.
  const { py, js } = emit([
    step("PAGE_DATA", { source: "auto", type: "Product", flatten: true }),
  ]);

  // Read it back the way Python will: the text in the .py file is not what
  // reaches the browser, because Python resolves the escapes in it first.
  // Checking the raw text passes with this broken, which is how it got here.
  // This guard used to shell out to `sh -c "command -v python3"`, which needs
  // a POSIX shell — so on the Windows machines it existed to protect, the
  // guard itself failed before the thing it was guarding could.
  const python = skipWithoutPython(t);
  if (!python) return;
  const pyFile = join(dir, "pd.py");
  writeFileSync(pyFile, py);
  const reader = join(dir, "read_snippet.py");
  writeFileSync(
    reader,
    [
      "import ast, sys",
      "tree = ast.parse(open(sys.argv[1]).read())",
      "for node in ast.walk(tree):",
      "    if isinstance(node, ast.Constant) and isinstance(node.value, str):",
      '        if "querySelectorAll" in node.value:',
      "            sys.stdout.write(node.value)",
      "            break",
    ].join("\n"),
  );
  const pySnippet = execFileSync(python, [reader, pyFile], {
    encoding: "utf8",
  });
  assert.ok(pySnippet.includes("querySelectorAll"), "no snippet found");
  assert.doesNotThrow(
    () => new Function(`return (${pySnippet})`),
    "the snippet Python sends to the browser does not parse as JavaScript",
  );

  // The Node emitter inlines the snippet as a real arrow function in the
  // script itself, so `node --check` above already parses it. Assert only that
  // it is present.
  assert.match(js, /page\.evaluate\(\(\) => \{/);
  assert.match(js, /ld\+json/);
});

// ── IF_ELSE conditions in an exported script ────────────────────────────────

test("every IF_ELSE condition is emitted, not stubbed to always-true", async () => {
  // Both emitters handled `exists` and fell through to
  // `if (true) { // TODO: impl extended condition ... }` for everything else.
  // The exported script therefore took the IF branch unconditionally — it ran,
  // produced a file, and had silently ignored its own branching. The B-13
  // check could not see it: it looks for "# TODO" in the Python output, and
  // the Node stub is a `//` comment.
  const { CONDITION_NAMES } = await import("../utils/conditions.js");
  const stubbed = [];
  for (const condition of CONDITION_NAMES) {
    const pipeline = [
      {
        id: "if",
        type: "IF_ELSE",
        config: { condition, selector: ".p", value: "10", attr: "data-id" },
        ifBranch: [step("CLICK", { selector: ".yes" })],
        elseBranch: [step("CLICK", { selector: ".no" })],
      },
    ];
    const { py, js } = emit(pipeline);
    if (/if \(true\)|if True:|TODO/.test(js + py)) stubbed.push(condition);
  }
  assert.deepEqual(stubbed, [], "these conditions are emitted as always-true");
});

test("an emitted numeric condition compares numbers, not strings", () => {
  // "$9.99" < "$25.50" is true as a string comparison and false as a number
  // one, which is the wrong branch on most of a shop.
  const { py, js } = emit([
    {
      id: "if",
      type: "IF_ELSE",
      config: { condition: "number-lt", selector: ".p", value: "50" },
      ifBranch: [step("CLICK", { selector: ".cheap" })],
      elseBranch: [],
    },
  ]);
  // The prelude defines vqNumber unconditionally, so look at the condition
  // itself rather than at the file.
  // Anchored on the emitted step, or the prelude's own `if`s match first.
  const jsTest = js.match(/\/\/ IF_ELSE:[\s\S]*?if \((.*)\) \{/)?.[1] ?? "";
  assert.match(
    jsTest,
    /vqNumber/,
    `the branch does not read a number: ${jsTest}`,
  );
  // Both sides are now named rather than one being inlined next to the
  // operator, because the right-hand side can also come from a second element.
  // What matters is unchanged: a `<` against 50 as a number, never as a string.
  assert.match(jsTest, /a < b/, `not a numeric comparison: ${jsTest}`);
  assert.match(jsTest, /, 50\)/, `50 is not the operand: ${jsTest}`);
  assert.ok(
    !/['"]50['"]/.test(jsTest),
    `50 is quoted, so this compares strings: ${jsTest}`,
  );

  const pyTest = py.match(/# IF_ELSE:[\s\S]*?\n\s*if (.*):/)?.[1] ?? "";
  assert.match(
    pyTest,
    /vq_number/,
    `the branch does not read a number: ${pyTest}`,
  );
  assert.match(pyTest, /a < b/, `not a numeric comparison: ${pyTest}`);
  assert.match(pyTest, /, 50\)/, `50 is not the operand: ${pyTest}`);
  assert.ok(
    !/['"]50['"]/.test(pyTest),
    `50 is quoted, so this compares strings: ${pyTest}`,
  );
});

test("the emitted branches still parse with every condition in them", (t) => {
  const branchy = [
    {
      id: "a",
      type: "IF_ELSE",
      config: { condition: "is-empty", selector: ".p" },
      ifBranch: [step("CLICK", { selector: ".x" })],
      elseBranch: [
        {
          id: "b",
          type: "IF_ELSE",
          config: { condition: "text-matches", selector: ".q", value: "\\d+" },
          ifBranch: [step("CLICK", { selector: ".y" })],
          elseBranch: [],
        },
      ],
    },
    {
      id: "c",
      type: "IF_ELSE",
      config: { condition: "attr-exists", selector: ".r", attr: "data-id" },
      ifBranch: [],
      elseBranch: [step("CLICK", { selector: ".z" })],
    },
  ];
  const { py, js } = emit(branchy);

  const jsFile = join(dir, "branches.mjs");
  writeFileSync(jsFile, js);
  execFileSync(process.execPath, ["--check", jsFile]);

  // This guard used to shell out to `sh -c "command -v python3"`, which needs
  // a POSIX shell — so on the Windows machines it existed to protect, the
  // guard itself failed before the thing it was guarding could.
  const python = skipWithoutPython(t);
  if (!python) return;
  const pyFile = join(dir, "branches.py");
  writeFileSync(pyFile, py);
  execFileSync(python, ["-m", "py_compile", pyFile]);
});

test("a capture group and flags reach both scripts, and only the shared flags do", () => {
  // The pipeline, the Node script and the Python script have to agree on which
  // group is the answer. They did not: group and flags lived in the pipeline
  // and neither emitter carried them, so a field set to group 2 exported as
  // group 1 and nobody was told.
  //
  // `g` is dropped rather than passed on. It means something in JavaScript that
  // it does not mean in Python, and it changes nothing for a transform that
  // reads one value — carrying it would only make the two scripts differ.
  const { py, js } = emit([
    step("EXTRACT", {
      fields: [
        {
          name: "id",
          selector: ".s",
          transform: ["regex"],
          regexPattern: "(\\w+)-(\\d+)",
          regexGroup: 2,
          regexFlags: "gi",
        },
      ],
    }),
  ]);

  assert.match(js, /vqRegex\(await vqReadEl\(_el, \{[^}]*\}\), '.*', 'i', 2\)/);
  assert.match(
    py,
    /vq_regex\(await vq_read_el\(_el, \{[^}]*\}\), r".*", "i", 2\)/,
  );
});

test("a regex field with neither group nor flags emits the plain two-argument call", () => {
  // The defaults are what almost every field uses. Emitting `, '', 1` on all of
  // them would be noise in a script a person is expected to read.
  const { py, js } = emit([
    step("EXTRACT", {
      fields: [
        {
          name: "id",
          selector: ".s",
          transform: ["regex"],
          regexPattern: "(\\d+)",
        },
      ],
    }),
  ]);

  assert.match(
    js,
    /vqRegex\(await vqReadEl\(_el, \{[^}]*\}\), '\(\\\\d\+\)'\)/,
  );
  assert.match(
    py,
    /vq_regex\(await vq_read_el\(_el, \{[^}]*\}\), r"\(\\d\+\)"\)/,
  );
});

// ── ASSERT and per-step retry in an exported script (K-12, K-13) ────────────

test("every ASSERT is emitted, not stubbed", async () => {
  const { ASSERTION_NAMES } = await import("../utils/assertions.js");
  const stubbed = [];
  for (const assertion of ASSERTION_NAMES) {
    const { py, js } = emit([
      step("ASSERT", {
        assertion,
        selector: ".card",
        count: 3,
        value: "In stock",
      }),
    ]);
    if (/UNSUPPORTED|TODO/.test(js + py)) stubbed.push(assertion);
  }
  assert.deepEqual(stubbed, [], "these assertions are not exportable");
});

test("a failed ASSERT stops the exported script", () => {
  const { py, js } = emit([
    step("ASSERT", {
      assertion: "count-at-least",
      selector: ".card",
      count: 3,
    }),
  ]);
  assert.match(js, /_count >= 3/);
  assert.match(js, /throw new Error\(`Verquill ASSERT/);
  assert.match(py, /_count >= 3/);
  assert.match(py, /raise AssertionError/);
});

test("an optional ASSERT warns instead of stopping the script", () => {
  // Same rule the run follows: `optional` means the failure is logged and the
  // pipeline carries on. A script that threw here would do less than the run.
  const { py, js } = emit([
    step("ASSERT", { assertion: "exists", selector: ".card", optional: true }),
  ]);
  assert.ok(!/throw new Error\(`Verquill ASSERT/.test(js), "Node still threw");
  assert.match(js, /console\.warn\('ASSERT/);
  assert.ok(!/raise AssertionError/.test(py), "Python still raised");
  assert.match(py, /print\("ASSERT/);
});

test("a step that asks for retries is retried in the exported script", () => {
  const { py, js } = emit([
    step("CLICK", { selector: ".flaky", retries: 3, retryDelayMs: 400 }),
  ]);
  assert.match(js, /for \(let _attempt = 0; ; _attempt\+\+\) \{/);
  assert.match(js, /if \(_attempt >= 3\) throw _err;/);
  assert.match(js, /await sleep\(400\);/);
  assert.match(py, /for _attempt in range\(4\):/);
  assert.match(py, /await asyncio\.sleep\(0\.4\)/);
  assert.match(py, /raise/);
});

test("a step with no retries is emitted with no wrapper", () => {
  const { py, js } = emit([step("CLICK", { selector: ".buy" })]);
  assert.ok(!/_attempt/.test(js + py), "an unretried step grew a retry loop");
});

test("the emitted retry count is clamped the way the run clamps it", () => {
  // The bound lives in utils/step-types.js so the executor and both emitters
  // cannot disagree about what "retries: 99" means.
  const { py, js } = emit([
    step("CLICK", { selector: ".flaky", retries: 99, retryDelayMs: 10 ** 9 }),
  ]);
  assert.match(js, /if \(_attempt >= 5\) throw _err;/);
  assert.match(js, /await sleep\(30000\);/);
  assert.match(py, /for _attempt in range\(6\):/);
  assert.match(py, /await asyncio\.sleep\(30\)/);
});

// ── K-20: the two paginators that are not a Next button ─────────────────────

test("a numbered paginator is exported, not silently flattened", () => {
  // The emitters branch on the loop's mode, and an unknown mode falls through
  // to a plain `for` — which runs the body N times against page one and looks
  // like a working script. That is exactly what paginate mode itself used to
  // do before it was emitted.
  const { py, js } = emit([
    {
      ...step("LOOP", {
        type: "paginate-links",
        selector: ".pagination a",
        max: 0,
      }),
      children: [step("EXTRACT", { fields: [] })],
    },
  ]);

  assert.match(js, /getAttribute\('href'\)/);
  assert.match(js, /page\.goto\(new URL\(_hrefs\[i\], page\.url\(\)\)\.href\)/);
  assert.match(py, /get_attribute\("href"\)/);
  assert.match(py, /urljoin\(page\.url, _href\)/);
});

test("a URL-pattern paginator computes each page number", () => {
  const { py, js } = emit([
    {
      ...step("LOOP", {
        type: "paginate-url",
        urlTemplate: "https://shop.test/list?offset={page}",
        startPage: 0,
        pageStep: 25,
        max: 3,
      }),
      children: [step("EXTRACT", { fields: [] })],
    },
  ]);

  assert.match(js, /for \(let i = 0; i < 3; i\+\+\)/);
  assert.match(js, /0 \+ i \* 25/);
  assert.match(py, /for i in range\(3\)/);
  assert.match(py, /0 \+ i \* 25/);
});

test("a URL-pattern loop with no {page} refuses instead of exporting a lie", () => {
  // Without the placeholder every iteration opens the same URL, so the script
  // would run, produce a file, and have scraped one page N times.
  const { py, js } = emit([
    {
      ...step("LOOP", {
        type: "paginate-url",
        urlTemplate: "https://shop.test/list",
        max: 3,
      }),
      children: [step("EXTRACT", { fields: [] })],
    },
  ]);

  assert.match(js, /UNSUPPORTED/);
  assert.match(js, /throw new Error/);
  assert.match(py, /UNSUPPORTED/);
  assert.match(py, /raise ValueError/);
});

// ── DOWNLOAD_FILE (K-23) ─────────────────────────────────────────────────────

test("DOWNLOAD_FILE fetches through the browser context, and says what it saved", () => {
  const { py, js } = emit([
    step("DOWNLOAD_FILE", { selector: ".gallery img", max: 3 }),
  ]);

  // context.request rather than a click: the context's cookies come with it,
  // so a file behind a login downloads the way it does in the extension.
  assert.match(py, /await page\.context\.request\.get\(_u\)/);
  assert.match(js, /await page\.context\(\)\.request\.get\(_u\)/);
  assert.match(py, /saved \{\}, failed \{\}/);
  assert.match(js, /saved \$\{_saved\}, failed \$\{_failed\}/);
  // Found files and saved none is a failure in the script for the same reason
  // it is one in the run.
  assert.match(py, /raise IOError\("Verquill: DOWNLOAD_FILE saved none/);
  assert.match(js, /DOWNLOAD_FILE saved none of the files/);
});

test("an exported filename is built one sanitised segment at a time", () => {
  const { py, js } = emit([
    step("DOWNLOAD_FILE", {
      selector: "img",
      filename: "shots/{{file.index}}-{{file.name}}",
    }),
  ]);

  assert.match(py, /os\.path\.join\("downloads", vq_safe_seg\(.*vq_safe_seg\(/);
  assert.match(js, /path\.join\('downloads', vqSafeSeg\(.*vqSafeSeg\(/);
  // The helper is the same allowlist the extension applies, so a name the page
  // supplied cannot name a directory in an exported run either.
  assert.match(py, /def vq_safe_seg/);
  assert.match(js, /const vqSafeSeg/);
});

test("a filename template the script cannot resolve is refused, not dropped", () => {
  // {{extracted.title}} comes from a run context a standalone script does not
  // have. Emitting the download with the value silently blank would save every
  // file under a name the user did not ask for.
  const { py, js } = emit([
    step("DOWNLOAD_FILE", {
      selector: "img",
      filename: "{{extracted.title}}.jpg",
    }),
  ]);

  assert.match(py, /UNSUPPORTED/);
  assert.match(py, /raise ValueError/);
  assert.match(js, /UNSUPPORTED/);
  assert.match(js, /throw new Error/);
});

test("the pre-download template warning ignores the fields the script fills in", async () => {
  const { findUnresolvedTemplates } =
    await import("../script-gen/pipeline-compiler.js");
  const ok = findUnresolvedTemplates(
    compile([
      step("DOWNLOAD_FILE", {
        selector: "img",
        filename: "verquill/{{file.name}}",
      }),
    ]),
  );
  assert.deepEqual(ok, [], "{{file.*}} is resolved by the emitted script");

  const bad = findUnresolvedTemplates(
    compile([
      step("DOWNLOAD_FILE", {
        selector: "img",
        filename: "{{item.title}}.jpg",
      }),
    ]),
  );
  assert.equal(bad.length, 1, "everything else is still reported");
});

// ── API: pagination and retry (K-24, K-25) ────────────────────────────────

test("an API step's rows and pagination are emitted in both languages", () => {
  const { py, js } = emit([
    step("API", {
      url: "https://shop.test/api/items",
      rowsPath: "items",
      pagination: { mode: "cursor", cursorPath: "next_cursor" },
    }),
  ]);
  assert.match(js, /vqApiRows/);
  assert.match(js, /vqDig\(apiBody, 'next_cursor'\)/);
  assert.match(js, /vqApiFetch/); // the 429/5xx retry
  assert.match(py, /vq_api_rows/);
  assert.match(py, /vq_dig\(api_body, "next_cursor"\)/);
  assert.match(py, /respect_retry_after_header=True/);
});

test("cursor pagination with no cursorPath refuses in both languages", () => {
  const { py, js } = emit([
    step("API", {
      url: "https://shop.test/api/items",
      rowsPath: "items",
      pagination: { mode: "cursor" },
    }),
  ]);
  assert.match(js, /UNSUPPORTED/);
  assert.match(js, /throw new Error/);
  assert.match(py, /UNSUPPORTED/);
  assert.match(py, /raise ValueError/);
});

test("pagination with no rowsPath refuses instead of exporting a script that cannot tell an empty page", () => {
  const { py, js } = emit([
    step("API", {
      url: "https://shop.test/api/items",
      pagination: { mode: "page" },
    }),
  ]);
  assert.match(js, /UNSUPPORTED/);
  assert.match(js, /rowsPath/);
  assert.match(py, /UNSUPPORTED/);
  assert.match(py, /rowsPath/);
});

test("an unknown API pagination mode refuses rather than doing nothing silently", () => {
  const { py, js } = emit([
    step("API", {
      url: "https://shop.test/api/items",
      rowsPath: "items",
      pagination: { mode: "bogus" },
    }),
  ]);
  assert.match(js, /UNSUPPORTED/);
  assert.match(py, /UNSUPPORTED/);
});

// ── K-28: a loop body means "this record", in the script as well as the run ──

test("a step inside an elements loop searches the record, not the page", () => {
  // The run resolves a child selector against the loop's current element
  // (_queryScoped). The emitted script searched the whole page, so "for each
  // card, extract the title" exported as a script that extracts every title on
  // the page, once per card. It ran, it produced a file, and it meant
  // something the pipeline never said.
  //
  // Asserted as a relationship, not a substring: `page.locator` must not
  // appear inside the loop body at all, and the queries there must hang off
  // the bound element. A test that only looked for ".locator(" would pass on
  // the broken version too, since `page.locator(` contains it.
  const { py, js } = emit([
    {
      ...step("LOOP", { type: "elements", selector: ".card", max: 5 }),
      children: [
        step("EXTRACT", { fields: [{ name: "t", selector: ".title" }] }),
        step("CLICK", { selector: "button.buy" }),
      ],
    },
  ]);

  const jsBody = js.slice(js.indexOf("const el = elements[i]"), js.length);
  const jsLoopEnd = jsBody.indexOf("\n}");
  const jsInner = jsBody.slice(0, jsLoopEnd);
  assert.ok(
    !/page\.locator\(|page\.click\(/.test(jsInner),
    `a page-level query survived inside the loop body:\n${jsInner}`,
  );
  assert.match(jsInner, /el\.locator\('\.title'\)/);
  assert.match(jsInner, /el\.locator\('button\.buy'\)\.click\(\)/);

  const pyBody = py.slice(py.indexOf("for i, el in enumerate"));
  const pyInner = pyBody.slice(0, pyBody.indexOf("\n\n"));
  assert.ok(
    !/page\.locator\(|page\.click\(/.test(pyInner),
    `a page-level query survived inside the loop body:\n${pyInner}`,
  );
  assert.match(pyInner, /el\.locator\("\.title"\)/);
  assert.match(pyInner, /el\.locator\("button\.buy"\)\.click\(\)/);
});

test("a loop that iterates counts or pages keeps its body page-level", () => {
  // `count` has no element to scope to, and the pagination modes iterate pages
  // rather than records — scoping their bodies would be wrong, not stricter.
  for (const config of [
    { type: "count", max: 3 },
    { type: "paginate-links", selector: ".pagination a", max: 0 },
  ]) {
    const { py, js } = emit([
      {
        ...step("LOOP", config),
        children: [step("CLICK", { selector: "button.buy" })],
      },
    ]);
    // The page shortcut, not the locator form: at the top level an exported
    // script should read like one a person wrote, and `page.click(sel)` is how
    // they would write it. The locator form appears only where "within this
    // element" actually has to be said.
    assert.match(js, /page\.click\('button\.buy'\)/, config.type);
    assert.match(py, /page\.click\("button\.buy"\)/, config.type);
  }
});

test("a loop inside a loop scopes to its own element, not the outer one", () => {
  const { js } = emit([
    {
      ...step("LOOP", { type: "elements", selector: ".card", max: 5 }),
      children: [
        {
          ...step("LOOP", { type: "elements", selector: ".variant", max: 3 }),
          children: [step("CLICK", { selector: ".add" })],
        },
      ],
    },
  ]);
  // The inner loop's own query hangs off the outer element…
  assert.match(js, /await el\.locator\('\.variant'\)\.all\(\)/);
  // …and its body hangs off the inner one, under a name that does not shadow.
  assert.match(js, /const el_child = elements\[i\]/);
  assert.match(js, /el_child\.locator\('\.add'\)\.click\(\)/);
});
