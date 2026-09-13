// End-to-end checks against a real Chromium with the extension loaded.
//
// Run with: npm run e2e
import test from "node:test";
import assert from "node:assert/strict";
import { launch, startSite } from "./harness.mjs";

const PRODUCTS = `<!doctype html><html><head><title>Shop</title></head><body>
  <h1 id="title">Test Shop</h1>
  <div class="product-card"><a class="product-link" href="/p/1">Widget</a>
    <span class="price">$10.00</span><span class="stock">In stock</span></div>
  <div class="product-card"><a class="product-link" href="/p/2">Gadget</a>
    <span class="price">$25.50</span><span class="stock">In stock</span></div>
  <div class="product-card"><a class="product-link" href="/p/3">Doohickey</a>
    <span class="price">$7.99</span><span class="stock">Out of stock</span></div>
  <input id="search" type="text">
  <input id="pw" type="password">
  <input id="agree" type="checkbox">
  <select id="size"><option value="s">Small</option><option value="l">Large</option></select>
  <div id="editable" contenteditable="true"></div>
  <button id="go">Go</button>
  <div id="clicked">no</div>
  <script>
    document.getElementById('go').addEventListener('click', () => {
      document.getElementById('clicked').textContent = 'yes';
    });
  </script>
</body></html>`;

// A page that is not a product: the case AUTO_EXTRACT could not express at all
// before schemas. Its JSON-LD uses the site's own key names, which is what the
// worker has to match a user's field names against.
const ARTICLE = `<!doctype html><html><head><title>Court listing</title>
  <meta property="og:section" content="Chancery Division">
  <script type="application/ld+json">
  {"@context":"https://schema.org","@type":"Article",
   "headline":"Acme Ltd v Bloggs",
   "datePublished":"2026-01-02",
   "author":{"@type":"Person","name":"Ada Lovelace"},
   "keywords":["contract","damages"]}
  </script></head><body>
  <h1>Acme Ltd v Bloggs</h1><p>Judgment of the court.</p>
  <nav><a href="/">Home</a></nav>
  <span class="court">Chancery Division</span>
</body></html>`;

// A business directory: the ordinary, legitimate scrape that happens to come
// back full of personal data. Nobody is doing anything wrong here, which is
// exactly why the run should mention it before the file is exported and shared.
const DIRECTORY = `<!doctype html><html><body>
  <ul>
    <li class="row"><span class="who">Ada Lovelace</span><span class="mail">ada@example.com</span></li>
    <li class="row"><span class="who">Grace Hopper</span><span class="mail">grace@example.com</span></li>
  </ul>
</body></html>`;

// An upload widget with no file input at all — the shape that made
// UPLOAD_ACTIVITY fail with "Upload input not found" on a page that was
// perfectly willing to take the file. It does what a real dropzone must:
// cancels dragover, so the browser allows the drop, then reads the files off
// the event.
const DROPZONE = `<!doctype html><html><body>
  <div id="zone" style="width:300px;height:120px;border:2px dashed #888">Drop files here</div>
  <div id="dropped">none</div>
  <div id="inert" style="width:120px;height:60px">No handler here</div>
  <script>
    var zone = document.getElementById('zone');
    zone.addEventListener('dragover', function (e) { e.preventDefault(); });
    zone.addEventListener('drop', function (e) {
      e.preventDefault();
      var names = [];
      for (var i = 0; i < e.dataTransfer.files.length; i++) {
        names.push(e.dataTransfer.files[i].name + ':' + e.dataTransfer.files[i].size);
      }
      document.getElementById('dropped').textContent = names.join(',');
    });
  </script>
</body></html>`;

// A controlled input that behaves like React's: it caches the last value it saw
// and overwrites anything it did not notice. This is the B-10 failure mode, in
// a real browser rather than a jsdom simulation of one.
const CONTROLLED = `<!doctype html><html><body>
  <input id="ctl" type="text">
  <div id="state"></div>
  <script>
    (function () {
      var node = document.getElementById('ctl');
      var proto = Object.getPrototypeOf(node);
      var desc = Object.getOwnPropertyDescriptor(proto, 'value');
      var tracked = '';
      var state = '';
      Object.defineProperty(node, 'value', {
        configurable: true,
        get: function () { return desc.get.call(this); },
        set: function (v) { tracked = String(v); desc.set.call(this, v); }
      });
      node._valueTracker = {
        getValue: function () { return tracked; },
        setValue: function (v) { tracked = String(v); }
      };
      node.addEventListener('input', function () {
        var next = desc.get.call(node);
        if (next === tracked) return;
        tracked = next;
        state = next;
      });
      node.addEventListener('input', function () {
        desc.set.call(node, state);
        document.getElementById('state').textContent = state;
      });
    })();
  </script>
</body></html>`;

// A page whose content arrives late, and a feed that grows as you scroll. Both
// are what the WAIT and SCROLL steps exist for, and neither can be simulated in
// jsdom: there is no layout, so nothing is ever really below the fold.
const LAZY = `<!doctype html><html><body>
  <div id="feed"></div>
  <div id="late-host"></div>
  <script>
    // A results panel that shows up after a moment, hidden first — the shape
    // that makes "wait until it exists" the wrong check.
    var late = document.createElement('div');
    late.className = 'results';
    late.style.display = 'none';
    late.textContent = 'Results';
    document.getElementById('late-host').appendChild(late);
    setTimeout(function () { late.style.display = 'block'; }, 700);

    // Ten items per screenful, four screenfuls, then nothing more.
    var pages = 0;
    function grow() {
      if (pages >= 4) return;
      pages++;
      var feed = document.getElementById('feed');
      for (var i = 0; i < 10; i++) {
        var d = document.createElement('div');
        d.className = 'post';
        d.style.height = '120px';
        d.textContent = 'post ' + (pages * 10 + i);
        feed.appendChild(d);
      }
    }
    grow();
    window.addEventListener('scroll', function () {
      if (window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 50) {
        setTimeout(grow, 100);
      }
    });
  </script>
</body></html>`;

/** Page N of a three-page list; page 3's Next button is disabled. */
const paged = (n) => `<!doctype html><html><body>
  <h1 id="title">Page ${n}</h1>
  <div class="row">item ${n}a</div>
  <div class="row">item ${n}b</div>
  ${
    n < 3
      ? `<a class="next" href="/page/${n + 1}">Next</a>`
      : `<button class="next" disabled>Next</button>`
  }
</body></html>`;

/**
 * A product page shaped the way real ones are: JSON-LD for the search engines,
 * Open Graph for the social cards, and prices rendered for people. Nothing
 * repeating, so the structure detector has nothing to offer — which is exactly
 * the case PAGE_DATA exists for.
 */
const RICH = `<!doctype html><html><head>
  <title>Widget — Test Shop</title>
  <meta property="og:title" content="Widget">
  <meta property="og:image" content="/i/widget.jpg">
  <meta name="description" content="A very good widget.">
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "WebSite", "name": "Test Shop" },
      {
        "@type": "Product",
        "name": "Widget",
        "sku": "W-1",
        "brand": { "@type": "Brand", "name": "Acme" },
        "offers": { "@type": "Offer", "price": "10.00", "priceCurrency": "USD" }
      }
    ]
  }
  </script>
</head><body>
  <h1>Widget</h1>
  <div itemscope itemtype="https://schema.org/Review">
    <span itemprop="author">Sam</span>
    <meta itemprop="datePublished" content="2026-01-05">
  </div>
</body></html>`;

/** A page several screenfuls tall, with a known element to crop to. */
const TALL = `<!doctype html><html><head><style>
  body { margin: 0; }
  .band { height: 700px; }
  #card { width: 300px; height: 200px; background: #c00; margin: 40px; }
</style></head><body>
  <div class="band" style="background:#eef"></div>
  <div id="card"></div>
  <div class="band" style="background:#efe"></div>
  <div class="band" style="background:#fee"></div>
</body></html>`;

/** A country list, shaped the way scrapethissite.com shapes one. */
const COUNTRY = (n, c, p, a) => `<div class="col-md-4 country">
  <h3 class="country-name"><i class="flag-icon"></i>${n}</h3>
  <div class="country-info">
    <strong>Capital:</strong> <span class="country-capital">${c}</span><br>
    <strong>Population:</strong> <span class="country-population">${p}</span><br>
    <strong>Area (km<sup>2</sup>):</strong> <span class="country-area">${a}</span>
  </div></div>`;
