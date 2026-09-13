# Verquill

A Chrome MV3 extension for visual web automation and data extraction. You build
a pipeline of steps on a node board in the side panel, run it against the active
tab, and export the results.

No build step. No bundler. Plain ES modules, loaded directly by Chrome.

> **Status.** A full audit found 192 issues; all 192 are now fixed, including
> the three subsystems that were originally left unreachable on purpose. Every
> fix landed with regression tests run against the pre-fix code first to confirm
> they failed: **1422 unit tests**, from zero, plus **85 end-to-end checks** in a
> real Chromium with the extension loaded and **8 against mirrored real pages** —
> which is how several findings were caught that no unit test could reach, among
> them an `EXPORT` that had never downloaded anything and page steps that failed
> after every navigation.
>
> [`docs/ISSUE_AUDIT.md`](docs/ISSUE_AUDIT.md) is the inventory,
> [`CHANGELOG.md`](CHANGELOG.md) the summary, and
> [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) explains why the parts are
> shaped the way they are.

---

## Quick start

1. Open Chrome → `chrome://extensions/`
2. Enable **Developer mode**
3. **Load unpacked** → select this folder
4. Click the Verquill icon; the side panel opens

Chrome 120 or newer.

### Working on it

```bash
npm install     # jsdom + fake-indexeddb, for the tests only
npm test        # 1404 tests, ~50s, no browser needed
npm run e2e     # 85 checks in a real Chromium with the extension loaded
npm run check   # parses every source file as an ES module
npm run format  # prettier; `npm run format:check` is the gate
npm run build   # packages the extension for the store
```

Every one of those runs in CI on Linux and Windows for each push and pull
request (`.github/workflows/ci.yml`), so a gate that passes locally is the same
gate that gates a merge. The browser suites are slower and run nightly
(`.github/workflows/browser.yml`) rather than blocking a review.

Python 3 is an optional test dependency: a handful of tests compile the Python
that `script-gen/` emits, which is the only way to know the generated script is
valid rather than merely well-shaped. Without it those tests skip, visibly, and
the rest still run. CI installs it so the skip never hides anything there.

The extension itself has no dependencies and nothing to build — `npm install`
is only for the test suite.

---

## How a run works

```
side panel  ──pipeline:preflight──▶  service worker  ──▶  ethics gates
    │                                     │                    │
    │  ◀── warnings, blockers ────────────┘                    │
    │                                                          │
    └──pipeline:start──▶  service worker  ─────────────────────┘
                              │
                    ┌─────────┴──────────┐
                    │                    │
            steps that run in     steps that run in
            the background        the page
            (NAVIGATE, API,       (CLICK, FILL, EXTRACT,
             LOOP, EXPORT…)        SELECT, IF_ELSE…)
                    │                    │
                    │            chrome.tabs.sendMessage
                    │                    ▼
                    │            content/injector.js
                    │                    │
                    └────────▶  rows ────┘
                                 │
                       checkpoint/row-buffer.js  ──▶  IndexedDB
                                 │
                       exporters/row-formatters.js ──▶ download
```

Which context runs a given step is declared once, in
[`utils/step-types.js`](utils/step-types.js) — the single source of the step
vocabulary, read by the side panel, the script emitters and the MCP server.

---

## Project structure

