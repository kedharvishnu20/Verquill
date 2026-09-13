// === page-data.js ===
/**
 * @module page-data
 * @description Read the structured data a page already publishes.
 *
 *   Most real sites embed JSON-LD, Schema.org microdata, or Open Graph tags —
 *   clean, typed, already-structured data, put there on purpose for machines to
 *   read. Every one of them was ignored, and the user was asked for CSS
 *   selectors instead: selectors that describe data the site was handing out
 *   for free, and that break the next time a designer renames a class.
 *
 *   `smart-extractor.js` does read JSON-LD, but only hunting for
 *   `@type: Product`. A recipe, a job posting, an article, an event, a
 *   business's address and opening hours — all invisible.
 *
 *   This is also the honest answer to "can we just turn the page into JSON".
 *   For a *single-record* page — a product, an article, a listing — which the
 *   structure detector cannot help with at all, because there is nothing
 *   repeating to find, this is exactly that, with no selectors involved.
 *
 *   A classic script, not a module: content scripts cannot `import`, so it is
 *   injected alongside injector.js and communicates through a global, the same
 *   way structure-detector.js and smart-extractor.js do.
 *
 *   What it will not do: invent data. A page with nothing structured on it
 *   comes back `found: false` with a reason, rather than a guess assembled from
 *   headings — a guess is indistinguishable from a reading, and the user has no
 *   way to tell which they got.
 *
 * @dependencies none
 */

"use strict";