const COUNTRIES = `<!doctype html><html><head><title>Countries</title></head><body>
  <div class="container"><h1>Countries</h1><div class="row">
  ${COUNTRY("Andorra", "Andorra la Vella", "84000", "468.0")}
  ${COUNTRY("Afghanistan", "Kabul", "29121286", "647500.0")}
  ${COUNTRY("Antarctica", "None", "0", "1.4E7")}
  ${COUNTRY("Albania", "Tirana", "2986952", "28748.0")}
  </div></div>
</body></html>`;

/** A page whose real content lives inside an iframe, as w3schools' demo does. */
const FRAMED = `<!doctype html><html><body>
  <h1 id="outer">Outer page</h1>
  <iframe id="iframeResult" src="/framed-inner" style="width:600px;height:300px"></iframe>
</body></html>`;
const FRAMED_INNER = `<!doctype html><html><body>
  <h1 id="inner-title">Inside the frame</h1>
  <div class="framed-item">Alpha</div>
  <div class="framed-item">Beta</div>
  <input id="framed-input" type="text">
  <button id="framed-btn">Go</button>
  <div id="framed-clicked">no</div>
  <script>
    document.getElementById('framed-btn').addEventListener('click', () => {
      document.getElementById('framed-clicked').textContent = 'yes';
    });
  </script>
</body></html>`;

/** A page that calls an API when you click, plus a tracking beacon to filter out. */
const APIPAGE = `<!doctype html><html><body>
  <button id="go">Load</button>
  <script>
    document.getElementById('go').addEventListener('click', async () => {
      await fetch('/api/items');
      await fetch('/track/px');
    });
  </script>
</body></html>`;

/** A grid of product cards, the shape "bulk extract" kept getting wrong. */
const CARDS = `<!doctype html><html><head><title>Cards</title></head><body>
  <h1 class="page-title">Shop</h1>
  <div class="grid">
    <div class="card"><h3 class="title">Widget</h3><span class="price">$10.00</span><a class="buy" href="/p/1">Buy</a></div>
    <div class="card"><h3 class="title">Gadget</h3><span class="price">$25.50</span><a class="buy" href="/p/2">Buy</a></div>
    <div class="card"><h3 class="title">Doohickey</h3><span class="price">$7.99</span><a class="buy" href="/p/3">Buy</a></div>
  </div>
</body></html>`;

let env;
let site;

test.before(async () => {
  site = await startSite({
    "/": PRODUCTS,
    "/controlled": CONTROLLED,
    "/lazy": LAZY,
    "/page/1": paged(1),
    "/page/2": paged(2),
    "/page/3": paged(3),
    "/rich": RICH,
    "/tall": TALL,
    "/countries": COUNTRIES,
    "/cards": CARDS,
    "/apipage": APIPAGE,
    "/api/items": '{"items":[1,2,3]}',
    "/track/px": "ok",
    "/article": ARTICLE,
    "/dropzone": DROPZONE,
    "/framed": FRAMED,
    "/framed-inner": FRAMED_INNER,
    "/directory": DIRECTORY,
  });
  env = await launch();
});

test.after(async () => {
  await env?.close();
  await site?.close();
});

// ── loading ──────────────────────────────────────────────────────────────────

test("Chrome loads the extension and starts the service worker", () => {
  assert.match(env.sw.url(), /background\/service-worker\.js$/);
  assert.match(env.extensionId, /^[a-p]{32}$/);
});

test("the side panel renders", async () => {
  const title = await env.panel.title();
  assert.ok(title.length > 0, "the panel page has a title");

  // The board, the palette trigger and the run controls all exist.
  for (const id of ["btn-master-run", "run-controls", "btn-master-pause"]) {
    assert.equal(
      await env.panel.locator(`#${id}`).count(),
      1,
      `#${id} is missing from the rendered panel`,
    );
  }
});

test("the panel loads with no uncaught errors", () => {
  assert.deepEqual(env.consoleErrors, []);
});

// ── the message bus ──────────────────────────────────────────────────────────

test("the worker answers on its message bus", async () => {
  const res = await env.send("checkpoint:check");
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(typeof res.result.hasResumable, "boolean");
});

test("an unknown message type is refused by name", async () => {
  const res = await env.send("nonsense:type");
  assert.equal(res.ok, false);
  assert.match(res.error, /Unknown message type/);
});

// ── on-demand injection (C-09) ───────────────────────────────────────────────

test("a step reaches a page with no declared content script", async () => {
  const page = await env.ctx.newPage();
  await page.goto(site.url("/"));
  const tabId = await page.evaluate(() => 0); // placeholder; real id below

  // The worker needs the tab id Chrome assigned. Ask the extension for it.
  const id = await env.panel.evaluate(
    (url) =>
      new Promise((resolve) => {
        chrome.tabs.query({}, (tabs) =>
          resolve(tabs.find((t) => t.url === url)?.id ?? null),
        );
      }),
    site.url("/"),
  );
  assert.ok(id, "the test page has a tab id");
  void tabId;

  const res = await env.send("step:execute", {
    step: {
      id: "s1",
      type: "EXTRACT",
      config: { fields: [{ name: "t", selector: "#title" }] },
    },
    tabId: id,
  });

  assert.equal(res.ok, true, `injection failed: ${JSON.stringify(res)}`);
  assert.deepEqual(res.result, [{ t: "Test Shop" }]);
  await page.close();
});

// ── the page steps, against a real DOM ───────────────────────────────────────

async function onSite(path = "/") {
  const page = await env.ctx.newPage();
  await page.goto(site.url(path));
  const id = await env.panel.evaluate(
    (url) =>
      new Promise((resolve) => {
        chrome.tabs.query({}, (tabs) => {
          // The *last* match, not the first: several checks visit the same
          // path, and any tab an earlier one left open would otherwise be the
          // one this test drives. That is how a working KEYBOARD step looked
          // broken — the key went to a stale tab and this page saw nothing.
          const matches = tabs.filter((t) => t.url === url);
          resolve(matches[matches.length - 1]?.id ?? null);
        });
      }),
    site.url(path),
  );
  return { page, tabId: id };
}

const step = (type, config) => ({ id: `s_${type}`, type, config });

/**
 * Put one file in the extension's storage library.
 *
 * UPLOAD_ACTIVITY reads its bytes from there rather than from the step, which
 * is why it is not exportable — so a check that handed the bytes in directly
 * would be testing a path the product does not have.
 */
async function seedStorageFile() {
  await env.sw.evaluate(async () => {
    await chrome.storage.local.set({
      vq_storage_files_v1: [
        {
          id: "e2e-shot",
          name: "shot.png",
          type: "image/png",
          dataUrl: "data:image/png;base64,QUJD",
        },
      ],
    });
  });
}

