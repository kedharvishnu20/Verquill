// Captcha detect-and-stop (capability review §4, closing A-06).
//
// content/captcha-detector.js was 342 lines that detected reCAPTCHA v2/v3,
// hCaptcha, Turnstile and image captchas, in no manifest entry and no import —
// an ES module importing the overlay engine, which a content script cannot do,
// so it never ran a line. Its counterpart solveCaptcha was reachable through a
// message nothing sent, and the panel stored a 2Captcha key nothing spent.
//
// The replacement answers a narrower and much more useful question: not "does
// this page use a captcha" but "is one standing in the way right now".
// reCAPTCHA v3 runs invisibly on an enormous share of the web and challenges
// almost nobody. A tool that stopped for those would cry wolf on most of the
// internet, and the warning would be ignored exactly when it mattered.
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(
  new URL("../content/captcha-check.js", import.meta.url),
  "utf8",
);
const worker = await readFile(
  new URL("../background/service-worker.js", import.meta.url),
  "utf8",
);

/**
 * jsdom gives every element a 0x0 box, and the whole point of this module is
 * whether something is rendered — so size is stubbed per element, and a test
 * says which elements are on screen.
 */
function check(html, { visible = [], title = "Shop" } = {}) {
  const dom = new JSDOM(
    `<!doctype html><html><head><title>${title}</title></head><body>${html}</body></html>`,
    {
      url: "https://shop.test/",
      runScripts: "outside-only",
    },
  );
  const { window } = dom;
  window.Element.prototype.getBoundingClientRect = function () {
    const on = visible.some((sel) => {
      try {
        return this.matches(sel);
      } catch {
        return false;
      }
    });
    const size = on ? 300 : 0;
    return {
      width: size,
      height: size,
      top: 0,
      left: 0,
      right: size,
      bottom: size,
      x: 0,
      y: 0,
    };
  };
  vm.runInContext(source, dom.getInternalVMContext(), {
    filename: "captcha-check.js",
  });
  const out = window.__vqCheckCaptcha();
  window.close();
  return out;
}

// ── It must not cry wolf ────────────────────────────────────────────────────

test("an ordinary page reports nothing", () => {
  const out = check(`<h1>Books</h1><table><tr><td>Gut</td></tr></table>`);
  assert.equal(out.blocking, false);
  assert.equal(out.present, false);
});

test("an invisible v3 widget does not stop the run", () => {
  // The single most common case on the web: a sitekey in the markup that never
  // challenges anyone. Stopping here would make the warning worthless.
  const out = check(
    `<h1>Shop</h1><div class="g-recaptcha" data-sitekey="abc" data-size="invisible"></div>`,
  );
  assert.equal(out.blocking, false, "an invisible widget must not block");
  assert.equal(out.present, true, "but it is worth reporting as present");
  assert.equal(out.type, "recaptcha");
});

test("a hidden login captcha nobody is using does not stop the run", () => {
  const out = check(
    `<form style="display:none"><div class="h-captcha" data-sitekey="k"></div></form>`,
  );
  assert.equal(out.blocking, false);
});

test("a script tag alone is not a captcha in the way", () => {
  const out = check(
    `<script src="https://www.google.com/recaptcha/api.js"></script><h1>Shop</h1>`,
  );
  assert.equal(out.blocking, false);
});

// ── It must catch the real thing ────────────────────────────────────────────

for (const [name, html, sel] of [
  [
    "reCAPTCHA v2",
    `<div class="g-recaptcha" data-sitekey="abc"></div>`,
    ".g-recaptcha",
  ],
  [
    "a reCAPTCHA challenge iframe",
    `<iframe src="https://www.google.com/recaptcha/api2/bframe?k=xyz"></iframe>`,
    "iframe",
  ],
  ["hCaptcha", `<div class="h-captcha" data-sitekey="hk"></div>`, ".h-captcha"],
  [
    "Turnstile",
    `<div class="cf-turnstile" data-sitekey="tk"></div>`,
    ".cf-turnstile",
  ],
  ["an image captcha", `<img src="/captcha.png" alt="captcha">`, "img"],
]) {
  test(`${name} on screen blocks the run`, () => {
    const out = check(html, { visible: [sel] });
    assert.equal(out.blocking, true, `${name} was not treated as blocking`);
    assert.ok(out.type, "no type reported");
    assert.ok(out.where, "no location reported — the user is told nothing");
  });
}

test("a rendered widget hands back its sitekey", () => {
  const out = check(`<div class="g-recaptcha" data-sitekey="abc123"></div>`, {
    visible: [".g-recaptcha"],
  });
  assert.equal(out.sitekey, "abc123");
});

// ── Interstitials replace the page, box or no box ───────────────────────────

