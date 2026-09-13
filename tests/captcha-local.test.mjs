// Tests for K-14 (local solving) and K-15 (the SOLVE_CAPTCHA step).
//
// K-02 closed detection: a captcha in the way pauses the run and names itself.
// What it deliberately left open was doing anything about one. The free tier of
// that is small: the arithmetic and word puzzles a site writes for itself need
// no service, no key and no money, and they are still common on forum software
// and on club, school and council sites.
//
// Two rules run through all of it. A wrong answer is worse than no answer — a
// guess is a failed attempt the site records, and there are usually three of
// those before a lockout, whereas a refusal costs a pause the user was going to
// see anyway. And nothing answers a challenge unless a person asked for it on
// that domain: the step exists only because it was added, the run has to carry
// the authorisation, and the domain has to carry the attestation.
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { solveLocalChallenge, tierOf } from "../utils/captcha-solvers.js";
import { STEP_TYPES, USER_STEP_TYPES } from "../utils/step-types.js";
import {
  _executeSteps,
  startRun,
  endRun,
  calls,
  reset,
  onContentMessage,
  onExecuteScript,
} from "./helpers/worker-harness.mjs";

const checkSource = await readFile(
  new URL("../content/captcha-check.js", import.meta.url),
  "utf8",
);

const logs = () =>
  calls.runtimeMessages
    .filter((m) => m.type === "pipeline:log")
    .map((m) => m.payload.message);

// ── The solver: only what it is sure of ─────────────────────────────────────

for (const [question, answer] of [
  ["What is 3 + 4?", "7"],
  ["3 + 4 =", "7"],
  ["What is seven minus two?", "5"],
  ["What is 2 x 3?", "6"],
  ["What is 6 ÷ 3?", "2"],
  ["Anti-spam: what is 5 plus 4?", "9"],
  ["What is the sum of 6 and 1?", "7"],
  ["How many letters are in CAT?", "3"],
  ['How many letters are in the word "HORSE"?', "5"],
  ["Type the third word of this sentence", "third"],
  ['Enter the second word in "red green blue"', "green"],
]) {
  test(`it answers ${JSON.stringify(question)}`, () => {
    assert.equal(solveLocalChallenge(question)?.answer, answer);
  });
}

test("it says how it got there, for the log", () => {
  const got = solveLocalChallenge("What is 3 + 4?");
  assert.match(got.how, /3 \+ 4/);
});

for (const [why, question] of [
  [
    "the sum is only part of a sentence",
    "Ship 3 + 4 boxes to the address below",
  ],
  ["the division is not exact", "What is 3 / 2?"],
  ["the answer would be negative", "What is 2 - 9?"],
  ["there are two sums in it", "What is 2 + 3 and then 4 + 5?"],
  ["there is no question in it at all", "Please enter your email address"],
  [
    "the word being counted is the question's own",
    "How many letters in the answer?",
  ],
  [
    "the sentence is shorter than the position it names",
    "Type the tenth word of this sentence",
  ],
]) {
  test(`it refuses when ${why}`, () => {
    assert.equal(
      solveLocalChallenge(question),
      null,
      "it guessed, and a guess is a failed attempt the site records",
    );
  });
}

test("nothing at all is not an answer", () => {
  for (const input of ["", "   ", null, undefined, "x".repeat(400)]) {
    assert.equal(solveLocalChallenge(input), null);
  }
});

// ── The classifier: what is worth trying ────────────────────────────────────

/**
 * jsdom gives every element a 0x0 box, and the module is about what is
 * rendered, so a test says which selectors are on screen. Same harness shape as
 * captcha-check.test.mjs.
 */