```
manifest.json                  MV3 manifest
package.json                   test tooling only; the extension has no deps

background/                    Service worker
  service-worker.js            Pipeline orchestrator, message bus, export
  ethics-engine.js             7 pre-run gates
  llm-extractor.js             AUTO_EXTRACT layer 3, through the AI gateway
  api-key-manager.js           AES-GCM key store; captcha-solver dispatch
  gateway-config.js            Provider, model and base URL for the AI gateway
  header-rules.js              declarativeNetRequest rules behind SET_HEADERS
  session-store.js             Cookies and storage captured by SESSION
  scheduler.js                 chrome.alarms-backed local schedules
  optional-permissions.js      Runtime permission requests, asked for on use
  proxy-manager.js             Proxy pool, health checks, per-run rotation
  rate-limiter.js              Token bucket; paces every acting step

content/                       Page context
  injector.js                  Step dispatcher, selector picker, shadow host
  page-data.js                 PAGE_DATA: JSON-LD, microdata, Open Graph
  smart-extractor.js           AUTO_EXTRACT layers 1 & 2
  structure-detector.js        Finds a page's repeating tables, for Detect Table
  page-sniffer.js              fetch/XHR capture, injected only during a run
  overlay-engine.js            Scrape-zone overlays
  overlay-renderer.js          Per-zone overlay elements
  form-filler.js               FILL: typing, selects, checkboxes, uploads
  captcha-check.js             Challenge detection for SOLVE_CAPTCHA
  page-json.js                 PAGE_JSON: read a JSON payload out of the page
  session-storage.js           Reads and restores localStorage / sessionStorage

sidepanel/
  index.html                   UI and all styles; fonts bundled locally
  pipeline-builder.js          Board, palette, step config, run control
  overlay-panel.js             Overlay preferences
  fonts/                       Inter + JetBrains Mono, latin subset

utils/
  step-types.js                The step vocabulary — one definition
  version.js                   The version number — one definition
  pdf-text.js                  PDF text extraction, no dependencies
  logger.js                    Structured logger; redacts by key name
  color-utils.js               Zone colours, WCAG contrast
  levenshtein.js               Similarity scoring, used by extraction-schema
  pipeline-capabilities.js     What a pipeline can do — the one security model
  ai-gateway.js                Anthropic · OpenAI · Gemini · any local server
  extraction-schema.js         AUTO_EXTRACT field lists and key mapping
  extraction-grounding.js      Refuses a value that is not on the page
  extraction-provenance.js     Which layer answered, and how sure it was
  selector-learning.js         Turns a verified AI answer into an EXTRACT step
  value-transforms.js          trim · number · date · regex, one definition
  row-dedupe.js                Bounded, LRU-evicted seen-key set for DEDUPE
  loop-items.js                LOOP over a list, a range or extracted rows
  conditions.js                IF_ELSE predicates
  assertions.js                ASSERT checks
  captcha-solvers.js           2captcha · anti-captcha clients
  sniffer-filter.js            What page-sniffer keeps and what it drops
  pdf-tables.js                Table reconstruction for PDF_EXTRACTION

checkpoint/
  idb-schema.js                Owns the IndexedDB schema
  row-buffer.js                Buffer rows, flush every 50 rows or 30s
  cursor-store.js              Run position for resume
  resume-manager.js            Incomplete-run detection
  dataset-store.js             Rows on disk, so a long run does not hold them
  ai-cache.js                  Keyed on url + schema + page hash; LRU-bounded

exporters/
  row-formatters.js            CSV · JSON · JSONL · TSV · XML · Markdown
  stream-writer.js             File System Access API, Blob fallback
  text-exporters.js            Save-dialog wrapper, used by the panel

ethics/
  robots-parser.js             RFC 9309 parser
  pii-detector.js              SSN · card · email · phone regexes

script-gen/
  pipeline-compiler.js         Pipeline JSON → AST
  python-emitter.js            AST → Python (playwright)
  node-emitter.js              AST → Node (playwright)

site/                          The community registry website (deployed apart)
mcp/                           Standalone MCP server (see mcp/README.md)
tests/                         1422 tests; node:test, jsdom, fake-indexeddb
e2e/                           85 checks against a real Chromium, plus 8 on
                               mirrored real pages
scripts/check-syntax.mjs       Parses every source file
scripts/build-dist.mjs         Packages the extension zip
docs/                          Audit, architecture, manual, template guide
examples/                      Pipeline JSON you can import
```

Nothing in this tree is unreachable. The three modules the audit left alone —
`form-filler.js`, `field-auto-mapper.js` and `captcha-detector.js` — have since
been resolved rather than left marked: `form-filler.js` is loaded on demand by
`injector.js` behind `FILL`, `captcha-detector.js` was replaced by the smaller
`captcha-check.js` that `SOLVE_CAPTCHA` actually uses, and
`field-auto-mapper.js` was deleted, with its one useful part — `fieldMatchScore`
in `utils/levenshtein.js` — now called by `utils/extraction-schema.js`.

That property is enforced rather than asserted: `npm run lint` fails on a
reference to a name that does not exist, and `tests/dead-code-and-defects.test.mjs`
fails if a second copy of a shared function appears. The history is in
[`docs/ISSUE_AUDIT.md`](docs/ISSUE_AUDIT.md) — see the F-01 table.

---

## Step types

Twenty-five, defined in [`utils/step-types.js`](utils/step-types.js).

