// === value-transforms.js ===
/**
 * @module value-transforms
 * @description Clean an extracted value at the point it is extracted.
 *
 *   EXTRACT returned exactly what was on the page. A price came back as
 *   `"$25.50"` — a string, with a currency symbol inside it. A link came back
 *   as `"/p/123"`, which is not a link anywhere except on that page. A review
 *   count came back as `"1,234 reviews"`. So every scrape ended in a
 *   spreadsheet doing find-and-replace, which is the part of the job people
 *   actually mind.
 *
 *   Pure, and separate from the content script on purpose: the script emitters
 *   apply the same transforms, so an exported script produces the same values
 *   as the extension rather than a plausible-looking approximation of them.
 *
 *   The rule throughout is the one the audit kept arriving at: **a transform
 *   that cannot do its job returns `null`, and never a wrong answer that looks
 *   right.** `"Out of stock"` as a number is not `0` — `0` is a price, and it
 *   would sit in the column indistinguishable from a real one.
 *
 * @dependencies none
 */

/**
 * Read a number out of the text wrapped around it.
 *
 * The hard part is the thousands separator. `"1.234,56"` is how most of Europe
 * writes 1234.56, and reading it as `1.234` is a hundredfold error in a price
 * column with nothing to signal it. So the separator is decided by which mark
 * appears last, which is what actually distinguishes the two conventions.
 *
 * @param {string} text
 * @returns {number|null}
 */
function toNumber(text) {
  const raw = String(text ?? "");

  // Scientific notation first, and only where it is unambiguous: digits, then
  // E, then a signed exponent. Found in a real scrape — scrapethissite.com
  // reports Antarctica's area as "1.4E7" — where the general pattern below
  // stopped at the E and turned fourteen million into 1.4. A wrong number that
  // looks plausible in a column of areas is the worst kind. "3 EUR" and
  // "Section 4E" are not exponents, and must not be read as any.
  const sci = raw.match(/-?\d+(?:[.,]\d+)?[eE][+-]?\d+/);
  if (sci) {
    const n = Number(sci[0].replace(",", "."));
    if (Number.isFinite(n)) return n;
  }

  // Grab the numeric run, including separators and a leading sign.
  const match = raw.match(/-?\d[\d.,  \s]*\d|-?\d/);
  if (!match) return null;

  let body = match[0].replace(/[\s  ]/g, "");
  const lastComma = body.lastIndexOf(",");
  const lastDot = body.lastIndexOf(".");

  if (lastComma > -1 && lastDot > -1) {
    // Both present: the later one is the decimal point.
    const decimal = lastComma > lastDot ? "," : ".";
    const thousands = decimal === "," ? "." : ",";
    body = body.split(thousands).join("").replace(decimal, ".");
  } else if (lastComma > -1) {
    // Only commas. Exactly one, with 1-2 digits after it, is a decimal comma
    // ("9,99"); anything else is thousands ("1,234", "1,234,567").
    const after = body.length - lastComma - 1;
    const single = body.indexOf(",") === lastComma;
    body =
      single && after > 0 && after <= 2
        ? body.replace(",", ".")
        : body.split(",").join("");
  } else if (lastDot > -1) {
    // Only dots. The mirror of the above: "1.234" is thousands, "25.50" is not.
    const after = body.length - lastDot - 1;
    const single = body.indexOf(".") === lastDot;
    if (!(single && after > 0 && after <= 2)) body = body.split(".").join("");
  }

  const n = Number(body);
  return Number.isFinite(n) ? n : null;
}

/**
 * Resolve a relative link against the page it came from.
 *
 * Left alone when there is no base to resolve against, or when the value is
 * not a URL at all — a half-resolved link is worse than an untouched one,
 * because it looks usable.
 *
 * That second case needed a guard, because `new URL()` does not fail on prose.
 * Against a base, `new URL("Out of stock", "https://shop.example/catalog/")`
 * does not throw; it percent-encodes the spaces and hands back
 * `https://shop.example/catalog/Out%20of%20stock`, an address that is
 * well-formed, clickable, and nowhere. A column of those is worse than a
 * column of untouched text in exactly the way this module's opening rule
 * says: a wrong answer that looks right.
 *
 * Whitespace is the signal, because it is the one thing a relative URL cannot
 * contain unencoded and the one thing a sentence always does. It leaves
 * `p/123`, `./x`, `?q=1` and `#frag` alone, which are the relative forms that
 * actually appear in markup. A single unspaced word that is not a link —
 * `InStock` — still resolves; there is nothing in the string to tell it apart
 * from a real path segment, and pretending otherwise would cost real links.
 */
