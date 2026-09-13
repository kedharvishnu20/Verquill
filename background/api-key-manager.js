// === api-key-manager.js ===
/**
 * @module api-key-manager
 * @description AES-GCM 256-bit encrypted API key storage for third-party
 *   providers (captcha solvers, data enrichment, notifications).
 *
 *   Lifetime: keys survive service-worker restarts but not browser restarts.
 *   Both the wrapped AES key and the ciphertexts live in
 *   chrome.storage.session, which Chrome clears when the browser closes.
 *
 *   Why the key is stored rather than held in module scope: MV3 terminates an
 *   idle service worker after ~30s and does NOT re-fire `activate` when it
 *   wakes it again. A module-scope-only key is therefore gone on the next
 *   wake, and regenerating one silently turns every stored ciphertext into
 *   garbage — which is exactly what used to happen here, a minute after the
 *   user saved a key. There is no MV3 mechanism for a key that both outlives
 *   worker termination and is never written down, so the key is persisted to
 *   the same session-scoped, memory-backed area as the data.
 *
 *   What that encryption is and is not worth: chrome.storage.session is
 *   already restricted to trusted extension contexts, and the key sits beside
 *   the ciphertext. This is defence in depth against incidental exposure — a
 *   storage dump, a casual devtools read, a sync bug that ships the wrong area
 *   somewhere — not protection against an attacker who can already read the
 *   extension's storage. Do not describe it as more than that.
 *
 *   Validation calls check the minimum required endpoint for each provider.
 *   On network failure, returns { valid: null, error: 'network' } to distinguish
 *   from an actually invalid key.
 *
 * @dependencies logger
 */

import { logger } from "../utils/logger.js";

const MODULE = "api-key-manager";

// Storage keys (both session-scoped; Chrome clears them on browser close)
const SESSION_KEY_KEYS = "vq_api_keys_enc"; // ciphertext map, provider -> blob
const SESSION_KEY_SK = "vq_session_key"; // wrapped AES key (JWK)

// ── AES-GCM session key ───────────────────────────────────────────────────────
/** @type {CryptoKey|null} In-memory handle; rehydrated from storage on demand. */
let _sessionCryptoKey = null;
/** @type {Promise<CryptoKey>|null} De-dupes concurrent initialisation. */
let _keyInitPromise = null;

/**
 * Load the existing session key, or mint one if this is a fresh browser
 * session. Safe to call repeatedly and concurrently: the same key is returned
 * every time within a browser session, so previously stored ciphertexts stay
 * readable across service-worker restarts.
 *
 * @returns {Promise<CryptoKey>}
 */
export async function initSessionKey() {
  if (_sessionCryptoKey) return _sessionCryptoKey;
  if (_keyInitPromise) return _keyInitPromise;

  _keyInitPromise = (async () => {
    const stored = await chrome.storage.session.get([SESSION_KEY_SK]);
    const jwk = stored?.[SESSION_KEY_SK];

    if (jwk) {
      try {
        _sessionCryptoKey = await crypto.subtle.importKey(
          "jwk",
          jwk,
          { name: "AES-GCM", length: 256 },
          true,
          ["encrypt", "decrypt"],
        );
        logger.info(MODULE, "session-key-restored", {});
        return _sessionCryptoKey;
      } catch (err) {
        // A key we cannot import cannot decrypt anything either. Clear both
        // halves rather than leaving undecryptable blobs behind.
        logger.error(MODULE, "session-key-import-fail", { error: err.message });
        await chrome.storage.session.remove([SESSION_KEY_SK, SESSION_KEY_KEYS]);
      }
    }

    const key = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      true, // extractable so it can be persisted for the session
      ["encrypt", "decrypt"],
    );
    const exported = await crypto.subtle.exportKey("jwk", key);
    await chrome.storage.session.set({ [SESSION_KEY_SK]: exported });

    _sessionCryptoKey = key;
    logger.info(MODULE, "session-key-created", {});
    return key;
  })().finally(() => {
    _keyInitPromise = null;
  });

  return _keyInitPromise;
}

