// Tests for K-14, the honeypot half: a form-filler that fills every field it
// is given will eventually fill one nobody can see.
//
// A honeypot is an input a human never reaches — hidden, offscreen, zero-sized,
// aria-hidden, or named so that only something reading the markup would want
// it. Anything in it was put there by a script. The failure is silent by
// design: the form is accepted, the submission is binned, and the account is
// marked. So this is not an option; it is what FILL does.
import test from "node:test";
import assert from "node:assert/strict";
import { loadInjector } from "./helpers/content-harness.mjs";
import {
  _dispatchStep,
  startRun,
  endRun,
  calls,
  reset,
  onContentMessage,
} from "./helpers/worker-harness.mjs";

const logs = () =>
  calls.runtimeMessages
    .filter((m) => m.type === "pipeline:log")
    .map((m) => m.payload.message);

/** Give one element a box of its own; the harness lays everything else out. */
function boxOf(el, box) {
  el.getBoundingClientRect = () => ({
    x: box.left ?? 0,
    y: box.top ?? 0,
    top: box.top ?? 0,
    left: box.left ?? 0,
    width: box.width ?? 0,
    height: box.height ?? 0,
    right: (box.left ?? 0) + (box.width ?? 0),
    bottom: (box.top ?? 0) + (box.height ?? 0),
  });
}

// ── What counts as a trap ───────────────────────────────────────────────────

test("an ordinary field is not a trap", async () => {
  const page = await loadInjector(
    `<form><label for="e">Email</label><input id="e" name="email"></form>`,
  );
  assert.equal(
    page.api._honeypotReason(page.document.getElementById("e")),
    null,
  );
  page.close();
});

for (const [name, html, id] of [
  ["a hidden input", `<input type="hidden" id="t" name="email">`, "t"],
  [
    "a field its wrapper hides",
    `<div style="display:none"><input id="t" name="email"></div>`,
    "t",
  ],
  [
    "an aria-hidden field",
    `<input id="t" name="email" aria-hidden="true">`,
    "t",
  ],
  [
    "a field behind the hidden attribute",
    `<input id="t" name="email" hidden>`,
    "t",
  ],
  ["a transparent field", `<input id="t" name="email" style="opacity:0">`, "t"],
  [
    "a field parked off the page",
    `<input id="t" name="email" style="position:absolute;left:-9999px">`,
    "t",
  ],
  [
    "a field named only a trap would use",
    `<input id="t" name="bot-field">`,
    "t",
  ],
  ["a field named honeypot", `<input id="t" name="honeypot_email">`, "t"],
  [
    "a field the site asks you to leave blank",
    `<input id="t" name="leave_this_blank">`,
    "t",
  ],
]) {
  test(`${name} is refused`, async () => {
    const page = await loadInjector(`<form>${html}</form>`);
    const reason = page.api._honeypotReason(page.document.getElementById(id));
    assert.ok(reason, `${name} was treated as an ordinary field`);
    assert.ok(reason.length > 5, "the reason is not something a user can read");
    page.close();
  });
}

test("a field with no size on screen is refused", async () => {
  const page = await loadInjector(`<form><input id="t" name="email"></form>`);
  const el = page.document.getElementById("t");
  boxOf(el, { width: 0, height: 0 });
  assert.match(page.api._honeypotReason(el), /no size/);
  page.close();
});

test("a field scrolled far above the viewport is refused", async () => {
  const page = await loadInjector(`<form><input id="t" name="email"></form>`);
  const el = page.document.getElementById("t");
  boxOf(el, { width: 120, height: 20, left: -4000, top: -4000 });
  assert.ok(page.api._honeypotReason(el));
  page.close();
});

test("a real url field on a comment form is still filled", async () => {
  // The name is bait on some forms and a real field on others, so a name that
  // has an honest use is never proof on its own.
  const page = await loadInjector(
    `<form><input id="t" name="url" placeholder="Your website"></form>`,
  );
  assert.equal(
    page.api._honeypotReason(page.document.getElementById("t")),
    null,
  );
  page.close();
});

// ── What FILL does about it ─────────────────────────────────────────────────

test("multi-field FILL fills the real fields and skips the trap", async () => {
  const page = await loadInjector(
    `<form>
       <input id="name" name="name">
       <div style="display:none"><input id="trap" name="email_confirm"></div>
       <input id="msg" name="message">
     </form>`,
  );
  const out = await page.api._stepFill({
    mode: "multi",
    delayMs: 0,
    fields: [
      { selector: "#name", value: "Ada" },
      { selector: "#trap", value: "ada@example.com" },
      { selector: "#msg", value: "hello" },
    ],
  });

  assert.equal(page.document.getElementById("name").value, "Ada");
  assert.equal(page.document.getElementById("msg").value, "hello");
  assert.equal(
    page.document.getElementById("trap").value,
    "",
    "the trap was filled, which is what flags the submission",
  );
  assert.equal(out.filled, 2);
  assert.equal(out.skipped.length, 1);
  assert.equal(out.skipped[0].selector, "#trap");
  assert.ok(out.skipped[0].reason);
  page.close();
});

