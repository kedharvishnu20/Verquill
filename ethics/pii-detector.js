// === pii-detector.js ===
/**
 * @module pii-detector
 * @description Pre-export and pre-fill PII regex scanner.
 *   Scans data for SSN, credit card, email, and phone patterns.
 *   Returns findings without blocking — the user must confirm.
 *
 *   Design decision: We use regex-only detection (no ML) for determinism
 *   and performance. False positives are acceptable; false negatives are not.
 *   The module NEVER stores or logs the actual PII values, only their type,
 *   field name, and row index.
 *
 * @dependencies logger
 */

import { logger } from "../utils/logger.js";

const MODULE = "pii-detector";

/** @type {Array<{ name: string, pattern: RegExp }>} */
const PII_PATTERNS = [
  {
    name: "SSN",
    pattern: /\b\d{3}-\d{2}-\d{4}\b/,
  },
  {
    name: "CreditCard-Visa",
    pattern: /\b4[0-9]{12}(?:[0-9]{3})?\b/,
  },
  {
    name: "CreditCard-Mastercard",
    pattern: /\b5[1-5][0-9]{14}\b/,
  },
  {
    name: "CreditCard-Amex",
    pattern: /\b3[47][0-9]{13}\b/,
  },
  {
    name: "Email",
    pattern: /[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/i,
  },
  {
    name: "Phone",
    pattern: /\b(\+\d{1,3})?[\s.-]?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/,
  },
];

/**
 * @typedef {Object} PIIFinding
 * @property {string} type      - PII type name (e.g. 'Email')
 * @property {string} field     - Column/field name where found
 * @property {number} rowIndex  - 0-based row index
 */

/**
 * Scan an array of row objects for PII patterns.
 * @param {object[]} rows       - Array of row objects (column → value)
 * @param {number}   [limit=50] - Max findings to collect (stop early)
 * @returns {PIIFinding[]}
 */
export function scanRows(rows, limit = 50) {
  const findings = [];

  outer: for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
    const row = rows[rowIdx];
    for (const [field, value] of Object.entries(row)) {
      if (value == null) continue;
      const str = String(value);
      for (const { name, pattern } of PII_PATTERNS) {
        if (pattern.test(str)) {
          findings.push({ type: name, field, rowIndex: rowIdx });
          logger.warn(MODULE, "pii-found", {
            type: name,
            field,
            rowIndex: rowIdx,
          });
          if (findings.length >= limit) break outer;
        }
      }
    }
  }

  return findings;
}

/**
 * Scan a flat text string (e.g. CSV content) for PII patterns.
 * Faster for pre-loading check before full parse.
 * @param {string} text
 * @returns {Array<{ type: string }>}
 */
export function scanText(text) {
  return PII_PATTERNS.filter(({ pattern }) => pattern.test(text)).map(
    ({ name }) => ({ type: name }),
  );
}

/**
 * Produce a human-readable summary of PII findings.
 * @param {PIIFinding[]} findings
 * @returns {string}
 */
export function summarizeFindings(findings) {
  if (findings.length === 0) return "No PII detected.";
  const byType = {};
  for (const { type } of findings) {
    byType[type] = (byType[type] ?? 0) + 1;
  }
  return Object.entries(byType)
    .map(([t, n]) => `${t}: ${n} occurrence${n !== 1 ? "s" : ""}`)
    .join(", ");
}

// === END pii-detector.js ===