function check(html, { visible = [], title = "Shop" } = {}) {
  const dom = new JSDOM(
    `<!doctype html><html><head><title>${title}</title></head><body>${html}</body></html>`,
    { url: "https://shop.test/", runScripts: "outside-only" },
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
    return on
      ? { width: 300, height: 300, top: 0, left: 0, right: 300, bottom: 300 }
      : { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
  };
  vm.runInContext(checkSource, dom.getInternalVMContext(), {
    filename: "captcha-check.js",
  });
  const out = window.__vqCheckCaptcha();
  window.close();
  return out;
}

test("a written question is reported as solvable on this machine", () => {
  const out = check(
    `<form><label for="cap">What is 3 + 4?</label><input type="text" id="cap" name="captcha"></form>`,
    { visible: ["#cap"] },
  );
  assert.equal(out.blocking, true);
  assert.equal(out.type, "question");
  assert.match(out.question, /3 \+ 4/);
  assert.equal(out.answerSelector, "#cap");
  // The page does not decide this — it cannot, since whether the question is
  // answerable is the parser's answer and a content script cannot import the
  // parser. It reports what it saw and the worker tiers it.
  assert.equal(out.tier, null, "the page assigned a tier of its own");
  assert.equal(tierOf(out), "solvable-locally");
});

test("a question the parser cannot answer is not called solvable", () => {
  // The bug this closes: the page used to report `solvable-locally` from a
  // shape test alone, so a challenge that looked like arithmetic and was not
  // told the user the run had stopped on something free, and then nothing
  // free happened.
  const out = check(
    `<form><label for="cap">What is 3 + 4 + 9 - 2 * 7?</label>` +
      `<input type="text" id="cap" name="captcha"></form>`,
    { visible: ["#cap"] },
  );
  assert.equal(out.type, "question");
  assert.equal(
    solveLocalChallenge(out.question),
    null,
    "the parser answered this after all — pick a harder example",
  );
  assert.equal(tierOf(out), "needs-a-service");
});

test("a written question is not filed under image captcha", () => {
  // input[name*="captcha"] is in the widget list as an image-captcha tell, and
  // it matches the answer box of every arithmetic question on the web.
  const out = check(
    `<form><p>How many letters are in CAT?</p><input type="text" name="captcha_answer"></form>`,
    { visible: ['input[name="captcha_answer"]'] },
  );
  assert.equal(out.type, "question");
  assert.equal(out.answerSelector, 'input[name="captcha_answer"]');
});

test("a widget captcha is reported as needing a service", () => {
  for (const [html, sel] of [
    [`<div class="g-recaptcha" data-sitekey="k"></div>`, ".g-recaptcha"],
    [`<div class="h-captcha" data-sitekey="k"></div>`, ".h-captcha"],
    [`<div class="cf-turnstile" data-sitekey="k"></div>`, ".cf-turnstile"],
    [`<img src="/captcha.png" alt="captcha">`, "img"],
  ]) {
    const out = check(html, { visible: [sel] });
    assert.equal(out.tier, null, `${sel}: the page tiered it itself`);
    assert.equal(tierOf(out), "needs-a-service", `${sel} was tiered wrongly`);
  }
});

test("a Cloudflare interstitial is not solvable at any price", () => {
  // It is bot management, not a captcha: it lifts on what the browser looks
  // like, and there is nothing to type. Saying so is what stops somebody
  // buying a solver for it later.
  const out = check(`<div id="challenge-running"></div>`, {
    title: "Just a moment...",
  });
  assert.equal(tierOf(out), "not-solvable");
  assert.match(out.reason, /bot.management|no answer to type/i);
});

test("an Akamai interstitial is recognised, and is not solvable either", () => {
  const out = check(`<iframe id="sec-cpt-if"></iframe>`, {
    title: "Access Denied",
  });
  assert.equal(out.type, "akamai");
  assert.equal(tierOf(out), "not-solvable");
});

test("an ordinary page has no tier because it has no challenge", () => {
  const out = check(
    `<form><label for="q">Your name</label>
    <input type="text" id="q" name="name"></form>`,
    { visible: ["#q"] },
  );
  assert.equal(out.blocking, false);
  assert.equal(out.tier, null);
});

// ── The step, and the two things it will not act without ────────────────────

test("SOLVE_CAPTCHA is a step a user adds, never one that happens", () => {
  assert.ok(USER_STEP_TYPES.includes("SOLVE_CAPTCHA"));
  assert.equal(STEP_TYPES.SOLVE_CAPTCHA.runsIn, "background");
  assert.equal(
    STEP_TYPES.SOLVE_CAPTCHA.exportable,
    false,
    "an exported script carries neither gate, so it would be the act without the consent",
  );
});

/** The checker answers with `found`, and the run holds `runState`. */
async function runSolve(found, over = {}, config = {}) {
  reset();
  const { runId, runState } = startRun(over);
  onExecuteScript((details) => (details.func ? [{ result: found }] : []));
  onContentMessage(async () => ({ ok: true, result: { typed: true } }));
  await _executeSteps(
    [{ id: "s1", type: "SOLVE_CAPTCHA", config }],
    1,
    runId,
    { extracted: {} },
    { total: 1, count: 0 },
  );
  const sent = calls.contentMessages.map((m) => m.payload);
  const active = runState.active;
  await endRun(runId);
  return { sent, active, lines: logs() };
}

const arithmetic = {
  blocking: true,
  present: true,
  type: "question",
  tier: "solvable-locally",
  where: "input#cap",
  reason: "the page asks a written question",
  question: "What is 3 + 4?",
  answerSelector: "#cap",
};

const attest = async (attested) => {
  await globalThis.chrome.storage.local.set({
    vq_captcha_attest_v1: attested ? { "shop.test": { at: 1 } } : {},
  });
};

test("without the run's authorisation it refuses and explains", async () => {
  await attest(true);
  const { sent, lines } = await runSolve(arithmetic, {
    captchaAuthorized: false,
  });
  assert.ok(
    !sent.some((p) => p.type === "FILL"),
    "it answered a challenge the run was never authorised to answer",
  );
  const said = lines.join("\n");
  assert.match(said, /not authorised/i);
});

test("without an attestation for the domain it refuses and explains", async () => {
  await attest(false);
  const { sent, lines } = await runSolve(arithmetic, {
    captchaAuthorized: true,
  });
  assert.ok(!sent.some((p) => p.type === "FILL"));
  const said = lines.join("\n");
  assert.match(said, /attest/i);
  assert.match(said, /shop\.test/);
});

test("with both, a written question is answered locally", async () => {
  await attest(true);
  const { sent, lines } = await runSolve(arithmetic, {
    captchaAuthorized: true,
  });
  const fill = sent.find((p) => p.type === "FILL");
  assert.ok(fill, "the challenge was not answered");
  assert.equal(fill.config.selector, "#cap");
  assert.equal(fill.config.text, "7");
  assert.match(lines.join("\n"), /on this machine|locally/i);
});

test("a submit selector is pressed only when the step names one", async () => {
  await attest(true);
  const without = await runSolve(arithmetic, { captchaAuthorized: true });
  assert.ok(!without.sent.some((p) => p.type === "CLICK"));

  const withSubmit = await runSolve(
    arithmetic,
    { captchaAuthorized: true },
    { submitSelector: "#go" },
  );
  const click = withSubmit.sent.find((p) => p.type === "CLICK");
  assert.equal(click?.config.selector, "#go");
});

test("on a challenge nothing free can answer it refuses rather than trying", async () => {
  await attest(true);
  const { sent, lines } = await runSolve(
    {
      blocking: true,
      present: true,
      type: "cloudflare",
      tier: "not-solvable",
      where: "#challenge-running",
      reason: "the site replaced the page with a bot-management interstitial",
      question: "",
      answerSelector: "",
    },
    { captchaAuthorized: true },
  );
  assert.ok(!sent.some((p) => p.type === "FILL"));
  assert.match(lines.join("\n"), /cloudflare/i);
});

test("a question it cannot parse pauses the run, exactly as before", async () => {
  await attest(true);
  reset();
  const { runId, runState } = startRun({ captchaAuthorized: true });
  onExecuteScript((details) =>
    details.func
      ? [
          {
            result: {
              ...arithmetic,
              question: "Which of these is a fruit: cat, apple, brick?",
            },
          },
        ]
      : [],
  );
  onContentMessage(async () => ({ ok: true, result: null }));
  const running = _executeSteps(
    [{ id: "s1", type: "SOLVE_CAPTCHA", config: {} }],
    1,
    runId,
    { extracted: {} },
    { total: 1, count: 0 },
  );
  // _awaitResume polls the run state, so end the pause the way the user does.
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(
    runState.paused,
    true,
    "it did not pause on a question it could not read",
  );
  assert.ok(
    !calls.contentMessages.some((m) => m.payload?.type === "FILL"),
    "it typed a guess",
  );
  runState.paused = false;
  await running;
  assert.match(logs().join("\n"), /not certain|worse than a pause/i);
  await endRun(runId);
});

test("a widget captcha pauses rather than pretending there is a free answer", async () => {
  await attest(true);
  reset();
  const { runId, runState } = startRun({ captchaAuthorized: true });
  onExecuteScript((details) =>
    details.func
      ? [
          {
            result: {
              blocking: true,
              present: true,
              type: "hcaptcha",
              tier: "needs-a-service",
              where: "div.h-captcha",
              reason: "a challenge is rendered on the page",
              question: "",
              answerSelector: "",
            },
          },
        ]
      : [],
  );
  onContentMessage(async () => ({ ok: true, result: null }));
  const running = _executeSteps(
    [{ id: "s1", type: "SOLVE_CAPTCHA", config: {} }],
    1,
    runId,
    { extracted: {} },
    { total: 1, count: 0 },
  );
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(runState.paused, true);
  runState.paused = false;
  await running;
  assert.match(logs().join("\n"), /no free way/i);
  await endRun(runId);
});

test("the attestation is stored per domain and outlives the run", async () => {
  const { __testing } = await import(
    new URL("../background/service-worker.js", import.meta.url).href
  );
  await attest(true);
  assert.equal(await __testing._captchaAttested("shop.test"), true);
  assert.equal(
    await __testing._captchaAttested("other.test"),
    false,
    "one domain's attestation covered another",
  );
});

test("with neither gate given, one refusal names both", async () => {
  // The two consent artefacts have different lifetimes on purpose — the flag
  // is per run, the attestation is per domain — and refusing on whichever was
  // checked first meant a user who had given neither satisfied one, pressed
  // Run, and was told about the other. Both, once.
  await attest(false);
  const { sent, lines } = await runSolve(arithmetic, {
    captchaAuthorized: false,
  });
  assert.ok(!sent.some((p) => p.type === "FILL"));
  const said = lines.join("\n");
  assert.match(said, /not authorised/i, "the run flag is not mentioned");
  assert.match(said, /not attested/i, "the attestation is not mentioned");
  assert.match(said, /shop\.test/, "it does not say which domain");
  assert.match(said, /neither is in place/i);
});

// ── The bring-your-own-key path, reached only after free has declined ────────

const imageCaptcha = {
  blocking: true,
  present: true,
  type: "image",
  tier: "needs-a-service",
  where: "img.captcha",
  reason: "a challenge is rendered on the page",
};

/** A gateway pointed at a local OpenAI-compatible endpoint: no key, no cost. */
const configureGateway = () =>
  globalThis.chrome.storage.local.set({
    vq_gateway_config_v1: {
      provider: "openai-compatible",
      model: "llava",
      baseUrl: "http://localhost:11434/v1",
    },
  });

/**
 * Drive SOLVE_CAPTCHA with the page reporting `found`, the image grab
 * returning `grab`, and the model replying `said`. Nothing here touches the
 * network: fetch is replaced for the duration.
 */
async function runWithGateway(found, grab, said) {
  reset();
  const { runId, runState } = startRun({ captchaAuthorized: true });
  onExecuteScript((details) => {
    if (!details.func) return [];
    return String(details.func).includes("__vqGrabCaptchaImage")
      ? [{ result: grab }]
      : [{ result: found }];
  });
  onContentMessage(async () => ({ ok: true, result: { typed: true } }));

  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), body: init?.body });
    return {
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      text: async () =>
        JSON.stringify({ choices: [{ message: { content: said } }] }),
    };
  };
  try {
    // Not awaited straight away: every path that has no answer pauses, and
    // _awaitResume polls until somebody resumes. End the pause the way the
    // user does, then let the step finish.
    const running = _executeSteps(
      [{ id: "s1", type: "SOLVE_CAPTCHA", config: {} }],
      1,
      runId,
      { extracted: {} },
      { total: 1, count: 0 },
    );
    // Waited for, not slept past. Clearing the pause on a fixed delay is a
    // race: when the step reaches the pause *after* that delay, the flag is
    // set with nobody left to clear it and _awaitResume polls for ever.
    for (let i = 0; i < 200 && !runState.paused; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    runState.paused = false;
    await running;
  } finally {
    globalThis.fetch = realFetch;
  }
  const sent = calls.contentMessages.map((m) => m.payload);
  await endRun(runId);
  return { sent, lines: logs(), seen };
}

