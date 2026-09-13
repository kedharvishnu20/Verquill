# Changelog

All notable changes to this project.

The format is loosely [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
`utils/version.js` is the single definition of the version number; a test fails
if any copy of it drifts.

## [Unreleased]

Everything below was found by a full-repository audit
([`docs/ISSUE_AUDIT.md`](docs/ISSUE_AUDIT.md), 192 findings) and fixed against
it. Entries name the finding, so the audit and this file can be read together.

Every fix landed with regression tests, and every test was run against the
pre-fix tree first to confirm it failed. The suite went from **zero tests to
1422**, plus **85 end-to-end checks** that load the extension into a real
Chromium and drive it and **8 against real pages mirrored into the repo** —
which is what caught several of them, including the two worst.

Counts inside individual entries below are deliberately left as they were
written. "It passed 442 unit tests" is a fact about the moment a bug was found,
and rewriting it to today's number would destroy the only thing it was there to
say.

### Added — the model's answer has to be on the page

The prompt says "never invent". That is an instruction, not a guarantee, and
the failure it is meant to prevent is the worst kind this tool can produce: a
column of plausible values the page never contained. Nothing about the export
says so, and the first person to notice is whoever acts on the data.

There is a real check available and it costs a string comparison, because the
text sent to the model is already in hand: **a value not present in it was
invented**. No second request, no model grading its own homework. A field that
fails is dropped and named in the log with what was claimed — an empty cell
cannot be acted on by mistake, and a fabricated one can.

The honest limit is stated in the panel: this rules out invention, not
confusion. A model that puts a real author's name in the price column passes,
because the name is on the page. The confidence figure is what speaks to that.

Most of the work is in not producing a _false_ positive, because a check that
vouches for an invented value is worse than no check — it puts a badge on the
thing it was built to catch. Four cases, each of which fooled an earlier draft:
a real year on the page must not vouch for the invented name beside it; a digit
inside a URL must not vouch for the URL; half a list is not a list; and a value
too short to prove anything is reported as unproven rather than as verified.
Four more go the other way, where a true answer must not be thrown away: a
number the page writes as `£1,299.00` and the model returns as `1299`, a list
the model joined from separate elements, a URL it resolved against the page,
and the curly quotes and en dashes a CMS substitutes.

### Fixed — every dynamic import in the service worker

`import()` is disallowed outright in a `ServiceWorkerGlobalScope`. The HTML
specification forbids it and Chrome throws
`import() is disallowed on ServiceWorkerGlobalScope`.

There were **nine** of them. The AI gateway's save and test buttons, the API-key
handlers, the captcha model path — every one of those threw the moment it ran in
a real browser, which means the gateway settings had never worked outside the
tests. All nine are now static imports.

No unit test could have caught it: Node allows dynamic import, so the worker
harness reproduced none of it. It surfaced the first time an end-to-end check
saved a gateway config in a real Chromium — which is exactly what that suite is
for.

### Added — AUTO_EXTRACT for any schema, not only for products

The step had seven field names hardcoded across two hundred lines of scoring
rules and spelled out again in its prompt. A page of court listings, job adverts
or conference talks got a step whose only question was "what is the price".

It now takes a list of field names. Deliberately just names — no types, no
required flags, no nesting: someone typing `title, author, published date` wants
three columns, and every further ceremony is a form to fill in before getting
them. An empty schema is the product default, so nothing saved before this
changes.

**The page's own structured data answers for free.** A site publishing
`datePublished` answers a request for "published date" with no model and no
cost, because the requested names are matched against the site's keys rather
than compared to them. That matching is `fieldMatchScore()` in
`utils/levenshtein.js` — written for `content/field-auto-mapper.js`, which
nothing has ever reached (audit A-07). It finally has a caller, and the caller
is in the worker, because `smart-extractor.js` is a classic content script that
cannot import a module. So the page reports the node it found and the worker
decides what the keys mean: the same split `IF_ELSE` and `ASSERT` already use.

Three rules keep it honest. An exact key match is never second-guessed by a
similarity score. One key answers one field, or a schema of `price` and
`originalPrice` reports the same number twice as though the page had said it
twice. And a key that is merely _nearby_ is not an answer — below the threshold
the field goes to the next layer rather than being filled with the closest thing
lying around.

**A heuristic does not answer for a field it was never taught.** Layer 2 knows
products; asked for "defendant solicitor" it says nothing, and the column stays
empty. A guess there would be indistinguishable from an answer in the export.

Two fixes fell out of it. The layer-3 merge ran over a hardcoded product list,
so a model's answer for a user-named field would have been discarded on the way
back — looking exactly like the model failing. And escalation now triggers on
_either_ a low score or an unanswered field: four fields at 95 and one empty
averages well above any threshold while a column is entirely blank.

### Changed — the AI layer works with a free local model

`AUTO_EXTRACT`'s third layer was a **second HTTP client**. It spoke to Gemini and
only Gemini, with its own key lookup, its own timeout and its own idea of what a
bad response looks like — while `utils/ai-gateway.js` already spoke to Anthropic,
OpenAI, Gemini **and any OpenAI-compatible local server**, and was wired to the
settings panel with a provider picker and a test button.

So the one feature that most needed a free local model was the only feature that
could not use one, and a fix to either client left the other wrong. It now goes
through the gateway like everything else. Point it at Ollama or LM Studio and
extraction costs nothing and sends nothing off the machine — including the
credential: a local server that asks for no auth is not sent one.

The gateway gained a JSON mode that uses each provider's **own** mechanism —
Gemini a response MIME type, OpenAI a response format, Anthropic a prefilled
assistant turn it must continue from, since it has no JSON flag. Asking for JSON
and then hunting for a code fence in prose is how half an explanation ends up in
a parser.

One deliberate concession to reality: "OpenAI-compatible" is a family, not a
specification. Ollama and llama.cpp honour `response_format`; several other local
servers reject the whole request for carrying a field they do not know. A 400
from a _local_ server is retried once without it, because the free path must not
be the fragile one. A hosted provider is not retried — dropping the field OpenAI
rejected would hide a real problem behind a worse answer.

`background/gateway-config.js` is now the one place that knows the storage key,
the `gateway:<provider>` key-naming convention and the "a local server needs no
key" exception. Two copies of a convention is two chances for the free path to
work in one place and be refused in the other.

### Docs — the capability review says what is true

`docs/CAPABILITY_REVIEW.md` recorded gaps, not defects: things that were not
broken because they had never been built. Every row in it is now closed, and
the rows are marked rather than deleted — each one names the case that was
failing, which is what makes the fix checkable.

Two counts in the docs had drifted by four and by two. Both are worth stating —
a reader wants to know how much of a pipeline survives export — so instead of
dropping them, a test now reads the registry and fails if either goes stale
again, and checks that every unexportable step still has a row in the README
saying why.

### Added — PDF_EXTRACTION can read the table, not just the text

A PDF has no notion of a table. It has strings, and coordinates to draw them
at; the grid is something the reader's eye assembles. So a PDF of tabular data
— which is most of the PDFs anyone wants to scrape — came out as one blob with
the columns run together.

`PDF_EXTRACTION` now has a table mode. It keeps the positions the text reader
throws away and reassembles the grid from them, putting the rows into the run's
results like any other extraction.

Three decisions, each with a way of being wrong that still produces a plausible
file. **Rows come from y with a tolerance** — a superscript or a font-size
change is enough to break exact matching, and every cell on its own row still
looks like a table. **Columns come from clustering x, not from counting cells**
— a row with an empty cell has fewer cells than its neighbours, and matching by
index would shift everything after the gap one column left. **A row drawn as one
padded string is split on runs of two or more spaces**, because a single space
is inside "New York".

Two things this found. `T*`, the operator that moves to the next line, was
being matched inside a `\b(...)\b` group — and `\b` cannot follow a `*`, so it
never fired and a whole page's lines landed at one y. And **which way is up is
not knowable from the numbers**: PDF's default space has y growing upward, but
a page can install a matrix that flips it, and Chrome's own print-to-PDF does.
Sorting rows on y put the header at the bottom and named every column after a
data value. Rows are now ordered the way the writer emitted them, with y
deciding only which cells share a row.

A PDF of prose produces no rows and says so, rather than inventing column
boundaries.

### Added — UPLOAD_ACTIVITY onto a drop zone, and a fix it uncovered

More and more upload widgets have no `input[type=file]` at all. They listen for
`drop` and read `event.dataTransfer.files`, so there is nothing whose `.files`
can be set — the step's entire mechanism did not apply, and it failed with
"Upload input not found" on a page perfectly willing to take the file.

`UPLOAD_ACTIVITY` now has a drop mode: point it at the zone and it dispatches
the real sequence — `dragenter`, `dragover`, `drop` — carrying a `DataTransfer`
holding real `File` objects, with `types` reporting `"Files"`, because that is
what a dropzone checks before it accepts.

The part that decides whether this is honest is knowing when it did **not**
work. Dispatching a drop at an element with no handler does nothing at all: no
error, no change, nothing on screen. A step that fired the events and reported
success would be exactly the failure this project keeps finding. There is a real
signal, though: a page that accepts a drop _must_ cancel `dragover`, or the
browser refuses the drop outright. So "did anything cancel these" answers "did
anything take the files", and a drop nothing handled fails the step with that
explanation rather than reporting an upload that never happened.

### Fixed — every upload on a freshly loaded page

`UPLOAD_ACTIVITY` talked to the tab with `chrome.tabs.sendMessage` directly
rather than through the helper that puts the content script back. Content
scripts are injected on demand and die with the document that hosts them (C-09),
so any upload after a navigation failed with "Receiving end does not exist" —
the same defect that had already been fixed for every other page step, missed
here because this one had its own send.

No unit test could have caught it: the worker harness answers whether or not
anything was injected. It surfaced the first time the new drop mode was run in a
real browser.

### Added — LOOP over a list you supply

Every other `LOOP` mode takes its bound from the page: the elements it matched,
the page links it found, the count you typed. None of them can say "visit these
500 product URLs", because the list is the input rather than something on
screen.

Two sources, chosen because neither needs a new permission or a new store.
**Lines you paste** — one item per line, which is what a spreadsheet column
becomes when you copy it; give it a delimiter and a header row and it is a
pasted CSV, with each column reachable as `{{item.<column>}}`. **Something an
earlier step produced** — a dotted path like `api.rows` or `pageData.records`,
so the list follows whatever the site returned today instead of a copy taken
last week.

The splitting is written out rather than done with `split(",")`. A column
holding `Smith, John` is one field; splitting it shifts every column after it,
silently, into a scrape that looks like it worked. A quote in the middle of a
value — `12" pipe` — is part of the value, not the start of a quoted field.

**The items reach the exported script.** This is what makes the mode worth
having rather than decorative: templates are otherwise resolved by the run and
merely _reported_ as unresolved on export, so a script fetching
`https://shop/{{item.value}}` five hundred times, braces and all, would be a
script that does not work. Because the list is known at export time, both
emitters bake it in and turn `{{item.field}}` and `{{loop.index}}` into real
reads of it — as string concatenation rather than a template literal or an
f-string, since a URL can contain a backtick, a `${`, or a brace.

A list read from the run context refuses to export, and says so in the panel
before you press Export rather than after: a standalone script has no run to
read from, and a loop over nothing that exits 0 is the failure this project
keeps finding.

### Added — EXPORT can add to a dataset instead of writing a new file

"A run per day into one dataset" produced thirty files, and stitching them
together by hand is where the duplicate rows and the mismatched columns come
from. `EXPORT` can now keep adding to one.

The two halves do it differently, and the panel says so rather than leaving it
to be discovered.

**The extension cannot append.** `chrome.downloads` writes and never reads, so
yesterday's file is not something it can open and add to. It keeps the rows
instead — in IndexedDB, under a dataset name, outliving the run that produced
them — and writes the whole set out again under one filename. The file grows a
run at a time, which is what was wanted; underneath it is a rewrite, which
matters for one reason: anything edited into the file by hand is lost on the
next run. The compensation is real, though — because the file is rendered from
rows every time, a page that gains a column mid-week gets that column, which a
literal append to a written CSV could never do.

**The exported script appends for real,** with `appendFileSync`. For CSV and
TSV it writes the header once and then checks, on every later run, that the
file's existing header still matches this run's columns — appending under a
header that has changed would put values under the wrong headings, and nothing
about the resulting file would say so.

Both halves refuse the same three formats. A JSON array has to be reopened to
take another element, an XML tree to take another node, and a Markdown table's
alignment row would end up in the middle of the data. The extension's mechanism
could manage all three; it refuses anyway, because a pipeline and the script
exported from it have to do the same thing.

The database schema is at version 3. The upgrade adds the `datasets` store and
touches nothing else.

### Added — IF_ELSE can compare one element against another

"Only take it if the sale price is under the list price" could not be written
at all. A condition tested one selector against a value you typed, and the value
you type is different on every row. (Comparing against something stored earlier
in the run already worked — `{{extracted.field}}` is resolved before the step
runs — so the second element was the whole gap.)

The right-hand side of a comparison can now be a second selector. Three details
decide whether that is worth having.

**Both sides are read in one message.** Two round trips would read them at two
moments, and on a page that updates itself that compares two states rather than
two elements.

**Both sides go through the same number reader.** `Number("£1,299.00")` is NaN,
so a comparison built on it would refuse most of the prices on a real shop. The
right-hand side is read exactly the way the left one is.

**A missing element is not a match.** The empty string is what a missing element
trims to, so without an explicit guard an empty left side would "equal" an
element that is not on the page. It takes the ELSE branch — and the run says so,
naming the selector, because silently taking ELSE is indistinguishable from a
condition that was simply not met.

### Added — CLICK with the right button, the middle button, or keys held

`CLICK` now takes a mouse button and a set of keys to hold. What it can do is
narrower than it sounds, and the panel says so rather than leaving you to find
out: an extension cannot make Chrome _react_ to a click. Opening a link in a
background tab and showing the browser's own context menu are default behaviours
the browser keeps for real clicks, and nothing a content script dispatches is
real. What these reach is the page's own handlers — a custom context menu,
ctrl-click multi-select, shift-click range selection — which is what they are
wanted for most of the time.

The event detail is the part worth getting right, and is easy to get wrong: a
non-primary button fires `auxclick`, not `click`, so a middle click synthesised
as a `click` reaches handlers that were not listening and misses the ones that
were. A right click fires `contextmenu` and no click event of any kind — firing
both would run the left-click handler too. `buttons` is cleared by the time the
click lands, so a handler telling a drag from a click is not lied to. The
checkbox-forcing and keyboard-activation fallbacks now run only for a plain left
click: a right click on a checkbox opens a menu, it does not tick the box.

Exported scripts pass the same button and modifiers to Playwright, which
supports both natively.

### Added — CLICK can wait for what the click was supposed to cause

"Load more" and "Next" finish _after_ the click returns. The next step then
read the rows that were already there, and the only answer was a `WAIT` step
holding a guessed number of milliseconds — too small on a slow day, wasted time
on a fast one. The failure is silent: the run carries on and the export is
simply short.

`CLICK` now names the thing to wait for instead of the time to wait — the page
to finish loading, an element to appear, an element to disappear, or the page to
stop changing — with its own timeout, and an element that never arrives fails
the step rather than passing quietly.

Two things came out of building it.

A click on a real link destroys the document that was about to answer it. The
worker read that as "the content script is missing", put it back, and delivered
**the same click a second time** — to whatever happened to match on the page
that had just replaced it. It is now read as what it is: the click navigated.
The tab is given time to land whether or not a wait was configured, because the
next step running against a half-replaced page is the other invisible failure.
The two cases were indistinguishable because Chrome's actual wording for a
mid-message teardown — "The message port closed before a response was
received" — was missing from the pattern that recognised them.

The Python emitter waited for network idle after **every** click, where neither
the extension nor the Node script waited at all. The same pipeline read the page
at two different moments depending on which language you exported it to, and on
a page holding a long-poll open the Python script hung on a click that had
already finished. All three now wait for exactly what the step asks for.

### Added — DEDUPE

Duplicate rows are the normal outcome of scraping, not an exotic one: a
paginator that repeats its last page, a feed re-rendering what is already on
screen, a run repeated tomorrow over a list that has moved on by three items.
The file ended up with the same record several times and nothing said so.

`DEDUPE` is a **gate, not a filter**, and the placement matters: rows reach
storage as they are extracted, so a step that "filtered the results" would be
unwriting rows already on disk. Put it before the steps that extract, and from
there on every row the run collects is checked.

- **The key is yours.** Name the fields that identify a record — a URL, an id, a
  title. Whole-row equality is almost never what a person means: two readings of
  one product differ by a stock count that moved between page loads. Values are
  compared the way a person compares them (trimmed, whitespace collapsed,
  case-folded), and a field the page did not have stays distinct from one it had
  empty.
- **"Across runs" is a real mode.** The keys persist under the pipeline and the
  site, so tomorrow's run collects only what is new — the mode a watchlist
  actually wants, with the cost stated: the keys are kept until you clear them.
- **The seen-set is bounded.** Past the limit the oldest keys are forgotten,
  which can let an old duplicate through. The panel says so rather than
  presenting the count as exact.
- **The exported script carries the same gate**, including the across-runs mode,
  which becomes a JSON file the script reads at the start and rewrites at the
  end. Verified by running a generated script twice against a page with a
  repeated link: the first run wrote two rows and dropped one, the second wrote
  none and dropped three.

Collecting rows also went from five copies of the same two lines — in EXTRACT,
PAGE_DATA, PAGE_JSON, API and AUTO_EXTRACT — to one path, because a gate added
to four of five is a gate that leaks.

### Fixed — three ways pagination scraped the same page twice

All three share a shape: the run keeps going, produces rows, finishes without an
error — and every page after the first is a copy of the first. The exporter's
dedup used to hide the evidence.

- **A Next link that opens in a new tab** (VQ-03). Clicking `target="_blank"`
  loaded page 2 into a tab nobody was reading while the run went on scraping
  page 1, once per "page", until the count ran out. The probe now reports where
  Next leads and whether it would open a tab, and the run follows the href in
  its own tab — through the same origin gate every other navigation uses. A
  JavaScript paginator calling `window.open` has no anchor to read, so a tab
  opened by the run's tab during the click is adopted after the fact and closed.
- **A URL-pattern loop ran past the last page** (VQ-04). That mode has nothing
  to probe: the template says where the pages are and `max` says how many. A run
  asked for 20 pages of a 5-page site fetched 15 empty ones, and on a site that
  clamps `?page=99` to the last page it scraped the same rows 15 times instead.
  A page that yields no rows after one that did now ends the loop, which is the
  same signal a person reads off the screen. There is a toggle for the pipeline
  whose rows come from somewhere else.
- **The exported script had a cruder idea of "last page"** (VQ-08). It asked
  only whether the Next control exists and is enabled, missing `aria-disabled`,
  a disabled class on a `<span>`, an `<a>` with no `href`, and a control the
  site hides with CSS. Those reasons — and the new-tab check, and the empty-page
  stop — now come from one shared file that both emitters send into the page, so
  the script and the pipeline cannot drift on what ends a paginator.

### Fixed — two gates that were not gates

- **Gate 4 measured the wrong thing** (VQ-15). It estimated captcha volume from
  the row delay of the first FORM_FILL step, if the pipeline happened to have
  one. A pipeline with no FORM_FILL fell back to a default and warned about
  3000 solves an hour with no captcha step anywhere in it; a pipeline solving a
  hundred captchas inside a loop was measured against a number that had nothing
  to do with it. It now counts SOLVE_CAPTCHA steps through their loops, paced by
  the run's own delay, bounded by both.
- **Gate 5 could not fire** (VQ-14). It compared "the proxy entry" against "the
  declared region" and no caller passed either, in any pipeline, ever. It now
  answers a question it can: you set the pool to exit through a country, and no
  live proxy in it claims to be there — so the run will quietly use whatever is
  alive instead. That also made geo rotation real: `selectProxy`'s geo mode read
  a `targetCountry` nobody passed and behaved exactly like random, and the mode
  was missing from the panel's dropdown besides.
- **Tor's ports are read as SOCKS** (VQ-17). Only 1080 was inferred, so a proxy
  on 9050 or 9150 was treated as HTTP: it connected, then failed every request,
  with nothing saying why.
- **Stale "unreachable" claims removed** (VQ-16). The architecture notes named
  three modules nobody calls; two had since been wired, and one of the three
  finding numbers cited was the proxy pool, which now runs during a scrape.

### Fixed — the exported script now does what the pipeline did

Six differences between running a pipeline and running its script, all found by
using the tool rather than by reading it. The tests for these do not check how
the generated code is spelled: they lift the helpers out of the generated file,
run them, and compare against the extension's own modules — the only comparison
that catches a re-implementation drifting from its original.

- **A bulk EXTRACT exported as one row** (VQ-06). Every field was read with
  `.first()`, so a pipeline that collected a grid of thirty products exported a
  script that returned one and said nothing about the other twenty-nine. Both
  emitters now assemble rows the way `_stepExtract` does: one match is a
  page-level value repeated on every row, n matches are positional, and a short
  field gets null rather than a repeat of its first match.
- **An element is read the way the extension reads it** (VQ-06, same fix). An
  `<img>` answers with its `src` and a bare `<a>` with its `href`; the scripts
  used `innerText()` for everything, which for a grid of images is the empty
  string on every row. Those rules now live in one file as JavaScript, and both
  emitted scripts send the same text into the page.
- **EXPORT wrote no file** (VQ-07). It emitted `// implement write here` — a
  script that runs, exits 0, and leaves nothing on disk. All six formats are now
  emitted in both languages, byte-for-byte identical to what the extension
  writes. Writing that test found a seventh difference: Python spaced its JSONL
  where JavaScript did not.
- **`1.4E7` became 1.4** (VQ-09). The extension reads scientific notation —
  scrapethissite.com reports Antarctica's area that way — and the emitted
  `vqNumber` stopped at the `E`. A wrong number that looks plausible in a column
  of areas is the worst kind. Non-breaking and narrow spaces between thousands
  are handled too.
- **A LOOP with max 0 ran zero times** (VQ-10). The panel says 0 means every
  one, and `_executeLoop` agrees; `Math.min(length, 0)` and `elements[:0]` did
  not.
- **Base64 that is not text came back mangled** (VQ-11). `Buffer.toString('utf8')`
  replaces bad bytes with U+FFFD and hands back a string where the in-page
  decoder returns null.
- **ASSERT compared the wrong text** (VQ-12). `_stepAssert` and `_stepIfElse`
  both read `textContent`; the scripts read `innerText`, which drops whatever
  CSS has hidden. An assertion could pass in the panel and fail in the script,
  with neither able to say why.

### Added — logging in, and the headers a site will accept

Two capabilities that needed a Chrome permission each, and so are declared
`optional_permissions`: installing Verquill asks for neither, and Chrome's own
consent dialog appears at the moment you switch one on in Settings →
Permissions. Both steps work without their permission and say exactly what they
lose. [`docs/SESSIONS_AND_HEADERS.md`](docs/SESSIONS_AND_HEADERS.md) is the
whole story: how to capture a session, where it is kept, what the encryption is
and is not worth, and how to revoke either permission.

- **`SESSION` — log in once, restore on every later run.** A session lives in
  two places the extension reaches separately: the cookie jar, which only the
  worker can read in full, and the page's own localStorage/sessionStorage,
  which only the page can see. Both halves are saved, so a restore puts back
  what the save took. With the **Cookies** permission it reads the `HttpOnly`
  session cookie — which is what a session cookie almost always is; without it
  it saves the visible cookies and warns, at save time, that a restore will
  probably be a logged-out one. Restoring onto a different origin is refused,
  and `HttpOnly` cookies are skipped rather than counted as written. The store
  is AES-GCM encrypted and persists across restarts (the API-key store
  deliberately does not); a pipeline's JSON carries only the session's name.
- **`SET_HEADERS` — send a `User-Agent` a site will accept.** Sites do refuse:
  tryscrapeme.com answers `403 Invalid User Agent` site-wide. A page cannot
  change its own request headers, so this uses `declarativeNetRequest` with the
  narrower `WithHostAccess` variant. The rules are scoped to the run's tab by a
  `tabIds` condition, replaced rather than stacked by a second step, removed on
  every exit from the run, and swept again at startup for anything a crash left
  behind — the lesson of the proxy that outlived its run (A-05). Headers the
  browser reserves come back named in the log rather than being dropped
  quietly.

### Section K — what using it on real sites found

The audit's A–J sections came from reading the code. Section K came from
running the tool against real pages, and it found things 700 tests had not.

- **Selectors can see inside web components** (K-01). CSS cannot cross a shadow
  boundary, so on a site built from web components every selector matched
  nothing and the tool said "not found" for elements plainly on screen. The
  resolver now walks open shadow roots when a plain query comes back empty, and
  a selector can pierce explicitly with `>>>` — a notation that has to be ours,
  because CSS has none. The exported scripts translate it to Playwright's `>>`.
  Closed shadow roots stay unreachable, and say so.
- **A captcha stops the run and names itself** (K-02). It used to produce empty
  rows and no error: EXTRACT does not fail on a miss, so being blocked looked
  exactly like a page with nothing on it. The check asks whether a captcha is
  _in the way_ rather than whether one is present — reCAPTCHA v3 runs invisibly
  on a large share of the web — and pauses the run so it can be resumed.
- **Data inside an iframe can be picked and read** (K-03, K-07, K-08). Three
  separate bugs stacked here, which is why it kept looking fixed: a picked
  selector lost the frame it came from, frames that loaded after the first
  injection never got the content script, and the picker's own full-viewport
  overlay in the top frame swallowed every click meant for a frame beneath it.
  Frames are matched by URL rather than by id, because ids do not survive a
  reload.
- **XPath selectors** (K-04), for pages that rename their classes on every
  request. A selector starting `//` or `.//` is evaluated as XPath, so an
  element can be found by its text or its position rather than by a class name
  that will be different next time.
- **A `base64` transform** (K-05), for pages that hide their content behind it.
  Input that was never base64 becomes null rather than a mangled string.
- **Test and Run agree about transforms** (K-06). The Test button showed raw
  values while a run cleaned them, so a field looked wrong in the panel and
  right in the export, or the reverse.
- **Detect Table works on the shapes real pages use** (K-09, K-10). It was
  measured against a battery of 37 table and list shapes rather than guessed at:
  navigation and footer landmarks are no longer offered as data, a wrapper
  element no longer hides the rows inside it, and a column the page names in a
  `<th>` is kept even when every row holds the same value — which is what lost
  the ratings column on a book table where every book had four stars.
- **The regex transform can reach any capture group** (K-11), with a group
  number and flags, instead of only ever returning the first group.
- **Any step can retry** (K-12). `optional` could only say "give up quietly",
  so a step that was flaky rather than wrong cost the row. A retry queues
  behind the rate limiter exactly as the first attempt did, and the wait is
  slept in slices so Stop is answered inside a long delay rather than after it.
- **`ASSERT`** (K-13), the step that stops a run whose page has changed shape
  instead of exporting five hundred empty rows. Exists, does not exist, a count
  compared against a number, or text that equals or contains. The page reports
  what it saw and the worker decides what that means, the same split `IF_ELSE`
  uses.
- **FILL will not fill a bot trap** (K-14). A field that is hidden, offscreen,
  zero-sized, `aria-hidden` or named as bait is skipped, and the log says which
  and why. There is no toggle: filling a honeypot fails silently — the form is
  accepted and the submission is binned — which is exactly the surprise this
  tool exists to prevent.
- **The written captchas a small site writes itself are answered locally**
  (K-14). Arithmetic, letter counts and "the third word of this sentence", read
  in the worker with no service, no key and no money. Every parser refuses the
  moment it is not certain, because a guess is a failed attempt the site
  records and a refusal is a pause the user was going to see anyway. The
  checker now also reports a tier — `solvable-locally`, `needs-a-service`,
  `not-solvable` — and Cloudflare and Akamai interstitials are `not-solvable`
  and say why: they are bot management, and no solver has an answer to sell.
- **`SOLVE_CAPTCHA`** (K-15), which runs only because somebody added it, and
  only with both the run's authorisation and an attestation for the domain —
  you own it, you have permission, or the account is your own — given once and
  stored per domain. Missing either, it refuses and says which. On a challenge
  nothing free can answer it refuses or pauses rather than pretending.

### Added — what the steps can now do

Section J of the audit. These are not defects in the A–I sense; they are
capabilities the configuration promised and the code did not have.

- **`WAIT` can wait for something** (J-01), instead of only for the clock. Wait
  for an element to appear, for one to disappear, or for the page to stop
  changing. The first two had been implemented in the content script since the
  first commit and were unreachable: the worker's WAIT case slept and returned,
  so nothing ever forwarded them. "Appear" means rendered, not merely present —
  a `display:none` placeholder matching the selector is what makes an existence
  check resolve early and hand the next step an empty page.
- **`SCROLL` has an infinite mode** (J-02) that scrolls until the page stops
  growing, for feeds and "load more" lists. Bounded, and it says whether it
  stopped because the feed ended or because it ran out of scrolls.
- **`PAGINATE` knows when the pages run out** (J-03). It was
  `return _stepClick(config)` — a click under a different name — so a loop set
  to 10 pages ran its body 10 times whether or not the site had 10 pages, and
  re-scraped the last one. A Next control that is missing, disabled, hidden or
  hrefless now ends the loop, and it says which.
- **`NAVIGATE` waits for the page** (J-04) rather than sleeping three seconds
  and hoping. A slow page is no longer scraped empty; a fast one no longer costs
  three seconds per iteration.
- **Seven step types have a configuration UI** (J-05) — WAIT, HOVER, SELECT,
  DRAG_DROP, PAGINATE, SCREENSHOT and API_SNIFFER fell through to a loop that
  rendered raw config keys as labels, so DRAG_DROP offered "source" and "target"
  and nothing else.
- Both script emitters were brought along, so an exported script does what the
  pipeline does: the new wait modes, the infinite scroll loop, and a paginating
  LOOP that clicks Next — which the emitted loop never did at all.
- **`PAGE_DATA` reads the structured data the page already publishes** (J-07) —
  JSON-LD, Schema.org microdata, Open Graph. No selectors at all, already typed
  and named, and it does not break when a designer renames a class. The existing
  JSON-LD reader only ever looked for `@type: Product`, so a recipe, a job
  posting, an article or an event was invisible.

  This is the answer to "can we just turn the page into JSON" for a single
  record — a product, an article — which Detect Table cannot help with, because
  there is nothing repeating to find. Detect Table now offers it when it finds
  no table, and only when there is something to read.

- **`IF_ELSE` can ask about emptiness, numbers and patterns** (J-08) — "only
  scrape items under £50" and "skip the row when the price is missing" could not
  be expressed at all before. The page reports what it saw and the worker
  decides, so a numeric branch uses the same number reader `EXTRACT` does rather
  than a second copy of it.
- **`SCREENSHOT` can capture the whole page or one element** (J-11), not just
  the visible strip. Full-page walks the page and joins the strips, puts the
  scroll position back, and truncates a bottomless feed rather than looping
  forever. A fixed header repeats in each strip — that is what stitching does,
  and it is stated rather than hidden. Captures are paced: Chrome allows about
  two a second, which the first real-browser run discovered by being refused.
- **The API sniffer can be filtered** (J-10) by URL and method, before the
  bounded buffer rather than after it, so analytics and font requests can no
  longer push the calls you wanted out of the capture.
- **`KEYBOARD` has a target and a repeat count** (J-09). It typed at whatever
  had focus, once.
- **Extracted values are cleaned as they are read** (J-06). `"$25.50"` arrives
  as `25.5`, `"/p/123"` as a full URL. Number reading handles European decimals,
  where the comma is the point — `"1.234,56"` read as `1.234` is a hundredfold
  error in a price column with nothing to signal it — and text with no number in
  it becomes empty, never `0`, because `0` is a plausible price. Detect Table
  picks the obvious transforms itself.

### Fixed — reported from real use

- **A field picked inside a loop was described page-wide** (J-20), which is why
  scraping a grid of product cards gave wrong answers. The loop already says
  what a record is, so a field picked inside it is now described _relative to
  that record_ — `.title`, not `.grid > .card:nth-of-type(2) > .title`, which
  finds the second card's title in every row. The picker outlines the records
  and refuses a click outside them.
- **Nothing could be dragged into a loop** (J-21). Drops were only accepted on
  another step, so an empty loop had no target at all, and dropping on the
  loop's card put the step _beside_ it. The body of a loop and each branch of
  an IF are drop targets now.
- **`PAGE_JSON`** (J-22) returns the page itself as JSON — a nested tree, the
  readable text in order, or one flat row per element. No selectors, works on
  anything. The companion to `PAGE_DATA`, which reads only what a site chooses
  to publish.

Six findings, all from someone actually running the extension rather than from
reading the code.

- **Nothing could reach inside an iframe** (J-14). The content script was
  injected into the top document only, and an iframe is a separate document
  rather than a branch of its parent's DOM — so no step could touch anything
  in one, on any site. Injection reaches every frame now, and each page step
  carries a **"Look inside iframes as well"** toggle. A toggle rather than
  always searching, because searching every frame changes what an ambiguous
  selector matches and a page can carry a dozen advertising iframes.
- **Half the step types could not be tested** (J-15) — `Unknown step type:
LOOP`, `Unknown step type: API_SNIFFER`, and PDF extraction with them. The
  test path forwarded anything it did not special-case to the page, and ten of
  the twenty-two types run in the worker. It asks the registry where a step
  runs now, and the three that genuinely cannot be tested alone say why.
- **The API sniffer captured and threw the captures away** (J-16). It hooked
  the page and recorded requests; the run state holding them was deleted the
  moment the run ended, and `data:download` never returned them. So the only
  way to see one was inside the export archive.
- **Detect Table ignored a table's own header row** (J-17), naming columns
  `tdnthoftype, tdnthoftype 2, …` while the page's `<thead>` said `name,
author, stars, price`.
- **`HOVER` reported success whatever happened** (J-18). It can open a
  JavaScript menu and cannot open a CSS `:hover` one — `:hover` follows the
  real mouse pointer, which no page may move. It can now be told what should
  appear, and fails with that explanation when nothing does.
- **A browser shortcut could not be registered, only triggered** (J-19):
  pressing Ctrl+W to capture it closed the tab, as it always will. Combos can
  be typed now, and a reserved one is flagged.

### Fixed — found by running it on a real website

The first scrape against a site I did not write the markup for
(`scrapethissite.com`) returned the right data in the wrong shape (J-12):

```
country name,strongnthoftype,country capital,strongnthoftype 2,…,sup
Andorra,Capital:,Andorra la Vella,Population:,84000,Area (km2):,468.0,2
```

- **Detect Table returned the page's own labels as columns.** Real markup labels
  its fields inline — `<strong>Capital:</strong>` beside the value — and those
  have the same shape in every record, so they read as perfectly consistent
  columns. Three held one label repeated 250 times; a fourth held the `2` from
  `km<sup>2</sup>`. A column whose value never changes is now dropped, and
  samples are kept for every record rather than the first three, because
  constancy cannot be judged from three.
- **`"1.4E7"` was read as `1.4`.** That is how the site reports Antarctica's
  area, and the numeric run stopped at the `E` — fourteen million became one
  point four, which looks entirely plausible in a column of areas.
- **Detect Table stacked a second scrape of the same list** (J-13), which is
  where the run's 1,250 rows for 250 countries came from: the button appended a
  loop each time it was pressed, said "Added a loop", and never mentioned that
  the previous one was still on the board. The generated pipeline was correct —
  reproduced in a real browser, it yields exactly one row per record. An
  existing loop over the same selector is now found first, and replacing it is
  a question rather than an accident.
- **Plain-number columns were left as text**, because the automatic transform
  only recognised money. A column whose samples are _all_ cleanly numeric is now
  read as numbers — all, not a majority, so a column that is 90% numbers and 10%
  `"N/A"` is left alone rather than having that 10% quietly emptied.

### Fixed — the exported scripts

- **A regex transform reached neither script intact.** In JavaScript `\S` in a
  single-quoted literal is just `S`; in Python the same pattern was emitted into
  an `r""` raw string with the backslash doubled. Both scripts parsed, ran, and
  matched nothing. The suite now reads the emitted pattern back and checks what
  it _matches_ rather than how it is spelled, and an unusable pattern is emitted
  as a refusal instead of repaired.
- **The browser snippet `PAGE_DATA` hands to Playwright** was embedded in a
  Python `"""…"""` literal with escaped single quotes, which Python resolves
  before the browser sees them — arriving as JavaScript with an unterminated
  string. It compiled as Python, because to Python it is just text.
- **Every `IF_ELSE` condition but `exists` was emitted as `if (true)`** with a
  TODO comment beside it, so an exported script took the IF branch
  unconditionally — it ran, produced a file, and had silently ignored its own
  branching. The existing check could not see it: it looks for `# TODO` in the
  Python output, and the Node stub was a `//` comment.
- The emitted scripts are now **compiled** in the test suite — `node --check`
  and `python -m py_compile` over a pipeline using every construct the emitters
  can produce. Pattern-matching the output is happy with source that will not
  parse.

### Fixed — the product did not work

- **FILL could not fill any framework-controlled input** (B-10). It assigned
  `el.value` and dispatched a plain `Event`; React caches the last value it saw,
  saw no change, and overwrote the field on its next render. The step reported
  success over an empty box. Vue and Angular lost the same way. It writes
  through the prototype's native setter now, and verifies the value stuck.
  Checkboxes, radios, `<select>` and contenteditable are handled instead of
  silently doing nothing.
- **`Disallow:` blocked the whole site** (B-17). The canonical "everything is
  allowed" line matched every path. Plus four more RFC 9309 defects: `$`
  escaping, group merging, Allow tie-breaks, and 4xx handling (B-18).
- **Pause did nothing and could not be reached** (E-01). There was no resume
  message at all, and the executor had stopped reading the flag.
- **The selector picker could deadlock** (E-02). It resolved only on click — no
  Escape, no cancel, no timeout — leaving the panel awaiting forever.
- **`SELECT` silently cleared the control** when no option matched (B-23), and
  `KEYBOARD` sent `code` values no real keyboard produces (B-24).
- **Templates did not resolve below the top level** (B-11), so `{{item.href}}`
  inside a FILL field was typed into the page verbatim.
- **`PDF_EXTRACTION` never parsed anything** (B-28). It had a full config UI and
  stored `{status: "pending"}`. The extension reads PDFs itself now —
  [`utils/pdf-text.js`](utils/pdf-text.js), no dependencies.
- **API keys were never validated** (F-03). Six validators existed and nothing
  called them; a typo saved exactly like a working key.
- **Script export always emitted Python** (B-12); the Node emitter had no route
  from the UI at all.

### Fixed — data loss and lies about data

- **Rows were silently duplicated on export** (D-07): dedup compared stringified
  rows, and an IndexedDB round-trip does not preserve key order.
- **Every page step after a navigation failed** (A-13). Content scripts are
  injected on demand and die with their document; only the start of a run
  injected them. So a pipeline that turned a page collected the first page and
  then logged `Receiving end does not exist` once per step — which is most of
  what a scraper does. Found by an end-to-end check that paginated three pages
  correctly and came back with one row.
- **`EXPORT` had never downloaded a file** (A-12). The worker called
  `URL.createObjectURL`, which MV3 service workers do not have, so every export
  failed and produced nothing. It passed 442 unit tests because the test harness
  defined that function for the worker — a mock more capable than the runtime.
  Found by running an export in a real browser.
- **One failed `indexedDB.open` disabled all persistence** for the worker's life
  (A-10, found while testing D-12) — the rejected promise stayed cached, and
  every later write failed with the original error.
- **The PDF reader lost every stream after the first** (A-11), because
  `endstream` ends in `stream`. Eighteen hand-built fixtures passed; a
  Chrome-printed PDF came back empty.
- **A transient flush failure killed the step that produced the row** (D-12),
  under a docblock promising the opposite.
- **The keep-alive could not keep anything alive** (D-02). Chrome clamps the
  alarm period it used to a full minute; the idle timeout is 30 seconds.
- **Screenshots and sniffed requests grew without bound** (D-10, D-11) until the
  worker ran out of memory, mid-run.
- **Row padding invented data** (B-08), and `EXTRACT` could not read an attribute
  at all (B-07).
- **XML and Markdown export were missing** and three CSV serializers disagreed
  (D-03…D-06, D-08).

### Fixed — security and privacy

- **Any web page could drive the step executor** (C-01). The only guard was
  `event.source !== window`, which every script in the page satisfies. The
  module docblock claimed an origin check that did not exist.
- **The network sniffer ran on every page** (C-02), and **two content scripts ran
  on every page the user visited** (C-09) for a tool that acts on one tab.
  Everything is injected on demand now.
- **Credentials were written into exported scripts in plaintext** (B-14), under a
  README claiming they were always redacted.
- **Proxy credentials were logged** (C-03), and the log sanitiser skipped arrays
  (C-11).
- **The MCP HTTP transport bound every interface** with no authentication (C-06).
- **Untrusted text was interpolated into the panel's DOM** (C-04, C-05).
- **A proxy health check left the whole browser proxied** (B-19).
- Four unused permissions dropped, `web_accessible_resources` cut from ten
  wildcards to five named files (C-07, C-08).

### Fixed — the UI

Pause and Resume (E-01); a cancellable picker (E-02, E-03); a row counter that
counts rows (E-04); `alert()` replaced with a toast and a log entry (E-06); test
steps that report what they returned (E-07); keyboard operation of the whole
panel (E-09); editing that no longer loses the caret (E-10); wires that redraw
once a frame instead of once per pointer move (E-11); an explained zoom modifier
(E-12); a board that stays with its running tab (E-13); confirmation before
destructive actions (E-14); drag-and-drop that works inside loops and branches
(E-05); editable field rows (E-16); a key-capture countdown (E-17); a bounded log
pane (E-18); and a storage panel that shows how full it is (E-20).

### Changed

- **One definition of each shared thing**, each with a test that fails on drift:
  the step vocabulary ([`utils/step-types.js`](utils/step-types.js), G-01), row
  formatting ([`exporters/row-formatters.js`](exporters/row-formatters.js),
  D-03), the IndexedDB schema
  ([`checkpoint/idb-schema.js`](checkpoint/idb-schema.js), A-03), the version
  number ([`utils/version.js`](utils/version.js), I-04), and one step dispatch
  chain instead of two that had drifted (B-27).
- **Rate limiting is enforced**, not just warned about (F-09). Ethics gate 3 said
  a run was too fast and nothing slowed it down.
- **The domain lock guards the actual risk** (B-03) rather than blocking every
  multi-origin pipeline.
- Documentation rewritten from the code (H-01…H-07, H-10). The old README
  described a planned architecture, presented dead modules as live, and asserted
  a security check that was not implemented.
- Prettier, and a test suite where there was none (I-01, I-02).

### Removed

Dead modules, each for a stated reason (F-01, F-02, F-07):
`data-sources/csv-parser.js` and `json-parser.js` (no input path exists),
`utils/deduplicator.js` (superseded), `content/smart-sleep.js` (unusable from a
classic content script), `utils/strings.js` (nothing rendered it).

`exporters/text-exporters.js`, `exporters/stream-writer.js`,
`utils/levenshtein.js` and `background/rate-limiter.js` were kept and wired up
instead — they were written for callers that never called.

### Known limitations, stated rather than hidden

- Capture buffers are **bounded**, not streamed to IndexedDB. A run that fills
  them keeps going, drops the excess, and says how much (D-10, D-11).
- Credential detection for script export is **heuristic** — key names, header
  names, password-shaped selectors. A password in a field none of those match is
  still emitted as written, so the export lists every credential it replaced
  (B-14).
- `D-01` is fixed in the sense that matters: a run lost to a terminated worker is
  **detected and reported**, and its rows stay downloadable. Resuming the
  pipeline itself is not attempted.
- Three modules remain unreachable on purpose: `form-filler.js`,
  `field-auto-mapper.js`, `captcha-detector.js` (A-05, A-06, A-07). The reasoning
  is in the audit.

## [3.0.0]

The state the audit was written against. Git history before this point labels
the same code `v3` and `v4` interchangeably, which is part of what I-04 was
about.