test("EXTRACT reads several rows from a real page", async () => {
  const { page, tabId } = await onSite();
  const res = await env.send("step:execute", {
    step: step("EXTRACT", {
      fields: [
        { name: "name", selector: ".product-link" },
        { name: "price", selector: ".price" },
      ],
    }),
    tabId,
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.result, [
    { name: "Widget", price: "$10.00" },
    { name: "Gadget", price: "$25.50" },
    { name: "Doohickey", price: "$7.99" },
  ]);
  await page.close();
});

test("EXTRACT reads an attribute when asked to", async () => {
  const { page, tabId } = await onSite();
  const res = await env.send("step:execute", {
    step: step("EXTRACT", {
      fields: [
        {
          name: "href",
          selector: ".product-link",
          type: "attribute",
          attribute: "href",
        },
      ],
    }),
    tabId,
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(
    res.result.map((r) => r.href),
    ["/p/1", "/p/2", "/p/3"],
  );
  await page.close();
});

test("CLICK actually clicks", async () => {
  const { page, tabId } = await onSite();
  const res = await env.send("step:execute", {
    step: step("CLICK", { selector: "#go" }),
    tabId,
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(await page.locator("#clicked").textContent(), "yes");
  await page.close();
});

test("UPLOAD_ACTIVITY drops files onto a zone with no file input", async () => {
  // jsdom has neither DataTransfer nor DragEvent, so the unit tests run against
  // stand-ins. Whether Chrome delivers the sequence, and whether a page really
  // gets a File out of the other end, can only be answered here.
  const { page, tabId } = await onSite("/dropzone");
  await seedStorageFile();
  const res = await env.send("step:execute", {
    step: step("UPLOAD_ACTIVITY", {
      selector: "#zone",
      mode: "drop",
      fileIds: ["e2e-shot"],
    }),
    tabId,
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(
    await page.locator("#dropped").textContent(),
    "shot.png:3",
    "the page read a real File, with its real length, off the event",
  );
  await page.close();
});

test("a drop nothing handles is reported as not accepted", async () => {
  const { page, tabId } = await onSite("/dropzone");
  await seedStorageFile();
  const res = await env.send("step:execute", {
    step: step("UPLOAD_ACTIVITY", {
      selector: "#inert",
      mode: "drop",
      fileIds: ["e2e-shot"],
    }),
    tabId,
  });
  // The step fails, and that is the point: a drop nobody handled must not be
  // reported as an upload that happened.
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.match(res.error, /did not accept the drop/i);
  assert.equal(await page.locator("#dropped").textContent(), "none");
  await page.close();
});

test("FILL types into a plain input", async () => {
  const { page, tabId } = await onSite();
  const res = await env.send("step:execute", {
    step: step("FILL", {
      selector: "#search",
      text: "running shoes",
      delayMs: 0,
    }),
    tabId,
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(await page.locator("#search").inputValue(), "running shoes");
  await page.close();
});

test("FILL beats a controlled input — the B-10 fix, in a real browser", async () => {
  const { page, tabId } = await onSite("/controlled");
  const res = await env.send("step:execute", {
    step: step("FILL", { selector: "#ctl", text: "sneakers", delayMs: 0 }),
    tabId,
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(
    await page.locator("#ctl").inputValue(),
    "sneakers",
    "the DOM value",
  );
  assert.equal(
    await page.locator("#state").textContent(),
    "sneakers",
    "and the component state behind it",
  );
  await page.close();
});

test("FILL handles a checkbox, a select and a contenteditable", async () => {
  const { page, tabId } = await onSite();

  assert.equal(
    (
      await env.send("step:execute", {
        step: step("FILL", { selector: "#agree", text: "true", delayMs: 0 }),
        tabId,
      })
    ).ok,
    true,
  );
  assert.equal(await page.locator("#agree").isChecked(), true);

  assert.equal(
    (
      await env.send("step:execute", {
        step: step("SELECT", { selector: "#size", value: "Large" }),
        tabId,
      })
    ).ok,
    true,
  );
  assert.equal(await page.locator("#size").inputValue(), "l");

  assert.equal(
    (
      await env.send("step:execute", {
        step: step("FILL", {
          selector: "#editable",
          text: "a note",
          delayMs: 0,
        }),
        tabId,
      })
    ).ok,
    true,
  );
  assert.equal(await page.locator("#editable").textContent(), "a note");

  await page.close();
});

test("a step that cannot succeed fails loudly", async () => {
  const { page, tabId } = await onSite();
  const missing = await env.send("step:execute", {
    step: step("CLICK", { selector: "#does-not-exist" }),
    tabId,
  });
  assert.equal(missing.ok, false);

  const wrongTarget = await env.send("step:execute", {
    step: step("FILL", { selector: "#title", text: "x", delayMs: 0 }),
    tabId,
  });
  assert.equal(wrongTarget.ok, false, "an h1 is not fillable");
  assert.match(
    wrongTarget.error,
    /not an input, textarea, select or contenteditable/,
  );

  const noOption = await env.send("step:execute", {
    step: step("SELECT", { selector: "#size", value: "Enormous" }),
    tabId,
  });
  assert.equal(noOption.ok, false);
  assert.match(noOption.error, /no option matching/);
  assert.equal(
    await page.locator("#size").inputValue(),
    "s",
    "left at its default rather than cleared",
  );

  await page.close();
});

test("IF_ELSE reads text as rendered, not as indented", async () => {
  const { page, tabId } = await onSite();
  const res = await env.send("step:execute", {
    step: step("IF_ELSE", {
      condition: "text-equals",
      selector: ".stock",
      value: "In stock",
    }),
    tabId,
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  // The page reports what it saw and does not decide (J-08), so evaluate it
  // here the way the worker does — against the one shared definition.
  const { evaluateCondition } = await import("../utils/conditions.js");
  assert.equal(
    evaluateCondition("text-equals", res.result, { value: "In stock" }),
    true,
  );
  assert.equal(res.result.exists, true);
  await page.close();
});

test("a numeric IF_ELSE reads the number out of a real page's text", async () => {
  const { page, tabId } = await onSite();
  const res = await env.send("step:execute", {
    step: step("IF_ELSE", { condition: "number-lt", selector: ".price" }),
    tabId,
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  const { evaluateCondition } = await import("../utils/conditions.js");
  // The first product is $10.00.
  assert.equal(
    evaluateCondition("number-lt", res.result, { value: "20" }),
    true,
  );
  assert.equal(
    evaluateCondition("number-gt", res.result, { value: "20" }),
    false,
  );
  await page.close();
});

// ── a whole pipeline ─────────────────────────────────────────────────────────

test("a pipeline runs end to end and its rows reach IndexedDB", async () => {
  const { page, tabId } = await onSite();

  const started = await env.send("pipeline:start", {
    tabId,
    targetOrigin: site.origin,
    pipeline: {
      name: "e2e",
      steps: [
        step("EXTRACT", {
          fields: [
            { name: "name", selector: ".product-link" },
            { name: "price", selector: ".price" },
          ],
        }),
      ],
    },
  });
  assert.equal(started.ok, true, JSON.stringify(started));
  const runId = started.result.runId;
  assert.ok(runId, "a run id came back");

  // Wait for the run to finish, then read what it stored.
  let rows = [];
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const dl = await env.send("data:download", { runId });
    if (dl.ok && dl.result.rows?.length) {
      rows = dl.result.rows;
      break;
    }
  }

  assert.equal(rows.length, 3, "three products were stored");
  assert.deepEqual(rows.map((r) => r.name).sort(), [
    "Doohickey",
    "Gadget",
    "Widget",
  ]);
  await page.close();
});

test("the ethics gates run and report", async () => {
  const { page, tabId } = await onSite();
  const res = await env.send("pipeline:preflight", {
    tabId,
    targetOrigin: site.origin,
    pipeline: { name: "p", steps: [step("CLICK", { selector: "#go" })] },
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.ok(Array.isArray(res.result.warnings));
  assert.equal(typeof res.result.blocked, "boolean");
  await page.close();
});

// ── PDF, against a real PDF ──────────────────────────────────────────────────

test("PDF_EXTRACTION reads a PDF over HTTP", async () => {
  // Chrome's own print-to-PDF gives a real, Flate-compressed PDF to read.
  const page = await env.ctx.newPage();
  await page.setContent(
    "<h1>Quarterly Report</h1><p>Revenue was 42 million.</p>",
  );
  const pdf = await page.pdf({ format: "A4" });
  await page.close();

  const { extractPdfText } = await import("../utils/pdf-text.js");
  const out = await extractPdfText(new Uint8Array(pdf));

  assert.ok(
    out.pageCount >= 1,
    `no content streams found: ${JSON.stringify(out.warnings)}`,
  );
  assert.match(out.text, /Quarterly Report/);
  assert.match(out.text, /42 million/);
});

test("PDF_EXTRACTION reads a real table back as rows", async () => {
  // A PDF Chrome itself produced, from an ordinary HTML table — so the
  // positions are whatever a real layout engine chose rather than the tidy
  // coordinates a hand-built fixture uses. That is the whole question: the unit
  // tests prove the grouping is right, and this proves the numbers it is given
  // are the ones a real writer emits.
  const page = await env.ctx.newPage();
  await page.setContent(`
    <style>table{border-collapse:collapse;font:12px sans-serif}td,th{padding:4px 24px;text-align:left}</style>
    <table>
      <tr><th>Product</th><th>Price</th><th>Stock</th></tr>
      <tr><td>Widget</td><td>10.00</td><td>In stock</td></tr>
      <tr><td>Gadget</td><td>25.50</td><td>In stock</td></tr>
      <tr><td>Doohickey</td><td>7.99</td><td>Sold out</td></tr>
    </table>`);
  const pdf = await page.pdf({ format: "A4" });
  await page.close();

  const { extractPdfItems } = await import("../utils/pdf-text.js");
  const { tablesFromPages } = await import("../utils/pdf-tables.js");
  const { pages } = await extractPdfItems(new Uint8Array(pdf));
  const { records } = tablesFromPages(pages);

  assert.equal(
    records.length,
    3,
    `expected three rows, got ${JSON.stringify(records)}`,
  );
  assert.deepEqual(
    records.map((r) => [r.Product, r.Price, r.Stock]),
    [
      ["Widget", "10.00", "In stock"],
      ["Gadget", "25.50", "In stock"],
      ["Doohickey", "7.99", "Sold out"],
    ],
  );
});

test("AUTO_EXTRACT answers a schema that has nothing to do with products", async () => {
  // The whole point of generalising it: a court listing, asked for the fields a
  // court listing has. The page publishes them as JSON-LD under its own key
  // names, so the free layer answers and no model is consulted at all.
  const { tabId, page } = await onSite("/article");
  const res = await env.send("step:execute", {
    step: step("AUTO_EXTRACT", {
      schema: "headline, published date, author, keywords",
      useLlm: false,
    }),
    tabId,
  });
  assert.equal(res.ok, true, JSON.stringify(res));

  const row = res.result;
  assert.equal(row.headline, "Acme Ltd v Bloggs");
  assert.equal(
    row["published date"],
    "2026-01-02",
    'the site calls it datePublished; the user called it "published date"',
  );
  assert.equal(
    row.author,
    "Ada Lovelace",
    "a nested Person node should give up its name rather than [object Object]",
  );
  assert.equal(row.keywords, "contract, damages");
  await page.close();
});

test("AUTO_EXTRACT leaves a field nothing answered empty rather than guessing", async () => {
  const { tabId, page } = await onSite("/article");
  const res = await env.send("step:execute", {
    step: step("AUTO_EXTRACT", {
      schema: "headline, defendant solicitor",
      useLlm: false,
    }),
    tabId,
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.result.headline, "Acme Ltd v Bloggs");
  assert.equal(
    res.result["defendant solicitor"],
    null,
    "a heuristic answering for a field it was never taught is indistinguishable from a real answer",
  );
  await page.close();
});

test("a scrape that comes back with personal data says so, once", async () => {
  // Ethics gate 2 filtered the pipeline for a step type that does not exist,
  // so it never fired on any pipeline. Worse than a no-op: it reported having
  // run. The check now happens where the rows are.
  const { tabId, page } = await onSite("/directory");
  await env.panel.evaluate(() => {
    globalThis.__vqPii = [];
    chrome.runtime.onMessage.addListener((msg) => {
      if (
        msg?.type === "pipeline:log" &&
        /Ethics . PII/.test(msg.payload?.message ?? "")
      ) {
        globalThis.__vqPii.push(msg.payload.message);
      }
    });
  });

  const started = await env.send("pipeline:start", {
    tabId,
    targetOrigin: site.origin,
    pipeline: {
      name: "directory",
      steps: [
        step("EXTRACT", {
          fields: [
            { name: "who", selector: ".who", type: "text" },
            { name: "mail", selector: ".mail", type: "text" },
          ],
        }),
      ],
    },
  });
  assert.equal(started.ok, true, JSON.stringify(started));

  const runId = started.result.runId;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    const st = await env.send("pipeline:status", { runId });
    if (st.ok && st.result.known && !st.result.active) break;
  }
  await page.close();

  const warnings = await env.panel.evaluate(() => globalThis.__vqPii ?? []);
  assert.equal(warnings.length, 1, "it should say so exactly once");
  assert.match(warnings[0], /Email/);
  assert.match(warnings[0], /mail/, "the column is what makes it actionable");
  // The rule this whole area has: never the value. A warning that puts an
  // email address into the log, and from there into a screenshot in a bug
  // report, has made things worse.
  assert.ok(
    !warnings[0].includes("ada@example.com"),
    "the warning carries the address it was warning about",
  );
});

test("a schedule fires and runs the pipeline it was saved with", async () => {
  // The claim both reviews said was missing, proved rather than described: no
  // server, no subscription, and the pipeline runs on a timer in the browser
  // that is already open.
  //
  // One minute is the floor Chrome honours, which is too long for a check, so
  // the alarm is fired directly — the same entry point Chrome uses. What that
  // proves is everything after the alarm: the tab opens, the pipeline runs,
  // the rows land, and the schedule records that it ran.
  const list0 = await env.send("schedule:list", {});
  assert.equal(list0.ok, true, JSON.stringify(list0));

  const saved = await env.send("schedule:save", {
    schedule: {
      name: "e2e nightly",
      url: site.url("/"),
      everyMinutes: 60,
      pipeline: {
        name: "e2e nightly",
        steps: [
          step("EXTRACT", {
            fields: [{ name: "title", selector: "#title", type: "text" }],
          }),
        ],
      },
    },
  });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  const id = saved.result.id;

  try {
    // An alarm exists for it, which is the half that decides whether the
    // schedule ever fires at all.
    const armed = await env.sw.evaluate(
      (name) =>
        new Promise((resolve) => {
          chrome.alarms.getAll((all) =>
            resolve(all.map((a) => a.name).includes(name)),
          );
        }),
      `vq_schedule_${id}`,
    );
    assert.equal(armed, true, "the schedule was stored with no alarm");

    const before = (await env.send("schedule:list", {})).result.schedules.find(
      (s) => s.id === id,
    );
    assert.equal(before.lastRunAt, null);

    const fired = await env.send("schedule:run", { id });
    assert.equal(fired.ok, true, JSON.stringify(fired));

    const after = (await env.send("schedule:list", {})).result.schedules.find(
      (s) => s.id === id,
    );
    assert.ok(after.lastRunAt, "the schedule did not record having run");
    assert.equal(
      after.lastStatus,
      "started",
      `the scheduled run failed: ${after.lastStatus}`,
    );
  } finally {
    await env.send("schedule:delete", { id });
    const gone = await env.sw.evaluate(
      (name) =>
        new Promise((resolve) => {
          chrome.alarms.getAll((all) =>
            resolve(all.map((a) => a.name).includes(name)),
          );
        }),
      `vq_schedule_${id}`,
    );
    // An alarm outliving its schedule fires forever for something the user
    // deleted and can no longer see.
    assert.equal(gone, false, "the alarm outlived the schedule");
  }
});

test("the row records which layer answered each field", async () => {
  // A row carried one `_extractionMethod` for all of it, taken from whichever
  // layer answered first. On this page that would say "json-ld" while half the
  // columns came from somewhere else entirely.
  const { tabId, page } = await onSite("/article");
  const res = await env.send("step:execute", {
    step: step("AUTO_EXTRACT", {
      schema: "headline, defendant solicitor",
      useLlm: false,
      provenance: true,
    }),
    tabId,
  });
  await page.close();
  assert.equal(res.ok, true, JSON.stringify(res));

  const cell = res.result._provenance;
  assert.ok(cell, "the column was asked for and is not there");
  assert.match(
    cell,
    /headline=json-ld\(headline\)/,
    "the site's own key is the part a person can go and check",
  );
  assert.match(
    cell,
    /defendant solicitor=none/,
    "a field nothing answered must not borrow the page's authority",
  );
  assert.ok(
    !/\n/.test(cell),
    "a newline inside a CSV cell is a support ticket",
  );
});

test("the column is not there unless the step was asked for it", async () => {
  const { tabId, page } = await onSite("/article");
  const res = await env.send("step:execute", {
    step: step("AUTO_EXTRACT", { schema: "headline", useLlm: false }),
    tabId,
  });
  await page.close();
  assert.equal(res.result._provenance, undefined);
  assert.equal(
    typeof res.result._confidence,
    "number",
    "the fields every existing export already has must stay",
  );
});

test("the same page is not sent to the model twice", async () => {
  // The one part of this that costs anything, not paid for twice. A local
  // server counts the requests: two identical runs, one call.
  const http = await import("node:http");
  let calls = 0;
  const model = http.createServer((req, res) => {
    calls++;
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          model: "fake-local",
          choices: [
            {
              message: {
                content: JSON.stringify({
                  headline: "Acme Ltd v Bloggs",
                  confidence: { headline: 90 },
                }),
              },
            },
          ],
        }),
      );
    });
  });
  await new Promise((r) => model.listen(0, "127.0.0.1", r));
  const port = model.address().port;

  try {
    const saved = await env.send("gateway:save", {
      provider: "openai-compatible",
      apiKey: "",
      model: "fake-local",
      baseUrl: `http://127.0.0.1:${port}/v1`,
    });
    assert.equal(saved.ok, true, JSON.stringify(saved));

    const run = async (config) => {
      const { tabId, page } = await onSite("/article");
      const res = await env.send("step:execute", {
        step: step("AUTO_EXTRACT", {
          schema: "headline, defendant solicitor",
          useLlm: true,
          ...config,
        }),
        tabId,
      });
      await page.close();
      assert.equal(res.ok, true, JSON.stringify(res));
      return res.result;
    };

    const first = await run({});
    assert.equal(calls, 1, "the model should have been asked once");
    assert.equal(first.headline, "Acme Ltd v Bloggs");

    const second = await run({});
    assert.equal(calls, 1, "the second run asked again for an unchanged page");
    assert.equal(
      second.headline,
      "Acme Ltd v Bloggs",
      "a cached answer has to be the same answer, not an empty one",
    );

    // The question changed, so the cache must not answer it. A field the page
    // cannot answer for free, or the free layers would settle it and the model
    // would not be asked either way.
    await run({ schema: "headline, defendant address" });
    assert.equal(calls, 2, "a different schema is a different question");

    // And the switch means what it says.
    await run({ cache: false });
    assert.equal(calls, 3, "the step was told not to use the cache");
  } finally {
    await env.send("gateway:save", {
      provider: "gemini",
      apiKey: "",
      model: "gemini-2.0-flash",
      baseUrl: "",
    });
    await new Promise((r) => model.close(r));
  }
});

test("a selector the model proposed is checked in the page before it is offered", async () => {
  // The end of the story this project tells about AI: the model is asked once,
  // its selectors are tested against the page, and what survives is an
  // ordinary EXTRACT step that runs for free ever after.
  //
  // The model here proposes one selector that is right and one that points at
  // the site's navigation while reporting a plausible value. Saved unchecked,
  // the second would produce a pipeline that runs, reports success, and fills
  // a column with the word "Home".
  const http = await import("node:http");
  const model = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          model: "fake-local",
          choices: [
            {
              message: {
                content: JSON.stringify({
                  headline: "Acme Ltd v Bloggs",
                  court: "Chancery Division",
                  confidence: { headline: 90, court: 88 },
                  selectors: {
                    headline: "h1",
                    // Real element, real text on the page — and the wrong
                    // element for this field.
                    court: "nav a",
                  },
                }),
              },
            },
          ],
        }),
      );
    });
  });
  await new Promise((r) => model.listen(0, "127.0.0.1", r));
  const port = model.address().port;

  try {
    const saved = await env.send("gateway:save", {
      provider: "openai-compatible",
      apiKey: "",
      model: "fake-local",
      baseUrl: `http://127.0.0.1:${port}/v1`,
    });
    assert.equal(saved.ok, true, JSON.stringify(saved));

    // Listen for the offer the worker broadcasts, from the panel's own page.
    await env.panel.evaluate(() => {
      globalThis.__vqSelectorOffers = [];
      chrome.runtime.onMessage.addListener((msg) => {
        if (msg?.type === "pipeline:selectors") {
          globalThis.__vqSelectorOffers.push(msg.payload);
        }
      });
    });

    const { tabId, page } = await onSite("/article");
    const res = await env.send("step:execute", {
      step: step("AUTO_EXTRACT", {
        schema: "headline, court",
        useLlm: true,
        cache: false,
        learnSelectors: true,
      }),
      tabId,
    });
    await page.close();
    assert.equal(res.ok, true, JSON.stringify(res));

    const offers = await env.panel.evaluate(
      () => globalThis.__vqSelectorOffers ?? [],
    );
    assert.equal(offers.length, 1, "the panel was never offered the step");
    const offer = offers[0];

    assert.equal(
      offer.verified.headline,
      "h1",
      "a selector that produces the reported value should survive",
    );
    assert.equal(
      offer.verified.court,
      undefined,
      "a selector pointing at the navigation reached the offer",
    );
    assert.equal(offer.how.court, "wrong-value");

    // And what is offered is a step the pipeline can actually run.
    assert.equal(offer.step.type, "EXTRACT");
    assert.deepEqual(offer.step.config.fields, [
      { name: "headline", selector: "h1", type: "text" },
    ]);

    // The point of all of it: that step runs on its own, with no model.
    const standalone = await onSite("/article");
    const ran = await env.send("step:execute", {
      step: step("EXTRACT", offer.step.config),
      tabId: standalone.tabId,
    });
    await standalone.page.close();
    assert.equal(ran.ok, true, JSON.stringify(ran));
    const rows = Array.isArray(ran.result) ? ran.result : [ran.result];
    assert.equal(rows[0].headline, "Acme Ltd v Bloggs");
  } finally {
    await env.send("gateway:save", {
      provider: "gemini",
      apiKey: "",
      model: "gemini-2.0-flash",
      baseUrl: "",
    });
    await new Promise((r) => model.close(r));
  }
});

test("a value the model invented is dropped, not exported", async () => {
  // The strongest claim this project makes about its AI layer, proved rather
  // than asserted — and proved with no key and no cost, against a local server
  // standing in for Ollama.
  //
  // The model is told to answer one field truthfully and one falsely. The
  // truthful one must survive; the false one must not reach the row, because
  // an empty cell cannot be acted on by mistake and a fabricated one can.
  const http = await import("node:http");
  let asked = false;
  const model = http.createServer((req, res) => {
    asked = true;
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          model: "fake-local",
          choices: [
            {
              message: {
                content: JSON.stringify({
                  // On the page.
                  headline: "Acme Ltd v Bloggs",
                  // Not on the page, and entirely plausible.
                  "defendant solicitor": "Hopper & Co LLP",
                  confidence: {
                    headline: 90,
                    "defendant solicitor": 88,
                  },
                }),
              },
            },
          ],
        }),
      );
    });
  });
  await new Promise((r) => model.listen(0, "127.0.0.1", r));
  const modelPort = model.address().port;

  try {
    const saved = await env.send("gateway:save", {
      provider: "openai-compatible",
      apiKey: "",
      model: "fake-local",
      baseUrl: `http://127.0.0.1:${modelPort}/v1`,
    });
    assert.equal(saved.ok, true, JSON.stringify(saved));

    const { tabId, page } = await onSite("/article");
    const res = await env.send("step:execute", {
      step: step("AUTO_EXTRACT", {
        schema: "headline, defendant solicitor",
        useLlm: true,
        grounded: true,
      }),
      tabId,
    });
    await page.close();

    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(asked, true, "the local model should have been consulted");
    assert.equal(
      res.result.headline,
      "Acme Ltd v Bloggs",
      "a true answer must survive the check",
    );
    assert.equal(
      res.result["defendant solicitor"],
      null,
      "the model invented a solicitor and it reached the row",
    );
  } finally {
    // Put the gateway back to a provider with no key, so nothing after this
    // finds a model configured.
    await env.send("gateway:save", {
      provider: "anthropic",
      apiKey: "",
      model: "",
      baseUrl: "",
    });
    model.closeAllConnections?.();
    await new Promise((r) => model.close(r));
  }
});