const pixel = {
  dataUrl:
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  mediaType: "image/png",
  answerSelector: "#vcode",
  width: 120,
  height: 40,
};

test("an image captcha is read by the configured model and typed in", async () => {
  await attest(true);
  await configureGateway();
  const { sent, lines, seen } = await runWithGateway(
    imageCaptcha,
    pixel,
    "A7X9K",
  );

  assert.equal(seen.length, 1, "it did not ask the model exactly once");
  const fill = sent.find((p) => p.type === "FILL");
  assert.ok(fill, "it never typed the answer");
  assert.equal(fill.config.text, "A7X9K");
  // The image path finds its own answer box beside the picture; the written
  // path's selector came back with the question.
  assert.equal(fill.config.selector, "#vcode");
  assert.match(lines.join("\n"), /model you configured/i);
});

test("a widget captcha never reaches the model", async () => {
  // A reCAPTCHA is a behavioural check, not a picture with an answer in it.
  // Sending its screenshot to a vision model spends the user's money to be
  // told nothing.
  await attest(true);
  await configureGateway();
  const { sent, seen } = await runWithGateway(
    { ...imageCaptcha, type: "recaptcha" },
    pixel,
    "whatever",
  );
  assert.equal(seen.length, 0, "it paid a model to look at a reCAPTCHA");
  assert.ok(!sent.some((p) => p.type === "FILL"));
});

