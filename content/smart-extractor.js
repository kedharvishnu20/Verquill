// === smart-extractor.js ===
/**
 * @module smart-extractor
 * @description Cascading product auto-extractor — Layers 1 & 2.
 *
 *   Layer 1 — Structured Data (zero guessing):
 *     Reads JSON-LD (@type Product), Schema.org microdata (itemprop),
 *     Open Graph meta tags, and product:* meta tags.
 *     Returns 95–100% accurate results when present.
 *
 *   Layer 2 — Heuristic DOM Scanner (educated guessing):
 *     Scores every element by class/id keywords, computed font size,
 *     proximity to add-to-cart CTAs, price regex patterns, and
 *     document position (H1 in main content area = product name).
 *     Returns 70–90% accurate results on sites without structured data.
 *
 *   Confidence model:
 *     Each returned field carries an integer 0–100 confidence score.
 *     Fields with confidence < 50 are returned with a `⚠️` warning flag.
 *     The caller (injector.js / service-worker.js) uses the overall
 *     confidence to decide whether to escalate to Layer 3 (LLM).
 *
 *   Design decisions:
 *     - Runs in ISOLATED world as a content script (no ES module imports).
 *     - Exposes window.__vqSmartExtract so injector.js can call it
 *       without needing a module boundary.
 *     - Pure DOM reads: no network calls, no side effects.
 *     - All querySelector calls are wrapped in try/catch to prevent
 *       malformed page HTML from crashing the extractor.
 *
 * @exports window.__vqSmartExtract  async (config?) => ExtractionResult
 */

"use strict";

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Confidence thresholds.
 * LAYER_ESCALATE: overall confidence below this → ask for Layer 3 (LLM).
 * FIELD_WARN: per-field confidence below this → mark as uncertain.
 */
const CONF = Object.freeze({
  LAYER_ESCALATE: 70,
  FIELD_WARN: 50,
});

/**
 * OG/meta property names to read.
 * Ordered by specificity — most specific first.
 */
const OG = Object.freeze({
  NAME: ["og:title", "twitter:title", "product:name", "title"],
  PRICE: ["product:price:amount", "og:price:amount", "twitter:data1"],
  CURRENCY: ["product:price:currency", "og:price:currency"],
  IMAGE: ["og:image", "og:image:secure_url", "twitter:image", "product:image"],
  DESCRIPTION: ["og:description", "twitter:description", "description"],
  BRAND: ["og:brand", "product:brand"],
  AVAILABILITY: ["product:availability", "og:availability"],
});

/**
 * Heuristic keyword scoring table.
 * Maps keyword fragments to field names and base scores.
 * Longer, more specific keywords score higher.
 */