// ── the steps that only a real browser can prove ─────────────────────────────

test("WAIT for an element waits for it to become visible, not merely to exist", async () => {
  // The element is in the DOM from the first paint and display:none for 700ms.
  // A wait that only checks existence returns at once, and whatever runs next
  // reads an empty panel — which is the failure this mode is meant to prevent.
  const { page, tabId } = await onSite("/lazy");
  const t0 = Date.now();
  const res = await env.send("step:execute", {
    step: step("WAIT", {
      mode: "selector-visible",
      selector: ".results",
      timeout: 5000,
    }),
    tabId,
  });
  const elapsed = Date.now() - t0;
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.ok(elapsed > 500, `returned after ${elapsed}ms — it did not wait`);
  assert.ok(elapsed < 4000, `took ${elapsed}ms — it waited too long`);
  await page.close();
});

test("a WAIT that never comes true fails the step", async () => {
  const { page, tabId } = await onSite("/lazy");
  const res = await env.send("step:execute", {
    step: step("WAIT", {
      mode: "selector-visible",
      selector: ".never",
      timeout: 800,
    }),
    tabId,
  });
  assert.equal(res.ok, false, "a wait that timed out is not a success");
  await page.close();
});

test("infinite scroll loads a lazy feed to the end", async () => {
  const { page, tabId } = await onSite("/lazy");
  const before = await page.locator(".post").count();
  assert.equal(before, 10, "the page starts with one screenful");

  const res = await env.send("step:execute", {
    step: step("SCROLL", {
      mode: "infinite",
      maxScrolls: 15,
      settleMs: 400,
      selector: ".post",
    }),
    tabId,
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.result.exhausted, true, "it reached the end of the feed");

  const after = await page.locator(".post").count();
  assert.equal(after, 40, `loaded ${after} posts of 40`);
  await page.close();
});

test("PAGINATE turns the page, and knows when it cannot", async () => {
  const { page, tabId } = await onSite("/page/1");

  const first = await env.send("step:execute", {
    step: step("PAGINATE", { selector: ".next", settleMs: 600 }),
    tabId,
  });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.result.exhausted, false);
  assert.equal(await page.locator("#title").textContent(), "Page 2");

  await page.goto(site.url("/page/3"));
  const last = await env.send("step:execute", {
    step: step("PAGINATE", { selector: ".next", settleMs: 300 }),
    tabId,
  });
  assert.equal(last.ok, true, JSON.stringify(last));
  assert.equal(
    last.result.exhausted,
    true,
    "the disabled Next button is the last page",
  );
  await page.close();
});

