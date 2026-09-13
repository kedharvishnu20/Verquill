// === structure-detector.js ===
/**
 * @module structure-detector
 * @description Find the repeating record sets on a page, and their columns.
 *
 *   Building a scrape normally means knowing CSS selectors before you start:
 *   name a field, pick it, repeat, and hope the selectors line up. This inverts
 *   that. It reads the page, works out which groups of elements are records —
 *   products, rows, results, reviews — and what columns each has, with sample
 *   values. The user then picks a table instead of picking elements.
 *
 *   A classic script, not a module: content scripts cannot `import`, so it is
 *   injected alongside injector.js and communicates through a global, the same
 *   way smart-extractor.js does.
 *
 *   Three things it does that a naive version gets wrong, each because real
 *   pages do it constantly:
 *
 *     * Records are grouped by *shape overlap*, not an exact fingerprint. A
 *       sponsored row carries an extra badge and a sold-out row has no rating;
 *       exact matching splits one list into three and the user silently scrapes
 *       a subset without ever being told.
 *     * A value split across children is read from the parent. A price written
 *       `<span>$</span><span>10</span>` is one column, not two.
 *     * A column whose text is already covered by an ancestor column is
 *       dropped, so a list does not come back as itself plus each of its items.
 *
 *   What it cannot do: pages that render records with no shared structure, and
 *   single-record pages (a product detail page has nothing repeating to find).
 *   Both come back as "no tables found" rather than as a bad guess.
 *
 * @dependencies none
 */

"use strict";

