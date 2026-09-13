// Overlay badges: the colour a step paints on the page, and whether its label
// can be read once it is there.
//
// Both halves of this file pin a defect that shipped. `badgeTextColor` chose
// text by `luminance > 0.5`, which is not the WCAG crossover — the point where
// dark text overtakes white depends on how dark the dark is, and this palette's
// dark is #111827. Ten of thirteen colours got the wrong text colour and eleven
// failed AA. And `STEP_COLOR_INDEX` had drifted off the registry far enough
// that nineteen real step types fell through `?? 0` and painted NAVIGATE blue,
// while ten of its keys named types that do not exist.
//
// So: the map is checked against the registry in both directions, and the
// colours are checked against the contrast ratio rather than against a list of
// hex values — a test that pins today's palette would have to be edited every
// time the palette moves, and would have passed happily on the broken one.
import test from "node:test";
import assert from "node:assert/strict";
import {
  ZONE_PALETTE,
  STEP_COLOR_INDEX,
  BADGE_DARK,
  COLOR_CAPTCHA,
  COLOR_BLOCKED,
  stepColor,
  badgeTextColor,
  contrastRatio,
  relativeLuminance,
  hexToRGB,
} from "../utils/color-utils.js";
import { STEP_TYPES, USER_STEP_TYPES } from "../utils/step-types.js";

/** WCAG AA for normal text. */
const AA = 4.5;

const ratio = (bg, fg) =>
  contrastRatio(relativeLuminance(bg), relativeLuminance(fg));

// ── The map matches the registry, both ways ─────────────────────────────────

test("every step a user can add has a colour of its own", () => {
  const missing = USER_STEP_TYPES.filter(
    (t) => STEP_COLOR_INDEX[t] === undefined,
  );
  assert.deepEqual(
    missing,
    [],
    "these steps fall through to the unknown-type colour, so they are " +
      "indistinguishable from each other on the page",
  );
});

test("no colour is assigned to a step type that does not exist", () => {
  const ghosts = Object.keys(STEP_COLOR_INDEX).filter((t) => !STEP_TYPES[t]);
  assert.deepEqual(
    ghosts,
    [],
    "a key here that the registry does not have is a rename that only got " +
      "done in one of the two files",
  );
});

test("internal dispatch types are not given user-facing colours", () => {
  // Not a correctness bug if one appeared, but it would mean the map is being
  // maintained by guesswork rather than from USER_STEP_TYPES.
  const internal = Object.keys(STEP_COLOR_INDEX).filter(
    (t) => STEP_TYPES[t]?.internal,
  );
  assert.deepEqual(internal, []);
});

test("every palette index the map uses actually exists", () => {
  for (const [type, idx] of Object.entries(STEP_COLOR_INDEX)) {
    if (idx < 0) continue; // the sentinels have their own colours
    assert.ok(
      ZONE_PALETTE[idx],
      `${type} points at palette slot ${idx}, which is past the end`,
    );
  }
});

// ── stepColor ───────────────────────────────────────────────────────────────

test("the captcha step gets the captcha colour", () => {
  // The registry type is SOLVE_CAPTCHA. The old special case tested for
  // "CAPTCHA_SOLVE", so it never fired once.
  assert.equal(stepColor("SOLVE_CAPTCHA"), COLOR_CAPTCHA);
});

test("an unknown step type paints grey, not NAVIGATE blue", () => {
  // Borrowing blue hides the gap: the step looks like a navigation rather than
  // like a step nobody has given a colour to.
  assert.equal(stepColor("NO_SUCH_STEP"), COLOR_BLOCKED);
  assert.notEqual(stepColor("NO_SUCH_STEP"), ZONE_PALETTE[0]);
});

test("steps that only configure the request are not painted as actions", () => {
  for (const t of ["SET_HEADERS", "SESSION"]) {
    assert.equal(stepColor(t), COLOR_BLOCKED, t);
  }
});

test("navigating and reading are told apart", () => {
  // The single most visible symptom of the drift: these were the same blue.
  const distinct = new Set(
    ["NAVIGATE", "EXTRACT", "FILL", "CLICK", "SCROLL", "WAIT", "PAGINATE"].map(
      stepColor,
    ),
  );
  assert.equal(distinct.size, 7, "two kinds of work share a colour");
});