| Category | Steps                                                                                                       |
| -------- | ----------------------------------------------------------------------------------------------------------- |
| Action   | `WEBSITE` `NAVIGATE` `CLICK` `FILL` `HOVER` `SELECT` `SCROLL` `KEYBOARD` `DRAG_DROP` `UPLOAD_ACTIVITY`      |
| Flow     | `WAIT` `IF_ELSE` `LOOP` `PAGINATE` `ASSERT` `SOLVE_CAPTCHA`                                                 |
| Data     | `EXTRACT` `PAGE_DATA` `PAGE_JSON` `SCREENSHOT` `EXPORT` `API` `API_SNIFFER` `PDF_EXTRACTION` `AUTO_EXTRACT` |

`PDF_EXTRACTION` reads the PDF in the service worker, with no dependencies —
see [`utils/pdf-text.js`](utils/pdf-text.js). It handles uncompressed and
FlateDecode content streams, literal and hex strings, and per-font `/ToUnicode`
CMaps. Encrypted PDFs, scanned pages and CID fonts with no `/ToUnicode` map are
reported rather than guessed at. The MCP server's `pdf_extract_text` uses pdfjs
and handles more; the two are independent.

### Selectors: CSS, XPath, shadow roots and frames

A selector is CSS by default. Three things extend that, because three real
boundaries do not move for CSS:

- **XPath.** A selector starting `//` or `.//` is evaluated as XPath, for pages
  whose class names are different on every request — find the cell by its text
  or its position instead.
- **Shadow roots.** CSS cannot cross into a web component. Writing
  `app-root >>> .price` searches inside open shadow roots; a plain selector that
  finds nothing also falls back to searching them. `>>>` is Verquill's own
  notation, resolved by its own code, and the exported scripts translate it to
  Playwright's `>>`. Closed shadow roots are unreachable to anything outside
  them, and the tool says so rather than pretending.
- **Iframes.** A selector picked inside a frame remembers which frame it came
  from, and is addressed to that frame at run time. Frames are matched by URL,
  because frame ids do not survive a reload.

### Detect Table

Building a scrape usually means knowing CSS selectors before you start: name a
field, pick it, repeat, hope they line up. **🔍 Detect Table** in the board
toolbar inverts that. It reads the page, works out which groups of elements are
records, and offers them as tables with sample rows. Pick one and you get a
`LOOP` over the container with an `EXTRACT` inside, columns already filled and
named.

It handles what real listings do: a sponsored row with an extra badge stays in
the group (grouping is by shape _overlap_, not an exact match, so you never
silently scrape a subset); a price written `<span>$</span><span>10</span>` is
one column; a list is one column rather than one per item; an anchor's text and
its `href` are two columns with two names.

A page with nothing repeating — a product detail page — is offered `PAGE_DATA`
instead, and told plainly when there is nothing to read either way. The picker
is still there for anything detection misses.

### PAGE_DATA — the page's own data, without selectors

Most sites publish their content as structured data for search engines: JSON-LD,
Schema.org microdata, Open Graph tags. It is already typed, already named, and
it does not break when a designer renames a class. Verquill ignored all of it
and asked for CSS selectors describing the same data.

`PAGE_DATA` reads it. No selectors at all. It handles what real pages do: a
`@graph` is flattened into its nodes (which is how WordPress and Yoast publish);
one malformed block does not lose the others, and is reported; nested microdata
scopes stay nested, so an offer's price does not end up on the product;
`<meta itemprop>` and `<time datetime>` are read for their machine-readable
value rather than their rendered text; a repeated `itemprop` becomes a list.

Optionally flattened, so `offers.price` is a column and a spreadsheet gets
scalars instead of `[object Object]`.

This is the answer to "can we just turn the page into JSON" for a _single_
record — a product, an article, a job posting — which Detect Table cannot help
with, because there is nothing repeating to find. A page that publishes nothing
says so, rather than returning a guess assembled from headings: a guess is
indistinguishable from a reading, and you would have no way to tell which you
got.

### Cleaning values as you extract them

Each `EXTRACT` field can carry a transform, so `"$25.50"` arrives as `25.5` and
`"/p/123"` as a full URL — rather than as a spreadsheet doing find-and-replace
afterwards. Number reading handles European decimals, where the comma is the
point: reading `"1.234,56"` as `1.234` is a hundredfold error in a price column
with nothing to signal it. Text with no number in it becomes empty, never zero —
`0` is a plausible price and would sit in the column indistinguishable from a
real one.

