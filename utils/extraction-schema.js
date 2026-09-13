// === extraction-schema.js ===
/**
 * @module extraction-schema
 * @description What `AUTO_EXTRACT` is being asked to find.
 *
 *   The step was product-only: seven field names hardcoded across two hundred
 *   lines of scoring rules in `content/smart-extractor.js`, and a prompt that
 *   spelled the same seven out again. A page of court listings, job adverts or
 *   conference talks got a step that could only ask "what is the price".
 *
 *   A schema is a list of field names. That is deliberately the whole of it —
 *   no types, no required flags, no nesting. A user typing `title, author,
 *   published` wants three columns, and every further ceremony is a form to
 *   fill in before getting them.
 *
 *   **Where the fuzzy matching lives, and why here.** A page's JSON-LD calls it
 *   `datePublished`; the user typed `published date`. Something has to decide
 *   those are the same field, and `fieldMatchScore()` in
 *   `utils/levenshtein.js` already does exactly that — it was written for
 *   `content/field-auto-mapper.js`, which nothing ever reached (audit A-07) and
 *   which has since been removed.
 *   It could not be used from the page even so: `smart-extractor.js` is a
 *   classic content script and cannot import a module. So the page reports the
 *   structured-data node it found and this decides what the keys mean, which is
 *   the same split `IF_ELSE` and `ASSERT` already use — the page observes, the
 *   worker judges.
 *
 * @dependencies utils/levenshtein.js
 */

import { fieldMatchScore } from "./levenshtein.js";

/**
 * What a blank schema means.
 *
 * Every pipeline saved before schemas existed has no `schema`, and must keep
 * doing exactly what it did. These are the fields layer 2's heuristics are
 * written for, so this is also the only schema where all three layers have an
 * opinion.
 */
export const DEFAULT_PRODUCT_FIELDS = Object.freeze([
  "name",
  "price",
  "originalPrice",
  "currency",
  "brand",
  "description",
  "sku",
  "availability",
  "rating",
  "reviewCount",
  "images",
]);

/**
 * How much each product field counts toward the overall confidence.
 *
 * Product-specific by nature: a page with no price is a worse product
 * extraction than a page with no SKU. A custom schema has no such ordering —
 * the user asked for those fields, so they weigh the same.
 */
export const PRODUCT_WEIGHTS = Object.freeze({
  name: 30,
  price: 25,
  images: 15,
  brand: 10,
  description: 10,
  sku: 5,
  availability: 5,
});

/** A field name a page could plausibly use as a key. */
const NAME_OK = /^[A-Za-z][A-Za-z0-9 _.-]{0,60}$/;

/** Below this, two names are different fields rather than spellings of one. */
export const MATCH_THRESHOLD = 0.62;

/** How many fields one step may ask for. Past this it is a database schema. */
export const MAX_FIELDS = 40;

/**
 * Read the field list the panel collects.
 *
 * Accepts a comma- or newline-separated string, or an array. Empty means the
 * product default, so an existing pipeline is unchanged.
 *
 * @param {string|string[]|undefined} input
 * @returns {{fields: string[], isDefault: boolean, rejected: string[]}}
 */
export function parseSchema(input) {
  const raw = Array.isArray(input) ? input : String(input ?? "").split(/[,\n]/);

  const fields = [];
  const rejected = [];
  const seen = new Set();

  for (const entry of raw) {
    const name = String(entry ?? "").trim();
    if (!name) continue;
    if (!NAME_OK.test(name)) {
      // Named rather than dropped: a field silently missing from every row is
      // the thing a user spends an afternoon on.
      rejected.push(name);
      continue;
    }
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (fields.length < MAX_FIELDS) fields.push(name);
    else rejected.push(name);
  }

  if (fields.length === 0) {
    return { fields: [...DEFAULT_PRODUCT_FIELDS], isDefault: true, rejected };
  }
  return { fields, isDefault: false, rejected };
}

/**
 * Weights for a schema's overall-confidence calculation.
 *
 * @param {string[]} fields
 * @param {boolean} isDefault
 * @returns {Record<string, number>}
 */
export function weightsFor(fields, isDefault) {
  if (isDefault) return { ...PRODUCT_WEIGHTS };
  // Equal: the user named these, so none of them is the optional one.
  return Object.fromEntries(fields.map((f) => [f, 1]));
}

/**
 * Pull a schema's fields out of a structured-data node.
 *
 * The node is whatever the page found — a JSON-LD object of any `@type`,
 * microdata, or Open Graph tags. Its keys are the site's, not ours, so each
 * requested field is matched against them by similarity rather than by
 * equality: `datePublished` answers a request for `published date`, and
 * `headline` answers `title`.
 *
 * An exact match always wins outright. Fuzzy matching only decides the rest,
 * and only above `MATCH_THRESHOLD` — below that the honest answer is that the
 * page does not publish the field, which sends it to the next layer rather
 * than filling the column with the nearest thing lying around.
 *
 * @param {object|null} node
 * @param {string[]} fields
 * @returns {{values: Record<string, any>, matchedKeys: Record<string, string>}}
 */
export function mapNodeToSchema(node, fields) {
  const values = {};
  const matchedKeys = {};
  if (!node || typeof node !== "object") return { values, matchedKeys };

  const keys = Object.keys(node).filter((k) => !k.startsWith("@"));
  const takenKeys = new Set();

  for (const field of fields) {
    // Exact first, case-insensitively. A page that calls it exactly what the
    // user called it should never be second-guessed by a similarity score.
    const exact = keys.find(
      (k) => k.toLowerCase() === field.toLowerCase() && !takenKeys.has(k),
    );
    let chosen = exact ?? null;

    if (!chosen) {
      let best = null;
      let bestScore = 0;
      for (const key of keys) {
        if (takenKeys.has(key)) continue;
        const score = fieldMatchScore(field, key);
        if (score > bestScore) {
          bestScore = score;
          best = key;
        }
      }
      if (best && bestScore >= MATCH_THRESHOLD) chosen = best;
    }

    if (!chosen) continue;
    const value = _flatten(node[chosen]);
    if (value === null) continue;

    // One key answers one field: without this, a schema of "price" and
    // "originalPrice" would take the same key twice and report the same number
    // in both columns as though the page had said it twice.
    takenKeys.add(chosen);
    values[field] = value;
    matchedKeys[field] = chosen;
  }

  return { values, matchedKeys };
}

/**
 * A structured-data value as something that fits in a cell.
 *
 * JSON-LD nests: `offers` is an object, `author` is often an object with a
 * `name`. A cell holding `[object Object]` is worse than an empty one, so a
 * nested node is reduced to the string it is plainly about, and anything with
 * no such string is refused rather than stringified.
 */
function _flatten(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    const parts = value.map(_flatten).filter(Boolean);
    return parts.length ? parts.join(", ") : null;
  }
  if (typeof value === "object") {
    // The conventional "what this node is called" keys, in the order a reader
    // would try them.
    for (const key of ["name", "@value", "value", "text", "url", "@id"]) {
      const inner = _flatten(value[key]);
      if (inner) return inner;
    }
    return null;
  }
  return null;
}

/**
 * Map a model's returned object onto the requested field names.
 *
 * A model asked for `published date` may answer with `publishedDate`,
 * `published_date` or `date`. Insisting on the exact key would throw away a
 * correct answer over its spelling.
 *
 * @param {object|null} answer
 * @param {string[]} fields
 * @returns {Record<string, any>}
 */
export function mapModelKeys(answer, fields) {
  const { values } = mapNodeToSchema(answer, fields);
  return values;
}

// === END extraction-schema.js ===