function toAbsoluteUrl(value, { base } = {}) {
  const text = String(value ?? "").trim();
  if (!text) return text;
  if (/\s/.test(text)) return text;
  try {
    return new URL(text, base || undefined).href;
  } catch {
    return text;
  }
}

/**
 * How much text a pattern is allowed to search before this transform simply
 * declines. Real fields — an ID at the end of a URL, a SKU in a caption — are
 * short; this exists for the field that is not, an "HTML" or "Text" reader
 * pointed at a whole page. It is a length cap, not a time limit: a short
 * string can still sit a genuinely pathological pattern in the regex engine
 * for a long time, which is what isCatastrophicPattern below is for. The two
 * together are the "as far as is reasonable" version of this guard — see the
 * module docs for what neither one catches.
 */
const MAX_REGEX_INPUT_LENGTH = 20000;

/**
 * A cheap, deliberately conservative check for the pattern shape behind
 * almost every real catastrophic-backtracking report: a group that can
 * already match empty or repeat internally, repeated again from outside it —
 * `(a+)+`, `(\d*)+`, `([^\s]+)*`. On the right input that shape makes the
 * engine try an exponential number of ways to split the string before it can
 * report failure, which is a hang, not a slow answer.
 *
 * This is a heuristic, not a proof of safety. It only looks one paren level
 * deep, so `((a+)b)+` slips past it, and it knows nothing about alternation
 * overlap (`(a|a)+`) or backreferences. What it does catch is the shape
 * nearly every real-world ReDoS report turns out to be, for the cost of one
 * more regex test.
 *
 * @param {string} pattern
 * @returns {boolean}
 */
function isCatastrophicPattern(pattern) {
  return /\([^()]*[+*][^()]*\)[+*]/.test(pattern);
}

/**
 * Pull a substring out with a pattern.
 *
 * `group` picks which capture group. 0 is always the whole match. A group of
 * 2 or more is that group or `null` if the pattern does not have it — asking
 * for group 2 on a pattern with one group is a real mistake, and silently
 * handing back group 1 instead would hide it.
 *
 * Group 1 is the exception, and is the same whether it is asked for or left
 * unset: on a pattern with no parentheses at all it gives the whole match, so
 * a plain pattern "just works" the way the field's placeholder text implies.
 * There is no mistake to hide there — a pattern with no groups and a request
 * for its first group can only have meant the match.
 *
 * No match, no pattern, a pattern `RegExp` will not accept, or one shaped for
 * catastrophic backtracking: all of these come back `null`, the same as
 * every other transform in this file on input it cannot use. A bad pattern
 * is a common mistake — the panel already flags one as the user types it —
 * and failing the whole EXTRACT step over it would take a multi-field,
 * multi-page run down for one wrong field.
 */
function byRegex(value, { pattern, flags = "", group } = {}) {
  const raw = String(pattern ?? "");
  // Normalized rather than passed through, so a run and the scripts generated
  // from it read the same pattern the same way.
  const f = normalizeRegexFlags(flags);
  if (!raw || !isValidRegex(raw, f)) return null;

  const text = String(value ?? "");
  if (text.length > MAX_REGEX_INPUT_LENGTH) return null;

  const m = text.match(new RegExp(raw, f));
  if (!m) return null;

  const g = normalizeRegexGroup(group);
  if (g === 0) return m[0];
  const idx = g > 0 ? g : 1;
  if (m[idx] !== undefined) return m[idx];
  return idx === 1 && m.length === 1 ? m[0] : null;
}

/** Collapse the whitespace real markup leaves inside a rendered string. */
const collapse = (value) =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Every transform the UI can offer, with the text it offers them under.
 *
 * Kept in one place so the panel cannot list a transform that does not exist,
 * and a test fails if one is added without a label or help text — the same
 * single-definition rule the step registry follows (G-01).
 *
 * @type {Record<string, {label: string, help: string, fn: Function, opts?: string[]}>}
 */