Detect Table picks the obvious ones for you: link columns become absolute URLs,
and a column that is mostly currency is read as a number. Conservative on
purpose, and visible in the field row so you can change it.

Two transforms parse rather than clean. `base64` decodes content a page is
hiding behind it, and gives back nothing rather than a mangled string when the
input was never base64. `regex` pulls a substring out with a pattern and a
capture group — 0 for the whole match — which is how an id comes out of
`/product/1234-name`. Its flags are limited to `i`, `m` and `s`: those are the
ones JavaScript and Python spell the same way, and a pipeline has to agree with
the scripts it generates.

The transforms live in [`utils/value-transforms.js`](utils/value-transforms.js)
and both script emitters apply the same ones, so an exported script produces the
same values.

### Templates

String config values support `{{loop.index}}`, `{{item.href}}`,
`{{extracted.price}}` and array indexing. See
[`docs/JinjaTemplateGuide.md`](docs/JinjaTemplateGuide.md). Every string in a
step's config is resolved, at any depth — including `FILL` field values and
`EXTRACT` field selectors. Templates are a runtime feature of the executor, so
an exported script carries them literally (audit B-16).

### AUTO_EXTRACT

Product pages only. Three layers, each run only if the previous one was not
confident enough:

1. **Structured data** — JSON-LD `@type Product`, microdata, Open Graph
2. **Heuristic DOM** — class/id keywords, font size, distance to the add-to-cart
   button, price regexes
3. **A model of your choosing** — only below the configured confidence, only if
   a provider is set up under Settings → AI gateway, and only if the step's AI
   toggle is on. Anthropic, OpenAI, Gemini, or any OpenAI-compatible local
   server: point it at Ollama or LM Studio and this layer costs nothing and
   sends nothing off the machine

Rows carry `_confidence` and `_extractionMethod`.

---

## Ethics gates

Seven gates run before the first step. The side panel runs them as a preflight
and shows what they found; the service worker runs them again at start, so a
client that skips the preflight gains nothing.

| Gate                | Effect                                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 1 robots.txt        | Warn if the path is disallowed (override with the bypass checkbox)                                                              |
| 2 PII               | Deferred to the content side, which does not implement it — currently a no-op                                                   |
| 3 Rate limit        | Warn above ~100 req/hr estimated. The executor also _enforces_ a token bucket per host — burst of 10, then 1 acting step/second |
| 4 Captcha volume    | Warn above 50 solves/hr estimated                                                                                               |
| 5 Proxy geo         | Warn if the proxy region differs from the declared one                                                                          |
| 6 Domain lock       | **Block** if any step's origin differs from the tab's                                                                           |
| 7 Overlay readiness | Warn about selectors that match nothing on the page                                                                             |

Gate 6 is aggressive: it blocks multi-domain pipelines and any `API` step
pointing at a third-party host. See audit B-03 — whether it should block, warn,
or exempt API steps is an open question.

---

## Storage and secrets

| Where                     | What                                                                                               |
| ------------------------- | -------------------------------------------------------------------------------------------------- |
| `chrome.storage.session`  | API keys (AES-GCM ciphertext) and the key that encrypts them                                       |
| `chrome.storage.local`    | Pipelines per tab, overlay prefs, proxy pool metadata, the file library (base64, budgeted to 8 MB) |
| IndexedDB (`verquill_v3`) | Result rows, run cursors                                                                           |
| Module scope              | Nothing that has to survive a worker restart                                                       |

API keys live for one browser session and are cleared when Chrome closes.

**On the encryption**: the key sits in the same session-scoped storage as the
ciphertext it protects. There is no MV3 mechanism for a key that both outlives
service-worker termination and is never written down, and the previous design —
key in module scope only — meant keys silently became unreadable about thirty
seconds after you saved them. This is defence in depth against incidental
exposure, not protection from anything that can already read extension storage.

The logger redacts by key name and recurses into arrays and objects. It is not a
guarantee: a secret under an innocuous key still gets logged.

---

## Permissions

Seven, each with a call site, enforced by a test:

`scripting` · `storage` · `alarms` · `sidePanel` · `proxy` · `tabs` ·
`downloads`, plus `<all_urls>` host access.

`web_accessible_resources` lists five files — the modules the content script
dynamically imports — not the whole tree.