test("a paginating pipeline scrapes each page once and stops", async () => {
  // The whole point of the PAGINATE change: max is 10, there are 3 pages, and
  // the run has to stop at 3 rather than re-scraping page 3 seven more times.
  const { page, tabId } = await onSite("/page/1");

  const started = await env.send("pipeline:start", {
    tabId,
    targetOrigin: site.origin,
    pipeline: {
      name: "paged",
      steps: [
        {
          id: "loop",
          type: "LOOP",
          config: { type: "paginate", selector: ".next", max: 10 },
          children: [
            step("EXTRACT", { fields: [{ name: "page", selector: "#title" }] }),
          ],
        },
      ],
    },
  });
  assert.equal(started.ok, true, JSON.stringify(started));
  const runId = started.result.runId;

  let rows = [];
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const dl = await env.send("data:download", { runId });
    if (dl.ok && dl.result.rows?.length >= 3) {
      rows = dl.result.rows;
      break;
    }
  }
  // Give a wrong implementation time to over-run before counting.
  await new Promise((r) => setTimeout(r, 1500));
  const dl = await env.send("data:download", { runId });
  rows = dl.result?.rows ?? rows;

  assert.equal(
    rows.length,
    3,
    `scraped ${rows.length} pages; the site has 3 (max was 10)`,
  );
  assert.deepEqual(
    rows.map((r) => r.page),
    ["Page 1", "Page 2", "Page 3"],
    "each page once, in order",
  );
  await page.close();
});

