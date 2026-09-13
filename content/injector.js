// === injector.js ===
/**
 * @module injector
 * @description Content script entry point. Creates a shadow DOM host and
 *   dispatches step execution requests from the background over
 *   chrome.runtime.onMessage.
 *
 *   Design decision: Shadow DOM isolation ensures our injected UI (selector
 *   picker overlay) doesn't conflict with page styles.
 *
 *   Trust boundary: the background is trusted, the page is not. The only
 *   window.postMessage input accepted is VQ_NETWORK_SNIFF from
 *   page-sniffer.js, and it is treated as page-controlled data — validated and
 *   clamped, never used to choose an action.
 *
 *   This file must stay under 40 KB. Heavy logic lives in form-filler.js,
 *   overlay-engine.js, etc. — which are injected via chrome.scripting
 *   on demand, not bundled here.
 *
 * @dependencies (none — minimal entry point)
 */

"use strict";

/*
 * Everything below runs inside a function.
 *
 * A classic content script's top-level `const` becomes a lexical binding on the
 * isolated world's global scope, and that binding is created when the script is
 * *instantiated* — before a single statement runs. So evaluating this file a
 * second time in the same document throws
 * `Identifier 'VQ_ORIGIN' has already been declared` before any runtime guard
 * can look at it, and the whole injection is lost.
 *
 * That used to be rare, because the only path in pinged first and skipped. It
 * stopped being rare when the sniffer began registering this file as a content
 * script as well: the registered copy and an on-demand injection genuinely
 * race, and whichever lost took the content script down with it.
 *
 * Inside a function the bindings are local, so a second evaluation is harmless,
 * and the guard below makes it a no-op rather than a second set of listeners —
 * two listeners in one document means every reply is sent twice and the second
 * one loses, which is how A-08 silently disabled the ethics gate.
 */