test("stepColor never returns undefined for anything in the registry", () => {
  for (const t of Object.keys(STEP_TYPES)) {
    assert.match(stepColor(t), /^#[0-9a-fA-F]{6}$/, t);
  }
});

// ── contrastRatio ───────────────────────────────────────────────────────────

test("contrastRatio matches the WCAG reference points", () => {
  assert.equal(Math.round(ratio("#000000", "#ffffff")), 21);
  assert.equal(ratio("#ffffff", "#ffffff"), 1);
  // The canonical AA example: #767676 is the darkest grey that passes on white.
  assert.ok(ratio("#767676", "#ffffff") >= AA);
  assert.ok(ratio("#777777", "#ffffff") < AA);
});

test("contrastRatio does not care which argument is lighter", () => {
  const a = relativeLuminance("#3B82F6");
  const b = relativeLuminance("#ffffff");
  assert.equal(contrastRatio(a, b), contrastRatio(b, a));
});

// ── badgeTextColor ──────────────────────────────────────────────────────────

test("badgeTextColor picks the better of its two options every time", () => {
  // The property, stated directly. A threshold can be wrong; picking the
  // larger of two measured ratios cannot be, and cannot drift when the palette
  // moves.
  const all = [...ZONE_PALETTE, COLOR_CAPTCHA, COLOR_BLOCKED, "#FACC15"];
  for (const bg of all) {
    const chosen = badgeTextColor(bg);
    const other = chosen === BADGE_DARK ? "#ffffff" : BADGE_DARK;
    assert.ok(
      ratio(bg, chosen) >= ratio(bg, other),
      `${bg}: chose ${chosen} at ${ratio(bg, chosen).toFixed(2)} over ` +
        `${other} at ${ratio(bg, other).toFixed(2)}`,
    );
  }
});

test("amber gets dark text", () => {
  // The worst case under the old threshold: white on #F59E0B at 2.15:1, where
  // dark text gives 8.26:1. Named on its own because it is the one a reader of
  // this file will want to see proved.
  assert.equal(badgeTextColor("#F59E0B"), BADGE_DARK);
  assert.ok(ratio("#F59E0B", BADGE_DARK) > 8);
});

test("dark blue gets white text", () => {
  assert.equal(badgeTextColor("#1E3A8A"), "#ffffff");
});

test("badgeTextColor returns one of the two colours it documents", () => {
  for (const bg of [...ZONE_PALETTE, "#000000", "#ffffff", "#808080"]) {
    assert.ok([BADGE_DARK, "#ffffff"].includes(badgeTextColor(bg)), bg);
  }
});

// ── The whole thing, on the page ────────────────────────────────────────────

test("every step badge a user can see reaches WCAG AA", () => {
  const failures = [];
  for (const type of USER_STEP_TYPES) {
    const bg = stepColor(type);
    const r = ratio(bg, badgeTextColor(bg));
    if (r < AA) failures.push(`${type} on ${bg}: ${r.toFixed(2)}:1`);
  }
  assert.deepEqual(
    failures,
    [],
    "the module's own docblock promises WCAG 2.1; these badges do not keep it",
  );
});

test("the palette itself carries readable text in every slot", () => {
  // Separate from the step check, because a slot no step currently uses is
  // still a slot the next step added will use.
  for (const bg of ZONE_PALETTE) {
    assert.ok(ratio(bg, badgeTextColor(bg)) >= AA, `${bg} cannot be labelled`);
  }
});

test("the violet slot is the darkened one, and it is darkened enough", () => {
  // #8B5CF6 could not reach AA against either text colour — 4.23 at best. This
  // pins the reason the palette value looks arbitrary, so nobody tidies it back.
  const violet = ZONE_PALETTE[3];
  assert.notEqual(violet, "#8B5CF6");
  assert.ok(ratio(violet, badgeTextColor(violet)) >= AA);
});

// ── hexToRGB, since everything above rests on it ────────────────────────────

test("hexToRGB reads both shorthand and full hex", () => {
  assert.deepEqual(hexToRGB("#f00"), { r: 255, g: 0, b: 0 });
  assert.deepEqual(hexToRGB("#ff0000"), { r: 255, g: 0, b: 0 });
  assert.deepEqual(hexToRGB("3B82F6"), { r: 0x3b, g: 0x82, b: 0xf6 });
});

test("relativeLuminance brackets at black and white", () => {
  assert.equal(relativeLuminance("#000000"), 0);
  assert.equal(Math.round(relativeLuminance("#ffffff")), 1);
});