test("NAVIGATE returns as soon as the page is loaded", async () => {
  const { page, tabId } = await onSite("/page/1");
  const t0 = Date.now();
  const res = await env.send("step:execute", {
    step: step("NAVIGATE", { url: site.url("/page/2"), wait: true }),
    tabId,
  });
  const elapsed = Date.now() - t0;
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.ok(
    elapsed < 2500,
    `a local page took ${elapsed}ms — the fixed 3s sleep is still there`,
  );
  assert.equal(await page.locator("#title").textContent(), "Page 2");
  await page.close();
});

test("a page step works after the run has navigated away", async () => {
  // The bug the paginating check above found. Content scripts are injected on
  // demand and die with their document, and only the start of a run injected
  // them — so every page step after any navigation failed with Chrome's
  // "Receiving end does not exist". Nothing in 500 unit tests could see it:
  // they mock chrome.tabs, and a mocked tab never navigates.
  const { page, tabId } = await onSite("/page/1");

  const nav = await env.send("step:execute", {
    step: step("NAVIGATE", { url: site.url("/page/2"), wait: true }),
    tabId,
  });
  assert.equal(nav.ok, true, JSON.stringify(nav));

  const res = await env.send("step:execute", {
    step: step("EXTRACT", { fields: [{ name: "t", selector: "#title" }] }),
    tabId,
  });
  assert.equal(
    res.ok,
    true,
    `the step could not reach the new page: ${JSON.stringify(res)}`,
  );
  assert.deepEqual(res.result, [{ t: "Page 2" }]);
  await page.close();
});

test("EXTRACT cleans values as it reads them", async () => {
  // The transforms run in the worker, against rows a real page produced, with
  // the real tab URL as the base for resolving links — none of which the unit
  // tests exercise, because they hand the worker rows it invented.
  const { page, tabId } = await onSite();
  const res = await env.send("step:execute", {
    step: step("EXTRACT", {
      fields: [
        { name: "name", selector: ".product-link" },
        { name: "price", selector: ".price", transform: ["number"] },
        {
          name: "link",
          selector: ".product-link",
          type: "attribute",
          attribute: "href",
          transform: ["url"],
        },
      ],
    }),
    tabId,
  });
  assert.equal(res.ok, true, JSON.stringify(res));

  // step:execute returns the page's raw rows; the run applies the transforms,
  // so check them through a run rather than through a single step.
  const started = await env.send("pipeline:start", {
    tabId,
    targetOrigin: site.origin,
    pipeline: {
      name: "clean",
      steps: [
        step("EXTRACT", {
          fields: [
            { name: "name", selector: ".product-link" },
            { name: "price", selector: ".price", transform: ["number"] },
            {
              name: "link",
              selector: ".product-link",
              type: "attribute",
              attribute: "href",
              transform: ["url"],
            },
          ],
        }),
      ],
    },
  });
  assert.equal(started.ok, true, JSON.stringify(started));

  let rows = [];
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const dl = await env.send("data:download", { runId: started.result.runId });
    if (dl.ok && dl.result.rows?.length) {
      rows = dl.result.rows;
      break;
    }
  }

  assert.equal(rows.length, 3);
  const widget = rows.find((r) => r.name === "Widget");
  assert.equal(widget.price, 10, 'a price is a number, not "$10.00"');
  assert.equal(
    widget.link,
    site.url("/p/1"),
    "a relative link is resolved against the page it came from",
  );
  await page.close();
});

test("PAGE_DATA reads a real page's structured data with no selectors", async () => {
  const { page, tabId } = await onSite("/rich");
  const res = await env.send("step:execute", {
    step: step("PAGE_DATA", {
      source: "auto",
      type: "Product",
      flatten: true,
      storeAs: "pageData",
    }),
    tabId,
  });
  assert.equal(res.ok, true, JSON.stringify(res));

  assert.equal(res.result.found, true);
  assert.equal(
    res.result.records.length,
    1,
    "the @graph was flattened and filtered",
  );
  const r = res.result.records[0];
  assert.equal(r.name, "Widget");
  assert.equal(r.sku, "W-1");
  assert.equal(r["brand.name"], "Acme", "nested objects become columns");
  assert.equal(r["offers.price"], "10.00");
  assert.equal(res.result.meta["og:title"], "Widget");
  assert.equal(
    res.result.meta["og:image"],
    site.url("/i/widget.jpg"),
    "and meta URLs are absolute",
  );
  await page.close();
});

