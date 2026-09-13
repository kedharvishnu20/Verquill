// The one imported value that reaches the DOM unescaped.
//
// `step.id` is interpolated into `data-id="…"` and `id="cfg-…"` attributes in
// more than sixty places across renderStepNode and generateConfigHtml, and
// unlike every other untrusted value in that file it never passes through
// esc(). On import it was only trimmed, so an id of
//
//   x" onmouseenter="…
//
// closed the attribute and added one of its own.
//
// The extension's CSP (`script-src 'self'`, no unsafe-inline) stops that
// handler from running, so the impact is attribute injection rather than
// script execution — but `data-id` is the lookup key every step action uses
// (`target.dataset.id` → _findStepDeep), so a crafted id lets one element
// carry another's identity, and the CSP is the only thing standing between
// that and worse.
//
// Escaping sixty-one call sites leaves the sixty-second to whoever adds it
// next. These tests pin the other fix: the value is constrained where it
// enters, so there is nothing to escape.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const panel = readFileSync(
  new URL("../sidepanel/pipeline-builder.js", import.meta.url),
  "utf8",
);
const manifest = JSON.parse(
  readFileSync(new URL("../manifest.json", import.meta.url), "utf8"),
);

const normalize = panel.match(
  /function _normalizeImportedStep\([\s\S]*?\n\}/,
)?.[0];

test("an imported id is checked against a charset, not just trimmed", () => {
  assert.ok(normalize, "_normalizeImportedStep should still exist");
  assert.match(normalize, /\[A-Za-z0-9_-\]/);
  assert.ok(
    !/let id = typeof step\.id === "string" && step\.id\.trim\(\)/.test(panel),
    "the id is still taken from the file as-is",
  );
});

test("an id carrying an attribute break is discarded, not rendered", () => {
  // The exact payload, run through the real predicate from the source rather
  // than a copy of it — a test that re-types the regex proves only that the
  // test is consistent with itself.
  const src = normalize.match(/const SAFE_ID = (\/.*?\/);/)?.[1];
  assert.ok(src, "the id charset should be a named constant");
  const SAFE_ID = new RegExp(src.slice(1, -1));

  for (const hostile of [
    'x" onmouseenter="alert(1)',
    "x'><script>alert(1)</script>",
    'a" data-id="b',
    "x y",
    "<img>",
    "a".repeat(65),
    "",
  ]) {
    assert.ok(!SAFE_ID.test(hostile), `accepted a hostile id: ${hostile}`);
  }
});

test("an ordinary id still survives the import unchanged", () => {
  // Constraining the value is only reasonable if it leaves real pipelines
  // alone. These are the shapes the product itself produces and ships.
  const src = normalize.match(/const SAFE_ID = (\/.*?\/);/)?.[1];
  const SAFE_ID = new RegExp(src.slice(1, -1));

  for (const ok of [
    "s_1757740000123",
    "step_loop_products",
    "e1",
    "VQ-0142",
    "a_b-c_9",
  ]) {
    assert.ok(SAFE_ID.test(ok), `rejected an ordinary id: ${ok}`);
  }
});

test("a generated id passes its own charset", () => {
  // _nextStepId supplies the replacement for anything rejected. If its output
  // did not satisfy SAFE_ID the rewrite would produce ids the next import
  // rejects again.
  const gen = panel.match(/function _nextStepId\(\)[\s\S]*?\n\}/)?.[0];
  const src = normalize.match(/const SAFE_ID = (\/.*?\/);/)?.[1];
  const SAFE_ID = new RegExp(src.slice(1, -1));
  const produced = new Function(`${gen}; return _nextStepId();`)();
  assert.ok(
    SAFE_ID.test(produced),
    `generated id fails the charset: ${produced}`,
  );
});

test("the injection it was found by no longer reaches the DOM", () => {
  // The original proof, kept as the regression. The real template line is
  // evaluated with a hostile id and the result parsed: nothing beyond the
  // attributes the template itself writes may appear.
  const line = panel
    .split("\n")
    .find((l) => l.includes('<div class="node-wrapper"'))
    .trim()
    .replace(/^let /, "");
  assert.ok(line, "the node-wrapper template should still exist");

  const src = normalize.match(/const SAFE_ID = (\/.*?\/);/)?.[1];
  const SAFE_ID = new RegExp(src.slice(1, -1));
  const offered = 'x" onmouseenter="alert(document.cookie)';

  // What the import would now hand the renderer.
  const step = { id: SAFE_ID.test(offered) ? offered : "s_safe123" };
  const index = 0,
    parentId = "",
    branchKey = "";
  let html;
  eval(line);

  const { document } = new JSDOM('<div id="c"></div>').window;
  document.getElementById("c").innerHTML = html + "</div>";
  const el = document.getElementById("c").firstElementChild;
  const attrs = [...el.attributes].map((a) => a.name);

  assert.ok(
    !attrs.includes("onmouseenter"),
    "a hostile id still injects an attribute",
  );
  assert.deepEqual(
    attrs.sort(),
    ["class", "data-branch", "data-id", "data-index", "data-parent-id"],
    "the rendered element gained an attribute the template does not write",
  );
});

test("the CSP that bounds this is still in place", () => {
  // It is what keeps the finding at attribute injection rather than script
  // execution. Adding 'unsafe-inline' would silently promote every remaining
  // unescaped interpolation in the panel into a scripting bug.
  const csp = manifest.content_security_policy?.extension_pages ?? "";
  assert.match(csp, /script-src 'self'/);
  assert.ok(
    !/unsafe-inline/.test(csp),
    "the panel CSP now allows inline script",
  );
});