const KEYWORD_SCORES = [
  // Name/title
  { field: "name", score: 90, rx: /\bproduct[-_]?(?:name|title)\b/i },
  { field: "name", score: 85, rx: /\bpdp[-_]?(?:name|title|heading)\b/i },
  { field: "name", score: 80, rx: /\bitem[-_]?(?:name|title)\b/i },
  { field: "name", score: 70, rx: /\bproduct[-_]?(?:header|info)\b/i },
  {
    field: "name",
    score: 60,
    rx: /\btitle\b.*\bproduct\b|\bproduct\b.*\btitle\b/i,
  },
  // Price (sale/current)
  {
    field: "price",
    score: 95,
    rx: /\bselling[-_]?price\b|\bsale[-_]?price\b|\bdiscounted[-_]?price\b/i,
  },
  {
    field: "price",
    score: 90,
    rx: /\bproduct[-_]?price\b|\bitem[-_]?price\b|\bpdp[-_]?price\b/i,
  },
  {
    field: "price",
    score: 85,
    rx: /\boffer[-_]?price\b|\bcurrent[-_]?price\b|\bfinal[-_]?price\b/i,
  },
  {
    field: "price",
    score: 80,
    rx: /\bprice[-_]?(?:box|container|block|value|amount)\b/i,
  },
  { field: "price", score: 70, rx: /\b(?:price|pricing)\b/i },
  // Original/MRP price
  {
    field: "originalPrice",
    score: 90,
    rx: /\b(?:mrp|original|was|before|old|regular|full)[-_]?price\b/i,
  },
  {
    field: "originalPrice",
    score: 80,
    rx: /\bprice[-_]?(?:before|was|original|old)\b/i,
  },
  {
    field: "originalPrice",
    score: 70,
    rx: /\bstrike[-_]?price\b|\blist[-_]?price\b/i,
  },
  // Images
  {
    field: "images",
    score: 90,
    rx: /\bproduct[-_]?(?:image|img|photo|gallery|media)\b/i,
  },
  { field: "images", score: 80, rx: /\bpdp[-_]?(?:image|gallery|media)\b/i },
  { field: "images", score: 70, rx: /\bgallery[-_]?(?:main|primary|hero)\b/i },
  {
    field: "images",
    score: 60,
    rx: /\bmain[-_]?(?:image|img|photo)\b|\bhero[-_]?(?:image|img)\b/i,
  },
  // Brand
  {
    field: "brand",
    score: 85,
    rx: /\bproduct[-_]?brand\b|\bbrand[-_]?name\b/i,
  },
  { field: "brand", score: 75, rx: /\bbrand\b/i },
  // SKU
  {
    field: "sku",
    score: 90,
    rx: /\bsku\b|\bmodel[-_]?(?:no|num|number|id)\b|\bpart[-_]?(?:no|num|number)\b/i,
  },
  {
    field: "sku",
    score: 75,
    rx: /\bitem[-_]?id\b|\bproduct[-_]?id\b|\bpid\b/i,
  },
  // Description
  { field: "description", score: 85, rx: /\bproduct[-_]?desc(?:ription)?\b/i },
  {
    field: "description",
    score: 75,
    rx: /\bitem[-_]?desc(?:ription)?\b|\bpdp[-_]?desc(?:ription)?\b/i,
  },
  { field: "description", score: 65, rx: /\bdesc(?:ription)?\b/i },
  // Availability
  {
    field: "availability",
    score: 85,
    rx: /\b(?:in[-_]?stock|out[-_]?of[-_]?stock|availability|stock[-_]?status)\b/i,
  },
  { field: "availability", score: 70, rx: /\bstock\b/i },
  // Rating
  {
    field: "rating",
    score: 85,
    rx: /\brating(?:[-_]?value|[-_]?score|[-_]?avg)?\b/i,
  },
  {
    field: "rating",
    score: 75,
    rx: /\bstars?\b.*\brating|\brating.*\bstars?\b/i,
  },
  // Review count
  {
    field: "reviewCount",
    score: 85,
    rx: /\b(?:review|rating)[-_]?count\b|\bnum[-_]?reviews?\b/i,
  },
  {
    field: "reviewCount",
    score: 75,
    rx: /\breviews?\b.*\bcount|\bcount.*\breviews?\b/i,
  },
];

/**
 * Regex for recognizing price strings in visible text.
 * Group 1: optional currency symbol prefix.
 * Group 2: numeric value with commas/decimals.
 */
const PRICE_RX =
  /(?:[$₹€£¥₩₽R\u20B9]|(?:USD|INR|EUR|GBP|JPY|CNY|AED|AUD|CAD)\s*)?\s*([\d,]+(?:\.\d{1,2})?)/;
const PRICE_LEADING_RX =
  /^(?:[$₹€£¥₩₽R]|(?:USD|INR|EUR|GBP|JPY|CNY|AED|AUD|CAD)\s*)?\s?[\d,]+(?:\.\d{1,2})?/;

/**
 * CTA text patterns — elements containing these near a field bump that
 * field's confidence by +20 (proximity scoring).
 */
const CTA_RX =
  /\b(?:add\s+to\s+(?:cart|bag|basket)|buy\s+now|purchase|order\s+now|shop\s+now|get\s+it\s+now|checkout)\b/i;

/**
 * Navigation/boilerplate container selectors to exclude from heuristic scan.
 * We never extract from these.
 */
const NOISE_SELECTORS = [
  "nav",
  "header",
  "footer",
  "aside",
  '[role="navigation"]',
  '[role="banner"]',
  '[role="contentinfo"]',
  ".nav",
  ".navbar",
  ".header",
  ".footer",
  ".sidebar",
  ".breadcrumb",
  ".breadcrumbs",
  "#nav",
  "#header",
  "#footer",
  "#sidebar",
].join(",");

// ── Utility helpers ────────────────────────────────────────────────────────────

/** Safe querySelector — returns null on invalid selector */
function _qs(root, sel) {
  try {
    return root.querySelector(sel);
  } catch {
    return null;
  }
}

/** Safe querySelectorAll — returns [] on invalid selector */
function _qsa(root, sel) {
  try {
    return Array.from(root.querySelectorAll(sel));
  } catch {
    return [];
  }
}