/**
 * Ensure the session key is available before an encrypt/decrypt call.
 * Never mints a replacement for a key that already has ciphertexts — that is
 * what initSessionKey's storage lookup is for.
 */
async function _ensureKey() {
  if (!_sessionCryptoKey) await initSessionKey();
}

// ── Encryption helpers ────────────────────────────────────────────────────────

/**
 * Encrypt a plaintext string with AES-GCM.
 * Returns base64url-encoded { iv, ciphertext } JSON.
 * @param {string} plaintext
 * @returns {Promise<string>}
 */
async function _encrypt(plaintext) {
  await _ensureKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder();
  const buf = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    _sessionCryptoKey,
    enc.encode(plaintext),
  );
  const b64 = (v) => btoa(String.fromCharCode(...new Uint8Array(v)));
  return JSON.stringify({ iv: b64(iv), ct: b64(buf) });
}

/**
 * Decrypt a previously encrypted blob.
 * @param {string} blob - JSON string from _encrypt()
 * @returns {Promise<string>}
 */
async function _decrypt(blob) {
  await _ensureKey();
  const { iv: ivB64, ct: ctB64 } = JSON.parse(blob);
  const dec = (v) => Uint8Array.from(atob(v), (c) => c.charCodeAt(0));
  const buf = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: dec(ivB64) },
    _sessionCryptoKey,
    dec(ctB64),
  );
  return new TextDecoder().decode(buf);
}

// ── Key storage ───────────────────────────────────────────────────────────────

/**
 * Load encrypted key map from session storage.
 * @returns {Promise<Map<string, string>>} provider → encrypted blob
 */
async function _loadEncMap() {
  const items = await chrome.storage.session.get([SESSION_KEY_KEYS]);
  const raw = items[SESSION_KEY_KEYS] ?? {};
  return new Map(Object.entries(raw));
}

/**
 * Save encrypted key map to session storage.
 * @param {Map<string, string>} map
 */
async function _saveEncMap(map) {
  await chrome.storage.session.set({
    [SESSION_KEY_KEYS]: Object.fromEntries(map),
  });
}

/**
 * Store an API key for a provider (encrypts before storing).
 * @param {string} provider - e.g. '2captcha', 'openai'
 * @param {string} keyValue
 */
export async function setApiKey(provider, keyValue) {
  if (!provider || !keyValue)
    throw new Error("provider and keyValue are required");
  const blob = await _encrypt(keyValue);
  const map = await _loadEncMap();
  map.set(provider, blob);
  await _saveEncMap(map);
  logger.info(MODULE, "key-stored", { provider });
  // NEVER log keyValue
}

/**
 * Retrieve and decrypt an API key.
 * @param {string} provider
 * @returns {Promise<string|null>}
 */
export async function getApiKey(provider) {
  const map = await _loadEncMap();
  const blob = map.get(provider);
  if (!blob) return null;
  try {
    return await _decrypt(blob);
  } catch (err) {
    // The blob cannot be recovered — the key that wrote it is gone. Drop it so
    // listProviders/hasApiKey stop reporting a key the user does not have, and
    // the UI can prompt for re-entry instead of failing on every use.
    logger.error(MODULE, "key-decrypt-fail", { provider, error: err.message });
    await removeApiKey(provider).catch(() => {});
    return null;
  }
}

/**
 * Remove an API key.
 * @param {string} provider
 */
export async function removeApiKey(provider) {
  const map = await _loadEncMap();
  map.delete(provider);
  await _saveEncMap(map);
  logger.info(MODULE, "key-removed", { provider });
}

/**
 * List stored providers (names only — no key values).
 * @returns {Promise<string[]>}
 */
export async function listProviders() {
  const map = await _loadEncMap();
  return [...map.keys()];
}

/**
 * Check if a key is stored for a provider.
 * @param {string} provider
 * @returns {Promise<boolean>}
 */
export async function hasApiKey(provider) {
  const map = await _loadEncMap();
  return map.has(provider);
}

// ── Key validation ────────────────────────────────────────────────────────────

