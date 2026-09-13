// === levenshtein.js ===
/**
 * @module levenshtein
 * @description Normalized Levenshtein distance and Jaccard similarity
 *   used by utils/extraction-schema.js to map a model's returned keys onto
 *   the field names the user asked for.
 *   Also exports a tokenizer for splitting identifiers into words.
 * @dependencies none
 */

"use strict";

/**
 * Compute the Levenshtein edit distance between two strings.
 * Uses a single-row DP approach for memory efficiency.
 * @param {string} a
 * @param {string} b
 * @returns {number} edit distance (integer)
 */
export function levenshteinDistance(a, b) {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Use typed array for performance
  let prev = new Uint32Array(b.length + 1);
  let curr = new Uint32Array(b.length + 1);

  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1, // deletion
        curr[j - 1] + 1, // insertion
        prev[j - 1] + cost, // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }

  return prev[b.length];
}

/**
 * Normalized Levenshtein similarity in [0,1].
 * 1.0 = identical, 0.0 = completely different.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function levenshteinNormalized(a, b) {
  const al = a.toLowerCase().trim();
  const bl = b.toLowerCase().trim();
  if (al === bl) return 1.0;
  const maxLen = Math.max(al.length, bl.length);
  if (maxLen === 0) return 1.0;
  return 1 - levenshteinDistance(al, bl) / maxLen;
}

/**
 * Tokenize an identifier or label into lowercase words.
 * Handles camelCase, snake_case, kebab-case, spaces.
 * @param {string} input
 * @returns {Set<string>}
 */
export function tokenize(input) {
  if (!input) return new Set();
  const words = String(input)
    // Insert space before uppercase in camelCase
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    // Split on non-alphanumeric
    .split(/[\s_\-./\\[\]()+,;:]+/)
    .map((w) => w.toLowerCase().trim())
    .filter((w) => w.length > 0);
  return new Set(words);
}

/**
 * Jaccard similarity between two token sets.
 * @param {Set<string>} setA
 * @param {Set<string>} setB
 * @returns {number} value in [0,1]
 */
export function jaccardSimilarity(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 1.0;
  const intersection = new Set([...setA].filter((t) => setB.has(t)));
  const union = new Set([...setA, ...setB]);
  return intersection.size / union.size;
}

/**
 * Combined field-match score: max of Jaccard(tokens) and Levenshtein(full strings).
 * Used by utils/extraction-schema.js to score key↔field pairs.
 * @param {string} colName   - Dataset column name
 * @param {string} fieldSignal - Field label/name/id/placeholder signal
 * @returns {number} score in [0,1]
 */
export function fieldMatchScore(colName, fieldSignal) {
  const tokensA = tokenize(colName);
  const tokensB = tokenize(fieldSignal);
  const jaccard = jaccardSimilarity(tokensA, tokensB);
  const lev = levenshteinNormalized(colName, fieldSignal);
  return Math.max(jaccard, lev);
}

// === END levenshtein.js ===