(() => {
  if (globalThis.__fsInjected) return;
  globalThis.__fsInjected = true;

  const VQ_ORIGIN = chrome.runtime.getURL("").replace(/\/$/, "");

  // ── Content event names ────────────────────────────────────────────────────────
  // Message types accepted from the background over chrome.runtime.
  // These were once also accepted from the page over postMessage; see the
  // listener below for why that is gone.
  const CE = Object.freeze({
    STEP_EXEC: "VQ_STEP_EXEC",
    PICK_SELECTOR: "VQ_PICK_SELECTOR",
    // The picker is armed in every frame at once, so the frames that were not
    // clicked in stay armed — a crosshair the user cannot get rid of, and a
    // stale picker that eats the next click. Whoever wins tells the rest.
    PICK_CANCEL: "VQ_PICK_CANCEL",
    FORM_FILL_ROW: "VQ_FORM_FILL_ROW",
  });

  // ── Shadow DOM host ────────────────────────────────────────────────────────────
  const _host = document.createElement("div");
  _host.id = "verquill-v3-host";
  _host.style.cssText =
    "position:fixed;top:0;left:0;z-index:2147483647;pointer-events:none;";
  const _shadow = _host.attachShadow({ mode: "closed" });
  document.documentElement.appendChild(_host);

  function _getScopedRoot(context) {
    const loop = context?.loop;
    if (!loop || !loop.selector || typeof loop.index0 !== "number") return null;
    const roots = Array.from(document.querySelectorAll(loop.selector));
    return roots[loop.index0] || null;
  }

  function _resolveTemplatePath(ctx, expr) {
    const parts = String(expr || "")
      .trim()
      .split(".");
    let val = ctx;
    for (let part of parts) {
      if (val === undefined || val === null) return undefined;

      const bracket = part.match(/^(.+?)\[(\d+)\]$/);
      if (bracket) {
        const key = bracket[1];
        const idx = Number(bracket[2]);
        val = val?.[key];
        if (!Array.isArray(val)) return undefined;
        val = val[idx];
        continue;
      }

      if (/^\d+$/.test(part)) {
        const idx = Number(part);
        if (!Array.isArray(val)) return undefined;
        val = val[idx];
        continue;
      }

      val = val[part];
    }
    return val;
  }

  function _renderSelectorTemplate(selector, context = {}) {
    if (typeof selector !== "string") return selector;
    if (!selector.includes("{{")) return selector;
    return selector.replace(/\{\{([^}]+)\}\}/g, (_, expr) => {
      const val = _resolveTemplatePath(context, expr);
      return val !== undefined && val !== null ? String(val) : "";
    });
  }

  function _normalizeScopedSelector(selector, context = {}) {
    if (selector === null || selector === undefined) return "";
    if (typeof selector === "object") return "";
    const rendered = _renderSelectorTemplate(selector, context);
    const text = String(rendered).trim();
    if (!text) return "";
    if (text === "[object Object]" || text === "[object Array]") return "";
    if (/^\d+$/.test(text)) return `:scope > *:nth-child(${Number(text)})`;
    return text;
  }

  /**
   * The piercing combinator.
   *
   * CSS has no way to cross a shadow boundary — `>>>` was specified and then
   * removed, and nothing replaced it. So a selector for an element inside a web
   * component simply cannot be written in CSS, which is why every step in this
   * file reported "not found" for elements plainly on the screen.
   *
   * `app-root >>> .price` means: find `app-root`, step into its shadow root,
   * find `.price` there. It chains, so `a >>> b >>> c` walks two boundaries.
   * Playwright spells the same idea `>>`, which is what the emitters translate
   * it to.
   */
  const PIERCE = ">>>";

  /**
   * Every open shadow root under `node`, including `node` itself.
   *
   * Closed roots are unreachable by design — `element.shadowRoot` is null for
   * them and no API returns one — so a selector into a closed component cannot
   * be resolved by anything, and saying so beats searching forever.
   */
  function _shadowRootsUnder(node, out = []) {
    if (!node) return out;
    out.push(node);
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT);
    let current = walker.currentNode;
    while (current) {
      if (current.shadowRoot) _shadowRootsUnder(current.shadowRoot, out);
      current = walker.nextNode();
    }
    return out;
  }

  /**
   * Query `root` and every open shadow root beneath it.
   *
   * Deliberately a fallback rather than the default: walking every shadow root
   * on a large page is far more work than one querySelectorAll, and the vast
   * majority of pages have none at all. _queryScoped only reaches for this when
   * the plain query found nothing, so pages without web components pay nothing.
   */
  function _deepQueryAll(root, selector, all = true) {
    const results = [];
    const seen = new Set();
    for (const scope of _shadowRootsUnder(root)) {
      try {
        for (const el of scope.querySelectorAll(selector)) {
          if (seen.has(el)) continue;
          seen.add(el);
          results.push(el);
          if (!all) return results;
        }
      } catch {
        // An invalid selector is invalid in every scope; stop rather than
        // throwing the same error once per shadow root.
        return results;
      }
    }
    return results;
  }

  /**
   * Resolve a selector that may carry `>>>`.
   *
   * Each segment is resolved inside the previous segment's shadow root, so the
   * path is explicit and cannot accidentally match a different component with
   * the same inner class.
   */
  function _pierceQueryAll(root, selector, all = true) {
    const segments = selector.split(PIERCE).map((p) => p.trim());
    let scopes = [root];

    for (let i = 0; i < segments.length; i++) {
      const part = segments[i];
      if (!part) return [];
      const last = i === segments.length - 1;
      const found = [];
      const seen = new Set();

      for (const scope of scopes) {
        let matches;
        try {
          matches = scope.querySelectorAll(part);
        } catch {
          return [];
        }
        for (const el of matches) {
          if (seen.has(el)) continue;
          seen.add(el);
          if (last) {
            found.push(el);
            if (!all) return found;
          } else if (el.shadowRoot) {
            // A host with no open shadow root cannot be stepped into; skip it
            // rather than silently searching its light DOM, which would match
            // the wrong thing and look like success.
            found.push(el.shadowRoot);
          }
        }
      }
      if (found.length === 0) return [];
      scopes = found;
    }
    return scopes;
  }

  /**
   * One query, plain first and piercing only if that finds nothing.
   *
   * @param {Document|Element|ShadowRoot} root
   * @param {string} selector
   * @param {boolean} all
   */
  /**
   * An XPath, rather than a CSS selector.
   *
   * `xpath=` is Playwright's own prefix, so a selector written for one works in
   * the other; a bare leading `//` or `(//` is how everyone else writes them.
   */
  function _isXPath(selector) {
    return /^\s*(xpath=|\/\/|\(\/\/|\.\/\/)/.test(selector);
  }

  /**
   * Resolve an XPath against a document or element.
   *
   * Worth having for the case CSS genuinely cannot express: selecting by the
   * text a node contains. On a site that regenerates its class names on every
   * request — a real anti-scraping technique — every CSS selector the picker
   * can write is dead on arrival, and `//td[contains(., "Total")]` is not.
   */
  function _xpathAll(root, selector, all) {
    const expr = selector.replace(/^\s*xpath=/, "").trim();
    const doc = root.ownerDocument ?? root;
    if (typeof doc.evaluate !== "function") return [];
    try {
      const it = doc.evaluate(
        expr,
        root,
        null,
        // ORDERED_NODE_SNAPSHOT_TYPE: a snapshot, so the list survives the
        // caller mutating the DOM — a click during a walk would otherwise
        // invalidate a live iterator mid-loop.
        7,
        null,
      );
      const out = [];
      for (let i = 0; i < it.snapshotLength; i++) {
        const node = it.snapshotItem(i);
        if (node?.nodeType === 1) {
          out.push(node);
          if (!all) break;
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  function _resolveIn(root, selector, all) {
    if (_isXPath(selector)) return _xpathAll(root, selector, all);
    if (selector.includes(PIERCE)) {
      return _pierceQueryAll(root, selector, all);
    }
    try {
      const direct = all
        ? Array.from(root.querySelectorAll(selector))
        : [root.querySelector(selector)].filter(Boolean);
      if (direct.length > 0) return direct;
    } catch {
      return [];
    }
    // Nothing in the light DOM. A selector copied from devtools does not carry
    // the boundary it sits behind, so try the shadow roots before giving up.
    return _deepQueryAll(root, selector, all);
  }

  /**
   * The attribute an element keeps its URL in, when the user did not name one.
   *
   * `currentSrc` first because a responsive `<img>` has already chosen which of
   * its candidates it loaded, and that is the file on the screen. The data-*
   * fallbacks are for lazy loaders, which leave `src` pointing at a placeholder
   * until the image scrolls into view: downloading the 1x1 spacer instead of
   * the product photo is the failure they avoid.
   */
  function _urlAttrOf(el) {
    const tag = el.tagName?.toLowerCase();
    if (tag === "a" || tag === "area") return el.getAttribute("href");
    if (tag === "object") return el.getAttribute("data");
    return (
      el.currentSrc ||
      el.getAttribute("src") ||
      el.getAttribute("href") ||
      el.getAttribute("data-src") ||
      el.getAttribute("data-original") ||
      el.getAttribute("data-lazy-src") ||
      ""
    );
  }

  function _queryScoped(selector, context, all = false) {
    const root = _getScopedRoot(context);
    const resolved = _normalizeScopedSelector(selector, context);
    if (root) {
      if (!resolved) return all ? [root] : [root];
      const scoped = _resolveIn(root, resolved, all);
      if (scoped.length > 0) return scoped;

      // If a full-page selector was provided inside LOOP child step,
      // allow document-level fallback when scoped lookup finds nothing.
      if (resolved.startsWith(":scope")) return [];
      return _resolveIn(document, resolved || "*", all);
    }
    if (!resolved) return [];
    return _resolveIn(document, resolved || "*", all);
  }

  /**
   * Bridge from the MAIN world to the background.
   *
   * This listener used to route VQ_STEP_EXEC, VQ_PICK_SELECTOR and
   * VQ_FORM_FILL_ROW into _handleEvent, guarded only by
   * `event.source !== window` — a check every script running in the page
   * satisfies. Any page could therefore drive CLICK, FILL, SELECT, DRAG_DROP,
   * NAVIGATE, UPLOAD_ACTIVITY and the selector picker on any site the user
   * visited, and read the results back off the `_ACK` reply.
   *
   * Nothing ever sent those events: the background talks to this content script
   * over chrome.tabs.sendMessage, and no code anywhere listened for an _ACK. The
   * whole surface was reachable only by an attacker, so it is gone.
   *
   * What remains is the one real sender — page-sniffer.js, which runs in the MAIN
   * world and has no other way to reach the extension. Its payload is page-
   * controlled by definition (it is the page's own traffic), so it is validated
   * and clamped here rather than trusted: a hostile sender must not be able to
   * push unbounded strings into the service worker's memory.
   */
  const SNIFF_LIMITS = { url: 2048, body: 512 * 1024, type: 32 };

  function _sanitizeSniffPayload(payload) {
    if (!payload || typeof payload !== "object") return null;

    const str = (value, max) =>
      typeof value === "string" ? value.slice(0, max) : "";

    const url = str(payload.url, SNIFF_LIMITS.url);
    if (!url) return null;

    const status = Number(payload.status);

    return {
      method: str(payload.method, 16).toUpperCase() || "GET",
      url,
      status: Number.isFinite(status) ? status : 0,
      reqBody: str(payload.reqBody, SNIFF_LIMITS.body),
      resBody: str(payload.resBody, SNIFF_LIMITS.body),
      apiType: str(payload.apiType, SNIFF_LIMITS.type),
    };
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const { type, payload } = event.data ?? {};
    if (type !== "VQ_NETWORK_SNIFF") return;

    const clean = _sanitizeSniffPayload(payload);
    if (!clean) return;

    try {
      chrome.runtime
        .sendMessage({ type: "network:sniff", payload: clean })
        .catch(() => {});
    } catch {
      // Extension context invalidated (extension reloaded while the page lives on)
    }
  });

  /**
   * Content types that mean "this document is itself an API response".
   * `+json` and `+xml` cover the suffixed types real APIs use, like
   * `application/vnd.api+json`.
   */
  const _DATA_DOC_TYPE =
    /^(application\/(json|.*\+json|xml|.*\+xml|x-ndjson|ld\+json)|text\/(json|xml|csv|plain))$/i;

  /**
   * Report the page itself when the page *is* the data.
   *
   * The sniffer hooks fetch and XMLHttpRequest, which between them cover every
   * request a page's own scripts make — and none of the one the browser made to
   * fetch the document. So opening an API URL directly, which is the most obvious
   * thing to try, captured nothing at all: there is no request to hook, because
   * the response is already on the screen.
   *
   * Reported once per document, and only stored if a run with the sniffer on owns
   * this tab — the worker's `network:sniff` handler checks that, so this cannot
   * record anything on its own.
   */
  function _reportDataDocument() {
    if (globalThis.__fsDataDocReported) return;
    const type = String(document.contentType || "");
    if (!_DATA_DOC_TYPE.test(type)) return;

    // Chrome renders a JSON or plain-text document inside a <pre>, so that is
    // where the untouched bytes are; innerText on the body would come back
    // reflowed, and on the JSON viewer would come back folded.
    const body =
      document.querySelector("pre")?.textContent ??
      document.body?.innerText ??
      "";
    if (!body.trim()) return;
    globalThis.__fsDataDocReported = true;

    let status = 0;
    try {
      status =
        Number(performance.getEntriesByType("navigation")[0]?.responseStatus) ||
        0;
    } catch {}

    try {
      chrome.runtime
        .sendMessage({
          type: "network:sniff",
          payload: {
            method: "GET",
            url: location.href,
            status,
            reqBody: "",
            resBody: body.slice(0, SNIFF_LIMITS.body),
            apiType: "document",
          },
        })
        .catch(() => {});
    } catch {
      // Extension context invalidated.
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", _reportDataDocument, {
      once: true,
    });
  } else {
    _reportDataDocument();
  }

  // ── Runtime message bridge (SW → content script) ──────────────────────────────

  /**
   * Message types this listener answers. Anything else must fall through.
   *
   * overlay-engine.js registers a second onMessage listener in this same content
   * script. Chrome runs every listener and delivers the first response, so a
   * listener that returns `true` for messages it does not understand steals them:
   * _handleEvent's default branch resolved to null, this listener replied
   * `{ ok: true, result: null }` first, and the overlay engine's real answer was
   * discarded. That silently disabled ethics Gate 7 and every overlay:* command.
   */
  const OWNED_MESSAGE_TYPES = new Set([
    CE.STEP_EXEC,
    CE.FORM_FILL_ROW,
    CE.PICK_SELECTOR,
    CE.PICK_CANCEL,
    "step:execute",
    // Answered so the worker can tell an already-injected tab from a fresh one.
    // The script is no longer declared for <all_urls> — it is injected on demand
    // (C-09) — so "is it there yet?" became a question that needed an answer.
    "fs:ping",
    "VQ_DETECT_STRUCTURE",
    "VQ_PROBE_SELECTORS",
  ]);

  // Registered once per document: the __fsInjected guard at the top of this file
  // is what makes that true, so a second injection never reaches this line.
  {
    chrome.runtime.onMessage.addListener((msg, sender, respond) => {
      const { type, payload } = msg ?? {};
      if (!type || !OWNED_MESSAGE_TYPES.has(type)) return false;

      _handleEvent(type, payload, null)
        .then((result) => respond({ ok: true, result }))
        .catch((err) => respond({ ok: false, error: err.message }));

      return true;
    });
  }

  // ── Step dispatcher ────────────────────────────────────────────────────────────
  async function _handleEvent(type, payload, id) {
    switch (type) {
      case CE.STEP_EXEC:
        return _executeStep(payload);

      case CE.FORM_FILL_ROW:
        return _formFillRow(payload);

      case CE.PICK_SELECTOR:
        return _activateSelectorPicker(payload);

      case CE.PICK_CANCEL:
        _cancelPicker();
        return { cancelled: true };

      case "step:execute":
        return _executeStep(payload);

      case "fs:ping":
        return { ready: true };

      // structure-detector.js is injected alongside this file and shares the
      // isolated world, so it hands its entry point over on a global. A classic
      // content script cannot import one.
      case "VQ_DETECT_STRUCTURE": {
        const detect = globalThis.__fsDetectStructure;
        if (typeof detect !== "function") {
          throw new Error("Structure detector is not loaded in this page.");
        }
        return detect();
      }

      // Run the selectors a model proposed and report what each one finds.
      //
      // Only reports. Whether a selector is worth keeping is decided in the
      // worker, where utils/selector-learning.js lives — this file is a
      // classic content script and cannot import a module. The page observes,
      // the worker judges, the same as IF_ELSE and ASSERT.
      case "VQ_PROBE_SELECTORS":
        return _probeSelectors(payload);

      default:
        throw new Error(`Unhandled event type: ${type}`);
    }
  }

  /**
   * What each of a set of CSS selectors finds on this page.
   *
   * @param {{selectors: Record<string, string>}} payload
   * @returns {Record<string, {count: number, text: string|null, error?: string}>}
   */
  function _probeSelectors({ selectors = {} } = {}) {
    const found = {};
    for (const [field, selector] of Object.entries(selectors)) {
      const sel = String(selector ?? "").trim();
      if (!sel) continue;
      try {
        const nodes = document.querySelectorAll(sel);
        const first = nodes[0];
        found[field] = {
          count: nodes.length,
          // The text as EXTRACT would read it, so what is verified here is
          // what the saved step will actually produce.
          text: first ? (first.textContent ?? "").trim() : null,
        };
      } catch (err) {
        // A model occasionally answers with a sentence. One dropped field,
        // never a failed step.
        found[field] = { count: 0, text: null, error: err.message };
      }
    }
    return found;
  }

  // ── Step execution ────────────────────────────────────────────────────────────
  async function _executeStep(step) {
    const { type, config } = step;
    const context = step.__fsContext || {};
    // WEBSITE, NAVIGATE, SCREENSHOT and LOOP are not here: the service worker
    // executes those itself and never forwards them. They used to have handlers
    // here that nothing could reach — _stepNavigate set location.href, which is
    // not how the executor navigates, and _stepScreenshot and _stepLoop returned
    // a shape ("screenshotRequested", "loopInfo") no caller ever read (B-32).
    // Reaching one of them now is a real error rather than a silent no-op.
    switch (type) {
      case "CLICK":
        return _stepClick(config, context);
      case "SCROLL":
        return _stepScroll(config, context);
      case "WAIT":
        return _stepWait(config, context);
      case "EXTRACT":
        return _stepExtract(config, context);
      case "AUTO_EXTRACT":
        return _stepAutoExtract(config);
      case "FILL":
        return _stepFill(config, context); // renamed from TYPE
      case "TYPE":
        return _stepFill(config, context); // legacy alias
      case "HOVER":
        return _stepHover(config, context);
      case "SELECT":
        return _stepSelect(config, context);
      case "KEYBOARD":
        return _stepKeyboard(config, context);
      case "DRAG_DROP":
        return _stepDragDrop(config, context);
      case "UPLOAD_ACTIVITY":
        return _stepUploadActivity(config, context);
      case "IF_ELSE":
        return _stepIfElse(config, context);
      case "ASSERT":
        return _stepAssert(config, context);
      case "EXPORT":
        return { exportTriggered: true };
      case "API":
        throw new Error("API step is executed in background runtime only");
      case "PAGINATE":
        return _stepPaginate(config, context);
      case "PAGINATE_PROBE":
        return _stepPaginateProbe(config, context);
      case "PAGE_METRICS":
        // What a full-page screenshot needs to know before it starts walking.
        return {
          scrollHeight: Math.max(
            document.documentElement?.scrollHeight ?? 0,
            document.body?.scrollHeight ?? 0,
          ),
          viewportHeight: window.innerHeight,
          width: document.documentElement?.clientWidth ?? window.innerWidth,
          // Captures come back at device resolution; the crop maths is in CSS
          // pixels, so the two have to be reconciled or every crop is off by the
          // zoom factor on a HiDPI screen.
          dpr: window.devicePixelRatio || 1,
          scrollY: window.scrollY,
        };

      case "SCROLL_TO":
        // "auto", never smooth: the worker captures as soon as this resolves,
        // and a smooth scroll is still moving when the shutter goes.
        window.scrollTo({ top: Number(config.top) || 0, behavior: "auto" });
        await _sleep(Number(config.settleMs) ?? 120);
        return { top: window.scrollY };

      case "ELEMENT_BOX": {
        const el = _queryScoped(config.selector || "", context, false)[0];
        if (!el) {
          // Throwing rather than returning the viewport: a full-page shot
          // labelled "the element" is the worst outcome, because it looks right.
          throw new Error(`Screenshot: nothing matched "${config.selector}".`);
        }
        el.scrollIntoView({ behavior: "auto", block: "center" });
        await _sleep(Number(config.settleMs) ?? 150);
        const r = el.getBoundingClientRect();
        return {
          x: r.left,
          y: r.top,
          width: r.width,
          height: r.height,
          dpr: window.devicePixelRatio || 1,
          // The crop is taken from a canvas the size of the whole capture, so
          // the worker needs the viewport's dimensions and not just the box's.
          viewport: {
            width: document.documentElement?.clientWidth ?? window.innerWidth,
            height: window.innerHeight,
          },
          viewportHeight: window.innerHeight,
        };
      }

      case "PAGE_JSON": {
        const read = globalThis.__fsPageJson;
        if (typeof read !== "function") {
          throw new Error("Page-to-JSON reader is not loaded in this page.");
        }
        return read(config);
      }

      case "PAGE_DATA": {
        // page-data.js is injected alongside this file and publishes the reader
        // on the shared isolated world, the same way structure-detector.js does.
        const read = globalThis.__fsReadPageData;
        if (typeof read !== "function") {
          throw new Error("Page data reader is not loaded in this page.");
        }
        return read(config);
      }
      case "SESSION_STORAGE": {
        // session-storage.js is injected on demand and publishes the reader on
        // the shared isolated world, the same way page-data.js does.
        const run = globalThis.__fsSessionStorage;
        if (typeof run !== "function") {
          throw new Error("Session storage reader is not loaded in this page.");
        }
        return run(config);
      }
      case "DOWNLOAD_COLLECT": {
        // The page says which URLs it can see; the worker fetches them. The
        // split is what lets DOWNLOAD_FILE work inside a LOOP for nothing —
        // _queryScoped already resolves against the loop's current record —
        // and it keeps chrome.downloads out of a context that cannot call it.
        const dEls = _queryScoped(config.selector || "", context, true);
        const wanted = String(config.attr || "auto").trim();
        const named = wanted && wanted !== "auto" ? wanted : "";
        const urls = [];
        const skipped = [];
        for (const el of dEls) {
          const raw = named ? el.getAttribute(named) : _urlAttrOf(el);
          const value = String(raw ?? "").trim();
          const tag = el.tagName.toLowerCase();
          if (!value) {
            skipped.push({
              tag,
              reason: named
                ? `<${tag}> has no ${named} attribute`
                : `<${tag}> carries no URL attribute`,
            });
            continue;
          }
          let absolute;
          try {
            // Resolved here because only the page knows its own base: a
            // document with a <base href> resolves its relative URLs against
            // that and not against the tab's address, which is all the worker
            // can see.
            absolute = value.startsWith("data:")
              ? value
              : new URL(value, document.baseURI).href;
          } catch {
            skipped.push({
              tag,
              reason: `"${value.slice(0, 80)}" is not a URL`,
            });
            continue;
          }
          urls.push({
            url: absolute,
            text: (el.textContent || "")
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, 120),
            alt: el.getAttribute("alt") || "",
            title: el.getAttribute("title") || "",
          });
        }
        return { urls, matched: dEls.length, skipped };
      }

      case "QUERY_COUNT": {
        const els = _queryScoped(config.selector || "*", context, true);
        return { count: els.length };
      }
      case "QUERY_ELEMENTS": {
        // Returns rich data for each matched element for template variables
        const qEls = _queryScoped(config.selector || "*", context, true);
        return qEls.map((el, i) => {
          const info = {
            index: i + 1, // 1-based ({{item.index}})
            index0: i, // 0-based ({{item.index0}})
            text: el.textContent.trim(),
            innerText: (el.innerText || "").trim(),
            href: el.href || el.getAttribute("href") || "",
            src: el.src || el.getAttribute("src") || "",
            value: el.value || el.getAttribute("value") || "",
            id: el.id || "",
            class: el.className || "",
            tag: el.tagName.toLowerCase(),
          };
          // All data-* attributes
          for (const [key, val] of Object.entries(el.dataset || {}))
            info[`data-${key}`] = val;
          // All aria-*
          for (const attr of el.attributes) {
            if (attr.name.startsWith("aria-")) info[attr.name] = attr.value;
          }
          return info;
        });
      }
      default:
        throw new Error(`Unknown step type: ${type}`);
    }
  }

  /**
   * AUTO_EXTRACT step handler.
   * Delegates to window.__fsSmartExtract which is exposed by smart-extractor.js.
   * That function runs Layers 1 (structured data) and 2 (heuristic DOM) locally,
   * then returns the result including a `simplifiedDom` string if the SW should
   * escalate to the LLM layer.
   *
   * @param {object} config - { confidenceThreshold?: number, schema?: string[] }
   * @returns {Promise<object>} Extraction result
   */
  async function _stepAutoExtract(config = {}) {
    // Guard: smart-extractor.js injects __fsSmartExtract onto window.
    // If the script hasn't loaded yet (rare race on instant navigation), wait briefly.
    let retries = 0;
    while (typeof window.__fsSmartExtract !== "function" && retries < 5) {
      await _sleep(200);
      retries++;
    }

    if (typeof window.__fsSmartExtract !== "function") {
      throw new Error(
        "AUTO_EXTRACT: smart-extractor.js not loaded — ensure it is registered " +
          "in manifest.json before injector.js.",
      );
    }

    // Run synchronously — pure DOM reads, no awaits needed inside
    const result = window.__fsSmartExtract({
      confidenceThreshold: config.confidenceThreshold ?? 70,
      // Already parsed by the worker: this file forwards it rather than
      // reading the raw config, so "what counts as a field name" has one
      // definition and it is not in the page.
      schema: Array.isArray(config.schema) ? config.schema : null,
    });

    return result;
  }

  // ── Search elements in iframes (for LinkedIn popups, etc.) ─────────────────────
  function _searchInIframes(selector) {
    const results = [];
    try {
      const iframes = document.querySelectorAll("iframe");
      for (const iframe of iframes) {
        try {
          // Check if accessible (same origin)
          const iframeDoc =
            iframe.contentDocument || iframe.contentWindow?.document;
          if (!iframeDoc) continue;

          const found = iframeDoc.querySelectorAll(selector);
          if (found.length > 0) results.push(...found);
        } catch (e) {
          // Cross-origin iframe, skip
        }
      }
    } catch {}
    return results;
  }

  function _pickClickableTarget(el) {
    if (!el) return null;
    const clickableSel = [
      "a[href]",
      "button",
      "label",
      "input:not([type='hidden'])",
      "select",
      "textarea",
      "summary",
      "[role='button']",
      "[onclick]",
      "[tabindex]",
    ].join(",");

    const ancestor = el.closest?.(clickableSel);
    if (ancestor) return ancestor;
    if (el.matches?.(clickableSel)) return el;
    return el;
  }

  function _isInteractable(el) {
    if (!(el instanceof Element)) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    if (style.pointerEvents === "none") return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    return true;
  }

  function _resolveTopmostAtCenter(el) {
    if (!(el instanceof Element)) return null;
    const r = el.getBoundingClientRect();
    const cx = Math.round(r.left + r.width / 2);
    const cy = Math.round(r.top + r.height / 2);
    const stack = document.elementsFromPoint(cx, cy);
    const related = stack.find(
      (node) =>
        node instanceof Element &&
        node !== _host &&
        (node === el || node.contains(el) || el.contains(node)),
    );
    if (related) return _pickClickableTarget(related) || related;
    const top = stack.find((node) => node instanceof Element && node !== _host);
    if (!top) return el;
    return _pickClickableTarget(top) || top;
  }

  function _dispatchKeyboardActivate(el) {
    if (!(el instanceof HTMLElement)) return;
    try {
      el.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          code: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      );
      el.dispatchEvent(
        new KeyboardEvent("keyup", {
          key: "Enter",
          code: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      );
    } catch {}
  }

  /** Which mouse button a name means, and the bitmask for "held down". */
  const _BUTTONS = {
    left: { button: 0, buttons: 1 },
    middle: { button: 1, buttons: 4 },
    right: { button: 2, buttons: 2 },
  };

  /** The event-init flags for the modifier keys held during a click. */
  function _modifierInit(modifiers) {
    const held = new Set(
      (Array.isArray(modifiers) ? modifiers : []).map((m) =>
        String(m).toLowerCase(),
      ),
    );
    return {
      ctrlKey: held.has("ctrl") || held.has("control"),
      shiftKey: held.has("shift"),
      altKey: held.has("alt"),
      metaKey: held.has("meta") || held.has("cmd") || held.has("command"),
    };
  }

  /**
   * A mouse click, spelled out as the events a real one produces.
   *
   * The button matters more than it looks. A non-primary button does not fire
   * `click` at all — the browser fires `auxclick` — so a middle click
   * synthesised as a `click` event reached handlers that were not listening for
   * it and missed the ones that were. A right click fires `contextmenu` and no
   * click event of any kind.
   *
   * What this cannot do, and does not pretend to: make Chrome act on the click
   * itself. Opening a link in a background tab, or showing the browser's own
   * context menu, is default behaviour reserved for trusted events, and nothing
   * a content script dispatches is trusted. So these are for pages that handle
   * the events themselves — a custom context menu, ctrl-click multi-select,
   * shift-click range selection — which is most of what they are wanted for.
   *
   * @param {Element} el
   * @param {{button?: string, modifiers?: string[]}} [opts]
   */
  function _dispatchSyntheticClick(el, opts = {}) {
    if (!(el instanceof Element)) return;
    const r = el.getBoundingClientRect();
    const cx = Math.round(r.left + r.width / 2);
    const cy = Math.round(r.top + r.height / 2);
    const name = String(opts.button || "left").toLowerCase();
    const { button, buttons } = _BUTTONS[name] ?? _BUTTONS.left;
    const init = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: cx,
      clientY: cy,
      button,
      buttons,
      ..._modifierInit(opts.modifiers),
    };
    // The button is released by the time the click lands, so `buttons` is 0 on
    // everything after mouseup. A handler that reads it to tell a drag from a
    // click would otherwise see a button still held.
    const released = { ...init, buttons: 0 };
    try {
      el.dispatchEvent(
        new PointerEvent("pointerdown", { ...init, pointerId: 1 }),
      );
      el.dispatchEvent(new MouseEvent("mousedown", init));
      el.dispatchEvent(
        new PointerEvent("pointerup", { ...released, pointerId: 1 }),
      );
      el.dispatchEvent(new MouseEvent("mouseup", released));
      if (name === "right") {
        el.dispatchEvent(new MouseEvent("contextmenu", released));
      } else if (name === "middle") {
        el.dispatchEvent(new MouseEvent("auxclick", released));
      } else {
        el.dispatchEvent(new MouseEvent("click", released));
      }
    } catch {
      el.dispatchEvent(
        new MouseEvent(
          name === "right"
            ? "contextmenu"
            : name === "middle"
              ? "auxclick"
              : "click",
          released,
        ),
      );
    }
  }

  function _isInViewport(el) {
    if (!(el instanceof Element)) return false;
    const r = el.getBoundingClientRect();
    return (
      r.bottom > 0 &&
      r.right > 0 &&
      r.top < window.innerHeight &&
      r.left < window.innerWidth
    );
  }

  function _pickBestClickMatch(candidates) {
    const list = Array.from(candidates || []).filter(
      (n) => n instanceof Element,
    );
    if (!list.length) return null;

    const modalCandidates = Array.from(
      document.querySelectorAll('[role="dialog"], [aria-modal="true"]'),
    ).filter((el) => _isInteractable(el));
    const activeModal = modalCandidates.length
      ? modalCandidates[modalCandidates.length - 1]
      : null;

    const score = (el) => {
      let s = 0;
      if (_isInteractable(el)) s += 40;
      if (_isInViewport(el)) s += 20;
      if (activeModal && activeModal.contains(el)) s += 80;

      const clickable = _pickClickableTarget(el);
      if (clickable && clickable !== el) s += 10;

      const r = el.getBoundingClientRect();
      const area = Math.max(1, r.width * r.height);
      s += Math.min(20, Math.log10(area));
      return s;
    };

    list.sort((a, b) => score(b) - score(a));
    return list[0] || null;
  }

  async function _stepClick(
    {
      selector,
      retries = 3,
      all = false,
      fallbackToLoopItem = false,
      // Which match to click, when position is the point rather than
      // "whichever looks most clickable". A numbered paginator needs page 3 to
      // be the third link, not the one _pickBestClickMatch likes best.
      index = null,
      // Which mouse button, and which keys held while clicking. Only for pages
      // that handle the events themselves — see _dispatchSyntheticClick.
      button = "left",
      modifiers = [],
    },
    context = {},
  ) {
    // `el.click()` is a plain left click and cannot be told otherwise, so any
    // other button or any held modifier has to be spelled out as events.
    const plain =
      String(button || "left").toLowerCase() === "left" &&
      !(Array.isArray(modifiers) && modifiers.length);
    const mouse = { button, modifiers };
    let els = [];
    const renderedSelector = _normalizeScopedSelector(selector, context);
    const scopedRoot = _getScopedRoot(context);
    let usedRootFallback = false;

    // Try up to `retries` times with waits in between
    for (let i = 0; i < retries; i++) {
      const matches = _queryScoped(selector, context, true);
      els = all
        ? matches
        : Number.isInteger(index)
          ? [matches[index]].filter(Boolean)
          : [_pickBestClickMatch(matches)].filter(Boolean);
      if (!selector && scopedRoot) els = [scopedRoot];
      if (els.length) break;
      await _sleep(600); // Increased wait time
    }

    // Try searching in iframes as fallback
    if (!els.length) {
      const iframeMatches = _searchInIframes(selector);
      els = all
        ? iframeMatches
        : [_pickBestClickMatch(iframeMatches)].filter(Boolean);
    }

    // In LOOP children, optionally fall back to the current loop item root.
    //
    // This used to happen unconditionally: a selector that matched nothing inside
    // a loop silently clicked the item container instead, so a typo produced a
    // plausible-looking successful click on the wrong element. It is now opt-in,
    // because "click the row itself" is a real pattern but it must be a choice.
    if (!els.length && scopedRoot && !all && fallbackToLoopItem) {
      els = [scopedRoot];
      usedRootFallback = true;
    }

    if (!els.length) {
      const inLoop = Boolean(scopedRoot);
      throw new Error(
        `❌ Click target not found. Selector: "${renderedSelector || selector}"\n` +
          `Try: 1) Wait longer before click, 2) Use element picker (🎯), 3) Check if in iframe` +
          (inLoop
            ? `\n4) Or enable "Fall back to the loop item" to click the row itself`
            : ""),
      );
    }

    let clicked = 0;
    for (const el of els) {
      let target = _pickClickableTarget(el);
      if (!target) continue;

      target.scrollIntoView({ behavior: "smooth", block: "center" });
      await _sleep(180);

      // On modal-heavy apps, center can be covered by transient layers.
      const topmost = _resolveTopmostAtCenter(target);
      if (topmost) target = topmost;

      if (!_isInteractable(target)) {
        await _sleep(220);
        const retryTopmost = _resolveTopmostAtCenter(target);
        if (retryTopmost) target = retryTopmost;
      }

      if (target instanceof HTMLElement)
        target.focus?.({ preventScroll: true });

      const isCheck =
        target instanceof HTMLInputElement &&
        ["checkbox", "radio"].includes(target.type?.toLowerCase());
      const wasChecked = isCheck ? target.checked : undefined;

      const primary = _pickClickableTarget(target) || target;
      const centerResolved = _resolveTopmostAtCenter(primary) || primary;
      const candidates = [primary, centerResolved].filter(
        (node, idx, arr) => node && arr.indexOf(node) === idx,
      );

      let fired = false;
      for (const candidate of candidates) {
        if (!_isInteractable(candidate)) continue;
        if (plain) {
          try {
            candidate.click();
            fired = true;
          } catch {}
        }

        if (!fired && candidate instanceof HTMLElement) {
          _dispatchSyntheticClick(candidate, mouse);
          fired = true;
        }

        // Space/Enter is a stand-in for a left click and nothing else: a
        // keyboard has no way to express "the right button".
        if (plain && !fired && candidate instanceof HTMLElement) {
          _dispatchKeyboardActivate(candidate);
          fired = true;
        }

        if (fired) break;
      }

      if (fired) clicked++;

      // Some pages block native click on hidden radio/checkbox wrappers.
      // Only for a plain click: a right click on a checkbox opens a menu, it
      // does not tick the box, and forcing the state here would be the tool
      // doing something the user did not ask for.
      if (plain && isCheck && target.checked === wasChecked) {
        if (target.type.toLowerCase() === "radio") target.checked = true;
        else target.checked = !target.checked;
        target.dispatchEvent(new Event("input", { bubbles: true }));
        target.dispatchEvent(new Event("change", { bubbles: true }));
      }

      // For delegated handlers (common on LI lists), also bubble a click on original matched node.
      if (target !== el && el instanceof HTMLElement) {
        _dispatchSyntheticClick(el, mouse);
      }
    }
    return {
      clicked,
      matched: els.length,
      selector: renderedSelector || selector,
      usedRootFallback,
      button: String(button || "left").toLowerCase(),
    };
  }

  async function _stepScroll(config = {}, context = {}) {
    const {
      mode = "pixel",
      amount,
      value,
      selector,
      container,
      behavior = "smooth",
    } = config;
    const scrollAmount = amount ?? value ?? 300;
    const scrollBehavior = behavior === "instant" ? "auto" : "smooth";
    // Infinite feeds live inside a `div` with its own scrollbar as often as
    // they live in the document — a chat window, a card list beside a fixed
    // sidebar. `container` names that element and every mode below scrolls it
    // instead of window/document, resolved through the same _queryScoped every
    // other selector-bearing step uses rather than a second query path.
    const target = container
      ? _queryScoped(container, context, false)[0]
      : null;
    if (container && !target) {
      throw new Error(`Scroll: no container matched "${container}".`);
    }
    if ((mode === "selector" || mode === "element") && selector) {
      // scrollIntoView already walks every scrollable ancestor to bring the
      // target on screen, container or not, so this mode needs nothing extra.
      const el = _queryScoped(selector, context, false)[0];
      if (el) el.scrollIntoView({ behavior: scrollBehavior, block: "center" });
    } else if (mode === "percent") {
      // documentElement, not body: with `body { height: 100% }` — or any layout
      // where the scroll container is the html element — body.scrollHeight is the
      // viewport height, so "scroll to 100%" moved one screen (B-31). A named
      // container has the equivalent trap: it is the element's own scrollHeight
      // that matters, not the document's.
      const top =
        ((target ? target.scrollHeight : _docHeight()) * scrollAmount) / 100;
      if (target) target.scrollTo({ top, behavior: scrollBehavior });
      else window.scrollTo({ top, behavior: scrollBehavior });
    } else if (mode === "infinite" || mode === "bottom") {
      return _scrollInfinite(config, context);
    } else {
      // mode === 'pixel' or 'px' or default
      if (target)
        target.scrollBy({ top: scrollAmount, behavior: scrollBehavior });
      else window.scrollBy({ top: scrollAmount, behavior: scrollBehavior });
    }
    return { scrolled: true };
  }

  /** How tall the scrollable document is, whichever element owns the scroll. */
  function _docHeight() {
    return Math.max(
      document.documentElement?.scrollHeight ?? 0,
      document.body?.scrollHeight ?? 0,
    );
  }

  /**
   * Scroll to the bottom repeatedly until the page stops growing.
   *
   * This is what an infinite feed needs and what the step could not do: the other
   * modes each perform exactly one scroll, so scraping a lazy-loaded list meant
   * guessing how many SCROLL steps to stack and hoping the network kept up.
   *
   * Two things it will not do:
   *   * spin forever — `maxScrolls` bounds it, and the result says whether it
   *     stopped because the feed ended or because it ran out of scrolls, so a
   *     truncated scrape is visible rather than silent;
   *   * declare the end on the first quiet round — `stableRounds` consecutive
   *     rounds with no growth are required, because a feed that is mid-fetch when
   *     the timer fires looks exactly like a feed that has finished.
   *
   * `container`, when given, names the element that actually scrolls — the
   * common shape for a lazy-loaded list is a `div` with its own scrollbar, and
   * measuring the document there never sees the list grow: the page around it
   * never changes height, so the loop would call it "exhausted" on round one.
   *
   * @returns {Promise<{scrolled: boolean, mode: string, scrolls: number,
   *   height: number, grew: number, exhausted: boolean, container: boolean}>}
   */
  async function _scrollInfinite(
    {
      maxScrolls = 50,
      settleMs = 1200,
      stableRounds = 2,
      selector = "",
      container = "",
    } = {},
    context = {},
  ) {
    const limit = Math.max(1, Number(maxScrolls) || 50);
    const settle = Math.max(0, Number(settleMs) ?? 1200);
    const needed = Math.max(1, Number(stableRounds) || 2);

    const target = container
      ? _queryScoped(container, context, false)[0]
      : null;
    if (container && !target) {
      throw new Error(`Scroll: no container matched "${container}".`);
    }

    const measureHeight = () => (target ? target.scrollHeight : _docHeight());
    const scrollToEnd = () => {
      if (target)
        target.scrollTo({ top: target.scrollHeight, behavior: "auto" });
      else window.scrollTo({ top: _docHeight(), behavior: "auto" });
    };
    // Counted within the container when one is set — _resolveIn is the same
    // resolver _queryScoped calls internally, so this stays one query path
    // rather than a plain querySelectorAll bolted on beside it.
    const countItems = () => {
      if (!selector) return 0;
      return target
        ? _resolveIn(target, selector, true).length
        : _queryScoped(selector, context, true).length;
    };

    const startHeight = measureHeight();
    const startItems = countItems();

    let height = startHeight;
    let items = startItems;
    let quiet = 0;
    let scrolls = 0;
    let exhausted = false;

    while (scrolls < limit) {
      scrollToEnd();
      scrolls++;
      await _sleep(settle);

      const nextHeight = measureHeight();
      const nextItems = countItems();
      // Item count is the better signal where it is available: a feed can swap
      // a placeholder for a card without the document getting any taller.
      const grew = nextHeight > height || (selector && nextItems > items);
      height = nextHeight;
      items = nextItems;

      if (grew) {
        quiet = 0;
        continue;
      }
      if (++quiet >= needed) {
        exhausted = true;
        break;
      }
    }

    return {
      scrolled: true,
      mode: "infinite",
      scrolls,
      height,
      grew: height - startHeight,
      items,
      newItems: items - startItems,
      exhausted,
      container: !!target,
    };
  }

  /**
   * Class names sites give a Next control that has nothing left to go to.
   * Checked as whole words so `disabled-state` matches and `undisabled` does not.
   */
  const _PAGINATE_DEAD_CLASS =
    /(^|[\s_-])(disabled|inactive|is-disabled)([\s_-]|$)/i;

  /**
   * Is this Next control still usable?
   * @returns {string} "" when it is, otherwise why it is not
   */
  function _paginateDeadReason(el) {
    if (el.disabled === true) return "the Next control is disabled";
    if (el.getAttribute("aria-disabled") === "true") {
      return "the Next control is marked aria-disabled";
    }
    if (_PAGINATE_DEAD_CLASS.test(el.className || "")) {
      return "the Next control is styled as disabled";
    }
    if (el.tagName === "A" && !el.getAttribute("href")) {
      return "the Next link has no target";
    }
    const style = el.ownerDocument.defaultView?.getComputedStyle?.(el);
    if (style && (style.display === "none" || style.visibility === "hidden")) {
      return "the Next control is hidden";
    }
    return "";
  }

  /**
   * A cheap description of what is on the page right now.
   *
   * Enough to tell "the click loaded page 2" from "the click did nothing", which
   * is the only way to stop at the end of a paginator whose Next button is always
   * present and always enabled — a common shape in single-page apps.
   */
  function _pageFingerprint() {
    return `${location.href}|${_docHeight()}|${document.body?.textContent?.length ?? 0}`;
  }

  /**
   * Look at the Next control without touching it.
   *
   * Split from the click deliberately. Clicking a real `<a href>` navigates, the
   * content script is torn down with the document, and the reply never arrives —
   * Chrome reports "the message channel closed before a response was received"
   * and the step looks like a failure. So the page answers the question first and
   * the worker performs the click, where losing the page mid-step is expected
   * rather than fatal.
   *
   * @returns {{exhausted: boolean, reason: string, fingerprint: string}}
   */
  function _stepPaginateProbe({ selector = "" }, context = {}) {
    if (!selector) throw new Error("Paginate: no Next selector configured.");
    const fingerprint = _pageFingerprint();

    const matches = _queryScoped(selector, context, true);
    if (matches.length === 0) {
      return {
        exhausted: true,
        fingerprint,
        reason: `no element matched "${selector}" — this looks like the last page`,
      };
    }
    const el = matches[0];
    const dead = _paginateDeadReason(el);

    // Where the Next control would take the browser, and whether it would open
    // a second tab doing it. A paginator with target="_blank" used to leave the
    // run scraping the page it was already on while the next one appeared in a
    // tab nobody was looking at — ten "pages" of the same rows, and no error.
    // The anchor may be an ancestor: sites wrap an icon or a <span> in the link.
    const anchor =
      el.tagName === "A" ? el : el.closest ? el.closest("a") : null;
    const target = String(anchor?.getAttribute("target") ?? "")
      .trim()
      .toLowerCase();
    const sameTab = target === "" || target === "_self" || target === "_top";

    return {
      exhausted: Boolean(dead),
      reason: dead,
      fingerprint,
      href: anchor?.href ?? "",
      newTab: Boolean(anchor) && !sameTab,
    };
  }

  /**
   * Click through to the next page, and say whether there was one.
   *
   * This used to be `return _stepClick(config)` — a click wearing a different
   * name. A loop configured for 10 pages therefore ran its body 10 times whether
   * or not the site had 10 pages: past the last one the click matched nothing,
   * _stepClick reported `clicked: 0` without failing, and the loop re-scraped the
   * final page until the count ran out. Duplicate rows, and no sign anything was
   * wrong.
   *
   * It does not wait for the next page here: see _stepPaginateProbe. The caller
   * (LOOP in paginate mode, via the worker) stops on `exhausted`.
   *
   * @returns {Promise<{paginated: boolean, exhausted: boolean, reason: string}>}
   */
  async function _stepPaginate({ selector = "" }, context = {}) {
    const probe = _stepPaginateProbe({ selector }, context);
    if (probe.exhausted) {
      return { paginated: false, exhausted: true, reason: probe.reason };
    }
    await _stepClick({ selector, retries: 3 }, context);
    return { paginated: true, exhausted: false, reason: "" };
  }

  /**
   * Wait for something, rather than for the clock.
   *
   * Every branch below except "fixed" was unreachable until now: the service
   * worker's WAIT case slept and returned, and never forwarded the step, so the
   * only wait the product could actually perform was the one that is wrong on a
   * page that loads its content asynchronously — which is all of them.
   *
   * A misconfigured wait throws instead of falling through to a sleep. Sleeping
   * looks like success, and the step after it reads a page that is not ready.
   */
  async function _stepWait(
    { mode = "fixed", ms = 1000, selector, timeout = 15000, quietMs = 500 },
    context = {},
  ) {
    const limit = Number(timeout) > 0 ? Number(timeout) : 15000;
    switch (mode) {
      case "selector-visible":
        if (!selector) {
          throw new Error("Wait: 'until element appears' needs a selector.");
        }
        await _waitForSelectorScoped(selector, limit, context);
        return { waited: true, mode, selector };

      case "selector-gone":
        if (!selector) {
          throw new Error("Wait: 'until element disappears' needs a selector.");
        }
        await _waitForSelectorGone(selector, limit, context);
        return { waited: true, mode, selector };

      case "DOM-stable":
        await _waitDOMStable(Number(quietMs) || 500, limit);
        return { waited: true, mode };

      default:
        await _sleep(Number(ms) || 1000);
        return { waited: true, mode: "fixed", ms: Number(ms) || 1000 };
    }
  }

  async function _stepExtract({ fields = [], schema = [] }, context = {}) {
    const extractors = schema.length > 0 ? schema : fields;
    if (extractors.length === 0) return [];

    const rawData = {};
    let maxLen = 1;

    const _extractValue = (el, field) => {
      if (field.type === "attribute") {
        // Falling through to text here would look like a successful extraction
        // of the wrong thing, which is how this went unnoticed while the UI had
        // no way to supply an attribute name at all.
        if (!field.attribute) {
          throw new Error(
            `EXTRACT field "${field.name || "unnamed"}" is set to Attr but has no attribute name.`,
          );
        }
        return el.getAttribute(field.attribute) ?? null;
      }
      if (field.type === "count") {
        // A value the page shows as repetition rather than text: four filled
        // stars is the rating 4, six tag chips is six tags. Same contract as
        // "attribute" — no selector means there is nothing to count, and
        // returning 0 would be a plausible-looking wrong answer.
        if (!field.countSelector) {
          throw new Error(
            `EXTRACT field "${field.name || "unnamed"}" is set to Count but has no selector to count.`,
          );
        }
        try {
          return String(el.querySelectorAll(field.countSelector).length);
        } catch {
          throw new Error(
            `EXTRACT field "${field.name || "unnamed"}": "${field.countSelector}" is not a valid selector.`,
          );
        }
      }
      if (field.type === "html") return el.innerHTML;

      const tag = el.tagName.toLowerCase();
      if (tag === "input") {
        const inputType = el.type?.toLowerCase() ?? "text";
        if (inputType === "checkbox" || inputType === "radio") {
          return el.checked ? (el.value ?? "true") : "";
        }
        if (inputType === "file") {
          const files = Array.from(el.files || []);
          return files.length
            ? files.map((f) => f.name).join(", ")
            : (el.value ?? "");
        }
        return el.value ?? el.getAttribute("value") ?? "";
      }
      if (tag === "textarea") return el.value ?? "";
      if (tag === "select") {
        const opts = Array.from(el.selectedOptions || []);
        if (el.multiple) {
          return opts
            .map((o) => o.value || o.textContent.trim())
            .filter(Boolean)
            .join(", ");
        }
        const opt = opts[0];
        return opt ? opt.value || opt.textContent.trim() : (el.value ?? "");
      }
      if (el.isContentEditable)
        return el.innerText?.trim() ?? el.textContent.trim();

      // Intelligent media and url scraping
      if (tag === "img")
        return el.src || el.dataset?.src || el.getAttribute("src");
      if (tag === "a" && !el.textContent.trim())
        return el.href || el.getAttribute("href");
      if (tag === "video" || tag === "audio")
        return (
          el.src || el.getAttribute("src") || el.querySelector("source")?.src
        );
      return (el.innerText || el.textContent || "").trim();
    };

    for (const field of extractors) {
      const name = field.name || "data";
      // Pull all elements matching the selector
      const els = _queryScoped(field.selector, context, true);
      if (els.length > maxLen) maxLen = els.length;

      rawData[name] = els.map((el) => _extractValue(el, field));
    }

    // Row assembly. Fields can legitimately match a different number of elements
    // than the row count: a page title matches once and belongs on every row.
    // But a field matching 3 of 10 rows is missing data, not a value to repeat —
    // padding those with the first match (as this used to) invents data that
    // looks real.
    //
    //   exactly 1 match  -> broadcast to every row (a shared, page-level value)
    //   n matches, n > 1 -> positional; rows past n get null
    //   0 matches        -> null everywhere
    const results = [];
    for (let i = 0; i < maxLen; i++) {
      const row = {};
      for (const field of extractors) {
        const name = field.name || "data";
        const values = rawData[name];

        let value;
        if (values.length === 1) {
          value = values[0];
        } else if (i < values.length) {
          value = values[i];
        } else {
          value = null;
        }

        // ?? not ||: "0", "" and false are real extracted values, and turning
        // them into null loses out-of-stock counts, empty inputs and the like.
        row[name] = value ?? null;
      }
      results.push(row);
    }
    return results;
  }

  /**
   * Build the File objects a page would have got from a file picker.
   *
   * @param {Array<{name?: string, dataUrl?: string}>} files
   * @returns {DataTransfer}
   */
  function _filesToDataTransfer(files) {
    const dt = new DataTransfer();
    for (const item of files) {
      const dataUrl = String(item?.dataUrl || "");
      const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
      if (!match) {
        throw new Error(`Invalid file payload for ${item?.name || "unknown"}`);
      }
      const mime = match[1] || "application/octet-stream";
      const bytes = Uint8Array.from(atob(match[2]), (c) => c.charCodeAt(0));
      dt.items.add(
        new File([bytes], item?.name || "upload.bin", { type: mime }),
      );
    }
    return dt;
  }

  /**
   * Drop files onto a zone that has no file input behind it.
   *
   * More and more upload widgets have none: they listen for `drop` and read
   * `event.dataTransfer.files`, so there is nothing whose `.files` can be set.
   *
   * The part worth getting right is knowing whether it worked. A drop on an
   * element with no handler does nothing at all — no error, no change — so a
   * step that dispatched the events and reported success would be the exact
   * shape of failure this project keeps finding. A page that accepts a drop
   * *must* call preventDefault() on `dragover`, or the browser refuses the drop
   * outright; almost all of them cancel `drop` too. So "did anything cancel
   * these" is a real answer to "did anything take the files", and it is
   * reported rather than assumed.
   *
   * @param {Element} zone
   * @param {DataTransfer} dt
   * @returns {{accepted: boolean, cancelled: string[]}}
   */
  function _dropOnto(zone, dt) {
    const cancelled = [];
    const fire = (type) => {
      const ev = new DragEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        dataTransfer: dt,
      });
      zone.dispatchEvent(ev);
      if (ev.defaultPrevented) cancelled.push(type);
    };
    // The full sequence: a dropzone that only tracks `dragenter`/`dragleave`
    // for its highlight still needs them to end up in the right state, and one
    // that reads `dragover` to decide whether to accept never sees the drop
    // without it.
    fire("dragenter");
    fire("dragover");
    fire("drop");
    return {
      accepted: cancelled.includes("dragover") || cancelled.includes("drop"),
      cancelled,
    };
  }

  async function _stepUploadActivity(
    { selector = "", files = [], mode = "input" },
    context = {},
  ) {
    const _isFileInput = (node) =>
      node instanceof HTMLInputElement && node.type === "file";

    const _sameDialogRank = (candidate, anchor) => {
      const candidateDialog = candidate.closest?.(
        '[role="dialog"], [aria-modal="true"]',
      );
      const anchorDialog = anchor?.closest?.(
        '[role="dialog"], [aria-modal="true"]',
      );
      return (
        candidateDialog && anchorDialog && candidateDialog === anchorDialog
      );
    };

    const _visibleish = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const style = getComputedStyle(el);
      return style.display !== "none" && style.visibility !== "hidden";
    };

    const _rankFileInputs = (inputs, anchor) => {
      const list = Array.from(inputs || []);
      list.sort((a, b) => {
        const aSame = _sameDialogRank(a, anchor) ? 1 : 0;
        const bSame = _sameDialogRank(b, anchor) ? 1 : 0;
        if (aSame !== bSame) return bSame - aSame;
        const aVisible = _visibleish(a) ? 1 : 0;
        const bVisible = _visibleish(b) ? 1 : 0;
        if (aVisible !== bVisible) return bVisible - aVisible;
        return 0;
      });
      return list;
    };

    const _findPopupTrigger = (anchor) => {
      if (!(anchor instanceof Element)) return null;
      const scope =
        anchor.closest?.('[role="dialog"], [aria-modal="true"]') ||
        anchor.parentElement ||
        anchor;
      const triggerSelectors = [
        'button[aria-label*="Add media"]',
        'button[aria-label*="Media"]',
        'button[aria-label*="upload"]',
        'button[aria-label*="Upload"]',
        '[role="button"][aria-label*="Add media"]',
        '[role="button"][aria-label*="Upload"]',
        "button.share-promoted-detour-button",
        'button[title*="media"]',
        'button[title*="upload"]',
      ];

      for (const sel of triggerSelectors) {
        const found = scope.querySelector?.(sel) || anchor.querySelector?.(sel);
        if (found instanceof HTMLElement) return found;
      }

      const nearbyButtons = Array.from(
        scope.querySelectorAll?.("button,[role='button']") || [],
      );
      return (
        nearbyButtons.find((el) => {
          const label =
            `${el.getAttribute?.("aria-label") || ""} ${el.getAttribute?.("title") || ""} ${el.textContent || ""}`.toLowerCase();
          return (
            label.includes("media") ||
            label.includes("upload") ||
            label.includes("add")
          );
        }) || null
      );
    };

    const _findUploadInput = async () => {
      const anchor = _queryScoped(selector, context, false)[0] || null;
      if (!anchor) return null;

      if (_isFileInput(anchor)) return anchor;

      const fromAnchor = anchor.querySelector?.('input[type="file"]');
      if (_isFileInput(fromAnchor)) return fromAnchor;

      const scopedModal = anchor.closest?.(
        '[role="dialog"], [aria-modal="true"]',
      );
      const fromModal = scopedModal?.querySelector?.('input[type="file"]');
      if (_isFileInput(fromModal)) return fromModal;

      const deepFromAnchor = _deepQueryAll(anchor, 'input[type="file"]').find(
        _isFileInput,
      );
      if (deepFromAnchor) return deepFromAnchor;

      const deepFromModal = scopedModal
        ? _deepQueryAll(scopedModal, 'input[type="file"]').find(_isFileInput)
        : null;
      if (deepFromModal) return deepFromModal;

      // If the picker landed on a trigger button/container, click once to reveal the hidden input.
      if (anchor instanceof HTMLElement) {
        const trigger = _findPopupTrigger(anchor);
        if (trigger && trigger !== anchor) {
          try {
            trigger.click();
          } catch {
            _dispatchSyntheticClick(trigger);
          }
          await _sleep(700);
        }

        try {
          anchor.click();
        } catch {
          _dispatchSyntheticClick(anchor);
        }
        await _sleep(700);
      }

      const afterClickFromAnchor = anchor.querySelector?.('input[type="file"]');
      if (_isFileInput(afterClickFromAnchor)) return afterClickFromAnchor;

      const deepAfterClickFromAnchor = _deepQueryAll(
        anchor,
        'input[type="file"]',
      ).find(_isFileInput);
      if (deepAfterClickFromAnchor) return deepAfterClickFromAnchor;

      const afterClickFromModal =
        scopedModal?.querySelector?.('input[type="file"]');
      if (_isFileInput(afterClickFromModal)) return afterClickFromModal;

      const deepAfterClickFromModal = scopedModal
        ? _deepQueryAll(scopedModal, 'input[type="file"]').find(_isFileInput)
        : null;
      if (deepAfterClickFromModal) return deepAfterClickFromModal;

      const afterClickTrigger = _findPopupTrigger(anchor);
      if (afterClickTrigger && afterClickTrigger !== anchor) {
        try {
          afterClickTrigger.click();
        } catch {
          _dispatchSyntheticClick(afterClickTrigger);
        }
        await _sleep(700);
        const modalAfterTrigger =
          scopedModal?.querySelector?.('input[type="file"]');
        if (_isFileInput(modalAfterTrigger)) return modalAfterTrigger;
        const deepModalAfterTrigger = scopedModal
          ? _deepQueryAll(scopedModal, 'input[type="file"]').find(_isFileInput)
          : null;
        if (deepModalAfterTrigger) return deepModalAfterTrigger;
        const anchorAfterTrigger = anchor.querySelector?.('input[type="file"]');
        if (_isFileInput(anchorAfterTrigger)) return anchorAfterTrigger;
        const deepAnchorAfterTrigger = _deepQueryAll(
          anchor,
          'input[type="file"]',
        ).find(_isFileInput);
        if (deepAnchorAfterTrigger) return deepAnchorAfterTrigger;
      }

      const allInputs = _rankFileInputs(
        _deepQueryAll(document, 'input[type="file"]'),
        anchor,
      );
      return allInputs[0] || null;
    };

    if (!Array.isArray(files) || files.length === 0) {
      throw new Error("UPLOAD_ACTIVITY has no files to upload.");
    }

    if (mode === "drop") {
      // The selector names the drop zone itself, so it is resolved the way
      // every other selector is rather than through the file-input search.
      const zone = _queryScoped(selector, context, false)[0];
      if (!zone) {
        throw new Error(`Upload: no drop zone matched "${selector}".`);
      }
      const dropDt = _filesToDataTransfer(files);
      zone.scrollIntoView?.({ behavior: "smooth", block: "center" });
      await _sleep(120);
      const { accepted, cancelled } = _dropOnto(zone, dropDt);
      return {
        uploaded: accepted ? dropDt.files.length : 0,
        selector,
        mode: "drop",
        accepted,
        cancelled,
        fileNames: Array.from(dropDt.files).map((f) => f.name),
      };
    }

    const input = await _findUploadInput();
    if (!input) throw new Error(`Upload input not found near: ${selector}`);
    if (!_isFileInput(input)) {
      throw new Error(`Target is not input[type=file]: ${selector}`);
    }

    const dt = _filesToDataTransfer(files);

    input.files = dt.files;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));

    return {
      uploaded: dt.files.length,
      selector,
      mode: "input",
      accepted: true,
      fileNames: Array.from(dt.files).map((f) => f.name),
    };
  }

  // ── FILL (was TYPE): single or multi-field input ─────────────────────────────

  /**
   * Names that exist only to catch something that fills every field it finds.
   *
   * Deliberately short. `url`, `website` and `nickname` are all used as bait,
   * and are also real fields on real comment forms, so a name alone is only
   * taken as proof when the name has no other purpose.
   */
  const _HONEYPOT_NAMES =
    /honey ?pot|hp_?(?:field|input)?$|bot[-_]?(?:field|check|trap)|_?gotcha|no[-_]?bot|spam[-_]?trap|leave[-_ ]?(?:this[-_ ])?blank|(?:do[-_]?not|dont)[-_]?fill/i;

  /**
   * Is this field a trap rather than a field?
   *
   * A honeypot is an input a person can never see and never types into, so
   * anything in it was put there by a script. Filling one does not fail
   * loudly — the form is accepted, the submission is binned, and the account
   * is quietly marked. That silence is why this is on by default and has no
   * toggle: an option to fill traps has no use anybody would want.
   *
   * Every ancestor is walked, because `display:none` on a wrapper is how most
   * of them are hidden and the input's own computed style says nothing about
   * it. The offscreen distances are generous: a field parked at -9999px is
   * unambiguous, whereas a sticky bar sitting a little above the fold is not.
   *
   * @param {Element} el
   * @returns {string|null} why it is a trap, or null when it is an ordinary field
   */
  function _honeypotReason(el) {
    if (!el) return null;
    if (el.tagName === "INPUT") {
      const type = (el.getAttribute("type") || "").toLowerCase();
      if (type === "hidden") return "it is an <input type=hidden>";
    }

    const view = el.ownerDocument?.defaultView;
    for (
      let node = el;
      node && node.nodeType === 1;
      node = node.parentElement
    ) {
      if (node.hasAttribute("hidden")) {
        return `${node === el ? "it" : `its <${node.tagName.toLowerCase()}> wrapper`} carries the hidden attribute`;
      }
      if (node.getAttribute("aria-hidden") === "true") {
        return `${node === el ? "it" : `its <${node.tagName.toLowerCase()}> wrapper`} is aria-hidden`;
      }
      const style = view?.getComputedStyle?.(node);
      if (!style) continue;
      if (style.display === "none") return "it is display:none";
      if (style.visibility === "hidden" || style.visibility === "collapse") {
        return "it is visibility:hidden";
      }
      if (style.opacity !== "" && Number(style.opacity) === 0) {
        return "it is fully transparent";
      }
      if (parseInt(style.textIndent, 10) <= -1000) {
        return "its text is indented off the page";
      }
      if (
        parseInt(style.left, 10) <= -1000 ||
        parseInt(style.top, 10) <= -1000
      ) {
        return "it is positioned off the page";
      }
    }

    const rect = el.getBoundingClientRect?.();
    if (rect) {
      if (rect.width < 2 || rect.height < 2) return "it has no size on screen";
      if (rect.right < -1000 || rect.bottom < -1000) {
        return "it sits off the page";
      }
    }

    const label = `${el.getAttribute("name") || ""} ${el.id || ""} ${el.className || ""}`;
    if (_HONEYPOT_NAMES.test(label)) {
      return "its name is one only a bot trap uses";
    }
    return null;
  }

  /**
   * Write a value the way a real keystroke would.
   *
   * `el.value = x` assigns to the property, and React (and Vue's v-model, and
   * Angular's ControlValueAccessor) install their own accessor on the instance
   * and cache the last value they saw in `_valueTracker`. So the assignment is
   * either swallowed or reverted on the next render, and the field snaps back to
   * empty — the single most common way FILL silently did nothing (B-10).
   *
   * Calling the *prototype's* native setter writes past the framework's accessor,
   * and clearing the tracker makes React believe the value changed so it runs its
   * onChange. This is the technique that has been sitting unused in the dead
   * content/form-filler.js all along.
   *
   * @param {HTMLElement} el
   * @param {string} value
   */
  function _setNativeValue(el, value) {
    const proto = Object.getPrototypeOf(el);
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    const tracker = el._valueTracker;
    // Setting the tracker to something other than the incoming value is what
    // makes React's change detection fire; clearing it outright is enough.
    if (tracker) tracker.setValue(`${value}_`);
    if (setter) setter.call(el, value);
    else el.value = value;
  }

  /** An `input` event frameworks recognise. A plain Event is not an InputEvent. */
  function _fireInput(el) {
    el.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        cancelable: true,
        composed: true,
      }),
    );
  }

  function _fireChange(el) {
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  /**
   * What kind of thing are we filling? FILL used to assume "something with a
   * .value you can append characters to", so a checkbox, a radio, a <select> and
   * a contenteditable div all silently did nothing (B-10).
   *
   * @param {Element} el
   * @returns {'checkbox'|'select'|'contenteditable'|'file'|'text'|null}
   */
  function _fillKind(el) {
    if (!el) return null;
    const tag = el.tagName;
    if (tag === "SELECT") return "select";
    if (tag === "INPUT") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (type === "checkbox" || type === "radio") return "checkbox";
      if (type === "file") return "file";
      return "text";
    }
    if (tag === "TEXTAREA") return "text";
    // isContentEditable is false for a detached element and undefined outside a
    // rendering engine, so fall back to the attribute that drives it.
    const ce = el.getAttribute?.("contenteditable");
    if (
      el.isContentEditable ||
      (ce !== null && ce !== undefined && ce !== "false")
    ) {
      return "contenteditable";
    }
    return null;
  }

  /** Values that mean "tick this box". */
  const _TRUTHY_FILL = new Set(["true", "1", "yes", "on", "checked", "check"]);

  async function _stepFill(
    {
      mode = "single",
      selector = "",
      text = "",
      delayMs = 50,
      append = false,
      fields = [],
      submitSelector = "",
    },
    context = {},
  ) {
    async function _typeInto(el, value, delay, shouldAppend) {
      const kind = _fillKind(el);
      if (!kind) {
        throw new Error(
          `Fill target is not an input, textarea, select or contenteditable: <${el.tagName.toLowerCase()}>`,
        );
      }
      if (kind === "file") {
        throw new Error(
          "Fill cannot set a file input for security reasons — use an Upload from Storage step.",
        );
      }
      // A password field is refused the same way, and for a stronger reason.
      //
      // The ethics engine has documented "password fields in form filling" as
      // a hard block since the audit. That block filters the pipeline for
      // steps of type FORM_FILL — which the registry does not have; the step
      // is FILL — so it has matched nothing on every pipeline ever run. The
      // in-page guard that would have caught it lives in form-filler.js,
      // reachable only through an VQ_FORM_FILL_ROW message that nothing
      // dispatches. Both copies of the protection were unreachable, so the
      // path a user actually builds would type a credential into a login form
      // and submit it, while the documentation said it could not.
      //
      // Here, because this is the one function both fill modes go through.
      if (el.type === "password") {
        throw new Error(
          "Fill will not type into a password field. Automating a credential " +
            "into a login form is the one thing this step refuses outright — " +
            "use a SESSION step to reuse a login you made yourself.",
        );
      }

      el.scrollIntoView({ behavior: "smooth", block: "center" });
      await _sleep(100);
      el.focus();

      const valStr = String(value ?? "");

      if (kind === "checkbox") {
        const want = _TRUTHY_FILL.has(valStr.trim().toLowerCase());
        // A radio can only be set, never cleared, by clicking it.
        if (el.checked !== want) {
          el.checked = want;
          _fireInput(el);
          _fireChange(el);
        }
        return { kind, checked: el.checked };
      }

      if (kind === "select") {
        return _setSelectValue(el, valStr);
      }

      if (kind === "contenteditable") {
        if (!shouldAppend) el.textContent = "";
        for (const ch of valStr) {
          el.textContent += ch;
          _fireInput(el);
          await _sleep(delay || 50);
        }
        _fireChange(el);
        return { kind, length: el.textContent.length };
      }

      // Text-like. Typed a character at a time so per-keystroke handlers
      // (autocomplete, validation, search-as-you-type) see the same sequence a
      // person would produce.
      let typed = shouldAppend ? String(el.value ?? "") : "";
      if (!shouldAppend) {
        _setNativeValue(el, "");
        _fireInput(el);
      }
      for (const ch of valStr) {
        typed += ch;
        _setNativeValue(el, typed);
        _fireInput(el);
        await _sleep(delay || 50);
      }
      _fireChange(el);

      // Verify it stuck. A framework that reverts the value is the whole point of
      // _setNativeValue, and reporting success while the field is empty is what
      // made this so hard to see. maxlength and input masks legitimately shorten
      // what lands, so a truncation to the field's limit counts as accepted.
      const max = el.maxLength;
      const truncated = max >= 0 ? typed.slice(0, max) : null;
      if (el.value !== typed && el.value !== truncated) {
        throw new Error(
          `Fill did not stick: typed ${JSON.stringify(typed)}, field holds ${JSON.stringify(el.value)}. The page may be controlling this input.`,
        );
      }
      return { kind, typed: el.value };
    }

    if (mode === "multi" && fields.length > 0) {
      const results = [];
      const missing = [];
      const skipped = [];
      for (const f of fields) {
        const el = _queryScoped(f.selector, context, false)[0];
        if (!el) {
          // Skipping silently meant a half-filled form was reported as a full
          // success, and the submit click went through anyway.
          missing.push(f.selector);
          continue;
        }
        // A trap is not a missing field: the form is still complete without
        // it, and it is the one field where doing nothing is the correct
        // answer. Recorded rather than dropped, so the log can say so.
        const trap = _honeypotReason(el);
        if (trap) {
          skipped.push({ selector: f.selector, reason: trap });
          continue;
        }
        results.push(
          await _typeInto(el, f.value ?? "", delayMs, f.append || false),
        );
        await _sleep(120);
      }
      if (missing.length) {
        throw new Error(`Fill target not found: ${missing.join(", ")}`);
      }
      if (submitSelector) {
        const btn = _queryScoped(submitSelector, context, false)[0];
        if (!btn) throw new Error(`Submit target not found: ${submitSelector}`);
        btn.scrollIntoView();
        await _sleep(200);
        btn.click();
      }
      return { filled: results.length, fields: results, skipped };
    }

    // single mode. The old code fell back to the scope root when the selector
    // matched nothing, so a typo typed into whatever container the loop was on.
    const el = _queryScoped(selector, context, false)[0];
    if (!el) throw new Error(`Fill target not found: ${selector}`);
    const result = await _typeInto(el, text, delayMs, append);
    return { typed: true, ...result };
  }

  /**
   * Hover an element — as far as a page script is allowed to.
   *
   * Measured in a real browser, a synthetic hover half works:
   *
   *   * a JavaScript `mouseover` / `mouseenter` listener fires — menus built
   *     that way open;
   *   * a CSS `:hover` rule does **not** apply.
   *
   * The second is not a defect here and cannot be fixed from a content script.
   * `:hover` follows the browser's real pointer, and no page may move the
   * cursor — one that could would be able to fake a click on anything. So a
   * CSS-only dropdown cannot be opened this way by any extension that does not
   * attach a debugger to the browser.
   *
   * What *was* wrong is that this reported success either way. Given
   * `revealSelector` it waits for the thing the hover is meant to bring up, and
   * says plainly when nothing came — because silence here means every step after
   * it works on a menu that never opened.
   */
  async function _stepHover(
    { selector, revealSelector = "", timeout = 3000 },
    context = {},
  ) {
    const el =
      _queryScoped(selector, context, false)[0] || _getScopedRoot(context);
    if (!el) throw new Error(`Hover target not found: ${selector}`);
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    await _sleep(150);
    const r = el.getBoundingClientRect();
    const cx = Math.round(r.left + r.width / 2);
    const cy = Math.round(r.top + r.height / 2);
    const init = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: cx,
      clientY: cy,
    };
    // pointerover/pointerenter before the mouse events, in that order: that is
    // the sequence a real pointer produces, and libraries that listen for the
    // pointer events ignore a mouse event arriving first.
    el.dispatchEvent(
      new PointerEvent("pointerover", { ...init, pointerId: 1 }),
    );
    el.dispatchEvent(
      new PointerEvent("pointerenter", { ...init, pointerId: 1 }),
    );
    el.dispatchEvent(new MouseEvent("mouseover", init));
    el.dispatchEvent(new MouseEvent("mouseenter", init));
    el.dispatchEvent(
      new PointerEvent("pointermove", { ...init, pointerId: 1 }),
    );
    el.dispatchEvent(new MouseEvent("mousemove", init));

    if (!revealSelector) return { hovered: true, x: cx, y: cy, revealed: null };

    const deadline = Date.now() + (Number(timeout) || 3000);
    while (Date.now() < deadline) {
      if (_queryScoped(revealSelector, context, false).some(_isVisible)) {
        return { hovered: true, x: cx, y: cy, revealed: true };
      }
      await _sleep(100);
    }
    throw new Error(
      `Hovered "${selector}" but "${revealSelector}" never appeared. ` +
        `If this menu opens through a CSS :hover rule, no extension can open it ` +
        `without attaching a debugger to the browser: :hover follows the real ` +
        `mouse pointer, which a page is not allowed to move. Try CLICK if the ` +
        `menu also opens on click.`,
    );
  }

  /**
   * Choose an option on a <select>.
   *
   * `el.value = x` on a select whose options do not contain x sets it to "" —
   * the select is silently *cleared*, and the old code reported success (B-23).
   * Matching is tried by value, then by visible label, then case-insensitively,
   * because the label is what the user sees and therefore what they type into
   * the step config.
   *
   * @param {HTMLSelectElement} el
   * @param {string} value
   */
  function _setSelectValue(el, value) {
    const want = String(value ?? "");
    const norm = (s) =>
      String(s ?? "")
        .trim()
        .toLowerCase();
    const options = Array.from(el.options || []);

    const match =
      options.find((o) => o.value === want) ??
      options.find((o) => o.text.trim() === want.trim()) ??
      options.find((o) => norm(o.value) === norm(want)) ??
      options.find((o) => norm(o.text) === norm(want));

    if (!match) {
      throw new Error(
        `Select has no option matching ${JSON.stringify(want)}. Available: ${
          options.map((o) => o.value || o.text.trim()).join(", ") || "(none)"
        }`,
      );
    }

    if (match.disabled) {
      throw new Error(`Select option ${JSON.stringify(want)} is disabled.`);
    }

    el.value = match.value;
    // A select fires input as well as change when a person picks an option, and
    // frameworks listen for input. Only change was sent before.
    _fireInput(el);
    _fireChange(el);
    return { kind: "select", selected: match.value, label: match.text.trim() };
  }

  async function _stepSelect({ selector, value }, context = {}) {
    const el = _queryScoped(selector, context, false)[0];
    if (!el) throw new Error(`Select target not found: ${selector}`);
    if (el.tagName !== "SELECT") {
      throw new Error(
        `Select target is a <${el.tagName.toLowerCase()}>, not a <select>.`,
      );
    }
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    await _sleep(100);
    return { selected: true, ..._setSelectValue(el, value) };
  }

  /**
   * The `code` value a physical key would report.
   *
   * The old rule was `"Key" + upper` for any single character, which produced
   * `Key1` for a digit (it is `Digit1`) and `Key-` for a symbol (`Minus`) —
   * neither of which is a real code, so any site keyed on `event.code` ignored
   * the event entirely (B-24).
   *
   * @param {string} key
   * @returns {string}
   */
  function _keyToCode(key) {
    if (key.length !== 1) return _NAMED_KEY_CODES[key] ?? key;
    if (key >= "a" && key <= "z") return `Key${key.toUpperCase()}`;
    if (key >= "A" && key <= "Z") return `Key${key}`;
    if (key >= "0" && key <= "9") return `Digit${key}`;
    return _SYMBOL_KEY_CODES[key] ?? "";
  }

  /** US-layout codes for the punctuation reachable without a modifier. */
  const _SYMBOL_KEY_CODES = Object.freeze({
    " ": "Space",
    "-": "Minus",
    "=": "Equal",
    "[": "BracketLeft",
    "]": "BracketRight",
    "\\": "Backslash",
    ";": "Semicolon",
    "'": "Quote",
    "`": "Backquote",
    ",": "Comma",
    ".": "Period",
    "/": "Slash",
  });

  /** Named keys whose code differs from their key value. */
  const _NAMED_KEY_CODES = Object.freeze({
    Escape: "Escape",
    Enter: "Enter",
    Tab: "Tab",
    Backspace: "Backspace",
    Delete: "Delete",
    " ": "Space",
    Space: "Space",
    ArrowUp: "ArrowUp",
    ArrowDown: "ArrowDown",
    ArrowLeft: "ArrowLeft",
    ArrowRight: "ArrowRight",
    Home: "Home",
    End: "End",
    PageUp: "PageUp",
    PageDown: "PageDown",
  });

  /** More presses than this is a stuck key, not an instruction. */
  const KEYBOARD_MAX_REPEAT = 500;

  /**
   * Press a key, optionally at a named element and more than once.
   *
   * It used to dispatch at `document.activeElement`, once, with no way to say
   * where. So "type into the search box and press Enter" needed a CLICK first
   * and worked only if that click happened to focus the right thing — and
   * pressing a key twice needed two steps.
   *
   * A selector that matches nothing throws rather than falling back to whatever
   * has focus: the fallback sends the key to the page body, where it does
   * nothing, and the step reports success.
   */
  async function _stepKeyboard(
    { key, selector = "", repeat = 1, delayMs = 50 },
    context = {},
  ) {
    // key may be a combo like "Ctrl+Enter" or "Shift+Alt+Delete"
    const parts = (key || "Enter").split("+");
    const mainKey = parts[parts.length - 1];
    const ctrlKey = parts.includes("Ctrl");
    const altKey = parts.includes("Alt");
    const shiftKey = parts.includes("Shift");
    const metaKey = parts.includes("Meta");

    let active;
    if (selector) {
      const el = _queryScoped(selector, context, false)[0];
      if (!el) throw new Error(`Keyboard: nothing matched "${selector}".`);
      // Focus as well as target it: a key event dispatched at an input the page
      // does not consider focused is ignored by most editors and frameworks.
      try {
        el.focus?.();
      } catch {}
      active = el;
    } else {
      active = document.activeElement || document.body;
    }

    const times = Math.max(
      1,
      Math.min(KEYBOARD_MAX_REPEAT, Math.floor(Number(repeat) || 1)),
    );
    const gap = Math.max(0, Number(delayMs) ?? 50);
    const code = _keyToCode(mainKey);
    const which = mainKey.length === 1 ? mainKey.charCodeAt(0) : 0;
    const evInit = {
      key: mainKey,
      code,
      which,
      charCode: which,
      keyCode: which,
      bubbles: true,
      cancelable: true,
      ctrlKey,
      altKey,
      shiftKey,
      metaKey,
    };

    for (let i = 0; i < times; i++) {
      active.dispatchEvent(new KeyboardEvent("keydown", evInit));
      active.dispatchEvent(new KeyboardEvent("keypress", evInit));
      await _sleep(Math.min(40, gap));
      active.dispatchEvent(new KeyboardEvent("keyup", evInit));
      if (i < times - 1 && gap > 0) await _sleep(gap);
    }
    return { keypressed: key, repeated: times, selector: selector || null };
  }

  async function _stepDragDrop({ source, target }, context = {}) {
    const src =
      _queryScoped(source, context, false)[0] || _getScopedRoot(context);
    const tgt = _queryScoped(target, context, false)[0] || null;
    if (!src || !tgt) throw new Error(`Drag/drop source or target not found`);
    const sr = src.getBoundingClientRect();
    const tr = tgt.getBoundingClientRect();
    const sx = sr.left + sr.width / 2,
      sy = sr.top + sr.height / 2;
    const tx = tr.left + tr.width / 2,
      ty = tr.top + tr.height / 2;
    const dt = new DataTransfer();
    const mki = (x, y) => ({
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
    });
    src.dispatchEvent(
      new PointerEvent("pointerdown", { ...mki(sx, sy), pointerId: 1 }),
    );
    src.dispatchEvent(new MouseEvent("mousedown", mki(sx, sy)));
    await _sleep(80);
    src.dispatchEvent(
      new DragEvent("dragstart", { ...mki(sx, sy), dataTransfer: dt }),
    );
    await _sleep(80);
    // simulate movement in 5 steps
    for (let i = 1; i <= 5; i++) {
      const x = sx + ((tx - sx) * i) / 5,
        y = sy + ((ty - sy) * i) / 5;
      const over = document.elementFromPoint(x, y) || tgt;
      over.dispatchEvent(
        new DragEvent("dragover", { ...mki(x, y), dataTransfer: dt }),
      );
      await _sleep(25);
    }
    tgt.dispatchEvent(
      new DragEvent("dragenter", { ...mki(tx, ty), dataTransfer: dt }),
    );
    tgt.dispatchEvent(
      new DragEvent("drop", { ...mki(tx, ty), dataTransfer: dt }),
    );
    await _sleep(60);
    src.dispatchEvent(
      new DragEvent("dragend", { ...mki(tx, ty), dataTransfer: dt }),
    );
    src.dispatchEvent(new MouseEvent("mouseup", mki(tx, ty)));
    src.dispatchEvent(
      new PointerEvent("pointerup", { ...mki(tx, ty), pointerId: 1 }),
    );
    return { dragged: true };
  }

  /** Collapse every run of whitespace to one space, and trim. */
  function _normText(v) {
    return String(v ?? "")
      .replace(/\s+/g, " ")
      .trim();
  }

  /**
   * Look at the element a branch asks about, and report what is there.
   *
   * It does not decide. Deciding needs the same number reader EXTRACT uses —
   * a branch reading "1.234,56" as 1.234 would take the wrong path on every
   * European price — and a classic content script cannot import the module that
   * holds it. A second parser here would drift from the first (G-01), so the
   * worker evaluates against `utils/conditions.js` and this only reads the DOM.
   *
   * A branch can compare against a second element rather than a typed value —
   * "is the sale price under the list price", "has the count changed" — so it
   * reports that one too, under `other`, read exactly the same way. Both sides
   * in one message: a second round trip would read the two at different
   * moments, and on a page that updates itself that is a comparison between
   * two states rather than between two elements.
   *
   * @returns {{exists: boolean, text: string, attrValue: ?string, other: ?object}}
   */
  async function _stepIfElse(
    { selector, attr = "", compareTo = "value", valueSelector = "" },
    context = {},
  ) {
    const read = (sel) => {
      const el = sel ? _queryScoped(sel, context, false)[0] || null : null;
      return {
        exists: !!el,
        // Unnormalised: the worker normalises, so both sides cannot disagree
        // about what counts as whitespace (B-25).
        text: el ? el.textContent : "",
        attrValue: el && attr ? el.getAttribute(attr) : null,
      };
    };
    const observed = read(selector);
    observed.other =
      compareTo === "selector" && valueSelector ? read(valueSelector) : null;
    return observed;
  }

  /**
   * Report what an ASSERT's selector matches, and nothing more.
   *
   * The comparison happens in the worker against utils/assertions.js, the same
   * split IF_ELSE uses: a second copy of "does this text match" here would be a
   * second definition to drift from the first (G-01). This is `_queryScoped`,
   * so an assertion sees exactly what the steps it is guarding see — shadow
   * roots, `>>>` paths, XPath and the loop's scoped root included.
   *
   * @returns {{count: number, text: string}}
   */
  async function _stepAssert({ selector = "" }, context = {}) {
    const els = _queryScoped(selector, context, true);
    return {
      count: els.length,
      // Unnormalised, like IF_ELSE's: the worker normalises, so the two cannot
      // disagree about what counts as whitespace (B-25).
      text: els.length ? els[0].textContent : "",
    };
  }

  // ── Form fill row ─────────────────────────────────────────────────────────────
  async function _formFillRow({ config, row, rowIndex, context }) {
    // Dynamically load form-filler (keeps injector.js small)
    const mod = await import(chrome.runtime.getURL("content/form-filler.js"));
    return mod.executeRow(config, row, rowIndex, context);
  }

  // ── Bulk selector — finds the common pattern for sibling elements ─────────────────
  function _buildBulkSelector(el) {
    // Build path from element up to the first repeating container
    let path = [];
    let current = el;
    let foundBulkSequence = false;
    // Set when the repetition was recognised from the tag alone, with nothing
    // on the element to name it. A bare tag is a true bulk answer — every image
    // in the grid *is* `img` — but on its own it also matches every image on
    // the page, so it is only accepted once a container is in the path.
    let needsAnchor = false;

    for (let depth = 0; depth < 5; depth++) {
      if (!current || current === document.documentElement) break;

      const parent = current.parentElement;
      const sameTagSiblings = parent
        ? Array.from(parent.children).filter(
            (c) => c.tagName === current.tagName,
          )
        : [];

      let part = current.tagName.toLowerCase();

      if (!foundBulkSequence && sameTagSiblings.length > 1) {
        // Find common classes across siblings
        const sigClass = _findCommonClass(sameTagSiblings);
        if (sigClass) {
          part += `.${CSS.escape(sigClass)}`;
          foundBulkSequence = true;
        } else if (["li", "tr", "td", "article", "section"].includes(part)) {
          // Repetition found, but this element is one of several *different*
          // things repeating side by side — the three cells of a table row, not
          // the rows. Returning the bare tag here is what made bulk picking a
          // price cell return `td`: every cell of every column, names and
          // authors and prices interleaved into one column of nonsense.
          //
          // Bulk means "this field, in every record" — one element per record,
          // not every sibling. So keep whatever distinguishes this element from
          // the siblings it is being confused with: its own class, else its
          // position among them.
          const own = Array.from(current.classList || []).find(
            (c) =>
              c.length > 1 &&
              !/^(active|selected|hover|first|last|odd|even)/.test(c) &&
              !/\d/.test(c),
          );
          if (own) {
            part += `.${CSS.escape(own)}`;
          } else {
            const idx = sameTagSiblings.indexOf(current) + 1;
            if (idx > 0) part += `:nth-of-type(${idx})`;
          }
          foundBulkSequence = true;
        } else {
          // Repetition with nothing to name it: a grid of bare <img>, a list of
          // <a>, a column of <p>. This used to fall through with the sequence
          // unrecognised, so the path built here was discarded and the
          // *specific* selector returned instead — `div.grid > img:nth-of-type(1)`
          // for a picker the user had put in Bulk mode, matching one image of
          // four. Reported from real use twice (VQ-01).
          //
          // The siblings here are the same kind of thing as each other, which
          // is what separates this from the td case above: every cell of a row
          // is a different field, but every image of a grid is an image.
          foundBulkSequence = true;
          needsAnchor = true;
        }
      } else {
        // Try to add stable classes
        if (current.className && typeof current.className === "string") {
          const stableClasses = current.className
            .split(/\s+/)
            .filter((c) => c && !/[\d_]/.test(c) && !c.includes("hover"));
          if (stableClasses.length > 0) {
            part += `.${CSS.escape(stableClasses[0])}`;
          }
        }
      }

      path.unshift(part);

      // If we've established a solid array anchor, check if it matches enough targets globally
      if (foundBulkSequence) {
        try {
          const candidate = path.join(" > ");
          // A bare tag needs its container before it means anything: `img`
          // matches the site logo and the footer badge too.
          const anchored = !needsAnchor || path.length >= 2;
          if (anchored && document.querySelectorAll(candidate).length >= 2) {
            return {
              selector: candidate,
              count: document.querySelectorAll(candidate).length,
            };
          }
        } catch {}
      }

      current = parent;
    }

    return {
      selector: _buildSpecificSelector(el),
      count: document.querySelectorAll(_buildSpecificSelector(el)).length,
    };
  }

  function _findCommonClass(elements) {
    if (!elements.length) return "";
    const classSets = elements.map((el) => Array.from(el.classList || []));
    // Find classes present in ALL elements
    const common = classSets[0].filter(
      (cls) =>
        cls.length > 1 && // skip single-char utility classes
        !cls.match(/^(active|selected|hover|first|last|odd|even|\d)/) && // skip state classes
        classSets.every((set) => set.includes(cls)),
    );
    return common[0] || "";
  }

  /**
   * A structural path to exactly one element.
   *
   * Positional, because it is the fallback used when nothing on the page names
   * the element — but not blindly positional. Every level used to be emitted as
   * `tag:nth-of-type(n)`, which produced
   * `body:nth-of-type(1) > table:nth-of-type(1) > tbody:nth-of-type(1) > tr:nth-of-type(2) > td:nth-of-type(1)`
   * where `table.books > tbody > tr:nth-of-type(2) > td.name` says the same thing
   * and survives the page gaining a second table. So each level uses the name the
   * page gave it and adds an index only where the name is ambiguous, the path
   * stops as soon as it is unique, and `html`/`body` are never emitted — they are
   * one per document and add nothing but noise.
   */
  function _buildNthPath(node, maxDepth = 8) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return "*";

    const stable = (c) =>
      c.length > 1 &&
      !/^(is|has|js|ng|v|active|open|show|hide|selected|disabled|hover|first|last|odd|even)([-_]|$)/.test(
        c,
      ) &&
      !/\d/.test(c);

    const parts = [];
    let current = node;
    let depth = 0;

    while (current && depth < maxDepth) {
      const tag = current.tagName.toLowerCase();
      if (tag === "html" || tag === "body") break;

      if (current.id) {
        parts.unshift(`#${CSS.escape(current.id)}`);
        break;
      }

      const parent = current.parentElement;
      const cls = Array.from(current.classList || []).find(stable);
      let part = cls ? `${tag}.${CSS.escape(cls)}` : tag;

      // An index only where the name does not already single this element out
      // among its siblings.
      if (parent) {
        const twins = Array.from(parent.children).filter((c) => {
          if (c.tagName.toLowerCase() !== tag) return false;
          return cls ? c.classList.contains(cls) : true;
        });
        if (twins.length > 1) {
          const sameType = Array.from(parent.children).filter(
            (c) => c.tagName.toLowerCase() === tag,
          );
          const idx = sameType.indexOf(current) + 1;
          if (idx > 0) part += `:nth-of-type(${idx})`;
        }
      }

      parts.unshift(part);

      // Stop as soon as the path is unambiguous; anything above it is noise.
      const chain = parts.join(" > ");
      try {
        if (document.querySelectorAll(chain).length === 1) return chain;
      } catch {}

      current = parent;
      depth++;
    }

    return parts.join(" > ") || node.tagName.toLowerCase();
  }

  function _buildSpecificSelector(el) {
    if (el.id) return `#${CSS.escape(el.id)}`;
    const tag = el.tagName.toLowerCase();
    const cls = Array.from(el.classList || [])
      .filter((c) => !c.match(/^(active|selected|hover|open|show)/))
      .slice(0, 2);
    if (cls.length) return `${tag}.${cls.map((c) => CSS.escape(c)).join(".")}`;
    // Never return a bare tag; use structural path fallback.
    return _buildNthPath(el);
  }

  // ── Selector picker overlay ────────────────────────────────────────────────────
  let _pickerActive = false;
  let _pickerResolve = null;
  /** Set by the active picker so another frame's win can tear this one down. */
  let _pickerCancel = null;

  function _cancelPicker() {
    _pickerCancel?.();
  }

  /**
   * Let the user click an element and return a selector for it.
   *
   * Cancelling used to be impossible. The promise resolved only from onClick —
   * no Escape, no right-click, no timeout — so a user who changed their mind left
   * `_pickerActive` true for the life of the page, every later pick returned null
   * immediately, and the side panel sat awaiting a message that never came. Only
   * a page reload recovered it.
   *
   * @param {{ bulk?: boolean }} payload
   * @returns {Promise<string|null>} selector, or null if cancelled
   */
  async function _activateSelectorPicker(payload) {
    if (_pickerActive) return null;
    _pickerActive = true;
    const isBulk = payload?.bulk === true;
    // Set when the field being picked lives inside a LOOP: the selector comes
    // back relative to the record rather than to the page.
    const scopeSelector = String(payload?.scopeSelector || "");

    return new Promise((resolve) => {
      _pickerResolve = resolve;

      // The blocker div. The host element sets pointer-events:none so the rest of
      // our shadow UI never eats page clicks, and this inherited it — so despite
      // the comment that used to sit here, it blocked nothing and the page kept
      // firing its own hover styles under the crosshair.
      const overlay = document.createElement("div");
      overlay.style.cssText = [
        "position:fixed;top:0;left:0;width:100%;height:100%;",
        "z-index:2147483645;cursor:crosshair;background:transparent;",
        "pointer-events:auto;",
      ].join("");
      _shadow.appendChild(overlay);

      let currentTarget = null;
      const highlight = document.createElement("div");
      highlight.style.cssText = [
        "position:fixed;pointer-events:none;border:2px solid #2563eb;",
        "background:rgba(37,99,235,0.1);border-radius:4px;transition:all 0.1s;z-index:2147483647;",
      ].join("");

      // Tiny instruction tooltip attached to the highlight
      const tooltip = document.createElement("div");
      tooltip.style.cssText =
        "position:absolute;bottom:-24px;left:-2px;background:#2563eb;color:#fff;font-size:10px;padding:2px 6px;border-radius:4px;white-space:nowrap;font-family:sans-serif;pointer-events:none;";
      tooltip.textContent = scopeSelector
        ? `Pick a field inside a ${scopeSelector} · Esc to cancel`
        : "Click to pick · Esc to cancel";
      highlight.appendChild(tooltip);

      /** Say something in the tooltip without ending the pick. */
      function _pickerNote(text) {
        tooltip.textContent = text;
        tooltip.style.background = "#dc2626";
        setTimeout(() => {
          tooltip.style.background = "#2563eb";
          tooltip.textContent = scopeSelector
            ? `Pick a field inside a ${scopeSelector} · Esc to cancel`
            : "Click to pick · Esc to cancel";
        }, 2200);
      }

      // Outline the records the field will be read from, so it is obvious where
      // a pick is meaningful.
      const scopeMarks = [];
      if (scopeSelector) {
        try {
          for (const record of document.querySelectorAll(scopeSelector)) {
            const r = record.getBoundingClientRect();
            if (!r.width && !r.height) continue;
            const mark = document.createElement("div");
            mark.style.cssText = [
              "position:fixed;pointer-events:none;border:1px dashed #16a34a;",
              "border-radius:4px;z-index:2147483646;",
              `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;`,
            ].join("");
            _shadow.appendChild(mark);
            scopeMarks.push(mark);
          }
        } catch {}
      }

      _shadow.appendChild(highlight);

      // So a win in another frame can disarm this one: the picker is armed in
      // every frame at once and only the clicked frame settles on its own.
      _pickerCancel = () => finish(null);

      document.addEventListener("mousemove", onMove, true); // Capture phase!
      document.addEventListener("click", onClick, true);
      document.addEventListener("keydown", onKey, true);
      document.addEventListener("contextmenu", onContextMenu, true);
      window.addEventListener("beforeunload", onUnload);

      let _blockTimer = null;
      let _lastX = 0,
        _lastY = 0;

      function _isIgnoredPickerTarget(el) {
        if (!el || el === _host || el === overlay || el === highlight)
          return true;
        if (el === document.documentElement || el === document.body)
          return true;
        return false;
      }

      function _pickRealTargetAtPoint(x, y) {
        const prevDisplay = _host.style.display;
        _host.style.display = "none";
        const stack = document.elementsFromPoint(x, y);
        _host.style.display = prevDisplay;

        const base =
          stack.find((node) => !_isIgnoredPickerTarget(node)) || null;
        if (!base) return null;

        const clickable = base.closest?.(
          "button,a,input,textarea,select,[role='button'],[contenteditable='true'],[aria-label]",
        );
        return clickable && !_isIgnoredPickerTarget(clickable)
          ? clickable
          : base;
      }

      function _pickTargetFromEvent(e) {
        const path = Array.isArray(e?.composedPath?.()) ? e.composedPath() : [];
        const base =
          path.find(
            (node) =>
              node &&
              node.nodeType === Node.ELEMENT_NODE &&
              !_isIgnoredPickerTarget(node),
          ) || null;
        if (!base) return null;

        const clickable = base.closest?.(
          "button,a,input,textarea,select,[role='button'],[contenteditable='true'],[aria-label]",
        );
        return clickable && !_isIgnoredPickerTarget(clickable)
          ? clickable
          : base;
      }

      function _updateHighlight() {
        if (!currentTarget) return;
        const rect = currentTarget.getBoundingClientRect();

        Object.assign(highlight.style, {
          top: `${rect.top}px`,
          left: `${rect.left}px`,
          width: `${rect.width}px`,
          height: `${rect.height}px`,
        });
      }

      /**
       * Let a click through to an iframe's own picker.
       *
       * The blocker overlay covers the whole viewport so the page cannot fire
       * its own hover styles under the crosshair (E-03) — and it covers any
       * iframe on the page too. So a click aimed at something *inside* a frame
       * hit this overlay first, the top document resolved the point to the
       * `<iframe>` element, and the picker returned a selector for the frame
       * rather than the thing in it. "It found the element, but not properly."
       *
       * The picker is armed in every frame at once, so the frame will answer
       * for itself if the event is allowed to reach it. Blocking is relaxed
       * only while the pointer is over a frame, which is exactly when this
       * document is not the one that should be answering.
       *
       * Moving back out is still noticed: the listener is on `document` in the
       * capture phase, so it fires for events dispatched on page elements
       * whether or not the overlay is transparent.
       */
      function _setOverlayPassthrough(target) {
        const isFrame =
          target?.tagName === "IFRAME" || target?.tagName === "FRAME";
        overlay.style.pointerEvents = isFrame ? "none" : "auto";
      }

      function onMove(e) {
        _lastX = e.clientX;
        _lastY = e.clientY;
        if (!_blockTimer) {
          _blockTimer = requestAnimationFrame(() => {
            const realTarget =
              _pickTargetFromEvent(e) || _pickRealTargetAtPoint(_lastX, _lastY);
            _blockTimer = null;
            if (!realTarget) return;
            _setOverlayPassthrough(realTarget);
            currentTarget = realTarget;
            _updateHighlight();
          });
        }
      }

      /**
       * Tear everything down exactly once and settle the promise.
       * Every exit path goes through here, so the picker cannot be left armed.
       * @param {string|null} selector
       */
      function finish(selector) {
        if (!_pickerActive) return; // already settled
        _pickerActive = false;
        _pickerCancel = null;

        document.removeEventListener("mousemove", onMove, true);
        document.removeEventListener("click", onClick, true);
        document.removeEventListener("keydown", onKey, true);
        document.removeEventListener("contextmenu", onContextMenu, true);
        window.removeEventListener("beforeunload", onUnload);

        if (_blockTimer) cancelAnimationFrame(_blockTimer);
        overlay.remove();
        highlight.remove();
        for (const mark of scopeMarks) mark.remove();

        const settle = _pickerResolve;
        _pickerResolve = null;
        settle?.(selector);
      }

      /**
       * A picked selector, plus the document it belongs to.
       *
       * The picker is armed in every frame at once, so the frame the user
       * actually clicked in is the one that answers. Its selector is relative
       * to its own document and means nothing in the parent — which is why
       * picking inside an iframe appeared to work and then matched nothing at
       * run time. The frame's URL travels with it so the run can be aimed at
       * the same document the user was looking at.
       */
      function _result(selector) {
        if (selector === null) return null;
        return {
          selector,
          frameUrl: window.top === window ? "" : location.href,
          top: window.top === window,
        };
      }

      function onClick(e) {
        e.preventDefault();
        e.stopPropagation();

        // Resolve again at click time so we don't keep a stale container target.
        currentTarget =
          _pickTargetFromEvent(e) ||
          _pickRealTargetAtPoint(e.clientX, e.clientY) ||
          currentTarget;

        if (!currentTarget) return finish(null);
        if (scopeSelector) {
          const rel = _buildScopedSelector(currentTarget, scopeSelector);
          if (!rel) {
            // Outside every record. A page-wide selector here would put the same
            // value in every row, which is what the unscoped picker did.
            _pickerNote(
              `That is not inside a ${scopeSelector}. Pick something within one of the highlighted records.`,
            );
            return;
          }
          return finish(_result(rel));
        }
        finish(_result(_buildSelector(currentTarget, isBulk)));
      }

      function onKey(e) {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        finish(null);
      }

      function onContextMenu(e) {
        // Right-click is the other reflex for "get me out of this mode".
        e.preventDefault();
        e.stopPropagation();
        finish(null);
      }

      function onUnload() {
        // A navigation destroys the page the picker was pointing at; settle so
        // the caller is not left waiting on a tab that no longer exists.
        finish(null);
      }
    });
  }

  /**
   * Describe an element relative to the record that contains it.
   *
   * When an EXTRACT sits inside a LOOP over `.card`, the loop already says what
   * a record is. The field only has to say where *within* a card to look — so
   * `.title`, not `.grid > .card:nth-of-type(2) > .title`, which finds the second
   * card's title in every row.
   *
   * The unscoped bulk picker guessed at this by walking up five levels of
   * direct-child combinators and stopping at the first selector matching two
   * elements. On a grid of product cards that lands almost anywhere, which is
   * what "bulk extract gives wrong answers" was.
   *
   * @param {Element} el
   * @param {string} scopeSelector - the loop's container selector
   * @returns {?string} null when the element is not inside any container;
   *   ":scope" when it *is* the container
   */
  function _buildScopedSelector(el, scopeSelector) {
    if (!el || !scopeSelector) return null;
    let root;
    try {
      root = el.closest(scopeSelector);
    } catch {
      return null;
    }
    if (!root) return null;
    if (root === el) return ":scope";

    // Prefer a class the element carries and no sibling in the record shares.
    const parts = [];
    let node = el;
    while (node && node !== root && node.parentElement) {
      const cls = [...node.classList].find(
        (c) =>
          !/^(is|has|js|ng|v|active|open|show|hide|selected|disabled)([-_]|$)|\d/.test(
            c,
          ),
      );
      if (cls) {
        const short = `.${CSS.escape(cls)}`;
        const candidate = parts.length
          ? `${short} ${parts.join(" > ")}`
          : short;
        // Only if it is unambiguous inside the record; otherwise keep climbing.
        try {
          if (root.querySelectorAll(candidate).length === 1) return candidate;
        } catch {}
      }
      const tag = node.tagName.toLowerCase();
      const sameTag = [...node.parentElement.children].filter(
        (c) => c.tagName === node.tagName,
      );
      parts.unshift(
        sameTag.length > 1
          ? `${tag}:nth-of-type(${sameTag.indexOf(node) + 1})`
          : tag,
      );
      node = node.parentElement;
    }
    return parts.join(" > ") || null;
  }

  /**
   * The chain of shadow hosts between the document and `el`, outermost first.
   *
   * `getRootNode()` returns the ShadowRoot an element lives in; its `host` is
   * the element in the parent tree. Walking that gives the boundaries a
   * selector has to cross.
   */
  /**
   * Describe `el` relative to the shadow root that contains it.
   *
   * Ids and classes inside a component are scoped to it, so they are usually
   * both short and unambiguous there — which is the one good thing about the
   * boundary that otherwise makes this hard.
   */
  function _selectorWithin(el, root, bulk) {
    const tag = el.tagName.toLowerCase();
    const stable = (c) =>
      c.length > 1 &&
      !/^(is|has|js|ng|v|active|open|show|hide|selected|disabled|hover)([-_]|$)/.test(
        c,
      ) &&
      !/\d/.test(c);

    const tryUnique = (sel) => {
      try {
        const n = root.querySelectorAll(sel).length;
        return bulk ? n >= 1 : n === 1;
      } catch {
        return false;
      }
    };

    if (el.id) {
      const byId = `#${CSS.escape(el.id)}`;
      if (tryUnique(byId)) return byId;
    }
    for (const attr of ["data-testid", "aria-label", "name", "role"]) {
      const v = el.getAttribute?.(attr);
      if (!v || v.length > 120) continue;
      const sel = `${tag}[${attr}="${CSS.escape(v)}"]`;
      if (tryUnique(sel)) return sel;
    }
    const cls = Array.from(el.classList || []).filter(stable);
    for (let n = 1; n <= Math.min(2, cls.length); n++) {
      const sel = `${tag}.${cls
        .slice(0, n)
        .map((c) => CSS.escape(c))
        .join(".")}`;
      if (tryUnique(sel)) return sel;
    }
    if (cls.length) {
      return `${tag}.${CSS.escape(cls[0])}`;
    }
    // Positional within the shadow root, which is a small tree.
    const parent = el.parentElement;
    if (parent) {
      const sameTag = [...parent.children].filter(
        (c) => c.tagName === el.tagName,
      );
      if (sameTag.length > 1) {
        return `${tag}:nth-of-type(${sameTag.indexOf(el) + 1})`;
      }
    }
    return tag;
  }

  function _shadowHostChain(el) {
    const hosts = [];
    let node = el;
    for (let i = 0; i < 10; i++) {
      const root = node?.getRootNode?.();
      if (!root || root === document || !root.host) break;
      hosts.unshift(root.host);
      node = root.host;
    }
    return hosts;
  }

  function _buildSelector(el, bulk = false) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return "*";
    if (el.tagName.toLowerCase() === "html") return "html";

    // Inside a web component, no plain CSS selector can reach this element —
    // the boundary is not expressible. Describe the hosts and the element
    // separately and join them with the piercing combinator.
    const hosts = _shadowHostChain(el);
    if (hosts.length > 0) {
      // Each host is described relative to the root *it* lives in. Recursing
      // into _buildSelector for every host re-walked the whole chain from the
      // document each time, so a component two levels deep named its outermost
      // host twice: `shop-card >>> shop-card >>> shop-badge >>> .rating`.
      const parts = hosts.map((host, i) =>
        i === 0
          ? _buildSelector(host, false)
          : _selectorWithin(host, host.getRootNode(), false),
      );
      parts.push(_selectorWithin(el, el.getRootNode(), bulk));
      return parts.join(` ${PIERCE} `);
    }
    if (el.tagName.toLowerCase() === "body") return "body";

    // 0. Intelligent Bulk Engine (for LOOP and EXTRACT)
    if (bulk) {
      const res = _buildBulkSelector(el);
      if (res && res.selector !== "*") return res.selector;
    }

    const semantics = [
      "data-testid",
      "data-test",
      "data-view-name",
      "data-id",
      "name",
      "aria-label",
      "placeholder",
      "role",
      "type",
      "title",
      "alt",
    ];

    const isLikelyStableClass = (c) => {
      if (!c) return false;
      if (/^(active|selected|hover|focus|open|show|disabled)$/i.test(c))
        return false;
      if (/^ng-|^css-|^jsx-|^sc-/.test(c)) return false;
      if (/\d{4,}/.test(c)) return false;
      if (/^(x|y|z|sm|md|lg|xl)$/i.test(c)) return false;
      return true;
    };

    const qCount = (sel) => {
      try {
        return document.querySelectorAll(sel).length;
      } catch {
        return 0;
      }
    };

    const nthOfType = (node) => {
      const tag = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (!parent) return tag;
      const siblings = Array.from(parent.children).filter(
        (c) => c.tagName.toLowerCase() === tag,
      );
      const idx = siblings.indexOf(node) + 1;
      return idx > 0 ? `${tag}:nth-of-type(${idx})` : tag;
    };

    const unique = (sel) => qCount(sel) === 1;

    const buildNodeCandidates = (node) => {
      const tag = node.tagName.toLowerCase();
      const out = [];

      if (node.id) {
        const idSel = `#${CSS.escape(node.id)}`;
        out.push(idSel);
        out.push(`${tag}${idSel}`);
      }

      for (const attr of semantics) {
        const val = node.getAttribute?.(attr);
        if (!val || String(val).length > 120) continue;
        out.push(`${tag}[${attr}="${CSS.escape(String(val))}"]`);
      }

      const classes = Array.from(node.classList || []).filter(
        isLikelyStableClass,
      );
      if (classes.length > 0) {
        out.push(`${tag}.${CSS.escape(classes[0])}`);
        if (classes.length > 1) {
          out.push(
            `${tag}.${CSS.escape(classes[0])}.${CSS.escape(classes[1])}`,
          );
        }
        if (classes.length > 2) {
          out.push(
            `${tag}.${CSS.escape(classes[0])}.${CSS.escape(classes[1])}.${CSS.escape(classes[2])}`,
          );
        }
      }

      out.push(nthOfType(node));
      out.push(tag);

      // De-duplicate while preserving score order
      return Array.from(new Set(out));
    };

    // 1) Try direct unique selector for the target element.
    const selfCandidates = buildNodeCandidates(el);
    const isTagOnly = (sel) => sel === el.tagName.toLowerCase();
    for (const sel of selfCandidates) {
      if (isTagOnly(sel)) continue;
      if (unique(sel)) return sel;
    }

    // 2) Build anchored path upward until unique.
    let current = el;
    let depth = 0;
    let parts = [];
    let bestSelector =
      selfCandidates.find((s) => !isTagOnly(s)) || _buildNthPath(el);
    let bestCount = qCount(bestSelector) || Number.POSITIVE_INFINITY;

    while (current && depth < 8 && current !== document.documentElement) {
      const candidates = buildNodeCandidates(current);
      const part =
        candidates.find((s) => s.startsWith("#")) ||
        candidates.find((s) => s.includes("[")) ||
        candidates.find((s) => s.includes(".")) ||
        candidates.find((s) => s.includes(":nth-of-type(")) ||
        current.tagName.toLowerCase();

      parts.unshift(part);
      const chain = parts.join(" > ");
      const count = qCount(chain);
      if (count === 1) return chain;
      if (count > 0 && count < bestCount) {
        bestCount = count;
        bestSelector = chain;
      }

      current = current.parentElement;
      depth++;
    }

    // 3) Nothing named the element uniquely, so name it by position.
    //
    // This step used to run only when the best candidate had degraded to a bare
    // tag, so "Specific" routinely returned a selector matching many elements:
    // picking one price cell in a table gave `td.price`, which is every price on
    // the page. The user asked for one element and silently got the column —
    // which is the whole of "Specific behaves like Bulk".
    //
    // Every element has a unique nth-of-type path unless it is inside a repeated
    // structure with no anchor at all, so this almost always resolves.
    const nth = _buildNthPath(el);
    if (qCount(nth) === 1) return nth;
    if (bestSelector === el.tagName.toLowerCase()) return nth;
    return bestSelector;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────
  function _sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // _waitForSelector lived here, duplicating _waitForSelectorScoped below
  // without the scoping. Nothing called it (B-32).

  /**
   * Is this element rendered, rather than merely present?
   *
   * A `display:none` placeholder for the spinner that has not started yet, or a
   * results container the page keeps empty and hidden between searches, both
   * match the selector the user picked. Treating those as "appeared" resolves the
   * wait immediately and hands the next step a page with nothing on it.
   */
  function _isVisible(el) {
    if (!el || !el.isConnected) return false;
    const style = el.ownerDocument.defaultView?.getComputedStyle?.(el);
    if (style) {
      if (style.display === "none") return false;
      if (style.visibility === "hidden" || style.visibility === "collapse") {
        return false;
      }
      if (Number(style.opacity) === 0) return false;
    }
    // A rendered element occupies space. Where there is no layout engine at all
    // and no rect to read, fall back to trusting the style checks above.
    const rect = el.getBoundingClientRect?.();
    if (!rect) return true;
    return rect.width > 0 || rect.height > 0;
  }

  async function _waitForSelectorScoped(selector, timeout, context = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (_queryScoped(selector, context, false).some(_isVisible)) return;
      await _sleep(100);
    }
    throw new Error(`Timeout waiting for selector: ${selector}`);
  }

  /** The mirror of the above: wait for a spinner or overlay to go away. */
  async function _waitForSelectorGone(selector, timeout, context = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (!_queryScoped(selector, context, false).some(_isVisible)) return;
      await _sleep(100);
    }
    throw new Error(`Timeout waiting for "${selector}" to disappear`);
  }

  async function _waitDOMStable(quietMs = 300, timeout = 8000) {
    return new Promise((resolve) => {
      let timer = null;
      const obs = new MutationObserver(() => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          obs.disconnect();
          resolve();
        }, quietMs);
      });
      obs.observe(document.documentElement, { childList: true, subtree: true });
      timer = setTimeout(() => {
        obs.disconnect();
        resolve();
      }, timeout);
    });
  }

  // === END injector.js ===

  // ── Bootstrap overlay engine ─────────────────────────────────────────────────
  // overlay-engine.js is an ES module — it cannot be declared in manifest
  // content_scripts directly. We load it dynamically so it self-initialises
  // (overlayEngine.init() is called at the bottom of overlay-engine.js).
  import(chrome.runtime.getURL("content/overlay-engine.js")).catch((err) => {
    console.warn("[Verquill] overlay-engine failed to load:", err.message);
  });
})();
