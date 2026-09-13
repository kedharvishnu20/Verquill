// === idb-schema.js ===
/**
 * @module idb-schema
 * @description Single owner of the `verquill_v3` IndexedDB schema.
 *
 *   Why this module exists: `cursor-store.js` and `row-buffer.js` each used to
 *   call `indexedDB.open(DB_NAME, 1)` with their own `onupgradeneeded` handler.
 *   Only the first opener runs an upgrade, so whichever module happened to open
 *   the database first decided which object stores existed. In practice
 *   `row-buffer.initBuffer()` runs at pipeline start and won that race, creating
 *   the database with `data_rows` only — after which every `cursors` transaction
 *   threw `NotFoundError` and checkpoint/resume silently did nothing.
 *
 *   The schema is now declared once here and both modules share one connection.
 *   Adding a store means adding it to STORES and bumping DB_VERSION; the upgrade
 *   handler is written to be additive so existing databases gain missing stores
 *   without losing data.
 *
 * @dependencies logger
 */

import { logger } from "../utils/logger.js";

const MODULE = "idb-schema";

export const DB_NAME = "verquill_v3";

/**
 * v1 — original schema (inconsistently created; see module docblock).
 * v2 — schema unified here; guarantees `cursors`, `row_buffer` and `data_rows`
 *      all exist regardless of which module opens the database first.
 * v3 — `datasets`, which outlive a run: an EXPORT set to append accumulates
 *      into one named collection so a run per day builds one file.
 * v4 — `ai_cache`: an answer a model already gave, for a page that has not
 *      changed since. The one part of this that costs money is not paid for
 *      twice.
 */
export const DB_VERSION = 4;

export const STORE_CURSORS = "cursors";
export const STORE_ROW_BUFFER = "row_buffer";
export const STORE_DATA_ROWS = "data_rows";
export const STORE_DATASETS = "datasets";
export const STORE_AI_CACHE = "ai_cache";

/**
 * Declarative schema. `upgrade` runs only when the store is created.
 * @type {Array<{ name: string, options: IDBObjectStoreParameters, indexes?: Array<{name:string, keyPath:string, options?:IDBIndexParameters}> }>}
 */
const STORES = [
  {
    name: STORE_CURSORS,
    options: { keyPath: "runId" },
  },
  {
    name: STORE_ROW_BUFFER,
    options: { autoIncrement: true },
  },
  {
    name: STORE_DATA_ROWS,
    options: { autoIncrement: true },
    indexes: [{ name: "runId", keyPath: "runId", options: { unique: false } }],
  },
  {
    // Keyed by dataset name rather than by run: the whole point is that the
    // rows survive the run that produced them.
    name: STORE_DATASETS,
    options: { autoIncrement: true },
    indexes: [
      { name: "dataset", keyPath: "dataset", options: { unique: false } },
    ],
  },
  {
    // Keyed by the fingerprint of the question, so a lookup is a `get` and
    // never a scan. The index is on last use rather than on when the entry was
    // written: eviction has to drop what nobody is asking for, not what was
    // stored longest ago.
    name: STORE_AI_CACHE,
    options: { keyPath: "key" },
    indexes: [
      { name: "lastUsed", keyPath: "lastUsed", options: { unique: false } },
    ],
  },
];

/** @type {Promise<IDBDatabase>|null} Cached connection, shared by all callers. */
let _dbPromise = null;

/**
 * Open (or reuse) the shared database connection.
 *
 * The returned promise is cached, so concurrent callers share one connection
 * and one upgrade transaction. If the connection is closed by a competing
 * upgrade elsewhere, the cache is dropped so the next call reopens.
 *
 * This used to adopt a previous install's database first, because an
 * IndexedDB database is identified by its name and renaming the constant
 * opens a different, empty one. That migration is gone: it was the last place
 * the old project name survived, and carrying a dead brand forward in a
 * string was judged the worse cost. Anything an install collected under the
 * old name is unreachable — export before upgrading, not after.
 *
 * @returns {Promise<IDBDatabase>}
 */
export function openDB() {
  if (_dbPromise) return _dbPromise;

  const attempt = _openCurrent();

  _dbPromise = attempt;
  attempt.catch(() => {
    if (_dbPromise === attempt) _dbPromise = null;
  });
  return attempt;
}

/** Open the current database, creating or upgrading its stores. */
function _openCurrent() {
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      // indexedDB.open can throw synchronously — a browser with storage
      // disabled, a private window, a worker torn down mid-call. That throw
      // never reaches req.onerror, so the cache below would keep handing back a
      // rejected promise for the life of the worker and every later row write,
      // cursor save and read would fail with the original error. Found while
      // testing D-12; recorded as A-10.
      reject(err);
      return;
    }

    req.onupgradeneeded = (event) => {
      const db = req.result;
      logger.info(MODULE, "schema-upgrade", {
        from: event.oldVersion,
        to: event.newVersion,
      });

      for (const store of STORES) {
        if (db.objectStoreNames.contains(store.name)) continue;
        const created = db.createObjectStore(store.name, store.options);
        for (const index of store.indexes ?? []) {
          created.createIndex(index.name, index.keyPath, index.options);
        }
        logger.info(MODULE, "store-created", { store: store.name });
      }
    };

    req.onsuccess = () => {
      const db = req.result;

      // Another context asked for a newer version — release our handle so the
      // upgrade is not blocked, and force the next caller to reopen.
      db.onversionchange = () => {
        logger.warn(MODULE, "versionchange-closing", {});
        db.close();
        _dbPromise = null;
      };

      db.onclose = () => {
        _dbPromise = null;
      };

      resolve(db);
    };

    req.onblocked = () => {
      logger.warn(MODULE, "open-blocked", {
        note: "Another connection is holding an older version open.",
      });
    };

    req.onerror = () => {
      logger.error(MODULE, "open-fail", { error: req.error?.message });
      reject(req.error);
    };
  });
}

/**
 * Run a transaction and resolve once it has actually committed.
 *
 * `fn` receives a map of store name → IDBObjectStore and may return a promise.
 * The transaction's `complete` event — not `fn`'s resolution — settles the
 * returned promise, so writes are durable by the time callers continue.
 *
 * @param {string[]} storeNames
 * @param {'readonly'|'readwrite'} mode
 * @param {(stores: Record<string, IDBObjectStore>) => any} fn
 * @returns {Promise<any>} whatever `fn` resolved to
 */
export async function withStores(storeNames, mode, fn) {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction(storeNames, mode);
    } catch (err) {
      reject(err);
      return;
    }

    let result;
    let failed = false;

    tx.oncomplete = () => {
      if (!failed) resolve(result);
    };
    tx.onerror = () => {
      failed = true;
      reject(tx.error);
    };
    tx.onabort = () => {
      failed = true;
      reject(tx.error ?? new Error("Transaction aborted"));
    };

    const stores = Object.fromEntries(
      storeNames.map((name) => [name, tx.objectStore(name)]),
    );

    Promise.resolve()
      .then(() => fn(stores))
      .then((value) => {
        result = value;
      })
      .catch((err) => {
        failed = true;
        try {
          tx.abort();
        } catch {
          /* already settled */
        }
        reject(err);
      });
  });
}

/**
 * Promisify a single IDBRequest.
 * @param {IDBRequest} req
 * @returns {Promise<any>}
 */
export function requestAsPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// === END idb-schema.js ===