(() => {
  /** Deeper than this is a graph, not a record; and a cycle would not end. */
  const MAX_DEPTH = 6;
  /** Sites publish enormous graphs; past this the rest is not worth the memory. */
  const MAX_RECORDS = 200;

  /** Meta tags worth carrying: the ones that describe the page's content. */
  const META_PREFIXES = [
    "og:",
    "twitter:",
    "product:",
    "article:",
    "book:",
    "music:",
    "video:",
    "profile:",
  ];
  const META_NAMES = ["description", "keywords", "author", "robots"];
  /** Meta values that are URLs, and so are worth resolving. */
  const META_URLISH =
    /(?:^|:)(?:url|image|image:secure_url|video|audio|player)$/;

  const clean = (s) =>
    String(s ?? "")
      .replace(/\s+/g, " ")
      .trim();

  /** Resolve against the page, so a value is usable off it. */
  function abs(value) {
    const text = clean(value);
    if (!text) return text;
    try {
      return new URL(text, location.href).href;
    } catch {
      return text;
    }
  }

  // ── JSON-LD ────────────────────────────────────────────────────────────────

  /**
   * Pull every node out of one parsed JSON-LD value.
   *
   * A block can be an object, an array of them, or an object whose `@graph`
   * holds the real content — which is what WordPress and Yoast publish, so
   * reading the wrapper and stopping finds nothing usable on a large share of
   * the web.
   *
   * @param {*} data
   * @param {object[]} out - appended to
   * @param {number} depth
   */
  function collectLdNodes(data, out, depth = 0) {
    if (!data || depth > MAX_DEPTH || out.length >= MAX_RECORDS) return;

    if (Array.isArray(data)) {
      for (const item of data) collectLdNodes(item, out, depth + 1);
      return;
    }
    if (typeof data !== "object") return;

    if (Array.isArray(data["@graph"])) {
      for (const node of data["@graph"]) collectLdNodes(node, out, depth + 1);
      // A wrapper carrying only a graph is not itself a record.
      const own = Object.keys(data).filter(
        (k) => k !== "@graph" && k !== "@context",
      );
      if (own.length === 0) return;
    }
    if (data["@type"] || data["@id"] || Object.keys(data).length > 0) {
      out.push(data);
    }
  }

  /**
   * @returns {{records: object[], warnings: string[]}}
   */
  function readJsonLd() {
    const records = [];
    const warnings = [];
    const blocks = document.querySelectorAll(
      'script[type="application/ld+json"]',
    );
    for (const block of blocks) {
      let parsed;
      try {
        parsed = JSON.parse(block.textContent || "");
      } catch {
        // Broken JSON-LD is extremely common. Throwing here would mean one bad
        // block on a page loses every good one — but saying nothing would hide
        // the reason a record the user can see in the source did not appear.
        warnings.push(
          "A JSON-LD block on this page is not valid JSON and was skipped.",
        );
        continue;
      }
      collectLdNodes(parsed, records);
    }
    return { records, warnings };
  }

  // ── Microdata ──────────────────────────────────────────────────────────────

  /** The last path segment of an itemtype URL: "…/schema.org/Product" → "Product". */
  const typeOf = (el) => {
    const raw = el.getAttribute("itemtype") || "";
    const name = raw.split(/[/#]/).filter(Boolean).pop();
    return name || null;
  };

  /**
   * The value of one itemprop element.
   *
   * `<meta itemprop>` and `<time datetime>` exist precisely because the visible
   * text is formatted for people: reading the text off a `<time>` gives
   * "3 days ago" where the attribute holds an ISO timestamp.
   */
  function propValue(el) {
    const tag = el.tagName.toLowerCase();
    if (el.hasAttribute("content")) return clean(el.getAttribute("content"));
    if (tag === "time" && el.hasAttribute("datetime")) {
      return clean(el.getAttribute("datetime"));
    }
    if (el.hasAttribute("href") && (tag === "a" || tag === "link")) {
      return abs(el.getAttribute("href"));
    }
    if (el.hasAttribute("src")) return abs(el.getAttribute("src"));
    if (tag === "data" && el.hasAttribute("value")) {
      return clean(el.getAttribute("value"));
    }
    return clean(el.textContent);
  }

  /**
   * Read one itemscope element into an object, recursing into nested scopes.
   *
   * Only the props belonging to *this* scope: an itemprop inside a nested
   * itemscope belongs to that one, and hoisting it flattens an offer's price
   * into the product.
   */
  function readScope(root, depth = 0) {
    const record = {};
    const type = typeOf(root);
    if (type) record["@type"] = type;

    const own = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (child.hasAttribute("itemprop")) {
          own.push(child);
          // A nested scope's own props belong to it, so do not descend.
          if (child.hasAttribute("itemscope")) continue;
        }
        walk(child);
      }
    };
    walk(root);

    for (const el of own) {
      const name = el.getAttribute("itemprop");
      if (!name) continue;
      const value =
        el.hasAttribute("itemscope") && depth < MAX_DEPTH
          ? readScope(el, depth + 1)
          : propValue(el);
      if (value === "" || value == null) continue;

      // A repeated prop is a list — recipe ingredients, article tags.
      if (name in record) {
        record[name] = Array.isArray(record[name])
          ? [...record[name], value]
          : [record[name], value];
      } else {
        record[name] = value;
      }
    }
    return record;
  }

  /** @returns {object[]} */
  function readMicrodata() {
    const records = [];
    for (const el of document.querySelectorAll("[itemscope][itemtype]")) {
      // Top-level scopes only; nested ones are read by their parent.
      if (el.parentElement?.closest("[itemscope]")) continue;
      const record = readScope(el);
      if (Object.keys(record).length > 1) records.push(record);
      if (records.length >= MAX_RECORDS) break;
    }
    return records;
  }

  // ── Meta tags ──────────────────────────────────────────────────────────────

  /** @returns {Record<string, string>} */
  function readMeta() {
    const out = {};
    for (const el of document.querySelectorAll("meta[content]")) {
      const key = el.getAttribute("property") || el.getAttribute("name");
      if (!key) continue;
      const wanted =
        META_PREFIXES.some((p) => key.startsWith(p)) ||
        META_NAMES.includes(key);
      if (!wanted) continue;
      const raw = el.getAttribute("content");
      out[key] = META_URLISH.test(key) ? abs(raw) : clean(raw);
    }
    return out;
  }

  // ── Flattening ─────────────────────────────────────────────────────────────

  /**
   * Turn a record into one row of scalars, `a.b.c` style.
   *
   * A spreadsheet has no cell type for a nested object: left as it is, the CSV
   * writer puts "[object Object]" in the price column. Arrays of scalars join
   * with commas; arrays of objects are indexed.
   *
   * `seen` guards the cycles JSON-LD graphs genuinely contain — without it a
   * self-referential graph hangs the tab.
   */
  function flatten(value, prefix = "", out = {}, depth = 0, seen = new Set()) {
    if (value === null || value === undefined) return out;

    if (Array.isArray(value)) {
      const scalars = value.every((v) => v === null || typeof v !== "object");
      if (scalars) {
        out[prefix || "value"] = value.map((v) => clean(v)).join(", ");
      } else {
        value.forEach((v, i) =>
          flatten(
            v,
            prefix ? `${prefix}.${i}` : String(i),
            out,
            depth + 1,
            seen,
          ),
        );
      }
      return out;
    }

    if (typeof value === "object") {
      if (depth >= MAX_DEPTH || seen.has(value)) return out;
      seen.add(value);
      for (const [key, val] of Object.entries(value)) {
        flatten(val, prefix ? `${prefix}.${key}` : key, out, depth + 1, seen);
      }
      seen.delete(value);
      return out;
    }

    out[prefix || "value"] = value;
    return out;
  }

  // ── The step ───────────────────────────────────────────────────────────────

  /**
   * Read the page's structured data.
   *
   * @param {object} [config]
   * @param {'auto'|'jsonld'|'microdata'|'meta'} [config.source] - where to look
   * @param {string} [config.type]    - keep only this Schema.org type
   * @param {boolean} [config.flatten] - one row of scalars per record
   * @returns {{found: boolean, url: string, title: string, records: object[],
   *   meta: Record<string,string>, sources: string[], warnings: string[],
   *   reason: string}}
   */
  function readPageData({
    source = "auto",
    type = "",
    flatten: flat = false,
  } = {}) {
    const warnings = [];
    const sources = [];
    let records = [];

    if (source === "auto" || source === "jsonld") {
      const ld = readJsonLd();
      warnings.push(...ld.warnings);
      if (ld.records.length) {
        records = ld.records;
        sources.push("json-ld");
      }
    }
    // In auto mode microdata is a fallback, not an addition: a site that
    // publishes both publishes the same record twice, and returning it twice
    // would double every row.
    if (
      (source === "microdata" || (source === "auto" && records.length === 0)) &&
      source !== "meta"
    ) {
      const micro = readMicrodata();
      if (micro.length) {
        records = micro;
        sources.push("microdata");
      }
    }

    if (type) {
      const wanted = String(type).toLowerCase();
      records = records.filter((r) => {
        const t = r["@type"];
        const list = Array.isArray(t) ? t : [t];
        return list.some((x) => String(x ?? "").toLowerCase() === wanted);
      });
    }

    const meta = source === "auto" || source === "meta" ? readMeta() : {};
    if (Object.keys(meta).length) sources.push("meta");

    if (flat) records = records.map((r) => flatten(r));

    const found = records.length > 0 || Object.keys(meta).length > 0;
    return {
      found,
      url: location.href,
      title: document.title,
      records: records.slice(0, MAX_RECORDS),
      meta,
      sources,
      warnings,
      reason: found
        ? ""
        : type
          ? `No structured data of type "${type}" on this page.`
          : "This page publishes no structured data — no JSON-LD, no microdata, no Open Graph tags. Pick fields by hand, or try Detect Table if it shows a list.",
    };
  }

  // The isolated world is shared with injector.js, which dispatches to this.
  globalThis.__vqReadPageData = readPageData;
})();

// === END page-data.js ===
