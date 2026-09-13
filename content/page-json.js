// === page-json.js ===
/**
 * @module page-json
 * @description Turn the page itself into JSON.
 *
 *   Asked for directly: "an activity that returns the entire page in JSON
 *   format". It is the companion to page-data.js, not a replacement:
 *
 *     * `PAGE_DATA` reads the structured data a site *publishes* — JSON-LD,
 *       microdata, Open Graph. Clean and typed where a site publishes any, and
 *       useless where it does not.
 *     * this reads the page as it actually is. No selectors, no guessing about
 *       which parts matter, works on anything.
 *
 *   The hard part is not walking the DOM. It is that a naive dump of a real
 *   page is several megabytes of scripts, minified CSS, SVG path data and
 *   layout wrappers, and finding anything in it is harder than writing the
 *   selector you were trying to avoid. So the default keeps what a reader
 *   would call content, and every exclusion is a switch that can be turned off.
 *
 *   Three shapes, because "as JSON" means different things depending on what
 *   you are going to do with it:
 *
 *     tree  the DOM's structure, nested — for feeding to something that will
 *           reason about the page
 *     text  the readable text in order — for reading, searching, or an LLM
 *     flat  one row per element — for a spreadsheet, or for finding the
 *           selector you actually want
 *
 *   A classic script, not a module: content scripts cannot `import`, so it is
 *   injected alongside injector.js and communicates through a global.
 *
 * @dependencies none
 */

"use strict";

(() => {
  /** Past this the output stops being something a person can use. */
  const DEFAULT_MAX_NODES = 5000;
  const DEFAULT_MAX_DEPTH = 25;
  /** Long text is content; enormous text is a minified asset in a <pre>. */
  const MAX_TEXT = 5000;

  /** Never content: markup that carries code or presentation, not meaning. */
  const CODE_TAGS = new Set([
    "SCRIPT",
    "STYLE",
    "NOSCRIPT",
    "TEMPLATE",
    "LINK",
  ]);
  /** Attributes worth keeping. Everything else is framework bookkeeping. */
  const KEEP_ATTRS = new Set([
    "id",
    "class",
    "href",
    "src",
    "alt",
    "title",
    "value",
    "type",
    "name",
    "placeholder",
    "role",
    "colspan",
    "rowspan",
    "datetime",
    "content",
  ]);

  const clean = (s) =>
    String(s ?? "")
      .replace(/\s+/g, " ")
      .trim();

  const abs = (value) => {
    const text = clean(value);
    if (!text) return text;
    try {
      return new URL(text, location.href).href;
    } catch {
      return text;
    }
  };

  /** The attributes of one element, filtered and with links resolved. */
  function attrsOf(el) {
    const out = {};
    for (const attr of el.attributes ?? []) {
      const name = attr.name;
      const keep =
        KEEP_ATTRS.has(name) ||
        name.startsWith("data-") ||
        name.startsWith("aria-");
      if (!keep) continue;
      // An SVG path's `d` is thousands of coordinates and means nothing to a
      // reader; the same goes for an inline data: image.
      if (name === "d" || name === "points") continue;
      let value = attr.value;
      if (name === "href" || name === "src") {
        if (value.startsWith("data:")) value = "data:…";
        else value = abs(value);
      }
      out[name] = clean(value).slice(0, 500);
    }
    return out;
  }

  /** The element's own text — not its descendants'. */
  function ownText(el) {
    return clean(
      [...el.childNodes]
        .filter((n) => n.nodeType === 3)
        .map((n) => n.textContent)
        .join(" "),
    ).slice(0, MAX_TEXT);
  }

  /** A short path to an element, for finding it again. */
  function pathTo(el, root) {
    const parts = [];
    let node = el;
    while (node && node !== root && node.parentElement && parts.length < 8) {
      const tag = node.tagName.toLowerCase();
      const id = node.id ? `#${node.id}` : "";
      const cls = node.classList?.[0] ? `.${node.classList[0]}` : "";
      parts.unshift(`${tag}${id || cls}`);
      node = node.parentElement;
    }
    return parts.join(" > ");
  }

  /**
   * Walk the DOM once, building whichever shape was asked for.
   *
   * One walk rather than three, so the node budget means the same thing in
   * every mode and a page cannot be truncated differently depending on how it
   * is being read.
   */
  function walk(root, config) {
    const maxNodes = Math.max(1, Number(config.maxNodes) || DEFAULT_MAX_NODES);
    const maxDepth = Math.max(1, Number(config.maxDepth) || DEFAULT_MAX_DEPTH);
    const keepCode = config.includeScripts === true;
    const mode = config.mode || "tree";

    let nodes = 0;
    let truncated = false;
    let reason = "";
    const text = [];
    const rows = [];

    function visit(el, depth) {
      if (truncated) return null;
      if (depth > maxDepth) {
        truncated = true;
        reason = `The page is nested deeper than ${maxDepth} levels; the rest was left out.`;
        return null;
      }
      if (nodes >= maxNodes) {
        truncated = true;
        reason = `The page has more than ${maxNodes} elements; the rest was left out.`;
        return null;
      }
      if (!keepCode && CODE_TAGS.has(el.tagName)) return null;
      nodes++;

      const own = ownText(el);
      const node = { tag: el.tagName.toLowerCase() };
      const attrs = attrsOf(el);
      if (Object.keys(attrs).length) node.attrs = attrs;
      if (own) node.text = own;

      if (own) text.push(own);
      if (mode === "flat") {
        const row = { tag: node.tag, path: pathTo(el, root) };
        if (own) row.text = own;
        if (attrs.href) row.href = attrs.href;
        if (attrs.src) row.src = attrs.src;
        if (attrs.id) row.id = attrs.id;
        if (attrs.class) row.class = attrs.class;
        rows.push(row);
      }

      const children = [];
      for (const child of el.children) {
        const built = visit(child, depth + 1);
        if (built) children.push(built);
      }
      if (children.length) node.children = children;
      return node;
    }

    const tree = visit(root, 0);
    return { tree, text, rows, nodes, truncated, reason };
  }

  /**
   * Read the page as JSON.
   *
   * @param {object} [config]
   * @param {'tree'|'text'|'flat'} [config.mode]
   * @param {string} [config.selector] - dump only this part of the page
   * @param {number} [config.maxNodes]
   * @param {number} [config.maxDepth]
   * @param {boolean} [config.includeScripts]
   * @returns {object}
   */
  function pageJson(config = {}) {
    const mode = config.mode || "tree";
    const base = {
      found: true,
      url: location.href,
      title: document.title,
      mode,
      truncated: false,
      reason: "",
    };

    let root = document.body || document.documentElement;
    if (config.selector) {
      let picked = null;
      try {
        picked = document.querySelector(config.selector);
      } catch {
        return {
          ...base,
          found: false,
          reason: `"${config.selector}" is not a valid selector.`,
        };
      }
      if (!picked) {
        // Not a silent fall back to the whole page: dumping five thousand
        // elements when the user asked for one is not a smaller mistake.
        return {
          ...base,
          found: false,
          reason: `Nothing on this page matches "${config.selector}".`,
        };
      }
      root = picked;
    }

    const out = walk(root, config);
    const result = {
      ...base,
      nodes: out.nodes,
      truncated: out.truncated,
      reason: out.reason,
    };
    if (mode === "text") result.text = out.text;
    else if (mode === "flat") result.rows = out.rows;
    else result.tree = out.tree;
    return result;
  }

  // The isolated world is shared with injector.js, which dispatches to this.
  globalThis.__vqPageJson = pageJson;
})();

// === END page-json.js ===