test("a model that pads its answer is not believed", async () => {
  // A failed attempt is recorded by the site and there are usually three
  // before a lockout, so anything that is not a short clean token is treated
  // as no answer rather than as an answer worth trying.
  await attest(true);
  await configureGateway();
  const { sent, lines } = await runWithGateway(
    imageCaptcha,
    pixel,
    "The captcha shows the characters A7X9K",
  );
  assert.ok(!sent.some((p) => p.type === "FILL"), "it typed a sentence");
  assert.match(lines.join("\n"), /not a captcha code/i);
});

test("a model that says it cannot read the image is believed", async () => {
  await attest(true);
  await configureGateway();
  const { sent, lines } = await runWithGateway(
    imageCaptcha,
    pixel,
    "UNREADABLE",
  );
  assert.ok(!sent.some((p) => p.type === "FILL"));
  assert.match(lines.join("\n"), /could not read/i);
});

test("with no provider configured nothing is asked and nothing is spent", async () => {
  // The default state of the tool. It is not a failure — it is what "free
  // unless you choose otherwise" means.
  await attest(true);
  await globalThis.chrome.storage.local.set({ vq_gateway_config_v1: null });
  const { sent, seen } = await runWithGateway(imageCaptcha, pixel, "A7X9K");
  assert.equal(seen.length, 0);
  assert.ok(!sent.some((p) => p.type === "FILL"));
});

test("a cross-origin captcha image is reported, not guessed at", async () => {
  await attest(true);
  await configureGateway();
  const { sent, lines, seen } = await runWithGateway(
    imageCaptcha,
    { error: "the captcha image is served from another origin" },
    "A7X9K",
  );
  assert.equal(
    seen.length,
    0,
    "it asked the model about an image it never had",
  );
  assert.ok(!sent.some((p) => p.type === "FILL"));
  assert.match(lines.join("\n"), /another origin/i);
});