(() => {
  /** Fewer than this is not a pattern, it is a coincidence. */
  const MIN_RECORDS = 3;
  const MAX_CANDIDATES = 6;
  const MAX_FIELDS = 15;
  const MAX_SAMPLE_ROWS = 3;
  /** How much of two records' child makeup must match to call them the same. */
  const SHAPE_OVERLAP = 0.6;
  /** A column present in fewer records than this is incidental. */
  const MIN_COVERAGE = 0.5;

  const NOISE = new Set([
    "SCRIPT",
    "STYLE",
    "NOSCRIPT",
    "TEMPLATE",
    "SVG",
    "PATH",
    "BR",
    "HR",
  ]);

  /**
   * Class names that are styling state rather than identity.
   *
   * Deliberately narrow. "row", "col", "item", "card" and "grid" read like
   * layout, and Bootstrap does use them that way — but they are also the most
   * common names a site gives an actual record, and excluding them makes the
   * detector fall back to a bare tag selector like `li`, which is worse in
   * every way. Bootstrap's real layout classes carry a digit (`col-md-6`) and
   * the digit rule already catches those.
   */
  const JUNK_CLASS =
    /^(is|has|js|ng|v|active|open|show|hide|visible|hidden|selected|disabled|sr|clearfix)([-_]|$)|\d/;

  const clean = (s) =>
    String(s ?? "")
      .replace(/\s+/g, " ")
      .trim();

  /** The child tag names of an element, as a multiset. */
  const childBag = (el) =>
    [...el.children].filter((c) => !NOISE.has(c.tagName)).map((c) => c.tagName);

  /** How much two child-bags have in common, 0..1. */
  function overlap(a, b) {
    if (!a?.length && !b?.length) return 1;
    const counts = new Map();
    for (const t of a) counts.set(t, (counts.get(t) ?? 0) + 1);
    let shared = 0;
    for (const t of b) {
      if ((counts.get(t) ?? 0) > 0) {
        counts.set(t, counts.get(t) - 1);
        shared++;
      }
    }
    return shared / Math.max(a.length, b.length, 1);
  }

  /** The most useful class on an element, or null. */
  function identityClass(el) {
    return [...el.classList].find((c) => !JUNK_CLASS.test(c)) ?? null;
  }

  /**
   * A selector for `el` relative to `root`, preferring a class.
   * @returns {string} "" when nothing usable was found
   */
  function relSelector(el, root) {
    // A shadow boundary is not expressible in CSS, so the path is emitted with
    // Verquill's piercing combinator and resolved by _queryScoped. Built
    // outermost-first by walking hosts, because the two sides of a boundary are
    // separate trees and `parentElement` is null at the top of each.
    const host = el.getRootNode?.()?.host;
    if (host && host !== root && root.contains?.(host)) {
      const inner = relSelector(el, el.getRootNode());
      const outer = relSelector(host, root);
      return outer ? `${outer} >>> ${inner}` : inner;
    }
    if (host === root || (host && !root.contains?.(host))) {
      // The record *is* the host, or sits inside it: describe within the root.
      root = el.getRootNode();
    }

    const parts = [];
    let node = el;
    // parentNode, not parentElement: the top of a shadow root has a
    // DocumentFragment for a parent, so parentElement is null there and a loop
    // guarded on it never ran a single iteration — every element in a
    // component came back with no selector at all.
    while (node && node !== root) {
      const parent = node.parentNode;
      if (!parent) break;
      const cls = identityClass(node);
      if (cls) {
        const short = `.${CSS.escape(cls)}`;
        return parts.length ? `${short} ${parts.join(" > ")}` : short;
      }
      const tag = node.tagName.toLowerCase();
      const siblings = [...(parent.children ?? [])].filter(
        (c) => c.tagName === node.tagName,
      );
      parts.unshift(
        siblings.length > 1
          ? `${tag}:nth-of-type(${siblings.indexOf(node) + 1})`
          : tag,
      );
      node = parent;
    }
    return parts.join(" > ");
  }

  /** A page-level selector for the record container. */
  function containerSelector(el) {
    const cls = identityClass(el);
    if (cls) {
      const sel = `.${CSS.escape(cls)}`;
      if (document.querySelectorAll(sel).length >= MIN_RECORDS) return sel;
    }
    const parentCls = el.parentElement && identityClass(el.parentElement);
    const tag = el.tagName.toLowerCase();
    if (parentCls) return `.${CSS.escape(parentCls)} > ${tag}`;
    return tag;
  }

  /**
   * The column names a table already gives its own columns.
   *
   * A real `<table>` says what each column is, in a header row, in words the
   * page author chose. Deriving a name from the selector that found the cell
   * instead produced exports like:
   *
   *     tdnthoftype,tdnthoftype 2,tdnthoftype 3,tdnthoftype 4
   *     Clean Code,Robert C. Martin,4.5,26.56
   *
   * — right data, every column misnamed, while the page was holding up a sign
   * saying "name". So read the sign.
   *
   * @param {Element} record - one record element, a <tr> or not
   * @returns {string[]} header text by column index; empty when there is none
   */
  function tableHeaders(record) {
    if (!record || record.tagName !== "TR") return [];
    const table = record.closest("table");
    if (!table) return [];

    // Only where the markup says so: a <thead>, or a row of <th>. A first row
    // of plain <td> is genuinely ambiguous — nothing distinguishes
    // `<tr><td>name</td></tr>` from a row of data, and a human has to read it
    // to tell. Guessing wrong either names every column after the first book,
    // or silently drops a real row from the scrape. So it is left as data,
    // where the user can see it and delete it.
    let cells = [...table.querySelectorAll("thead th, thead td")];
    if (cells.length === 0) {
      cells = [...(table.querySelector("tr:has(th)")?.children ?? [])].filter(
        (c) => c.tagName === "TH",
      );
    }
    return cells.map((c) => clean(c.textContent));
  }

  /**
   * A row of column headers, in either vocabulary.
   *
   * `<th>` cells differ in tag from `<td>` cells, so a real table's header row
   * falls out of the record set on shape alone. An ARIA table spells both with
   * the same element and distinguishes them by `role`, so the header row
   * matched the data rows perfectly and became row one of the scrape.
   */
  function isHeaderRow(el) {
    const kids = [...el.children].filter((c) => !NOISE.has(c.tagName));
    if (kids.length === 0) return false;
    return kids.every(
      (c) => c.tagName === "TH" || c.getAttribute?.("role") === "columnheader",
    );
  }

  /** Header text from an ARIA table, when the markup uses roles. */
  function ariaHeaders(record) {
    const table = record?.closest?.('[role="table"],[role="grid"]');
    if (!table) return [];
    const row = [...table.children].find(isHeaderRow);
    if (!row) return [];
    return [...row.children]
      .filter((c) => !NOISE.has(c.tagName))
      .map((c) => clean(c.textContent));
  }

  /**
   * The 1-based column index a `td:nth-of-type(N)` selector points at.
   * @returns {number} 0 when the selector is not a positional cell
   */
  function cellIndex(selector) {
    const last =
      selector
        .split(/[\s>+~]+/)
        .filter(Boolean)
        .shift() ?? "";
    const m = last.match(/^(?:td|th):nth-of-type\((\d+)\)$/i);
    return m ? Number(m[1]) : 0;
  }

  /**
   * The best name for a column: the one the page gave it, else a guess.
   *
   * @param {string} selector
   * @param {string} kind - "text", "href" or "src"
   * @param {string[]} headers - the table's header row, if it has one
   */
  function nameFrom(selector, kind, headers, childIndex = -1) {
    const index = cellIndex(selector);
    const header =
      index > 0
        ? (headers[index - 1] ?? "")
        : childIndex >= 0
          ? (headers[childIndex] ?? "")
          : "";
    if (!header) return nameFor(selector, kind);
    const base = header.toLowerCase();
    // The cell may yield more than one column — its text and a link's href —
    // so the kind still has to be part of the name.
    if (kind === "href") return base.endsWith("url") ? base : `${base} url`;
    if (kind === "src") return base.endsWith("image") ? base : `${base} image`;
    return base;
  }

  /** A column name guessed from the selector that found it. */
  function nameFor(selector, kind) {
    const last =
      selector
        .split(/[\s>+~]+/)
        .filter(Boolean)
        .pop() ?? "";
    const token =
      last.match(/\.([A-Za-z][\w-]*)/)?.[1] ??
      last.replace(/[^A-Za-z]/g, "") ??
      "field";
    const base =
      token
        .replace(/^(s|p|c|js|is|ui|el)[-_]/i, "")
        .replace(/[-_]+/g, " ")
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .trim()
        .toLowerCase() || "field";
    if (kind === "href") return base.endsWith("url") ? base : `${base} url`;
    if (kind === "src") return base.endsWith("image") ? base : `${base} image`;
    return base;
  }

  /**
   * Make every column name unique within a table.
   *
   * An anchor carries both text and an href, so `.link` produces two columns.
   * Rows are plain objects, so two columns sharing a name means one silently
   * overwrites the other and a column vanishes without a word.
   *
   * @param {Array<{name: string}>} columns - named in place
   */
  function uniquifyNames(columns) {
    const taken = new Set();
    for (const col of columns) {
      let name = col.name;
      let n = 2;
      while (taken.has(name)) name = `${col.name} ${n++}`;
      taken.add(name);
      col.name = name;
    }
  }

  /**
   * Every element inside a record, including the ones behind shadow roots.
   *
   * A record built from web components has no children in the light DOM at
   * all — `<shop-card>` is an empty tag and its title, price and rating live
   * in its shadow root. `record.querySelectorAll("*")` returned nothing, so
   * the record had no columns, and a table needs two: Detect Table reported
   * "no tables found" on a whole class of modern site.
   */
  function descendants(record) {
    const out = [];
    const visit = (node) => {
      for (const el of node.querySelectorAll("*")) {
        out.push(el);
        if (el.shadowRoot) visit(el.shadowRoot);
      }
    };
    visit(record);
    if (record.shadowRoot) visit(record.shadowRoot);
    return out;
  }

  /**
   * Page furniture that repeats but is not data.
   *
   * A navigation menu, a pager and a footer link list are all perfectly regular
   * repeating structures — that is what makes them menus — so the detector
   * scored them exactly as it scored a product grid. On a real page the nav is
   * often the *longer* list: a twelve-item menu beat a four-product grid,
   * because the score was rows x columns and the menu had three times the rows.
   *
   * These landmarks say what they are, so believe them.
   */
  const CHROME_SELECTOR =
    'nav,footer,[role="navigation"],[role="contentinfo"],.pagination,.breadcrumb,.breadcrumbs';

  function isPageChrome(el) {
    try {
      return Boolean(el.closest(CHROME_SELECTOR));
    } catch {
      return false;
    }
  }

  /**
   * How much a candidate is worth being offered first.
   *
   * Not simply rows x columns. An anchor's text and its href are one piece of
   * information counted twice, so a list of bare links scored double what it
   * was worth — which is most of why menus outranked data. Columns are counted
   * per distinct element instead, and a candidate whose every column comes from
   * a single element is a link list rather than a table.
   */
  function distinctBases(columns) {
    return new Set(
      columns.map((c) =>
        String(c.selector)
          .replace(/\s*>\s*/g, " ")
          .trim(),
      ),
    ).size;
  }

  function scoreOf(members, columns) {
    return members.length * Math.max(1, distinctBases(columns));
  }

  /** Group the page's elements into candidate record sets. */
  function findRecordSets() {
    const sets = [];
    for (const parent of document.querySelectorAll("*")) {
      const kids = [...parent.children].filter((c) => !NOISE.has(c.tagName));
      if (kids.length < MIN_RECORDS) continue;

      const byTag = new Map();
      for (const kid of kids) {
        if (!byTag.has(kid.tagName)) byTag.set(kid.tagName, []);
        byTag.get(kid.tagName).push(kid);
      }

      for (const sameTag of byTag.values()) {
        if (sameTag.length < MIN_RECORDS) continue;
        const bags = sameTag.map(childBag);

        // The shape the most siblings agree on is the reference.
        let reference = null;
        let bestCount = 0;
        for (const bag of bags) {
          const n = bags.filter((b) => overlap(bag, b) >= SHAPE_OVERLAP).length;
          if (n > bestCount) {
            bestCount = n;
            reference = bag;
          }
        }
        if (!reference) continue;

        const members = sameTag.filter(
          (_, i) => overlap(bags[i], reference) >= SHAPE_OVERLAP,
        );
        // A header row that matches the data rows on shape is still a header
        // row. In an ARIA table both are spelled the same and only the role
        // tells them apart, so it became row one of every scrape.
        const rows = members.filter((m) => !isHeaderRow(m));
        if (rows.length >= MIN_RECORDS) sets.push(rows);
      }
    }
    return sets;
  }

  /** Work out the columns of one record set. */
  /**
   * Attributes that carry a value the element renders as graphics.
   *
   * `aria-label`, `title` and `alt` are the accessible name — the standard,
   * required way to say what a picture means, so a rating widget that omits
   * them is already broken for screen readers. `data-*` is where a component
   * keeps the value that drives its own rendering.
   */
  const LABEL_ATTRS = ["aria-label", "title", "alt"];

  /**
   * The value of an element that has no text, no href and no src.
   *
   * Returns every plausible carrier rather than picking one, because which is
   * right depends on the site and the caller already has the machinery to
   * decide: a column whose value never varies across records is dropped as a
   * label, so a wrong guess here costs a column that disappears on its own,
   * while a missing guess costs the user their data.
   *
   * @returns {Array<[kind, sample, extra]>} entries for the column table
   */
  function graphicValues(el, record) {
    const out = [];
    const attr = (n) => clean(el.getAttribute?.(n) ?? "");

    // 1. The accessible name — "4 out of 5 stars".
    for (const name of LABEL_ATTRS) {
      const v = attr(name);
      if (v && v.length <= 120) return [["attr", v, { attribute: name }]];
    }

    // 2. The value the component renders from — data-rating, data-score.
    for (const a of el.attributes ?? []) {
      if (!a.name.startsWith("data-")) continue;
      const v = clean(a.value);
      if (!v || v.length > 40) continue;
      return [["attr", v, { attribute: a.name }]];
    }

    // Nothing states the value outright, so offer the two ways it might be
    // implied and let the constancy filter settle it.

    // 3. The class list, where the value is encoded in it: the shape
    //    `<p class="star-rating Three">` that book-catalogue markup uses. A
    //    class list that is the same in every record is a style hook, and the
    //    constancy filter drops it without this having to guess.
    const classes = clean(el.className || "");
    if (classes && el.children.length > 0) {
      out.push(["attr", classes, { attribute: "class" }]);
    }

    // 4. Repeated icon children, counted: four filled stars is the value 4.
    //    Only the most specific signature, so `<i class="star filled">` wins
    //    over the bare `<i>` it also matches and the widget yields one column.
    if (el.children.length >= 2) {
      const sigs = new Map();
      for (const child of el.children) {
        if (NOISE.has(child.tagName) || child.children.length > 0) continue;
        const tag = child.tagName.toLowerCase();
        const cls = [...child.classList].filter((c) => !JUNK_CLASS.test(c));
        const sig = cls.length ? `${tag}.${cls.join(".")}` : tag;
        sigs.set(sig, (sigs.get(sig) ?? 0) + 1);
      }
      let best = "";
      let bestCount = 0;
      for (const [sig, n] of sigs) {
        if (n < 2) continue;
        const specificity = sig.split(".").length;
        const bestSpec = best ? best.split(".").length : -1;
        if (
          specificity > bestSpec ||
          (specificity === bestSpec && n > bestCount)
        ) {
          best = sig;
          bestCount = n;
        }
      }
      if (best) out.push(["count", String(bestCount), { countSelector: best }]);
    }

    return out;
  }

  function columnsOf(members) {
    const found = new Map();

    for (const record of members) {
      const seen = new Set();
      for (const el of descendants(record)) {
        if (NOISE.has(el.tagName)) continue;

        const full = clean(el.textContent);
        const ownText = clean(
          [...el.childNodes]
            .filter((n) => n.nodeType === 3)
            .map((n) => n.textContent)
            .join(" "),
        );

        const href = el.getAttribute?.("href");
        const src = el.getAttribute?.("src");

        // Drop the wrapper, keep the thing it wraps.
        //
        // Markup nests: `<td><div class="wrap"><div class="title">X</div></div></td>`
        // is three elements holding one value, and only the innermost has a
        // selector worth writing. This used to look *up* — "my parent has one
        // child and my text, so I am the artefact" — which is true of every
        // element in such a chain, including the one that actually holds the
        // text. Both got skipped, the cell yielded nothing, and a table whose
        // cells wrap their contents in divs came back as "no tables found".
        //
        // Looking down instead names the redundant one exactly: an element
        // whose single element child carries all of its text adds nothing the
        // child does not already say.
        const kids = [...el.children].filter((c) => !NOISE.has(c.tagName));
        if (
          !href && // unless it carries something of its own: an <a> around an
          !src && //  <img> is this shape, and both columns are wanted
          kids.length === 1 &&
          clean(kids[0].textContent) === full
        ) {
          continue;
        }

        // An element whose children are all leaves reads as one value — that is
        // how a price split across spans becomes a single column.
        const childrenAreLeaves =
          el.children.length > 0 &&
          [...el.children].every((c) => c.children.length === 0);
        const value = ownText || (childrenAreLeaves ? full : "");

        // No text, no link, no image is not the same as no value. A star
        // rating, a status pip, a flag — the whole point of the widget is to
        // show a value without writing it down, and this used to `continue`
        // straight past them. That is why a books table detected as "10 rows x
        // 3 columns" with the rating column missing.
        // A shadow host has no text of its own — its content is a separate
        // tree, walked here in its own right. Offering the host's attributes
        // as a column duplicates whatever its insides already yield.
        const graphic =
          !value && !href && !src && !el.shadowRoot
            ? graphicValues(el, record)
            : [];
        if (!value && !href && !src && graphic.length === 0) continue;

        const selector = relSelector(el, record);
        if (!selector) continue;

        for (const [kind, sample, extra] of [
          ["text", value],
          ["href", href],
          ["src", src],
          ...graphic,
        ]) {
          if (!sample) continue;
          const id = `${selector}|${kind}|${extra?.attribute ?? extra?.countSelector ?? ""}`;
          if (!found.has(id)) {
            found.set(id, {
              selector,
              kind,
              ...extra,
              hits: 0,
              samples: [],
              // The element's whole rendered text, kept beside the sample
              // because they are not the same thing and the containment pass
              // below needs the difference. See the note there.
              fulls: [],
              // Where this column sits in the record, in document order. The
              // detector walks the DOM in order, so first-seen is left-to-right.
              order: found.size,
              depth: 0,
              // Which cell of the record this is, when it is one. A <th> row
              // names its columns by position, and only a positional selector
              // (`td:nth-of-type(2)`) could be matched back to that name — so a
              // table whose cells carry classes, or an ARIA table that spells
              // its cells with roles, got selector-derived names while the page
              // was holding up a sign saying "Price".
              childIndex: [...record.children]
                .filter((c) => !NOISE.has(c.tagName))
                .indexOf(el),
            });
            let d = 0;
            for (let n = el; n && n !== record; n = n.parentElement) d++;
            found.get(id).depth = d;
          }
          const col = found.get(id);
          // Once per record, so coverage is a share and not a tally.
          if (!seen.has(id)) {
            col.hits++;
            seen.add(id);
          }
          col.samples.push(sample);
          if (kind === "text") col.fulls.push(full);
        }
      }
    }

    let columns = [...found.values()].filter(
      (c) => c.hits >= members.length * MIN_COVERAGE,
    );

    // The names the page gives its own columns, needed here as well as for
    // naming: a column the page names in a header row is a column, whatever
    // its values happen to be.
    const headerNames = tableHeaders(members[0]);
    const columnNames = headerNames.length
      ? headerNames
      : ariaHeaders(members[0]);

    /** Does the page's header row name this column? */
    const isNamedColumn = (c) => {
      const idx = cellIndex(c.selector);
      if (idx > 0) return Boolean(columnNames[idx - 1]);
      return c.childIndex >= 0 && Boolean(columnNames[c.childIndex]);
    };

    // A column whose value never changes is the form's label, not the record's
    // data. Real markup labels its fields inline — `<strong>Capital:</strong>`
    // beside the value — and those <strong>s have the same shape in every
    // record, so they read as a perfectly consistent column. On a real run
    // against a country list this produced three columns holding "Capital:",
    // "Population:" and "Area (km2):" repeated 250 times, plus a fourth holding
    // the "2" from km<sup>2</sup>.
    //
    // Unless the page names it. A rating column that reads 4 for every book on
    // the page is constant and is still the ratings column — dropping it lost a
    // column the table's own header row was announcing, which is the one piece
    // of evidence that settles "label or data" outright. The label case has no
    // header: it is an element *inside* a cell, not a cell.
    //
    // Only applied where there is enough to judge by: with two records, two
    // matching values is a coincidence as often as a rule.
    if (members.length >= MIN_RECORDS) {
      columns = columns.filter((c) => {
        if (isNamedColumn(c)) return true;
        if (c.samples.length < Math.min(members.length, MIN_RECORDS))
          return true;
        const distinct = new Set(c.samples.map((v) => clean(v)));
        return distinct.size > 1;
      });
    }

    // Drop a text column whose value is already inside a shallower one. A list
    // and each of its items are not four columns, they are one.
    //
    // Compared against the shallower column's *whole* text, not its sample.
    // Those differ exactly when a cell mixes text with an element —
    // `<td><span>$</span>10.49</td>` — because a cell's sample is its own text
    // nodes only, so the two read "10.49" and "$": disjoint pieces of one cell
    // rather than one containing the other, and this pass let the `<span>`
    // through as a second column. The page's header row then named both of
    // them, and the price column appeared twice, the second as "price 2".
    const texts = columns.filter((c) => c.kind === "text");
    columns = columns.filter((col) => {
      if (col.kind !== "text") return true;
      const mine = col.samples[0] ?? "";
      if (!mine) return false;
      return !texts.some(
        (other) =>
          other !== col &&
          other.depth < col.depth &&
          (other.fulls[0] ?? other.samples[0] ?? "").includes(mine),
      );
    });

    const named0 = columnNames;
    const named = columns
      // Two different jobs, so two different orders. Ranking by coverage picks
      // *which* columns survive the cap — the ones present in most records are
      // the real ones. But a reader expects the columns in the order the page
      // has them: a table whose header says name, author, stars, price should
      // not come back price-first because the price cell happened to be the
      // shallowest. So rank, cut, then restore document order.
      .sort((a, b) => b.hits - a.hits || a.depth - b.depth)
      .slice(0, MAX_FIELDS)
      .sort((a, b) => a.order - b.order)
      .map((c) => ({
        name: nameFrom(c.selector, c.kind, named0, c.childIndex ?? -1),
        selector: c.selector,
        kind: c.kind,
        // A "attr" or "count" column is only readable with the attribute name
        // or the child selector that produced it. Dropping them here made the
        // detected column fail at run time with "set to Attr but has no
        // attribute name" — loudly, at least, but still a column that could
        // not be used.
        ...(c.attribute ? { attribute: c.attribute } : {}),
        ...(c.countSelector ? { countSelector: c.countSelector } : {}),
        coverage: Math.round((c.hits / members.length) * 100),
        // Trimmed only now: the constancy check above needs every sample, and
        // three would have called a 250-row label column "varied" as often as
        // not.
        samples: c.samples.slice(0, MAX_SAMPLE_ROWS),
      }));
    uniquifyNames(named);
    return named;
  }

  /**
   * Read the page's repeating structures.
   *
   * @returns {{ url: string, title: string, candidates: object[] }}
   */
  function detectStructure() {
    const candidates = [];

    for (const members of findRecordSets()) {
      // A menu, a pager and a footer link list repeat perfectly regularly —
      // that is what makes them menus — so they were scored exactly like a
      // product grid, and on a real page the nav is often the longer list.
      if (members.every(isPageChrome)) continue;

      const columns = columnsOf(members);
      // Two *columns* is not the test — an anchor's text and its href are two
      // columns describing one element, which is what let a sidebar of ten
      // category links outrank a four-product grid. A table needs two distinct
      // things per record.
      if (distinctBases(columns) < 2) continue;

      const selector = containerSelector(members[0]);
      // Only offer a container the page can actually find again.
      let matched = 0;
      try {
        matched = document.querySelectorAll(selector).length;
      } catch {
        continue;
      }
      if (matched < MIN_RECORDS) continue;

      candidates.push({
        selector,
        count: members.length,
        matched,
        fields: columns,
        // Rows the user reads to decide, rather than trusting the selectors.
        sampleRows: Array.from({
          length: Math.min(MAX_SAMPLE_ROWS, members.length),
        }).map((_, i) =>
          Object.fromEntries(
            columns.map((c) => [c.name, c.samples[i] ?? c.samples[0] ?? ""]),
          ),
        ),
        score: scoreOf(members, columns),
      });
    }

    // Two containers can describe the same list; keep the better one.
    const unique = new Map();
    for (const c of candidates.sort((a, b) => b.score - a.score)) {
      if (!unique.has(c.selector)) unique.set(c.selector, c);
    }

    return {
      url: location.href,
      title: document.title,
      candidates: [...unique.values()].slice(0, MAX_CANDIDATES),
    };
  }

  // The isolated world is shared with injector.js, which dispatches to this.
  globalThis.__vqDetectStructure = detectStructure;
})();

// === END structure-detector.js ===
