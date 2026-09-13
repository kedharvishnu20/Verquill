// === session-store.js ===
/**
 * @module session-store
 * @description Where a saved logged-in session is kept, and what keeping it
 *   there does and does not protect.
 *
 *   **Why not the api-key-manager's store.** That one lives in
 *   `chrome.storage.session`, which Chrome empties when the browser closes —
 *   deliberately, because an API key you re-paste is a small cost for a secret
 *   that never survives a reboot. A session is the opposite: the whole value
 *   of saving one is logging in today and scraping tomorrow. A session store
 *   that forgot overnight would be a feature that looks finished and isn't,
 *   which is the failure mode this project has spent the most effort removing.
 *   So this store persists, and pays for it with a weaker threat model.
 *
 *   **What the encryption is worth, honestly.** Values are AES-GCM encrypted
 *   with a key in `chrome.storage.local`, next to the ciphertext. Anyone who
 *   can read the profile directory can read both, so this is not protection
 *   against someone with your disk — it is protection against a saved session
 *   sitting in plain text where anything that glances at extension storage,
 *   or a pipeline exported and shared, would carry it out with it. Cookies
 *   never enter a pipeline's JSON: only the session's *name* does, and the
 *   values stay here. The doc says the same thing in the same words.
 *
 *   **Metadata is not encrypted**, on purpose: the panel lists what is saved,
 *   for which origin, and when, without decrypting anything or holding a
 *   session's cookies in memory to render a list.
 *
 * @dependencies logger
 */

import { logger } from "../utils/logger.js";

const MODULE = "session-store";

const KEY_INDEX = "vq_sessions_index"; // name -> metadata, plaintext
const KEY_BLOBS = "vq_sessions_enc"; // name -> ciphertext
const KEY_SK = "vq_sessions_key"; // the AES key, as JWK

/** Enough for anyone's saved logins; a bound so this cannot grow forever. */
const MAX_SESSIONS = 50;

/** @type {CryptoKey|null} */
let _key = null;
/** @type {Promise<CryptoKey>|null} */
let _keyInit = null;

/**
 * Load the store's key, minting one on first use.
 *
 * De-duped the way api-key-manager's is: two steps saving at once must not
 * generate two keys, or the first save becomes undecryptable.
 *
 * @returns {Promise<CryptoKey>}
 */
async function _ensureKey() {
  if (_key) return _key;
  if (_keyInit) return _keyInit;

  _keyInit = (async () => {
    const stored = await chrome.storage.local.get([KEY_SK]);
    const jwk = stored?.[KEY_SK];
    if (jwk) {
      try {
        _key = await crypto.subtle.importKey(
          "jwk",
          jwk,
          { name: "AES-GCM", length: 256 },
          true,
          ["encrypt", "decrypt"],
        );
        return _key;
      } catch (err) {
        // A key that will not import cannot decrypt what it wrote. Drop the
        // blobs with it rather than leaving sessions that fail one by one at
        // restore time, where the message would be far less clear.
        logger.error(MODULE, "key-import-fail", { error: err.message });
        await chrome.storage.local.remove([KEY_SK, KEY_BLOBS, KEY_INDEX]);
      }
    }
    const key = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"],
    );
    await chrome.storage.local.set({
      [KEY_SK]: await crypto.subtle.exportKey("jwk", key),
    });
    _key = key;
    logger.info(MODULE, "key-created", {});
    return key;
  })().finally(() => {
    _keyInit = null;
  });

  return _keyInit;
}

const _b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const _unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function _encrypt(value) {
  const key = await _ensureKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const buf = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return JSON.stringify({ iv: _b64(iv), ct: _b64(buf) });
}

async function _decrypt(blob) {
  const key = await _ensureKey();
  const { iv, ct } = JSON.parse(blob);
  const buf = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: _unb64(iv) },
    key,
    _unb64(ct),
  );
  return JSON.parse(new TextDecoder().decode(buf));
}

async function _read(area) {
  const items = await chrome.storage.local.get([area]);
  return items?.[area] ?? {};
}

/**
 * Save a session under a name, replacing any session already using it.
 *
 * @param {string} name
 * @param {object} record - { origin, cookies, localStorage, sessionStorage, cookieSource }
 * @returns {Promise<object>} the metadata now listed for it
 */
export async function saveSession(name, record) {
  const key = String(name || "").trim();
  if (!key) throw new Error("A saved session needs a name.");

  const index = await _read(KEY_INDEX);
  if (!(key in index) && Object.keys(index).length >= MAX_SESSIONS) {
    throw new Error(
      `${MAX_SESSIONS} saved sessions is the limit. Delete one in Settings → Sessions first.`,
    );
  }

  const meta = {
    name: key,
    origin: record.origin || "",
    savedAt: Date.now(),
    cookieCount: (record.cookies || []).length,
    // Which of the two ways the cookies were read. A restore that fails is
    // almost always a "document.cookie" save missing the HttpOnly session
    // cookie, and this is what lets the message say so instead of guessing.
    cookieSource: record.cookieSource || "document.cookie",
    localCount: Object.keys(record.localStorage || {}).length,
    sessionCount: Object.keys(record.sessionStorage || {}).length,
  };

  const blobs = await _read(KEY_BLOBS);
  blobs[key] = await _encrypt(record);
  index[key] = meta;
  await chrome.storage.local.set({ [KEY_BLOBS]: blobs, [KEY_INDEX]: index });
  logger.info(MODULE, "saved", {
    name: key,
    origin: meta.origin,
    cookies: meta.cookieCount,
    source: meta.cookieSource,
  });
  return meta;
}

/**
 * Read a saved session back, or null if there is none under that name.
 *
 * @param {string} name
 * @returns {Promise<object|null>}
 */
export async function loadSession(name) {
  const key = String(name || "").trim();
  const blobs = await _read(KEY_BLOBS);
  const blob = blobs[key];
  if (!blob) return null;
  try {
    return await _decrypt(blob);
  } catch (err) {
    logger.error(MODULE, "decrypt-fail", { name: key, error: err.message });
    throw new Error(
      `The saved session "${key}" could not be read back. Save it again.`,
    );
  }
}

/** Metadata for every saved session, newest first. Decrypts nothing. */
export async function listSessions() {
  const index = await _read(KEY_INDEX);
  return Object.values(index).sort(
    (a, b) => (b.savedAt || 0) - (a.savedAt || 0),
  );
}

/**
 * Forget a saved session.
 * @param {string} name
 * @returns {Promise<boolean>} whether there was one to forget
 */
export async function deleteSession(name) {
  const key = String(name || "").trim();
  const index = await _read(KEY_INDEX);
  const blobs = await _read(KEY_BLOBS);
  const existed = key in index || key in blobs;
  delete index[key];
  delete blobs[key];
  await chrome.storage.local.set({ [KEY_BLOBS]: blobs, [KEY_INDEX]: index });
  if (existed) logger.info(MODULE, "deleted", { name: key });
  return existed;
}

// === END session-store.js ===
