# Architecture decisions

Why the parts are shaped the way they are. Each entry states the constraint
first, because most of these look arbitrary until you know it.

Findings in brackets are from [`ISSUE_AUDIT.md`](ISSUE_AUDIT.md).

---

## 1. No build step, no dependencies in the extension

Plain ES modules, loaded directly by Chrome. `npm install` is for the test suite
and Prettier.

**Why.** A bundler is a second thing to keep working, and MV3's CSP forbids
remote scripts anyway. The cost is real and paid deliberately: no npm library is
available at run time, which is why `utils/pdf-text.js` reads PDFs by hand
rather than importing pdfjs the way the MCP server does. When a dependency looks
necessary, the answer is usually a smaller design.

**Consequence.** `content/injector.js` and `content/page-sniffer.js` are classic
scripts, not modules — content scripts cannot use `import`. They dynamically
`import(chrome.runtime.getURL(...))` for the few modules they need, which is why
`web_accessible_resources` exists and why it is exactly five files.

---

## 2. One definition, plus a test that fails on drift

The same list was copy-pasted into four places and had diverged in all of them:
`pipeline_validate` reported step types the UI had just produced as
"unsupported", while listing one that did not exist [G-01].

Shared things now have exactly one home, and each has a test whose only job is
to fail when a second copy appears:

| One place                     | Read by                                     |
| ----------------------------- | ------------------------------------------- |
| `utils/step-types.js`         | panel, both emitters, MCP server, executor  |
| `exporters/row-formatters.js` | worker export, panel download, MCP          |
| `checkpoint/idb-schema.js`    | row buffer, cursor store, resume manager    |
| `utils/version.js`            | compiler, MCP identity, manifest (via test) |
| `_dispatchStep`               | top-level steps, loop bodies, branches      |

The test is the load-bearing part. Without it "one place" lasts until the next
person is in a hurry.

`content/injector.js` cannot import the registry, so a test asserts its switch
covers every type marked `runsIn: "page"` instead.

---

## 3. Fail loudly rather than doing less quietly

The single most common defect in this codebase was a step that reported success
while doing nothing:

- Emitters turned unsupported steps into a `# TODO` comment, so the script ran
  and did less than the pipeline [B-13].
- `FILL` typed into a field a framework immediately reverted [B-10].
- `SELECT` cleared the control when nothing matched [B-23].
- `EXTRACT` padded short columns with fabricated values [B-08].
- A loop with `max: 0` ran zero times and said nothing [B-22].

So: an exported script throws on a step it cannot express, `FILL` verifies the
value stuck, `SELECT` names the available options, and a zero-count loop is an
error naming the mode where zero is legal.

Where guessing is possible but wrong, the code refuses and reports. A PDF page
whose font has no `/ToUnicode` map comes back with a note, never with the
mojibake that guessing would produce.

---

## 4. State that must survive a terminated worker goes to storage

MV3 kills an idle service worker after 30 seconds, and `await`ing a timer does
not count as activity.

- **Rows** → IndexedDB, flushed every 50 rows or 30 seconds.
- **Run cursors** → IndexedDB, so an interrupted run stays recoverable.
- **API keys** → `chrome.storage.session`, encrypted; see §5.
- **`_runStates`** → module scope, deliberately. A run cannot survive worker
  death, so the fix is to _detect_ the loss and keep the data reachable, not to
  pretend otherwise [D-01].

The keep-alive is an interval calling a cheap extension API, because that is
what resets the idle timer. The alarm that was supposed to do it fired after the
worker it was protecting had already been torn down — Chrome clamps sub-minute
alarm periods [D-02].

---

## 5. The encryption key lives beside the ciphertext, and that is stated

API keys are AES-GCM encrypted in `chrome.storage.session`; the key that
encrypts them is in the same session-scoped storage.

**Why.** There is no MV3 mechanism for a key that both outlives service-worker
termination and is never written down. The previous design kept it in module
scope only, which meant keys became unreadable about thirty seconds after you
saved them [A-04].

This is defence in depth against incidental exposure — a log line, a crash
dump — not protection from anything that can already read extension storage. The
README says so in those words rather than implying more.

---

## 6. Nothing runs in a page until that page is the target

`injector.js` and `smart-extractor.js` were declared content scripts on
`<all_urls>`, so both ran in every page the user visited, for a tool that acts
on one tab at a time [C-09].

They are injected on demand into the tab a run or a picker is about to touch.
The worker pings first — a second injection would re-register the message
listener and double every reply.

`page-sniffer.js` has always been runtime-registered: it wraps `fetch` and `XHR`
in the page's own world and forwards bodies, so it is scoped to an active
`API_SNIFFER` run's origin [C-02].

`<all_urls>` **host access** is still needed, for `fetch` from the worker — API
steps and robots.txt. Host access and running code in pages are different
things, and only the second was the problem.

The corollary took a while to surface. A content script is destroyed with the
document that hosts it, and a run injected once, at the start — so every page
step after the run's first navigation was talking to nothing [A-13]. On-demand
injection is not a one-time setup step; it is a precondition of every message to
a page. `_sendToPage` sends optimistically and, on Chrome's "no receiver"
errors, injects and retries once.

---

## 7. The ethics gates run twice, on purpose

The side panel runs them as a preflight and shows what they found. The service
worker runs them again at `pipeline:start`.

**Why.** A client that skips the preflight must gain nothing by it. The panel's
copy is for explaining; the worker's is for enforcing.