/** Clean and collapse whitespace in a string */
function _clean(str) {
  return String(str || "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Return true if element is inside a known noise/nav container */
function _isNoise(el) {
  try {
    return !!el.closest(NOISE_SELECTORS);
  } catch {
    return false;
  }
}

/** Get the combined class + id string of an element for keyword matching */
function _classId(el) {
  return `${el.className || ""} ${el.id || ""}`.toLowerCase();
}

/** Get computed font-size in px as a number */
function _fontSize(el) {
  try {
    const raw = window.getComputedStyle(el).fontSize;
    return raw ? parseFloat(raw) : 0;
  } catch {
    return 0;
  }
}

/** Get computed font-weight as a number */
function _fontWeight(el) {
  try {
    const raw = window.getComputedStyle(el).fontWeight;
    if (!raw) return 400;
    if (raw === "bold") return 700;
    if (raw === "bolder") return 800;
    const n = parseInt(raw, 10);
    return isNaN(n) ? 400 : n;
  } catch {
    return 400;
  }
}

/** Extract visible bounding rect, returns null if hidden */
function _rect(el) {
  try {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return null;
    return r;
  } catch {
    return null;
  }
}

/** Absolute distance between two DOMRects centers */
function _distance(a, b) {
  const ax = a.left + a.width / 2,
    ay = a.top + a.height / 2;
  const bx = b.left + b.width / 2,
    by = b.top + b.height / 2;
  return Math.sqrt((ax - bx) ** 2 + (ay - by) ** 2);
}

/** Parse a price string → numeric value or null */
function _parsePrice(str) {
  const s = _clean(str).replace(/,/g, "");
  const m = s.match(/[\d]+(?:\.\d{1,2})?/);
  return m ? parseFloat(m[0]) : null;
}

/** Detect currency symbol from text */
function _detectCurrency(str) {
  const s = _clean(str);
  if (/₹|INR/.test(s)) return "INR";
  if (/\$|USD/.test(s)) return "USD";
  if (/€|EUR/.test(s)) return "EUR";
  if (/£|GBP/.test(s)) return "GBP";
  if (/¥|JPY|CNY/.test(s)) return "JPY";
  if (/₩|KRW/.test(s)) return "KRW";
  if (/₽|RUB/.test(s)) return "RUB";
  if (/AED/.test(s)) return "AED";
  return null;
}

/** Build a confidence result object */
function _conf(value, confidence, method) {
  return { value, confidence: Math.min(100, Math.max(0, confidence)), method };
}

// ── Layer 1: Structured Data ──────────────────────────────────────────────────

/**
 * Extract product data from all JSON-LD blocks on the page.
 * Handles both direct @type:Product and graph arrays.
 */
function _readJsonLd() {
  const scripts = _qsa(document, 'script[type="application/ld+json"]');
  for (const script of scripts) {
    try {
      const data = JSON.parse(script.textContent || "");
      const product = _findProductInLd(data);
      if (product) return product;
    } catch {
      /* malformed JSON-LD — skip */
    }
  }
  return null;
}

/** How much of a page's raw structured node is worth carrying to the worker. */
const MAX_NODE_KEYS = 60;
const MAX_NODE_CHARS = 20000;

/**
 * The richest structured-data node on the page, whatever its type.
 *
 * `_readJsonLd` above looks for `@type: Product` and nothing else, which is
 * right for the product extractor and useless for a page of articles, job
 * adverts or court listings. A schema naming its own fields needs the node
 * itself — the worker matches the requested names against the site's keys,
 * because the fuzzy matcher is an ES module and this file is a classic content
 * script that cannot import one.
 *
 * "Richest" is simply the most keys: a page usually carries one substantial
 * node and several stubs (a WebSite with a name and a url, a
 * BreadcrumbList), and the substantial one is the one being described.
 *
 * @returns {object|null} a flat-ish node, capped in size
 */
function _readAnyStructuredNode() {
  const nodes = [];

  const collect = (data, depth = 0) => {
    if (!data || depth > 4) return;
    if (Array.isArray(data)) {
      for (const item of data) collect(item, depth + 1);
      return;
    }
    if (typeof data !== "object") return;
    if (Array.isArray(data["@graph"])) {
      for (const item of data["@graph"]) collect(item, depth + 1);
    }
    // A node worth reporting says what it is and carries some content.
    const keys = Object.keys(data).filter((k) => !k.startsWith("@"));
    if (keys.length > 0) nodes.push(data);
  };

  for (const script of _qsa(document, 'script[type="application/ld+json"]')) {
    try {
      collect(JSON.parse(script.textContent || ""));
    } catch {
      /* malformed JSON-LD — skip */
    }
  }

  if (nodes.length === 0) return null;
  nodes.sort(
    (a, b) =>
      Object.keys(b).filter((k) => !k.startsWith("@")).length -
      Object.keys(a).filter((k) => !k.startsWith("@")).length,
  );

  const chosen = nodes[0];
  const out = {};
  let budget = MAX_NODE_CHARS;
  for (const key of Object.keys(chosen).slice(0, MAX_NODE_KEYS)) {
    const value = chosen[key];
    // Cheap size guard rather than a deep walk: this crosses a message
    // boundary, and a page embedding its whole catalogue in one node would
    // otherwise send all of it.
    let text;
    try {
      text = JSON.stringify(value) ?? "";
    } catch {
      continue; // circular or unserialisable — not something to report
    }
    if (text.length > budget) continue;
    budget -= text.length;
    out[key] = value;
  }
  if (chosen["@type"]) out["@type"] = chosen["@type"];
  return Object.keys(out).length ? out : null;
}

/**
 * The Open Graph and standard meta tags, as a node of their own.
 *
 * A page with no JSON-LD often still names its author, its publish date and
 * its section in meta tags. Reported under the bare name — `og:title` becomes
 * `title` — because that is the name a user would type.
 */
function _readMetaNode() {
  const out = {};
  for (const meta of _qsa(document, "meta[property], meta[name]")) {
    const raw = (
      meta.getAttribute("property") ||
      meta.getAttribute("name") ||
      ""
    ).trim();
    const content = (meta.getAttribute("content") || "").trim();
    if (!raw || !content) continue;
    // og:title, article:published_time, twitter:creator → title,
    // published_time, creator.
    const key = raw.replace(/^(og|article|twitter|product|book|profile):/, "");
    if (!key || key.includes(":")) continue;
    if (!(key in out)) out[key] = content;
  }
  return Object.keys(out).length ? out : null;
}

function _findProductInLd(data) {
  if (!data) return null;

  // Single object
  if (
    data["@type"] === "Product" ||
    (Array.isArray(data["@type"]) && data["@type"].includes("Product"))
  ) {
    return _normalizeJsonLd(data);
  }

  // @graph array
  if (Array.isArray(data["@graph"])) {
    for (const node of data["@graph"]) {
      const found = _findProductInLd(node);
      if (found) return found;
    }
  }

  // Array of objects
  if (Array.isArray(data)) {
    for (const item of data) {
      const found = _findProductInLd(item);
      if (found) return found;
    }
  }

  return null;
}

function _normalizeJsonLd(product) {
  const name = _clean(product.name);

  // Offers can be an array or a single object
  let offers = product.offers;
  if (Array.isArray(offers)) offers = offers[0];
  const price =
    offers?.price != null
      ? String(offers.price)
      : product.price != null
        ? String(product.price)
        : null;
  const currency = offers?.priceCurrency || product.priceCurrency || null;

  // Images: image can be string, object with url, or array
  const rawImages = Array.isArray(product.image)
    ? product.image
    : product.image
      ? [product.image]
      : [];
  const images = rawImages
    .map((img) => {
      if (typeof img === "string") return img;
      if (img?.url) return img.url;
      return null;
    })
    .filter(Boolean);

  const brand =
    typeof product.brand === "string"
      ? product.brand
      : product.brand?.name || null;

  const description = _clean(product.description || "");

  // SKU alternatives
  const sku =
    product.sku ||
    product.mpn ||
    product.productID ||
    product.identifier ||
    null;

  // Availability mapping
  let availability = null;
  const avail = offers?.availability || product.availability;
  if (avail) {
    const a = String(avail).toLowerCase();
    if (a.includes("instock")) availability = "In Stock";
    else if (a.includes("outofstock")) availability = "Out of Stock";
    else if (a.includes("preorder")) availability = "Pre-order";
    else availability = _clean(avail);
  }

  // Aggregate rating
  const aggRating = product.aggregateRating;
  const rating =
    aggRating?.ratingValue != null ? String(aggRating.ratingValue) : null;
  const reviewCount =
    aggRating?.reviewCount != null
      ? String(aggRating.reviewCount)
      : aggRating?.ratingCount != null
        ? String(aggRating.ratingCount)
        : null;

  return {
    name,
    price,
    currency,
    images,
    brand,
    description,
    sku,
    availability,
    rating,
    reviewCount,
  };
}

/**
 * Read Schema.org Microdata (itemprop attributes).
 */
function _readMicrodata() {
  const scope = _qs(document, '[itemtype*="schema.org/Product"]');
  if (!scope) return null;

  const get = (name, root = scope) => {
    const el = _qs(root, `[itemprop="${name}"]`);
    if (!el) return null;
    return (
      _clean(
        el.content ||
          el.getAttribute("content") ||
          el.getAttribute("href") ||
          el.textContent,
      ) || null
    );
  };

  const getAll = (name) =>
    _qsa(scope, `[itemprop="${name}"]`)
      .map((el) =>
        _clean(
          el.src ||
            el.getAttribute("src") ||
            el.content ||
            el.getAttribute("content") ||
            "",
        ),
      )
      .filter(Boolean);

  const offerScope = _qs(scope, '[itemtype*="Offer"]');
  const price = offerScope
    ? get("price", offerScope) || get("lowPrice", offerScope)
    : get("price");

  return {
    name: get("name"),
    price,
    currency: offerScope
      ? get("priceCurrency", offerScope)
      : get("priceCurrency"),
    images: getAll("image"),
    brand: get("brand") || get("manufacturer"),
    description: get("description"),
    sku: get("sku") || get("mpn") || get("productID"),
    availability: get("availability") ? "In Stock" : null,
    rating: get("ratingValue"),
    reviewCount: get("reviewCount") || get("ratingCount"),
  };
}

/**
 * Read Open Graph and product:* meta tags.
 */
function _readOpenGraph() {
  const getMeta = (properties) => {
    for (const prop of properties) {
      // Try property= and name= attributes
      const el = _qs(
        document,
        `meta[property="${prop}"], meta[name="${prop}"]`,
      );
      if (el) {
        const v = _clean(el.content || el.getAttribute("content") || "");
        if (v) return v;
      }
    }
    return null;
  };

  const getAllMeta = (properties) => {
    const results = [];
    for (const prop of properties) {
      _qsa(document, `meta[property="${prop}"], meta[name="${prop}"]`).forEach(
        (el) => {
          const v = _clean(el.content || el.getAttribute("content") || "");
          if (v) results.push(v);
        },
      );
    }
    return results;
  };

  const name = getMeta(OG.NAME);
  const price = getMeta(OG.PRICE);
  const currency = getMeta(OG.CURRENCY);
  const images = getAllMeta(OG.IMAGE);
  const description = getMeta(OG.DESCRIPTION);
  const brand = getMeta(OG.BRAND);
  const availability = getMeta(OG.AVAILABILITY);

  // Only return if we got at least name or price
  if (!name && !price) return null;
  return {
    name,
    price,
    currency,
    images,
    brand,
    description,
    sku: null,
    availability,
    rating: null,
    reviewCount: null,
  };
}

/**
 * Layer 1 master function.
 * Returns: { result, confidence, method } or null if nothing found.
 */
function _runLayer1() {
  // Priority: JSON-LD > Microdata > OG meta
  const jsonLd = _readJsonLd();
  if (jsonLd) {
    const confidence = _scoreStructuredResult(jsonLd);
    return { result: jsonLd, confidence, method: "json-ld" };
  }

  const microdata = _readMicrodata();
  if (microdata) {
    const confidence = _scoreStructuredResult(microdata);
    return { result: microdata, confidence, method: "microdata" };
  }

  const og = _readOpenGraph();
  if (og) {
    const confidence = _scoreStructuredResult(og);
    return { result: og, confidence, method: "og-meta" };
  }

  return null;
}

/**
 * Score a structured result (0–100) based on field coverage.
 * Weights reflect importance of each field.
 */
function _scoreStructuredResult(r) {
  if (!r) return 0;
  const weights = {
    name: 30,
    price: 25,
    images: 15,
    brand: 10,
    description: 10,
    sku: 5,
    availability: 5,
  };
  let score = 0,
    total = 0;
  for (const [field, weight] of Object.entries(weights)) {
    total += weight;
    const v = r[field];
    if (v != null && v !== "" && !(Array.isArray(v) && v.length === 0)) {
      score += weight;
    }
  }
  return Math.round((score / total) * 100);
}

// ── Layer 2: Heuristic DOM Scanner ────────────────────────────────────────────

/**
 * Find all CTA (add-to-cart) button rects on the page.
 * Used for proximity scoring.
 */
function _findCtaRects() {
  const buttons = _qsa(
    document,
    "button, [role='button'], a.btn, a.button, input[type='submit']",
  );
  return buttons
    .filter((el) =>
      CTA_RX.test(
        el.textContent || el.value || el.getAttribute("aria-label") || "",
      ),
    )
    .map((el) => _rect(el))
    .filter(Boolean);
}

/**
 * Score a DOM element for a specific field.
 * Returns 0–100.
 */
function _scoreElement(el, field, ctaRects) {
  let score = 0;

  // Class/ID keyword matching (highest weight)
  const ci = _classId(el);
  for (const kw of KEYWORD_SCORES) {
    if (kw.field === field && kw.rx.test(ci)) {
      score = Math.max(score, kw.score);
    }
  }

  // data-* attribute keyword matching
  if (el.dataset) {
    const dataStr = Object.entries(el.dataset)
      .map(([k, v]) => `${k} ${v}`)
      .join(" ")
      .toLowerCase();
    for (const kw of KEYWORD_SCORES) {
      if (kw.field === field && kw.rx.test(dataStr)) {
        score = Math.max(score, kw.score - 10); // slightly lower confidence for data-attrs
      }
    }
  }

  // Tag-specific bonuses
  const tag = el.tagName.toLowerCase();
  if (field === "name" && tag === "h1") score = Math.max(score, 75);
  if (field === "name" && tag === "h2") score = Math.max(score, 60);
  if (field === "images" && tag === "img") score = Math.max(score, 60);

  // Font size bonus for name and price (large text = prominent content)
  if (field === "name" || field === "price") {
    const fs = _fontSize(el);
    if (fs >= 28) score = Math.min(100, score + 15);
    else if (fs >= 22) score = Math.min(100, score + 10);
    else if (fs >= 18) score = Math.min(100, score + 5);

    const fw = _fontWeight(el);
    if (fw >= 700) score = Math.min(100, score + 5);
  }

  // Price currency symbol bonus
  if (field === "price" || field === "originalPrice") {
    const text = el.textContent || "";
    if (PRICE_LEADING_RX.test(_clean(text))) {
      score = Math.min(100, score + 20);
    }
  }

  // Proximity to CTA (add-to-cart) bonus
  if (ctaRects.length > 0 && (field === "name" || field === "price")) {
    const elRect = _rect(el);
    if (elRect) {
      const minDist = Math.min(...ctaRects.map((cr) => _distance(elRect, cr)));
      // Within 300px of a CTA → strong signal; within 600px → moderate
      if (minDist < 300) score = Math.min(100, score + 20);
      else if (minDist < 600) score = Math.min(100, score + 10);
    }
  }

  // Penalize noise containers
  if (_isNoise(el)) score = Math.max(0, score - 40);

  return score;
}

/**
 * Heuristic extraction for a single text field.
 * Returns { value, confidence, el } or null.
 */
function _heuristicTextField(field, minScore, ctaRects) {
  const candidates = _qsa(document, "*");
  let best = null;

  for (const el of candidates) {
    if (_isNoise(el)) continue;
    const text = _clean(el.innerText || el.textContent || "");
    if (!text || text.length > 2000) continue; // skip empty or suspiciously huge

    const score = _scoreElement(el, field, ctaRects);
    if (score < minScore) continue;

    if (!best || score > best.score) {
      best = { value: text, score, el };
    }
  }

  return best
    ? { value: best.value, confidence: best.score, el: best.el }
    : null;
}

/**
 * Heuristic price extraction — takes advantage of PRICE_LEADING_RX
 * and double-validates with parsed numeric value.
 */
function _heuristicPrice(field, isOriginal, ctaRects) {
  const candidates = _qsa(document, "*");
  let best = null;

  for (const el of candidates) {
    if (_isNoise(el)) continue;
    const children = el.children.length;
    if (children > 3) continue; // unlikely to be a price leaf node

    const text = _clean(el.innerText || el.textContent || "");
    if (!text) continue;

    // Must look like a price string
    if (
      !PRICE_LEADING_RX.test(text) &&
      !/[$₹€£¥₩₽]|(?:USD|INR|EUR|GBP)/.test(text)
    )
      continue;

    // Numeric value must parse
    const numVal = _parsePrice(text);
    if (numVal === null || numVal <= 0 || numVal > 1_000_000) continue;

    let score = _scoreElement(el, field, ctaRects);

    // Positive: has a price-looking text
    score = Math.min(100, score + 25);

    // For originalPrice: look for strikethrough style
    if (isOriginal) {
      const style = window.getComputedStyle(el);
      if (
        style.textDecoration &&
        style.textDecoration.includes("line-through")
      ) {
        score = Math.min(100, score + 20);
      }
    }

    if (!best || score > best.score) {
      best = { value: text, score, numVal, el };
    }
  }

  return best ? { value: best.value, confidence: best.score } : null;
}

/**
 * Heuristic image extraction — finds the largest, most central <img>
 * near the product content area.
 */
function _heuristicImages(ctaRects) {
  const imgs = _qsa(document, "img");
  const scored = [];

  for (const img of imgs) {
    if (_isNoise(img)) continue;
    const src =
      img.src || img.dataset?.src || img.getAttribute("data-src") || "";
    if (!src || (src.startsWith("data:") && src.length < 200)) continue; // skip tiny inline SVG/GIF
    if (/sprite|icon|logo|flag|pixel|1x1|blank|placeholder/i.test(src))
      continue;

    const r = _rect(img);
    if (!r) continue;
    const area = r.width * r.height;
    if (area < 4000) continue; // smaller than ~63x63 → probably icon

    let score = _scoreElement(img, "images", ctaRects);
    // Size bonus
    if (area > 100000) score = Math.min(100, score + 30);
    else if (area > 40000) score = Math.min(100, score + 20);
    else score = Math.min(100, score + 10);

    scored.push({ src, score, area });
  }

  scored.sort((a, b) => b.score - a.score || b.area - a.area);

  // Deduplicate by src
  const seen = new Set();
  const results = [];
  for (const item of scored) {
    if (seen.has(item.src)) continue;
    seen.add(item.src);
    results.push(item);
    if (results.length >= 8) break; // cap at 8 images
  }

  const confidence = results.length > 0 ? Math.min(100, results[0].score) : 0;
  return { value: results.map((i) => i.src), confidence };
}

/**
 * Layer 2 master function.
 */
function _runLayer2() {
  const ctaRects = _findCtaRects();

  const name = _heuristicTextField("name", 50, ctaRects);
  const priceResult = _heuristicPrice("price", false, ctaRects);
  const origResult = _heuristicPrice("originalPrice", true, ctaRects);
  const brand = _heuristicTextField("brand", 55, ctaRects);
  const sku = _heuristicTextField("sku", 60, ctaRects);
  const desc = _heuristicTextField("description", 55, ctaRects);
  const avail = _heuristicTextField("availability", 60, ctaRects);
  const rating = _heuristicTextField("rating", 60, ctaRects);
  const reviewCnt = _heuristicTextField("reviewCount", 60, ctaRects);
  const images = _heuristicImages(ctaRects);

  // Detect currency from price text
  const currency = priceResult ? _detectCurrency(priceResult.value) : null;

  const result = {
    name: name?.value || null,
    price: priceResult?.value || null,
    originalPrice: origResult?.value || null,
    currency,
    brand: brand?.value || null,
    description: desc?.value || null,
    sku: sku?.value || null,
    availability: avail?.value || null,
    rating: rating?.value || null,
    reviewCount: reviewCnt?.value || null,
    images: images.value,
  };

  const perField = {
    name: name?.confidence ?? 0,
    price: priceResult?.confidence ?? 0,
    originalPrice: origResult?.confidence ?? 0,
    currency: currency ? 70 : 0,
    brand: brand?.confidence ?? 0,
    description: desc?.confidence ?? 0,
    sku: sku?.confidence ?? 0,
    availability: avail?.confidence ?? 0,
    rating: rating?.confidence ?? 0,
    reviewCount: reviewCnt?.confidence ?? 0,
    images: images.confidence,
  };

  // Overall = weighted average of key fields
  const weights = {
    name: 30,
    price: 25,
    images: 15,
    brand: 10,
    description: 10,
    sku: 5,
    availability: 5,
  };
  let totalWeight = 0,
    weightedSum = 0;
  for (const [field, weight] of Object.entries(weights)) {
    totalWeight += weight;
    weightedSum += (perField[field] || 0) * weight;
  }
  const overallConfidence = Math.round(weightedSum / totalWeight);

  return { result, perField, overallConfidence, method: "heuristic" };
}

// ── Merge & Finalize ──────────────────────────────────────────────────────────

/**
 * Merge Layer 1 structured data with Layer 2 heuristics.
 * Structured data wins for each field, heuristic fills gaps.
 */
function _mergeResults(layer1, layer2) {
  const structured = layer1?.result || {};
  const heuristic = layer2?.result || {};

  const merged = {};
  const fieldList = [
    "name",
    "price",
    "originalPrice",
    "currency",
    "brand",
    "description",
    "sku",
    "availability",
    "rating",
    "reviewCount",
    "images",
  ];

  for (const field of fieldList) {
    const sv = structured[field];
    const hv = heuristic[field];

    // Structured data wins unless it's empty/null
    const isEmpty = (v) =>
      v === null ||
      v === undefined ||
      v === "" ||
      (Array.isArray(v) && v.length === 0);
    merged[field] = isEmpty(sv) ? (isEmpty(hv) ? null : hv) : sv;
  }

  // Build per-field confidence (structured = 95+, heuristic = as-scored) and,
  // beside it, which layer actually answered.
  //
  // The row used to carry one `method` for all of it, taken from whichever
  // layer answered first. That is untrue of any real page: `name` from the
  // site's JSON-LD and `price` from a guess at the markup are not the same
  // kind of claim, and one label hides which cells are which.
  const l1Conf = layer1?.confidence ?? 0;
  const perField = {};
  const from = {};

  for (const field of fieldList) {
    const sv = structured[field];
    const hp = layer2?.perField?.[field] ?? 0;
    const isEmpty = (v) =>
      v === null ||
      v === undefined ||
      v === "" ||
      (Array.isArray(v) && v.length === 0);

    if (!isEmpty(sv)) {
      // From structured data: very high confidence
      perField[field] =
        layer1?.method === "json-ld"
          ? 98
          : layer1?.method === "microdata"
            ? 95
            : 90;
      from[field] = layer1?.method || "json-ld";
    } else {
      // The value, not the score, decides the source: a field nothing found
      // is empty, not a guess that happened to score zero.
      perField[field] = hp;
      from[field] = isEmpty(heuristic[field]) ? "none" : "heuristic";
    }
  }

  // Overall confidence
  const weights = {
    name: 30,
    price: 25,
    images: 15,
    brand: 10,
    description: 10,
    sku: 5,
    availability: 5,
  };
  let totalWeight = 0,
    weightedSum = 0;
  for (const [field, weight] of Object.entries(weights)) {
    totalWeight += weight;
    weightedSum += (perField[field] || 0) * weight;
  }
  const overallConfidence = Math.round(weightedSum / totalWeight);

  // Build warnings for low-confidence fields
  const warnings = [];
  for (const [field, conf] of Object.entries(perField)) {
    if (merged[field] != null && conf < CONF.FIELD_WARN) {
      warnings.push(
        `⚠️ Field "${field}" has low confidence (${conf}/100) — verify manually.`,
      );
    }
  }

  const method =
    layer1?.method === "json-ld"
      ? "json-ld"
      : layer1?.method === "microdata"
        ? "microdata"
        : layer1?.method === "og-meta"
          ? "og-meta"
          : "heuristic";

  return {
    result: merged,
    perField,
    from,
    overallConfidence,
    method,
    warnings,
  };
}

// ── Simplified DOM for LLM ────────────────────────────────────────────────────

/**
 * Strip navigation, scripts, styles, and ads from the page and return
 * a compact text representation suitable for sending to an LLM.
 * Capped at 12000 characters.
 */
function _buildSimplifiedDom() {
  const clone = document.body.cloneNode(true);

  // Remove noise elements from the clone
  const noiseEls = clone.querySelectorAll(
    "script, style, link, noscript, svg, iframe, nav, header, footer, aside, " +
      '[role="navigation"], [role="banner"], [role="contentinfo"], ' +
      ".nav, .navbar, .header, .footer, .sidebar, .breadcrumb, " +
      ".ads, .advertisement, .cookie-banner, .popup, .modal:not([aria-label*='product'])",
  );
  noiseEls.forEach((el) => el.remove());

  const text = clone.innerText || clone.textContent || "";
  return text
    .replace(/\s{3,}/g, "\n\n")
    .trim()
    .slice(0, 12000);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Main entry point.
 * @param {object} config
 * @param {number} [config.confidenceThreshold=70] - If overall score < this,
 *   the caller should escalate to LLM Layer 3.
 * @returns {{
 *   result: object,
 *   perField: object,
 *   overallConfidence: number,
 *   method: string,
 *   warnings: string[],
 *   needsLlm: boolean,
 *   simplifiedDom: string
 * }}
 */
function vqSmartExtract(config = {}) {
  const threshold = config.confidenceThreshold ?? CONF.LAYER_ESCALATE;
  // A schema the worker resolved. Present only when the user asked for fields
  // of their own; the product path below is untouched without it.
  const schema = Array.isArray(config.schema) ? config.schema : null;

  // Layer 1: Structured data (fast, always run first)
  const layer1 = _runLayer1();

  // Layer 2: Heuristic (run even if L1 found data — fills gaps)
  const layer2 = _runLayer2();

  // Merge both layers
  const merged = _mergeResults(layer1, layer2);

  // Determine if LLM should be called
  const needsLlm = merged.overallConfidence < threshold;

  // Build simplified DOM string only if LLM is needed (saves memory otherwise)
  //
  // With a schema it is always built: the worker cannot judge whether the
  // free layers answered a field this file has no rules for, so the decision
  // to escalate is made there and the text has to be in hand for it.
  const simplifiedDom = needsLlm || schema ? _buildSimplifiedDom() : "";

  const out = {
    result: merged.result,
    perField: merged.perField,
    from: merged.from,
    overallConfidence: merged.overallConfidence,
    method: merged.method,
    warnings: merged.warnings,
    needsLlm,
    simplifiedDom,
  };

  if (schema) {
    // The site's own keys, for the worker to match the requested names
    // against. Two nodes rather than one merged node so their provenance
    // stays distinguishable: JSON-LD is a publisher's assertion about the
    // page, a meta tag is whatever the CMS filled in.
    out.structuredNode = _readAnyStructuredNode();
    out.metaNode = _readMetaNode();
  }

  return out;
}

// Expose to window so injector.js can call it without module boundary
window.__vqSmartExtract = vqSmartExtract;

// === END smart-extractor.js ===