**No content script is declared.** `injector.js` and `smart-extractor.js` used
to run on `<all_urls>`, in every page you visited, for a tool that acts on one
tab at a time (audit C-09). They are injected on demand into the tab a run or a
picker is about to touch. `<all_urls>` host access is still needed, but for
`fetch` from the worker — API steps and robots.txt — not for running code in
pages.

---

## Script export

A pipeline can be emitted as a runnable Python or Node script (Playwright).

The emitters cover **21 of the 29 step types**. The other eight cannot be
expressed standalone:

| Step              | Why                                                                                                                                |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `UPLOAD_ACTIVITY` | Needs file bytes from the storage library                                                                                          |
| `API_SNIFFER`     | Needs the in-page fetch/XHR hook                                                                                                   |
| `PDF_EXTRACTION`  | Playwright drives a browser; it has no PDF text extractor                                                                          |
| `AUTO_EXTRACT`    | Needs the in-page three-layer extractor, and a model the script has no configuration for                                           |
| `PAGE_JSON`       | A second copy of the DOM walker would drift from the first                                                                         |
| `SOLVE_CAPTCHA`   | A script carries neither the run authorisation nor the domain attestation, so it would be the act without the consent              |
| `SESSION`         | The saved state is encrypted in the extension's own storage, and reading a cookie needs a Chrome permission a script does not have |
| `SET_HEADERS`     | `declarativeNetRequest` is a browser-extension API. A script sets its own headers per request instead                              |

Those emit an explicit `raise NotImplementedError` / `throw`, and are listed in
the run log before the download. They used to become a `# TODO` comment, so the
script ran and quietly did less than the pipeline.

Python or Node — pick the language in the toolbar next to the button.

**Credentials** are replaced with `__FS_ENV__NAME__` markers that both generated
scripts resolve from the environment at run time, so nothing is written into the
file. Detection is by config key name, by HTTP header name (`Authorization`,
`X-API-Key`, `Cookie`…), and by password-shaped selectors. A password typed into
a field none of those recognise is still emitted as written — nothing in the
config distinguishes it from any other text — so the run log lists every
credential it replaced, and what it did not find is visible by omission.

**Templates are not resolved.** `{{loop.index}}` is a runtime feature of the
executor; a standalone script has nothing to resolve it with. Any template left
in the pipeline is named in the run log before the download, rather than shipped
as literal braces in a URL (audit B-16).

---

## MCP server

[`mcp/`](mcp/) is a standalone Model Context Protocol server exposing 18 tools:
workspace file access, pipeline compile/validate/save/emit, PDF text
extraction, PII and robots checks, and row formatting. It shares
`utils/step-types.js` and `exporters/row-formatters.js` with the extension, so
validation and output match.

See [`mcp/README.md`](mcp/README.md).

---

## Docs

| File                                                               | What it is                                               |
| ------------------------------------------------------------------ | -------------------------------------------------------- |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)                     | Why the parts are shaped the way they are                |
| [`docs/ISSUE_AUDIT.md`](docs/ISSUE_AUDIT.md)                       | Full issue inventory, all 192 with fix status            |
| [`docs/CAPABILITY_REVIEW.md`](docs/CAPABILITY_REVIEW.md)           | Gaps — things not broken because never built             |
| [`docs/KNOWN_LIMITATIONS.md`](docs/KNOWN_LIMITATIONS.md)           | What it does not do, and why not                         |
| [`docs/verquill-master-manual.md`](docs/verquill-master-manual.md) | Per-module reference; links and exports checked by test  |
| [`docs/SESSIONS_AND_HEADERS.md`](docs/SESSIONS_AND_HEADERS.md)     | What SESSION and SET_HEADERS buy, and what they cost     |
| [`docs/JinjaTemplateGuide.md`](docs/JinjaTemplateGuide.md)         | Template syntax                                          |
| [`docs/TEST_CHECKLIST.md`](docs/TEST_CHECKLIST.md)                 | The manual checks automation cannot reach                |
| [`docs/STORE_LISTING.md`](docs/STORE_LISTING.md)                   | Store copy and a justification per permission            |
| [`SECURITY.md`](SECURITY.md)                                       | What counts as a vulnerability, and the trust boundaries |
| [`PRIVACY.md`](PRIVACY.md)                                         | Where data lives and what leaves the machine             |
| [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md)                         | Argue with the code, not the person                      |

---

## License

MIT — see [LICENSE](LICENSE).