/**
 * @typedef {Object} ValidationResult
 * @property {boolean|null} valid   - true=valid, false=invalid, null=network error
 * @property {number}  [balance]
 * @property {number}  [quotaRemaining]
 * @property {string}  [error]
 */

/**
 * Validate the stored key for a given provider.
 * @param {string} provider
 * @returns {Promise<ValidationResult>}
 */
export async function validateApiKey(provider) {
  const key = await getApiKey(provider);
  if (!key) return { valid: false, error: "No key stored" };

  const validators = {
    "2captcha": () => _validate2captcha(key),
    anticaptcha: () => _validateAnticaptcha(key),
    capsolver: () => _validateCapsolver(key),
    hunter: () => _validateHunter(key),
    openai: () => _validateOpenAI(key),
    gemini: () => _validateGemini(key),
  };

  const fn = validators[provider.toLowerCase()];
  if (!fn) {
    logger.warn(MODULE, "no-validator", { provider });
    return { valid: null, error: "No validator for this provider" };
  }

  try {
    const result = await fn();
    logger.info(MODULE, "key-validated", { provider, valid: result.valid });
    return result;
  } catch (err) {
    if (err.name === "AbortError" || err.message?.includes("Failed to fetch")) {
      logger.warn(MODULE, "validation-network-fail", { provider });
      return { valid: null, error: "network" };
    }
    logger.error(MODULE, "validation-error", { provider, error: err.message });
    return { valid: false, error: err.message };
  }
}

async function _validate2captcha(key) {
  const url = `https://2captcha.com/res.php?action=getbalance&key=${encodeURIComponent(key)}`;
  const res = await _timedFetch(url);
  const text = await res.text();
  const bal = parseFloat(text);
  if (text.startsWith("ERROR_")) return { valid: false, error: text };
  return { valid: !isNaN(bal), balance: bal };
}

async function _validateAnticaptcha(key) {
  const res = await _timedFetch("https://api.anti-captcha.com/getBalance", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientKey: key }),
  });
  const json = await res.json();
  if (json.errorId !== 0) return { valid: false, error: json.errorDescription };
  return { valid: true, balance: json.balance };
}

async function _validateCapsolver(key) {
  const res = await _timedFetch("https://api.capsolver.com/getBalance", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientKey: key }),
  });
  const json = await res.json();
  if (json.errorId) return { valid: false, error: json.errorDescription };
  return { valid: true, balance: json.balance };
}

async function _validateHunter(key) {
  const url = `https://api.hunter.io/v2/account?api_key=${encodeURIComponent(key)}`;
  const res = await _timedFetch(url);
  const json = await res.json();
  if (json.errors) return { valid: false, error: json.errors[0]?.details };
  const searches = json.data?.requests?.searches;
  return {
    valid: true,
    quotaRemaining: searches ? searches.available - searches.used : undefined,
  };
}