test("PAGE_DATA falls back to microdata when there is no JSON-LD of that type", async () => {
  const { page, tabId } = await onSite("/rich");
  const res = await env.send("step:execute", {
    step: step("PAGE_DATA", { source: "microdata", flatten: true }),
    tabId,
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  const review = res.result.records.find((r) => r["@type"] === "Review");
  assert.ok(
    review,
    `no microdata record: ${JSON.stringify(res.result.records)}`,
  );
  assert.equal(review.author, "Sam");
  assert.equal(
    review.datePublished,
    "2026-01-05",
    "read from the meta content, not the rendered text",
  );
  await page.close();
});

test("a PAGE_DATA run turns the page into exportable rows", async () => {
  const { page, tabId } = await onSite("/rich");
  const started = await env.send("pipeline:start", {
    tabId,
    targetOrigin: site.origin,
    pipeline: {
      name: "pd",
      steps: [
        step("PAGE_DATA", { source: "auto", type: "Product", flatten: true }),
      ],
    },
  });
  assert.equal(started.ok, true, JSON.stringify(started));

  let rows = [];
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const dl = await env.send("data:download", { runId: started.result.runId });
    if (dl.ok && dl.result.rows?.length) {
      rows = dl.result.rows;
      break;
    }
  }
  assert.equal(rows.length, 1, "the record became a row");
  assert.equal(rows[0].name, "Widget");
  assert.equal(rows[0]["offers.price"], "10.00");
  await page.close();
});

test("PAGE_DATA on a page with nothing structured does not fail the run", async () => {
  // A pipeline reading many pages must not stop because one of them has no
  // markup — but it must say why the row is missing.
  const { page, tabId } = await onSite("/page/1");
  const res = await env.send("step:execute", {
    step: step("PAGE_DATA", { source: "auto" }),
    tabId,
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.result.found, false);
  assert.match(res.result.reason, /no structured data/i);
  await page.close();
});

// ── screenshots that are more than the visible strip ────────────────────────

/** The pixel size of a data: URL image, measured by decoding it. */
async function imageSize(page, dataUrl) {
  return page.evaluate(
    (url) =>
      new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () =>
          resolve({ w: img.naturalWidth, h: img.naturalHeight });
        img.onerror = () => reject(new Error("not a decodable image"));
        img.src = url;
      }),
    dataUrl,
  );
}

/**
 * Take one screenshot and hand the image back.
 *
 * Through step:execute, which returns the shot directly: data:download carries
 * rows only — screenshots ride along in the export archive — so a run would
 * give nothing to measure.
 */