test("a skipped trap is not reported as a missing field", async () => {
  // Throwing would stop the run over a field that was never meant to be
  // filled, which is a worse answer than the silence it replaces.
  const page = await loadInjector(
    `<form><input id="a" name="a"><input id="trap" name="honeypot" hidden></form>`,
  );
  await assert.doesNotReject(() =>
    page.api._stepFill({
      mode: "multi",
      delayMs: 0,
      fields: [
        { selector: "#a", value: "x" },
        { selector: "#trap", value: "y" },
      ],
    }),
  );
  page.close();
});

// ── And says so ─────────────────────────────────────────────────────────────

test("the run log names the field and why it was skipped", async () => {
  reset();
  const { runId } = startRun();
  onContentMessage(async () => ({
    ok: true,
    result: {
      filled: 1,
      fields: [],
      skipped: [{ selector: "#trap", reason: "it is display:none" }],
    },
  }));
  await _dispatchStep(
    {
      id: "f1",
      type: "FILL",
      config: { mode: "multi", fields: [{ selector: "#trap", value: "x" }] },
    },
    1,
    runId,
    { extracted: {} },
  );
  const line = logs().find((m) => m.includes("#trap"));
  assert.ok(
    line,
    "a form quietly did less than it was told to and said nothing",
  );
  assert.match(line, /display:none/);
  assert.match(line, /trap/i);
  await endRun(runId);
});

// ── Passwords: the block that was documented and never reachable ────────────
//
// The ethics engine has listed "password fields in form filling" as a hard
// block since the audit. Reading the code rather than the docblock: that block
// filters the pipeline for steps of type FORM_FILL, and the registry has no
// such type — the step is FILL. It matched nothing on every pipeline ever run,
// and the comment three lines above it in ethics-engine.js says so about a
// *different* gate, which is how it survived a fix that was looking straight
// at it.
//
// The in-page guard that should have caught it (form-filler.js:333) is
// reachable only through an VQ_FORM_FILL_ROW message that nothing dispatches.
// So both copies of the protection were dead, and the path a user actually
// builds would type a credential into a login form and click submit, while
// SECURITY.md and the ethics engine both said it could not.
//
// A honeypot check does not cover this: a password field is visible, focusable
// and real. It is the one field where doing the obvious thing is the harm.

test("FILL refuses a password field outright", async () => {
  const page = await loadInjector(
    `<form><input id="u" name="user"><input id="p" type="password" name="pass"></form>`,
  );
  await assert.rejects(
    () =>
      page.api._stepFill({
        mode: "single",
        selector: "#p",
        text: "hunter2",
        delayMs: 0,
      }),
    /password field/i,
    "FILL typed into a password field",
  );
  assert.equal(
    page.document.getElementById("p").value,
    "",
    "the credential reached the field before the refusal",
  );
  page.close();
});

test("a password field inside a multi-field FILL stops the whole step", async () => {
  // Not skipped like a honeypot. A honeypot is a field the form is complete
  // without; a login form without its password is a step that was going to
  // submit a credential and should not continue to the submit click.
  const page = await loadInjector(
    `<form>
       <input id="u" name="user">
       <input id="p" type="password" name="pass">
       <button id="go">Sign in</button>
     </form>`,
  );
  let clicked = false;
  page.document.getElementById("go").addEventListener("click", () => {
    clicked = true;
  });

  await assert.rejects(
    () =>
      page.api._stepFill({
        mode: "multi",
        delayMs: 0,
        submitSelector: "#go",
        fields: [
          { selector: "#u", value: "ada" },
          { selector: "#p", value: "hunter2" },
        ],
      }),
    /password field/i,
  );
  assert.equal(page.document.getElementById("p").value, "");
  assert.equal(clicked, false, "the form was submitted anyway");
  page.close();
});

test("an ordinary text field is unaffected", async () => {
  // The other half: a refusal that also blocked normal fills would be found
  // immediately, which is exactly why it is worth asserting.
  const page = await loadInjector(`<form><input id="u" name="user"></form>`);
  await page.api._stepFill({
    mode: "single",
    selector: "#u",
    text: "ada",
    delayMs: 0,
  });
  assert.equal(page.document.getElementById("u").value, "ada");
  page.close();
});