async function _validateOpenAI(key) {
  const res = await _timedFetch("https://api.openai.com/v1/models", {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (res.status === 401) return { valid: false, error: "Invalid API key" };
  if (!res.ok) return { valid: false, error: `HTTP ${res.status}` };
  return { valid: true };
}

async function _validateGemini(key) {
  // Use the Gemini models list endpoint — lightweight validation call.
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}&pageSize=1`;
  const res = await _timedFetch(url);
  if (res.status === 400) {
    const json = await res.json().catch(() => ({}));
    const msg = json?.error?.message || "Invalid API key";
    return { valid: false, error: msg };
  }
  if (res.status === 403 || res.status === 401)
    return { valid: false, error: "Invalid or unauthorized Gemini API key" };
  if (!res.ok) return { valid: false, error: `HTTP ${res.status}` };
  return { valid: true };
}

/**
 * Fetch with a 10-second timeout.
 */
async function _timedFetch(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10_000);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// ── Captcha ethics gate ───────────────────────────────────────────────────────

/**
 * Check all captcha ethics gates before dispatch.
 * @param {{
 *   authorized: boolean,
 *   robotsAllows: boolean,
 *   estimatedSolvesPerHr: number,
 *   recipeEnabled: boolean
 * }} flags
 * @returns {{ allowed: boolean, reason?: string }}
 */
export function checkCaptchaGates(flags) {
  if (!flags.recipeEnabled)
    return { allowed: false, reason: "Recipe captchaEnabled=false" };
  if (!flags.authorized)
    return {
      allowed: false,
      reason: "User has not authorized automation for this site",
    };
  if (!flags.robotsAllows)
    return { allowed: false, reason: "robots.txt disallows this path" };
  if (flags.estimatedSolvesPerHr > 50) {
    return {
      allowed: false,
      reason: `Estimated solves/hr (${flags.estimatedSolvesPerHr}) exceeds limit of 50`,
    };
  }
  return { allowed: true };
}

// ── Captcha dispatcher ────────────────────────────────────────────────────────
//
// NOT REACHABLE, and no longer for the reason this comment used to give.
// Detection is live — content/captcha-check.js finds a challenge and
// SOLVE_CAPTCHA acts on it — but it answers through the free tier and, failing
// that, your own vision model. This paid-provider dispatcher is exposed through
// the captcha:solve message and nothing sends it. See docs/ISSUE_AUDIT.md A-06
// and K-14/K-17.

/**
 * Dispatch a captcha solve request to the configured provider.
 * Provider is selected by priority: 2captcha → anticaptcha → capsolver.
 * Returns the solution token, or throws if blocked by ethics gate.
 *
 * @param {{
 *   type: 'recaptcha-v2'|'recaptcha-v3'|'hcaptcha'|'turnstile'|'image',
 *   sitekey?: string,
 *   pageUrl: string,
 *   imageBase64?: string,
 *   gates: object
 * }} params
 * @returns {Promise<string>} solution token
 */
export async function solveCaptcha(params) {
  // Ethics gate enforced here, not just in UI
  const gateResult = checkCaptchaGates(params.gates ?? {});
  if (!gateResult.allowed) {
    logger.error(MODULE, "captcha-gate-block", { reason: gateResult.reason });
    throw Object.assign(new Error(`CaptchaGateBlocked: ${gateResult.reason}`), {
      code: "ETHICS_BLOCK",
    });
  }

  // Find first available provider in order of preference
  const providers = ["2captcha", "anticaptcha", "capsolver"];
  for (const provider of providers) {
    const key = await getApiKey(provider);
    if (!key) continue;
    try {
      const token = await _dispatchSolve(provider, key, params);
      logger.info(MODULE, "captcha-solved", { provider, type: params.type });
      return token;
    } catch (err) {
      logger.warn(MODULE, "captcha-provider-fail", {
        provider,
        error: err.message,
      });
    }
  }

  throw new Error("No captcha provider available or all failed");
}

async function _dispatchSolve(
  provider,
  key,
  { type, sitekey, pageUrl, imageBase64 },
) {
  if (provider === "2captcha") {
    return _solve2captcha(key, { type, sitekey, pageUrl, imageBase64 });
  }
  if (provider === "anticaptcha") {
    return _solveAnticaptcha(key, { type, sitekey, pageUrl });
  }
  if (provider === "capsolver") {
    return _solveCapsolver(key, { type, sitekey, pageUrl });
  }
  throw new Error(`Unknown provider: ${provider}`);
}

async function _solve2captcha(key, { type, sitekey, pageUrl, imageBase64 }) {
  let submitUrl, submitBody;
  if (type === "image") {
    submitUrl = "https://2captcha.com/in.php";
    submitBody = `key=${key}&method=base64&body=${encodeURIComponent(imageBase64)}&json=1`;
  } else {
    const method = type === "hcaptcha" ? "hcaptcha" : "userrecaptcha";
    submitUrl = "https://2captcha.com/in.php";
    submitBody = `key=${key}&method=${method}&googlekey=${sitekey}&pageurl=${encodeURIComponent(pageUrl)}&json=1`;
  }

  const submitRes = await _timedFetch(submitUrl, {
    method: "POST",
    body: new URLSearchParams(submitBody),
  });
  const submitJson = await submitRes.json();
  if (!submitJson.status)
    throw new Error(submitJson.request ?? "Submit failed");

  const captchaId = submitJson.request;
  return _poll2captcha(key, captchaId);
}

async function _poll2captcha(key, captchaId) {
  for (let attempt = 0; attempt <= POLL_MAX_ATTEMPTS; attempt++) {
    await _sleep(POLL_INTERVAL_MS);
    const res = await _timedFetch(
      `https://2captcha.com/res.php?key=${key}&action=get&id=${captchaId}&json=1`,
    );
    const json = await res.json();
    if (json.status === 0 && json.request === "CAPCHA_NOT_READY") continue;
    if (!json.status) throw new Error(json.request ?? "Poll failed");
    return json.request;
  }
  throw new Error(POLL_TIMEOUT_MESSAGE("2captcha"));
}

