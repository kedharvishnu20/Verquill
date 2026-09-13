// SESSION — save a logged-in session once, restore it on every later run.
//
// The session lives in two places the extension reaches separately: the cookie
// jar, which only the worker can read in full, and the page's own
// localStorage/sessionStorage, which only the page can see. The tests below
// cover both halves and the store between them.
//
// The failure this feature has to avoid is the quiet one: a session saved
// without the `cookies` permission is missing the HttpOnly session cookie —
// which is what a session cookie almost always is — so it restores as a
// logged-out session and the run scrapes a login page. The store records which
// of the two ways the cookies were read, so the message can say so.
import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { JSDOM } from "jsdom";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

if (!globalThis.crypto?.subtle) globalThis.crypto = webcrypto;

const STORE = new URL("../background/session-store.js", import.meta.url).href;
const localArea = new Map();

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
  storage: { local: area(localArea), session: area(new Map()) },
};

let generation = 0;
/** A saved session must survive the worker being torn down — and a reboot. */
const restartWorker = () => import(`${STORE}?gen=${++generation}`);

const RECORD = {
  origin: "https://shop.test",
  cookies: [
    {
      name: "sid",
      value: "SECRET-SESSION",
      domain: "shop.test",
      httpOnly: true,
    },
  ],
  cookieSource: "chrome.cookies",
  localStorage: { token: "abc" },
  sessionStorage: {},
};

// ── The store ────────────────────────────────────────────────────────────────

test("a saved session survives a worker restart", async () => {
  const first = await restartWorker();
  await first.saveSession("shop", RECORD);

  // New module scope, same storage: exactly what Chrome does to an idle worker.
  const second = await restartWorker();
  const back = await second.loadSession("shop");
  assert.equal(back.cookies[0].value, "SECRET-SESSION");
  assert.equal(back.localStorage.token, "abc");
});

test("the key persists in local storage, not session storage", async () => {
  // chrome.storage.session is emptied when the browser closes. A session store
  // that forgot overnight would defeat the purpose of saving one.
  assert.ok(localArea.has("vq_sessions_key"));
});

test("what is stored is not the plaintext", () => {
  const raw = JSON.stringify(localArea.get("vq_sessions_enc"));
  assert.ok(!raw.includes("SECRET-SESSION"));
  assert.ok(!raw.includes("abc"));
});

test("the listing says how the cookies were read, without decrypting", async () => {
  const store = await restartWorker();
  await store.saveSession("partial", {
    origin: "https://other.test",
    cookies: [{ name: "a", value: "1" }],
    cookieSource: "document.cookie",
  });
  const list = await store.listSessions();
  const partial = list.find((s) => s.name === "partial");
  assert.equal(partial.cookieSource, "document.cookie");
  assert.equal(partial.cookieCount, 1);
  assert.equal(partial.origin, "https://other.test");
  // Plaintext metadata only — no values in the index.
  assert.ok(
    !JSON.stringify(localArea.get("vq_sessions_index")).includes('"1"'),
  );
});

test("forgetting a session removes both halves", async () => {
  const store = await restartWorker();
  assert.equal(await store.deleteSession("partial"), true);
  assert.equal(await store.deleteSession("partial"), false);
  assert.equal(await store.loadSession("partial"), null);
});

test("a session needs a name", async () => {
  const store = await restartWorker();
  await assert.rejects(() => store.saveSession("  ", RECORD), /needs a name/);
});

// ── The page's half ──────────────────────────────────────────────────────────

const source = await readFile(
  new URL("../content/session-storage.js", import.meta.url),
  "utf8",
);

function inPage(fn, { url = "https://shop.test/account" } = {}) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url,
    runScripts: "outside-only",
  });
  vm.runInContext(source, dom.getInternalVMContext(), {
    filename: "session-storage.js",
  });
  try {
    return fn(dom.window);
  } finally {
    dom.window.close();
  }
}

test("dump reads both storage areas and the cookies the page can see", () => {
  const out = inPage((w) => {
    w.localStorage.setItem("token", "abc");
    w.sessionStorage.setItem("cart", "3");
    w.document.cookie = "visible=yes";
    return w.__vqSessionStorage({ mode: "dump" });
  });
  assert.equal(out.localStorage.token, "abc");
  assert.equal(out.sessionStorage.cart, "3");
  // Spread into this realm first: an array made inside the jsdom VM has a
  // different Array.prototype, and deepStrictEqual checks prototypes.
  assert.deepEqual(
    [...out.cookies].map((c) => c.name),
    ["visible"],
  );
  // Named so the worker can tell the user this reading is the partial one.
  assert.equal(out.cookieSource, "document.cookie");
  assert.equal(out.origin, "https://shop.test");
});

test("restore writes storage back and reports how much stuck", () => {
  const out = inPage((w) => {
    const res = w.__vqSessionStorage({
      mode: "restore",
      data: { localStorage: { token: "abc" }, sessionStorage: { cart: "3" } },
    });
    assert.equal(w.localStorage.getItem("token"), "abc");
    assert.equal(w.sessionStorage.getItem("cart"), "3");
    return res;
  });
  assert.equal(out.localWritten, 1);
  assert.equal(out.sessionWritten, 1);
});

test("restore skips HttpOnly cookies rather than pretending to write them", () => {
  const out = inPage((w) =>
    w.__vqSessionStorage({
      mode: "restore",
      includeStorage: false,
      data: {
        cookies: [
          { name: "sid", value: "S", httpOnly: true },
          { name: "pref", value: "dark" },
        ],
      },
    }),
  );
  // document.cookie cannot write an HttpOnly cookie; counting it as written
  // would be the lie that makes a logged-out restore look successful.
  assert.equal(out.cookiesWritten, 1);
});

test("a value too large to be a session token is left behind, with a warning", () => {
  const out = inPage((w) => {
    w.localStorage.setItem("cache", "x".repeat(200_000));
    w.localStorage.setItem("token", "abc");
    return w.__vqSessionStorage({ mode: "dump", includeCookies: false });
  });
  assert.equal(out.localStorage.token, "abc");
  assert.ok(!("cache" in out.localStorage));
  assert.match(out.warnings.join(" "), /too large/);
});

test("the step is registered, and is not exportable", async () => {
  const { STEP_TYPES, USER_STEP_TYPES, PAGE_STEP_TYPES } =
    await import("../utils/step-types.js");
  assert.ok(USER_STEP_TYPES.includes("SESSION"));
  assert.equal(STEP_TYPES.SESSION.exportable, false);
  // The page half is a dispatch type, not something a user adds by hand.
  assert.ok(PAGE_STEP_TYPES.includes("SESSION_STORAGE"));
  assert.ok(!USER_STEP_TYPES.includes("SESSION_STORAGE"));
});