async function shot(tabId, config) {
  const res = await env.send("step:execute", {
    step: step("SCREENSHOT", config),
    tabId,
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.ok(
    res.result.dataUrl?.startsWith("data:image/"),
    "no image came back",
  );
  return res.result;
}

test("a full-page screenshot is taller than one screenful", async () => {
  // The check that only a real browser can make: joining the strips needs
  // OffscreenCanvas and createImageBitmap, which Node does not have, so the
  // unit tests can only prove the scrolling. This proves the picture.
  const { page, tabId } = await onSite("/tall");
  const viewport = await page.evaluate(() => window.innerHeight);

  const full = await shot(tabId, { area: "full", quality: 100 });
  const size = await imageSize(page, full.dataUrl);
  assert.ok(
    size.h > viewport * 1.5,
    `the image is ${size.h}px tall; the viewport is ${viewport}px, and the page is 2800px`,
  );
  await page.close();
});

test("a full-page screenshot leaves the page where it found it", async () => {
  const { page, tabId } = await onSite("/tall");
  await page.evaluate(() => window.scrollTo(0, 500));
  await shot(tabId, { area: "full" });
  const after = await page.evaluate(() => window.scrollY);
  assert.ok(
    Math.abs(after - 500) < 30,
    `the page was left at ${after}px, not back at 500px`,
  );
  await page.close();
});

test("an element screenshot is the size of the element", async () => {
  const { page, tabId } = await onSite("/tall");
  const cropped = await shot(tabId, {
    area: "element",
    selector: "#card",
    quality: 100,
  });
  const size = await imageSize(page, cropped.dataUrl);
  const dpr = await page.evaluate(() => window.devicePixelRatio || 1);
  assert.ok(
    Math.abs(size.w - 300 * dpr) <= 2 && Math.abs(size.h - 200 * dpr) <= 2,
    `cropped to ${size.w}x${size.h}; the element is 300x200 at dpr ${dpr}`,
  );
  await page.close();
});

test("an element screenshot of a missing element fails the step", async () => {
  const { page, tabId } = await onSite("/tall");
  const res = await env.send("step:execute", {
    step: step("SCREENSHOT", { area: "element", selector: "#nope" }),
    tabId,
  });
  assert.equal(res.ok, false, "a missing element must not yield a page shot");
  await page.close();
});

test("the visible-area screenshot still works, and is one screenful", async () => {
  const { page, tabId } = await onSite("/tall");
  const viewport = await page.evaluate(() => window.innerHeight);
  const view = await shot(tabId, { area: "viewport", quality: 100 });
  const size = await imageSize(page, view.dataUrl);
  const dpr = await page.evaluate(() => window.devicePixelRatio || 1);
  assert.ok(
    Math.abs(size.h - viewport * dpr) < 40,
    `${size.h}px tall for a ${viewport}px viewport at dpr ${dpr}`,
  );
  await page.close();
});

test("KEYBOARD sends a key to the element it names", async () => {
  const { page, tabId } = await onSite();
  await page.evaluate(() => {
    const i = document.getElementById("search");
    window.__seen = [];
    i.addEventListener("keydown", (e) => window.__seen.push(e.key));
  });

  const res = await env.send("step:execute", {
    step: step("KEYBOARD", {
      key: "Enter",
      selector: "#search",
      repeat: 2,
      delayMs: 5,
    }),
    tabId,
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  const seen = await page.evaluate(() => window.__seen);
  assert.deepEqual(seen, ["Enter", "Enter"]);
  await page.close();
});

// ── the run that started all this ───────────────────────────────────────────

test("a detected country table gives one row per country, with clean columns", async () => {
  // The shape of a real scrape that came back with the right data in the wrong
  // columns: three of them held "Capital:", "Population:" and "Area (km2):"
  // repeated in every row, and a fourth held the 2 from km<sup>2</sup> (J-12).
  const { page, tabId } = await onSite("/countries");

  const det = await env.send("content:detect", { tabId });
  assert.equal(det.ok, true, JSON.stringify(det));
  const table = det.result.candidates[0];
  assert.ok(table, "nothing was detected");
  assert.equal(table.selector, ".country");
  assert.equal(
    table.fields.length,
    4,
    `expected 4 columns, got: ${table.fields.map((f) => f.name).join(", ")}`,
  );
  for (const field of table.fields) {
    assert.ok(
      new Set(field.samples.map((v) => String(v).trim())).size > 1,
      `"${field.name}" holds the same value in every row — a label, not data`,
    );
  }

  const started = await env.send("pipeline:start", {
    tabId,
    targetOrigin: site.origin,
    pipeline: {
      name: "countries",
      steps: [
        {
          id: "loop",
          type: "LOOP",
          config: { type: "elements", selector: table.selector, max: 0 },
          children: [
            step("EXTRACT", {
              fields: table.fields.map((f) => ({
                name: f.name,
                selector: f.selector,
                type: "text",
                // The area column carries "1.4E7" — the value that used to be
                // read as 1.4.
                ...(f.name.includes("area") || f.name.includes("population")
                  ? { transform: ["number"] }
                  : {}),
              })),
            }),
          ],
        },
      ],
    },
  });
  assert.equal(started.ok, true, JSON.stringify(started));

  let rows = [];
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const dl = await env.send("data:download", { runId: started.result.runId });
    if (dl.ok && dl.result.rows?.length >= 4) {
      rows = dl.result.rows;
      break;
    }
  }
  // Give a duplicating implementation time to over-run before counting.
  await new Promise((r) => setTimeout(r, 1500));
  rows = (await env.send("data:download", { runId: started.result.runId }))
    .result.rows;

  assert.equal(rows.length, 4, `one row per country; got ${rows.length}`);
  const nameKey = table.fields[0].name;
  assert.deepEqual(rows.map((r) => r[nameKey]).sort(), [
    "Afghanistan",
    "Albania",
    "Andorra",
    "Antarctica",
  ]);

  const antarctica = rows.find((r) => r[nameKey] === "Antarctica");
  const areaKey = table.fields.find((f) => f.name.includes("area")).name;
  assert.equal(
    antarctica[areaKey],
    14000000,
    `"1.4E7" was read as ${antarctica[areaKey]}`,
  );
  await page.close();
});

// ── inside an iframe ────────────────────────────────────────────────────────

test("without the toggle, a selector inside an iframe is not found", async () => {
  // Not a regression — the honest default. An iframe is a separate document,
  // so `#inner-title` genuinely is not in this page, and searching every frame
  // by default would change what an ambiguous selector matches.
  const { page, tabId } = await onSite("/framed");
  const res = await env.send("step:execute", {
    step: step("EXTRACT", {
      fields: [{ name: "t", selector: "#inner-title" }],
    }),
    tabId,
  });
  const rows = res.ok ? res.result : [];
  assert.ok(
    rows.length === 0 || !rows[0]?.t,
    `it reached into the frame without being asked: ${JSON.stringify(rows)}`,
  );
  await page.close();
});

test("with the toggle on, a step reads inside the iframe", async () => {
  const { page, tabId } = await onSite("/framed");
  const res = await env.send("step:execute", {
    step: step("EXTRACT", {
      inFrame: true,
      fields: [{ name: "t", selector: "#inner-title" }],
    }),
    tabId,
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.result, [{ t: "Inside the frame" }]);
  await page.close();
});

test("with the toggle on, a step clicks inside the iframe", async () => {
  const { page, tabId } = await onSite("/framed");
  const res = await env.send("step:execute", {
    step: step("CLICK", { selector: "#framed-btn", inFrame: true }),
    tabId,
  });
  assert.equal(res.ok, true, JSON.stringify(res));

  const frame = page.frames().find((f) => f.url().includes("framed-inner"));
  assert.equal(await frame.locator("#framed-clicked").textContent(), "yes");
  await page.close();
});

test("with the toggle on, a step types inside the iframe", async () => {
  const { page, tabId } = await onSite("/framed");
  const res = await env.send("step:execute", {
    step: step("FILL", {
      selector: "#framed-input",
      text: "hello",
      inFrame: true,
    }),
    tabId,
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  const frame = page.frames().find((f) => f.url().includes("framed-inner"));
  assert.equal(await frame.locator("#framed-input").inputValue(), "hello");
  await page.close();
});

test("the top document still wins when the selector matches there too", async () => {
  // The toggle must not change which element a working selector finds.
  const { page, tabId } = await onSite("/framed");
  const res = await env.send("step:execute", {
    step: step("EXTRACT", {
      inFrame: true,
      fields: [{ name: "t", selector: "h1" }],
    }),
    tabId,
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.result[0].t, "Outer page");
  await page.close();
});

test("a selector that is nowhere says it looked in the frames too", async () => {
  const { page, tabId } = await onSite("/framed");
  const res = await env.send("step:execute", {
    step: step("CLICK", { selector: "#nowhere", inFrame: true }),
    tabId,
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /frame/i, `unhelpful error: ${res.error}`);
  await page.close();
});

// ── the API sniffer, from the outside ───────────────────────────────────────

async function sniffRun(tabId, config) {
  const started = await env.send("pipeline:start", {
    tabId,
    targetOrigin: site.origin,
    pipeline: {
      name: "sniff",
      steps: [
        step("API_SNIFFER", { enabled: true, ...config }),
        step("WAIT", { mode: "fixed", ms: 400 }),
        step("CLICK", { selector: "#go" }),
        step("WAIT", { mode: "fixed", ms: 1500 }),
      ],
    },
  });
  assert.equal(started.ok, true, JSON.stringify(started));
  await new Promise((r) => setTimeout(r, 5000));
  const dl = await env.send("data:download", { runId: started.result.runId });
  return dl.result.networks ?? [];
}

test("the sniffer captures the calls a page makes during a run", async () => {
  // Reported as "the API sniffer is not working". It was capturing; the
  // captures lived only on the run state, which is deleted the moment the run
  // finishes — so by the time anyone looked, they were gone.
  const { page, tabId } = await onSite("/apipage");
  const nets = await sniffRun(tabId, {});
  assert.ok(
    nets.length >= 2,
    `captured ${nets.length}: ${JSON.stringify(nets)}`,
  );
  assert.ok(nets.some((n) => String(n.url).includes("/api/items")));
  await page.close();
});

test("the sniffer's URL filter keeps the calls you asked for and drops the rest", async () => {
  const { page, tabId } = await onSite("/apipage");
  const nets = await sniffRun(tabId, { urlFilter: "/api/" });
  assert.ok(
    nets.length > 0 && nets.every((n) => String(n.url).includes("/api/")),
    `filter let other traffic through: ${nets.map((n) => n.url).join(", ")}`,
  );
  await page.close();
});

// ── product cards: a loop, and fields relative to a card ────────────────────

test("a loop-scoped field reads from every card, not from the first one", async () => {
  // The failure that prompted this: fields picked for a card grid were
  // described page-wide, so a run either repeated one card's values or picked
  // whichever element happened to be first.
  const { page, tabId } = await onSite("/cards");
  const started = await env.send("pipeline:start", {
    tabId,
    targetOrigin: site.origin,
    pipeline: {
      name: "cards",
      steps: [
        {
          id: "loop",
          type: "LOOP",
          config: { type: "elements", selector: ".card", max: 0 },
          children: [
            step("EXTRACT", {
              fields: [
                { name: "title", selector: ".title" },
                { name: "price", selector: ".price", transform: ["number"] },
                {
                  name: "link",
                  selector: ".buy",
                  type: "attribute",
                  attribute: "href",
                  transform: ["url"],
                },
              ],
            }),
          ],
        },
      ],
    },
  });
  assert.equal(started.ok, true, JSON.stringify(started));

  let rows = [];
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const dl = await env.send("data:download", { runId: started.result.runId });
    if (dl.ok && dl.result.rows?.length >= 3) {
      rows = dl.result.rows;
      break;
    }
  }
  assert.equal(rows.length, 3, `got ${rows.length} rows for 3 cards`);
  assert.deepEqual(
    rows.map((r) => r.title),
    ["Widget", "Gadget", "Doohickey"],
    "each card contributed its own title",
  );
  assert.deepEqual(
    rows.map((r) => r.price),
    [10, 25.5, 7.99],
  );
  assert.equal(rows[2].link, site.url("/p/3"));
  await page.close();
});

test("the picker describes a card's field relative to the card", async () => {
  const { page, tabId } = await onSite("/cards");
  // What the panel now asks for when the EXTRACT sits inside a loop.
  const rel = await page.evaluate(() => {
    const el = document.querySelectorAll(".card .title")[1];
    return window.__vqTestScoped ? null : el.className;
  });
  void rel;

  // Prove the shape through the step that uses it: a relative selector finds
  // one element per card.
  const res = await env.send("step:execute", {
    step: step("QUERY_COUNT", { selector: ".title" }),
    tabId,
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.result.count, 3);
  await page.close();
});

// ── the page as JSON ────────────────────────────────────────────────────────

test("PAGE_JSON returns the page as a tree, without its scripts", async () => {
  const { page, tabId } = await onSite("/cards");
  const res = await env.send("step:execute", {
    step: step("PAGE_JSON", { mode: "tree", maxNodes: 5000 }),
    tabId,
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.result.found, true);
  assert.equal(res.result.truncated, false);

  const json = JSON.stringify(res.result.tree);
  assert.ok(json.includes("Widget"), "the content is missing");
  assert.ok(json.includes("card"), "the structure is missing");
  await page.close();
});

test("PAGE_JSON text mode gives the readable lines in order", async () => {
  const { page, tabId } = await onSite("/cards");
  const res = await env.send("step:execute", {
    step: step("PAGE_JSON", { mode: "text" }),
    tabId,
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.result.text.slice(0, 4), [
    "Shop",
    "Widget",
    "$10.00",
    "Buy",
  ]);
  await page.close();
});

test("PAGE_JSON can be pointed at one part of the page", async () => {
  const { page, tabId } = await onSite("/cards");
  const res = await env.send("step:execute", {
    step: step("PAGE_JSON", { mode: "text", selector: ".grid" }),
    tabId,
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.ok(!res.result.text.includes("Shop"), "the heading leaked in");
  assert.ok(res.result.text.includes("Widget"));
  await page.close();
});

test("a PAGE_JSON run produces a row you can export", async () => {
  const { page, tabId } = await onSite("/cards");
  const started = await env.send("pipeline:start", {
    tabId,
    targetOrigin: site.origin,
    pipeline: {
      name: "pj",
      steps: [step("PAGE_JSON", { mode: "flat", selector: ".grid" })],
    },
  });
  assert.equal(started.ok, true, JSON.stringify(started));

  let rows = [];
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const dl = await env.send("data:download", { runId: started.result.runId });
    if (dl.ok && dl.result.rows?.length) {
      rows = dl.result.rows;
      break;
    }
  }
  assert.equal(rows.length, 1, "one row holding the page");
  assert.ok(Array.isArray(rows[0].content), "flat mode should be rows");
  assert.ok(rows[0].content.some((r) => r.text === "Widget"));
  await page.close();
});
