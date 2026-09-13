// Regression tests for audit finding A-04.
//
// The AES-GCM key lived only in module scope and was re-created solely from the
// service worker's `activate` listener. MV3 tears an idle worker down after
// ~30s and does not re-fire `activate` when it wakes it, so _ensureKey() minted
// a fresh key and every stored ciphertext decrypted to garbage. getApiKey()
// swallowed the failure and returned null — a key saved a minute earlier was
// silently gone.
//
// A worker restart is simulated by re-importing the module under a new query
// string (fresh module scope) while keeping chrome.storage.session contents,
// which is exactly what Chrome does.
import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

if (!globalThis.crypto?.subtle) globalThis.crypto = webcrypto;

const MODULE = new URL("../background/api-key-manager.js", import.meta.url)
  .href;

const sessionArea = new Map();

function area(map) {
  return {
    async get(keys) {
      const out = {};
      for (const k of Array.isArray(keys) ? keys : [keys]) {
        if (map.has(k)) out[k] = map.get(k);
      }
      return out;
    },
    async set(obj) {
      for (const [k, v] of Object.entries(obj)) map.set(k, v);
    },
    async remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) map.delete(k);
    },
  };
}

globalThis.chrome = {
  storage: { session: area(sessionArea), local: area(new Map()) },
};

let generation = 0;
/** Simulate the worker being torn down and woken: new module scope, same storage. */
const restartWorker = () => import(`${MODULE}?gen=${++generation}`);

test("keys are readable within one worker generation", async () => {
  const km = await restartWorker();
  await km.initSessionKey();
  await km.setApiKey("gemini", "AIzaSy-REAL-KEY-123");
  await km.setApiKey("2captcha", "abc123def456");

  assert.equal(await km.getApiKey("gemini"), "AIzaSy-REAL-KEY-123");
  assert.equal(await km.getApiKey("2captcha"), "abc123def456");
});

test("stored blobs are not the plaintext", () => {
  const dump = JSON.stringify([...sessionArea.values()]);
  assert.ok(
    !dump.includes("AIzaSy-REAL-KEY-123"),
    "key value must not be stored in the clear",
  );
});

test("keys survive a service-worker restart", async () => {
  const km = await restartWorker();
  assert.equal(
    await km.getApiKey("gemini"),
    "AIzaSy-REAL-KEY-123",
    "this is the exact failure: a fresh module scope used to mint a new key",
  );
  assert.equal(await km.getApiKey("2captcha"), "abc123def456");
  assert.deepEqual((await km.listProviders()).sort(), ["2captcha", "gemini"]);
});

test("repeated restarts do not mint a replacement key", async () => {
  const km = await restartWorker();
  await km.initSessionKey();
  assert.equal(await km.getApiKey("gemini"), "AIzaSy-REAL-KEY-123");
  assert.ok(sessionArea.has("vq_session_key"));
});

test("concurrent initSessionKey calls share one key", async () => {
  const km = await restartWorker();
  const [a, b, c] = await Promise.all([
    km.initSessionKey(),
    km.initSessionKey(),
    km.initSessionKey(),
  ]);
  assert.equal(a, b);
  assert.equal(b, c);
  assert.equal(await km.getApiKey("gemini"), "AIzaSy-REAL-KEY-123");
});

test("closing the browser clears keys rather than corrupting them", async () => {
  sessionArea.clear(); // what Chrome does to storage.session on browser close
  const km = await restartWorker();

  assert.equal(await km.getApiKey("gemini"), null);
  assert.deepEqual(await km.listProviders(), []);

  await km.setApiKey("gemini", "NEW-SESSION-KEY");
  assert.equal(await km.getApiKey("gemini"), "NEW-SESSION-KEY");
});

test("an undecryptable blob is dropped, not reported as a stored key", async () => {
  sessionArea.set("vq_api_keys_enc", {
    ...sessionArea.get("vq_api_keys_enc"),
    openai: JSON.stringify({
      iv: "AAAAAAAAAAAAAAAA",
      ct: "AAAAAAAAAAAAAAAAAAAAAAAA",
    }),
  });

  const km = await restartWorker();
  assert.equal(await km.getApiKey("openai"), null);
  assert.equal(
    await km.hasApiKey("openai"),
    false,
    "stops advertising a key the user does not have",
  );
  assert.equal(
    await km.getApiKey("gemini"),
    "NEW-SESSION-KEY",
    "good keys are untouched",
  );
});