Gate 6 (domain lock) checks _authored_ origins at start, and undeclared origins
are blocked at execution — which is where a templated URL is finally known
[B-03].

---

## 8. Bounded, not solved — and labelled as such

Some fixes are ceilings rather than designs:

- Screenshots and sniffed requests are capped by size and count. The design fix
  is to stream them to IndexedDB the way rows already are. Until then a run that
  fills the buffer keeps going, drops the excess, and reports the count in the
  export line [D-10, D-11].
- Credential detection for script export is heuristic. It cannot recognise a
  password in a field that looks like any other, so the export lists every
  credential it _did_ replace, making the gaps visible by omission [B-14].
- The file library checks a budget before writing, because
  `chrome.storage.local` is ~10 MB and base64 inflates by a third. That is a
  guard, not a storage design [C-12].

Each limit is stated in the module and in the audit. A limitation someone has to
rediscover is worse than one written down.

---

## 9. Two PDF readers, deliberately

The MCP server uses pdfjs. The extension cannot — no bundler, no npm — so
`utils/pdf-text.js` reads PDFs directly.

They are independent implementations of overlapping scope, which is normally a
smell. Here the alternative is worse: either the extension gains a build step,
or `PDF_EXTRACTION` stays a stub that tells the user to run a tool they have no
bridge to, which is what it did [B-28, G-05].

The extension's reader handles what text PDFs are mostly made of and reports
what it cannot do. pdfjs handles more. That difference is documented rather than
papered over.

---

## 10. Nothing is kept unreachable any more

This section used to name three modules that worked and that nothing called.
All three are resolved, and the resolutions were different on purpose.

`form-filler.js` runs behind FILL, loaded on demand by the injector.
`captcha-detector.js` was replaced by the smaller `captcha-check.js`, which
SOLVE_CAPTCHA actually consults [K-02]. The A-05 citation was wrong as well —
that finding is the proxy pool, which now runs during a scrape.

`field-auto-mapper.js` is deleted. It stayed unreachable longest, on the
reasoning that removing it foreclosed a decision that was not mine. That
reasoning expired once the decision was made elsewhere: AUTO_EXTRACT needed to
map a model's returned keys onto the field names a user asked for, which is the
same problem the mapper was written for. So its one genuinely useful part,
`fieldMatchScore()` in `utils/levenshtein.js`, is now called by
`utils/extraction-schema.js`, and the rest of the file was deleted rather than
left as a second, drifting copy of that idea.

The general rule this settles on: a module that nothing calls is not preserved
for its own sake. Either something calls it or it goes, and the useful part of
a deleted module moves to where it is used rather than being kept in place
against a future that may not come.

That is now enforced rather than intended. `npm run lint` fails on a reference
to a name that does not exist, and `tests/dead-code-and-defects.test.mjs` fails
if a shared function grows a second implementation.

Everything else the audit called dead has since been deleted or wired up. The
table is in the audit's status section.

---

## 11. A step that navigates cannot report from the page it left

`PAGINATE` is two messages: the page inspects the Next control and answers, then
the worker performs the click.

Doing both in the page is the obvious design and it cannot work. Clicking a real
`<a href>` navigates; the content script is destroyed with the document before
it can reply; Chrome reports "the message channel closed before a response was
received"; the step fails. On exactly the sites pagination is for.

So the decision is made where the DOM is, and the act that destroys the DOM is
performed from the worker, which survives it. A lost reply to the click is the
expected outcome rather than an error — and that one send is deliberately not
retried, because re-sending it would turn a second page [J-03].

The same shape applies to any step that navigates. `NAVIGATE` waits on the
tab's load state from the worker rather than on anything in the page [J-04].

---

## 12. Read what the page says about itself before reading what it looks like

Three readers now sit in front of the selector picker, in order of how much they
survive a redesign:

| Reader       | Reads                          | Breaks when                               |
| ------------ | ------------------------------ | ----------------------------------------- |
| `PAGE_DATA`  | JSON-LD, microdata, Open Graph | the site stops publishing structured data |
| Detect Table | repeating DOM shapes           | the list's markup changes shape           |
| The picker   | one CSS selector               | any class is renamed                      |

The order is deliberate. A selector describes what a page currently looks like;
structured data describes what it _is_, and the site maintains it for search
engines, so it is the most durable thing on the page and it was the one thing
the product ignored [J-07].

They cover different pages rather than competing. Detect Table needs something
repeating, which a product detail page does not have. `PAGE_DATA` needs the site
to publish markup, which many do not. So Detect Table falls through to
`PAGE_DATA`, and both fall through to the picker — and each says which it is, so
a reading is never mistaken for a guess.

None of them guesses. A page with no repeating structure and no structured data
says exactly that. Assembling a plausible record out of headings would be
indistinguishable from a real reading, and the user would have no way to tell
which they got.

## 13. Clean the value where it is read, once

Transforms live in `utils/value-transforms.js` and run in the **worker**, not
the page — for three reasons, in order of weight: a classic content script
cannot import an ES module, so doing it in the page would mean a second copy
that drifts (the G-01 rule); the worker knows the tab's URL, which is what a
relative link must be resolved against; and a failing transform can name the
field it failed on rather than surfacing as a column quietly full of nulls.

Both script emitters apply the same transforms, so an exported script produces
the same values [J-06].

The rule inside every transform is the one the whole audit kept arriving at: a
transform that cannot do its job returns `null`, never a wrong answer that looks
right. `"Out of stock"` as a number is not `0` — `0` is a price, and it would
sit in the column indistinguishable from a real one.