async function _solveAnticaptcha(key, { type, sitekey, pageUrl }) {
  const taskType =
    type === "hcaptcha" ? "HCaptchaTaskProxyless" : "NoCaptchaTaskProxyless";
  const res = await _timedFetch("https://api.anti-captcha.com/createTask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientKey: key,
      task: { type: taskType, websiteURL: pageUrl, websiteKey: sitekey },
    }),
  });
  const json = await res.json();
  if (json.errorId) throw new Error(json.errorDescription);
  return _pollAnticaptcha(key, json.taskId);
}

async function _pollAnticaptcha(key, taskId) {
  for (let attempt = 0; attempt <= POLL_MAX_ATTEMPTS; attempt++) {
    await _sleep(POLL_INTERVAL_MS);
    const res = await _timedFetch(
      "https://api.anti-captcha.com/getTaskResult",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientKey: key, taskId }),
      },
    );
    const json = await res.json();
    if (json.status === "processing") continue;
    if (json.errorId) throw new Error(json.errorDescription);
    return json.solution?.gRecaptchaResponse ?? json.solution?.token;
  }
  throw new Error(POLL_TIMEOUT_MESSAGE("Anti-Captcha"));
}

async function _solveCapsolver(key, { type, sitekey, pageUrl }) {
  const taskType =
    type === "turnstile"
      ? "AntiTurnstileTaskProxyless"
      : "ReCaptchaV2TaskProxyless";
  const res = await _timedFetch("https://api.capsolver.com/createTask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientKey: key,
      task: { type: taskType, websiteURL: pageUrl, websiteKey: sitekey },
    }),
  });
  const json = await res.json();
  if (json.errorId) throw new Error(json.errorDescription);
  return _pollCapsolver(key, json.taskId);
}

async function _pollCapsolver(key, taskId) {
  for (let attempt = 0; attempt <= POLL_MAX_ATTEMPTS; attempt++) {
    await _sleep(POLL_INTERVAL_MS);
    const res = await _timedFetch("https://api.capsolver.com/getTaskResult", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: key, taskId }),
    });
    const json = await res.json();
    if (json.status === "processing") continue;
    if (json.errorId) throw new Error(json.errorDescription);
    return json.solution?.gRecaptchaResponse ?? json.solution?.token;
  }
  throw new Error(POLL_TIMEOUT_MESSAGE("Capsolver"));
}

/**
 * Captcha solve polling.
 *
 * The three pollers recursed once per attempt, building 25 nested await frames
 * per solve, and their `attempts > 24` budget was an undocumented two-minute
 * hang with a message that did not say how long it had waited (audit B-33).
 * They loop now, and the timeout says what it means.
 */
const POLL_INTERVAL_MS = 5000;
const POLL_MAX_ATTEMPTS = 24;
const POLL_TIMEOUT_MESSAGE = (service) =>
  `${service} did not return a solution within ` +
  `${Math.round((POLL_INTERVAL_MS * (POLL_MAX_ATTEMPTS + 1)) / 1000)}s.`;

function _sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// === END api-key-manager.js ===
