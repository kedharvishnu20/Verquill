// === dataset-store.js ===
/**
 * @module dataset-store
 * @description Rows that outlive the run that produced them.
 *
 *   "A run per day into one dataset" was the gap. Every export wrote its own
 *   file, so thirty days of scraping was thirty files to stitch together by
 *   hand — and stitching them is where the duplicates and the mismatched
 *   columns come from.
 *
 *   **Why a store rather than an append.** An extension cannot append to a
 *   file. `chrome.downloads` writes; it has no read access to the Downloads
 *   folder, so yesterday's file is not something this can open, parse and add
 *   to. What it can do is remember the rows and write the whole set out again
 *   under the same name. The file grows a run at a time, which is what was
 *   wanted; the mechanism underneath is a rewrite, and saying so matters
 *   because it explains the one thing a real append would not do — the file
 *   is replaced, so anything edited into it by hand is lost.
 *
 *   A side effect worth having: because the file is rendered from rows every
 *   time, the header is always right. A literal append cannot add a column to
 *   a CSV that is already written, so a page that gains a field mid-week
 *   silently drops it. Here it does not.
 *
 * @dependencies checkpoint/idb-schema.js, utils/logger.js
 */

import { withStores, requestAsPromise, STORE_DATASETS } from "./idb-schema.js";
import { logger } from "../utils/logger.js";

const MODULE = "dataset-store";

/**
 * Where one dataset stops growing.
 *
 * Not arbitrary: a single download is capped at 64 MB, and a dataset that
 * cannot be written is worse than one that stopped accepting rows and said so.
 * At a few hundred bytes a row this leaves plenty of headroom.
 */
export const MAX_DATASET_ROWS = 200000;

/**
 * A dataset name, made safe to use as one.
 *
 * It ends up in a filename, so it goes through the same shape of allowlist the
 * download path uses. Empty means "the default dataset" rather than an error:
 * a user who ticks "append" and types nothing still gets the behaviour they
 * asked for.
 *
 * @param {unknown} name
 * @returns {string}
 */
export function datasetName(name) {
  const clean = String(name ?? "")
    .replace(/[^\p{L}\p{N} ._-]/gu, "_")
    .replace(/^[.\s]+/, "")
    .replace(/[.\s]+$/, "")
    .slice(0, 60)
    .trim();
  return clean || "default";
}

/**
 * Add rows to a dataset.
 *
 * @param {string} name
 * @param {object[]} rows
 * @returns {Promise<{added: number, total: number, dropped: number}>}
 */
export async function appendRows(name, rows) {
  const dataset = datasetName(name);
  const incoming = Array.isArray(rows) ? rows : [];
  if (incoming.length === 0) {
    return { added: 0, total: await countRows(dataset), dropped: 0 };
  }

  const existing = await countRows(dataset);
  const room = Math.max(0, MAX_DATASET_ROWS - existing);
  const toWrite = incoming.slice(0, room);
  const dropped = incoming.length - toWrite.length;

  if (toWrite.length > 0) {
    await withStores(
      [STORE_DATASETS],
      "readwrite",
      ({ [STORE_DATASETS]: s }) => {
        for (const row of toWrite) s.add({ dataset, row });
      },
    );
  }

  if (dropped > 0) {
    logger.warn(MODULE, "dataset-full", { dataset, dropped });
  }
  return { added: toWrite.length, total: existing + toWrite.length, dropped };
}

/**
 * Every row in a dataset, oldest first.
 *
 * Insertion order is the auto-increment key's order, which is the order the
 * runs happened — so the file reads as a history rather than as a shuffle.
 *
 * @param {string} name
 * @returns {Promise<object[]>}
 */
export async function readDataset(name) {
  const dataset = datasetName(name);
  const records = await withStores(
    [STORE_DATASETS],
    "readonly",
    ({ [STORE_DATASETS]: s }) =>
      requestAsPromise(s.index("dataset").getAll(IDBKeyRange.only(dataset))),
  );
  return (records ?? []).map((r) => r.row);
}

/** @param {string} name @returns {Promise<number>} */
export async function countRows(name) {
  const dataset = datasetName(name);
  const n = await withStores(
    [STORE_DATASETS],
    "readonly",
    ({ [STORE_DATASETS]: s }) =>
      requestAsPromise(s.index("dataset").count(IDBKeyRange.only(dataset))),
  );
  return n ?? 0;
}

/**
 * Forget a dataset. Starting the collection again is a thing people do.
 * @param {string} name
 * @returns {Promise<number>} how many rows were removed
 */
export async function clearDataset(name) {
  const dataset = datasetName(name);
  return withStores(
    [STORE_DATASETS],
    "readwrite",
    ({ [STORE_DATASETS]: s }) => {
      return new Promise((resolve, reject) => {
        let removed = 0;
        const req = s.index("dataset").openKeyCursor(IDBKeyRange.only(dataset));
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) {
            resolve(removed);
            return;
          }
          s.delete(cursor.primaryKey);
          removed++;
          cursor.continue();
        };
        req.onerror = () => reject(req.error);
      });
    },
  );
}

// === END dataset-store.js ===