export const TRANSFORMS = Object.freeze({
  trim: {
    label: "Tidy whitespace",
    help: "Collapses the line breaks and indentation markup leaves inside text.",
    fn: (v) => collapse(v),
  },
  number: {
    label: "Number",
    help: 'Reads the number out of text like "$25.50" or "1,234 reviews". Text with no number in it becomes empty rather than zero.',
    fn: (v) => toNumber(v),
  },
  url: {
    label: "Full URL",
    help: 'Turns a relative link like "/p/123" into a complete address you can open.',
    fn: (v, o) => toAbsoluteUrl(v, o),
  },
  regex: {
    label: "Pattern",
    help: "Keeps the part matching your pattern — the first (bracketed group) if you use one, or pick a later group and use 0 for the whole match. No match, or a pattern that will not run, becomes empty.",
    fn: (v, o) => byRegex(v, o),
    opts: ["pattern", "group", "flags"],
  },
  /**
   * Decode base64 that a page is hiding real content behind.
   *
   * A deliberate obfuscation on some sites and an ordinary encoding on others
   * (data: URLs, embedded payloads). Returns null rather than a mangled string
   * when the input is not valid base64 — a plausible wrong answer is worse
   * than an empty cell, and "VGhpcw" and "Total: 42" are both just strings
   * until one of them fails to decode.
   */
  base64: {
    label: "Decode base64",
    help: 'Turns base64 like "SGVsbG8gd29ybGQ=" back into the text it hides. Anything that is not valid base64 becomes empty rather than a mangled string.',
    fn: (v) => {
      const raw = String(v ?? "").trim();
      if (!raw) return null;
      // Tolerate URL-safe alphabets and missing padding, both common in the
      // wild; reject anything that is not base64 at all.
      const norm = raw.replace(/-/g, "+").replace(/_/g, "/");
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(norm) || norm.length < 4) return null;
      const padded = norm + "=".repeat((4 - (norm.length % 4)) % 4);
      try {
        const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        return null;
      }
    },
  },

  lower: {
    label: "lowercase",
    help: "Useful for values you will match or group on later.",
    fn: (v) => String(v ?? "").toLowerCase(),
  },
  upper: {
    label: "UPPERCASE",
    help: "Useful for codes and country abbreviations.",
    fn: (v) => String(v ?? "").toUpperCase(),
  },
});

/**
 * The flags this tool is willing to run.
 *
 * A pipeline and the two scripts it generates must extract the same values, so
 * the set is the intersection of what JavaScript and Python both spell the same
 * way: case-insensitive, multiline, and dot-matches-newline. `g` is excluded on
 * purpose — a transform reads one value, and a global regex would only change
 * where the next call starts.
 */
export const REGEX_FLAGS = "ims";

/**
 * @param {unknown} flags
 * @returns {string} the given flags, in a fixed order, with anything unsupported dropped
 */
export function normalizeRegexFlags(flags) {
  const given = String(flags ?? "").toLowerCase();
  return [...REGEX_FLAGS].filter((f) => given.includes(f)).join("");
}

/**
 * @param {unknown} group
 * @returns {number|null} the capture group asked for, or null for "unset"
 */
export function normalizeRegexGroup(group) {
  if (group === "" || group === null || group === undefined) return null;
  const n = Number(group);
  return Number.isInteger(n) && n >= 0 && n <= 20 ? n : null;
}

/**
 * Is this something RegExp will accept, and not a shape known to hang the
 * engine on the right input?
 *
 * Used by the panel to reject a pattern as it is typed, by the `regex`
 * transform itself before it ever runs one, and by both script emitters to
 * refuse a field rather than repair it — a repaired pattern gives a script
 * that runs and extracts something other than what the pipeline extracts,
 * which is worse than one that stops and says why.
 *
 * @param {string} pattern
 * @param {string} [flags]
 * @returns {boolean}
 */
export function isValidRegex(pattern, flags = "") {
  const str = String(pattern ?? "");
  if (isCatastrophicPattern(str)) return false;
  try {
    new RegExp(str, String(flags ?? ""));
    return true;
  } catch {
    return false;
  }
}

/** The names the UI offers, in the order it offers them. */
export const TRANSFORM_NAMES = Object.freeze(Object.keys(TRANSFORMS));

/**
 * Apply one transform.
 *
 * @param {*} value
 * @param {string} name  - a key of TRANSFORMS, or "none"
 * @param {object} [opts] - `base` for url, `pattern` for regex
 * @returns {*}
 * @throws when `name` is not a transform — a misspelled name silently ignored
 *   is a pipeline that quietly does not do what its configuration says.
 */
export function applyTransform(value, name, opts = {}) {
  if (!name || name === "none") return value;
  const meta = TRANSFORMS[name];
  if (!meta) {
    throw new Error(
      `Unknown value transform "${name}". Supported: ${TRANSFORM_NAMES.join(", ")}.`,
    );
  }
  return meta.fn(value, opts);
}

/**
 * Apply transforms in order, stopping at the first that yields null.
 *
 * Carrying a null onward would let the *next* transform's behaviour on null
 * decide the output — `number` on null becoming 0 being the case that matters,
 * since 0 is a plausible price.
 *
 * @param {*} value
 * @param {string[]} [names]
 * @param {object} [opts]
 * @returns {*}
 */
export function applyTransforms(value, names, opts = {}) {
  if (!Array.isArray(names) || names.length === 0) return value;
  let out = value;
  for (const name of names) {
    out = applyTransform(out, name, opts);
    if (out === null) return null;
  }
  return out;
}

// === END value-transforms.js ===