test("a Cloudflare interstitial blocks even with nothing measurable", () => {
  // The challenge page has no widget of its own to size, and the site the run
  // wanted is simply not there.
  const out = check(`<div id="challenge-running"></div>`, {
    title: "Just a moment...",
  });
  assert.equal(out.blocking, true);
  assert.equal(out.type, "cloudflare");
});

test("the interstitial is recognised by its title alone", () => {
  const out = check(`<h1>Please wait</h1>`, {
    title: "Attention Required! | Cloudflare",
  });
  assert.equal(out.blocking, true);
  assert.match(out.where, /page title/);
});

test("a page merely mentioning Cloudflare is not an interstitial", () => {
  const out = check(`<p>We use Cloudflare for caching.</p>`, {
    title: "About our infrastructure",
  });
  assert.equal(out.blocking, false);
});

// ── The wiring ──────────────────────────────────────────────────────────────

test("the run pauses rather than failing", () => {
  // A run that fails here throws away the rows it has and makes the user start
  // again for a thirty-second obstacle. Resume already exists (E-01).
  const fn = worker.slice(
    worker.indexOf("async function _pauseForCaptcha"),
    worker.indexOf("async function _executeSteps"),
  );
  assert.match(fn, /runState\.paused = true/);
  assert.ok(
    !/runState\.active = false/.test(fn),
    "it stops the run instead of pausing it",
  );
  assert.match(
    fn,
    /found\?\.blocking/,
    "it pauses for a captcha that is not in the way",
  );
  assert.match(fn, /press Resume/, "the user is not told what to do");
  assert.match(fn, /reCAPTCHA/, "the type is shown as the raw internal name");
});

test("an empty result is checked, not just a thrown one", () => {
  // The case that matters most: EXTRACT does not fail on a miss — by design,
  // so a genuinely empty column is not a crash (B-08) — so a captcha wall
  // produced a run of empty rows and said nothing at all. Waiting for a step
  // to throw would have missed every blocked scrape.
  const dispatch = worker.slice(
    worker.indexOf("async function _dispatchStep"),
    worker.indexOf("_registerHandler(MSG.STEP_EXECUTE"),
  );
  const dflt = dispatch.slice(dispatch.lastIndexOf("default: {"));
  assert.match(dflt, /_looksEmpty\(resp\.result\)/);
  assert.match(dflt, /_pauseForCaptcha\(runId, tabId, step\.type\)/);
  assert.match(
    dflt,
    /await _awaitResume\(runId\)/,
    "it pauses and never waits, so the retry runs against the same wall",
  );
  assert.match(
    dflt,
    /resp = await _sendToPage\(tabId, step\);/,
    "the step is not retried after the captcha is solved",
  );
});

test("it checks when a page step cannot find what it wants", () => {
  assert.match(worker, /CAPTCHA_SUSPECT_STEPS/);
  const set = worker.slice(
    worker.indexOf("const CAPTCHA_SUSPECT_STEPS"),
    worker.indexOf("const CAPTCHA_FILE"),
  );
  for (const t of ["CLICK", "FILL", "EXTRACT", "PAGINATE"]) {
    assert.match(set, new RegExp(`"${t}"`), `${t} is not checked`);
  }
});

test("the checker is injected on demand, not bundled into every page", () => {
  // The capability review found the 167 KB injection payload to be the one
  // load cost worth cutting; adding to it for a rare condition would be
  // moving in the wrong direction.
  assert.ok(
    !/CONTENT_FILES = \[[^\]]*captcha/s.test(worker),
    "the checker was added to the always-injected set",
  );
  assert.match(worker, /files: \[CAPTCHA_FILE\]/);
});

test("solving one captcha does not excuse the next", () => {
  const resume = worker.slice(
    worker.indexOf("_registerHandler(MSG.PIPELINE_RESUME"),
    worker.indexOf("_registerHandler(MSG.PIPELINE_RESUME") + 600,
  );
  assert.match(resume, /pausedForCaptcha = false/);
});

test("the retry keeps the run's bookkeeping straight", () => {
  // A bare `continue` after a successful retry would skip the progress counter
  // and the saved cursor, so a resumed run would repeat the step it had just
  // completed.
  const loop = worker.slice(
    worker.indexOf("async function _executeSteps"),
    worker.indexOf("/** Loop and branch bodies. */"),
  );
  const retry = loop.slice(loop.indexOf("_pauseForCaptcha"));
  assert.match(retry, /if \(recovered\) \{/);
  assert.match(retry, /progress\.count \+= 1;/);
  assert.match(retry, /saveCursor\(/);
});

test("the dead ES-module detector is gone", async () => {
  // Two detectors would be two definitions of the same thing (G-01), and the
  // old one could never run.
  const { access } = await import("node:fs/promises");
  await assert.rejects(
    () => access(new URL("../content/captcha-detector.js", import.meta.url)),
    "content/captcha-detector.js is still present",
  );
});
