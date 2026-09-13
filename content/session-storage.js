// === session-storage.js ===
/**
 * @module session-storage
 * @description The half of a saved session that only the page can reach.
 *
 *   A logged-in session is rarely just a cookie. Sites keep a token in
 *   `localStorage`, a cart in `sessionStorage`, a "you have seen the banner"
 *   flag in either — and none of that is visible to the worker, because
 *   storage is per-origin and lives in the page. So the worker asks the page
 *   for it, the same split DOWNLOAD_COLLECT uses: the page reports what it can
 *   see, the worker decides what to do with it.
 *
 *   Cookies are read here too, but only as a fallback. `document.cookie`
 *   cannot see an `HttpOnly` cookie, and a session cookie almost always is
 *   one — so what comes back from here is a partial answer, and it says so.
 *   The complete answer needs the `cookies` permission and comes from the
 *   worker instead. Reporting which of the two happened is the point: a
 *   restored session that is quietly logged out is the failure this feature
 *   has to avoid.
 *
 *   A classic script, not a module: content scripts cannot `import`, so it is
 *   injected on demand and publishes onto the isolated world the way
 *   page-data.js does.
 *
 * @dependencies none
 */

"use strict";

(() => {
  /** Past this a "session" is a database, and writing it back would be slow. */
  const MAX_ITEMS = 500;
  /** One value this big is not a session token; it is cached page content. */
  const MAX_VALUE_CHARS = 100_000;

  /**
   * Read one Storage area, defensively.
   *
   * Storage throws rather than returning empty when the browser is set to
   * block site data, and on an opaque origin. That is a fact about the page
   * worth reporting, not an error worth failing the run over.
   */
  function dumpArea(area, name, warnings) {
    const out = {};
    let store;
    try {
      store = area();
    } catch (err) {
      warnings.push(`${name} is not readable on this page (${err.message}).`);
      return out;
    }
    if (!store) return out;
    let skipped = 0;
    for (
      let i = 0;
      i < store.length && Object.keys(out).length < MAX_ITEMS;
      i++
    ) {
      const key = store.key(i);
      if (key === null) continue;
      let value;
      try {
        value = store.getItem(key);
      } catch {
        skipped++;
        continue;
      }
      if (value === null) continue;
      if (value.length > MAX_VALUE_CHARS) {
        skipped++;
        continue;
      }
      out[key] = value;
    }
    if (skipped) {
      warnings.push(
        `${skipped} ${name} ${skipped === 1 ? "entry was" : "entries were"} too large to save.`,
      );
    }
    if (store.length > MAX_ITEMS) {
      warnings.push(
        `${name} has ${store.length} entries; only the first ${MAX_ITEMS} were saved.`,
      );
    }
    return out;
  }

  /** Cookies the document can see. Never the HttpOnly ones — see the header. */
  function dumpDocumentCookies() {
    const out = [];
    const raw = String(document.cookie || "");
    if (!raw.trim()) return out;
    for (const part of raw.split(";")) {
      const eq = part.indexOf("=");
      if (eq < 1) continue;
      out.push({
        name: part.slice(0, eq).trim(),
        value: part.slice(eq + 1).trim(),
        domain: location.hostname,
        path: "/",
        secure: location.protocol === "https:",
        httpOnly: false,
        // No expiry is recoverable from document.cookie, so a restored one is
        // a session cookie. Saying so beats implying a lifetime we never saw.
        session: true,
      });
    }
    return out;
  }

  function writeArea(area, name, values, warnings) {
    let written = 0;
    let store;
    try {
      store = area();
    } catch (err) {
      warnings.push(`${name} is not writable on this page (${err.message}).`);
      return written;
    }
    if (!store) return written;
    for (const [key, value] of Object.entries(values || {})) {
      try {
        store.setItem(key, value);
        written++;
      } catch (err) {
        // Quota, usually. Stop rather than half-writing the rest one by one.
        warnings.push(`${name} rejected "${key}" (${err.message}).`);
        break;
      }
    }
    return written;
  }

  /**
   * @param {object} config
   * @param {"dump"|"restore"} config.mode
   * @param {object} [config.data] - for restore: what dump returned
   * @param {boolean} [config.includeStorage]
   * @param {boolean} [config.includeCookies]
   */
  function sessionStorageStep(config = {}) {
    const warnings = [];
    const local = () => window.localStorage;
    const session = () => window.sessionStorage;
    const wantStorage = config.includeStorage !== false;
    const wantCookies = config.includeCookies !== false;

    if (config.mode === "restore") {
      const data = config.data || {};
      let cookiesWritten = 0;
      if (wantCookies) {
        for (const c of data.cookies || []) {
          if (c.httpOnly) continue; // document.cookie cannot write these
          try {
            const bits = [`${c.name}=${c.value}`, `path=${c.path || "/"}`];
            if (c.secure) bits.push("secure");
            if (c.expirationDate) {
              bits.push(
                `expires=${new Date(c.expirationDate * 1000).toUTCString()}`,
              );
            }
            document.cookie = bits.join("; ");
            cookiesWritten++;
          } catch (err) {
            warnings.push(`Cookie "${c.name}" was refused (${err.message}).`);
          }
        }
      }
      const localWritten = wantStorage
        ? writeArea(local, "localStorage", data.localStorage, warnings)
        : 0;
      const sessionWritten = wantStorage
        ? writeArea(session, "sessionStorage", data.sessionStorage, warnings)
        : 0;
      return {
        url: location.href,
        origin: location.origin,
        cookiesWritten,
        localWritten,
        sessionWritten,
        warnings,
      };
    }

    return {
      url: location.href,
      origin: location.origin,
      localStorage: wantStorage
        ? dumpArea(local, "localStorage", warnings)
        : {},
      sessionStorage: wantStorage
        ? dumpArea(session, "sessionStorage", warnings)
        : {},
      cookies: wantCookies ? dumpDocumentCookies() : [],
      cookieSource: "document.cookie",
      warnings,
    };
  }

  // The isolated world is shared with injector.js, which dispatches to this.
  globalThis.__vqSessionStorage = sessionStorageStep;
})();

// === END session-storage.js ===
