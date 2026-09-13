# Contributing

## Setup

```bash
npm install     # jsdom + fake-indexeddb + prettier, for the tooling only
npm test        # node:test, no browser needed
npm run check   # parses every source file as an ES module
npm run format  # prettier
npm run e2e     # loads the extension in a real Chromium and drives it
```

The extension itself has no dependencies and nothing to build. `npm install` is
for the test suite and the formatter.

To load it: `chrome://extensions/` → Developer mode → **Load unpacked** → this
folder. Chrome 120 or newer.

## The rule that matters most

**Write the test against the broken code first, and watch it fail.**

Not as a formality. This repository has produced tests that passed against the
code they were supposed to catch:

- A postMessage attack test that never simulated the attack, because jsdom
  leaves `event.source` null and the guard being tested rejected null.
- Three separate assertions that matched the comment explaining a removal rather
  than the code, so they passed whether or not the removal happened.
- A "not exported" flag that landed one level too deep in an object. Valid JS,
  so `npm run check` was happy and the flag did nothing.

Each was caught by running the new test against the pre-fix tree. Copy the tree
aside, revert the files you changed, run the test, confirm it fails for the
reason you expect. If it passes, your test is wrong.

When you assert on the _absence_ of something in source, strip comments first —
the comment explaining why you removed it will otherwise match forever.

## What a good change looks like

**One finding, or one closely-related group, per commit.** The commit message
says what was broken, how it behaved, and what it does now. Past tense for the
bug, present for the fix. If the audit entry was wrong, correct it in the same
commit rather than quietly working around it — several entries carry a
**Correction** paragraph for exactly this reason.

**Fix the cause, not the symptom.** The recurring shape here is one definition
where there were several: `utils/step-types.js`, `utils/version.js`,
`exporters/row-formatters.js`, `checkpoint/idb-schema.js`, `_dispatchStep`. Each
came with a test that fails on drift, which is what makes "one place" true
rather than aspirational.

**Fail loudly over doing less quietly.** An exported script that throws on a
step it cannot express is better than one that emits a comment and runs. A FILL
that reports it did not stick is better than one that returns success over an
empty field. A page the PDF reader cannot decode gets a note, never mojibake.

**Say what you did not do.** Capture buffers are bounded, not streamed to
IndexedDB. Credential detection is heuristic. Both limits are stated in the code
and in the audit, so the next person does not have to rediscover them.

## Testing

`tests/` uses Node's built-in runner. No framework.

| Helper                              | For                                                                                                        |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `tests/helpers/content-harness.mjs` | `content/injector.js` in jsdom — it is a classic content script, so it is evaluated with `vm.runInContext` |
| `tests/helpers/worker-harness.mjs`  | `background/service-worker.js` against a mock `chrome`                                                     |

Panel functions are extracted from source and evaluated against jsdom, because
`sidepanel/pipeline-builder.js` has no exports and touches ~20 DOM ids at module
scope. Extract _lazily_, inside the test — a missing function at module scope
aborts the whole file and every later test disappears instead of failing.

Some things need a fresh process (module-level caches, for instance). `node:test`
gives each file its own, so put those in their own file and say why at the top.

### And then run it in a browser

`npm run e2e` launches Chromium with the extension loaded, serves a small site
over real HTTP, and drives actual steps against it. The unit tests mock `chrome`,
jsdom the DOM and fake IndexedDB — they prove the logic, and they cannot prove
Chrome will load the manifest or that a step reaches a page.

That distinction is not theoretical. Two blockers survived the whole unit suite:

- The PDF reader passed 18 hand-built fixtures and returned nothing for a PDF
  Chrome had printed, because `endstream` ends in `stream` and the scan matched
  the tail of the token it had just consumed (A-11).
- `EXPORT` had **never** downloaded a file. Service workers have no
  `URL.createObjectURL`, and the worker harness defined one (A-12).

The second is the sharper lesson: **a mock must be as poor as the thing it
stands in for.** A stub that is more capable than the runtime does not test the
code, it tests a fiction. When you add to a harness, add the limitation too.

Add an e2e check for anything that crosses a boundary the unit tests fake:
injection, messaging, storage, a real file format.

## Structure

Every module opens with a docblock: what it is, what it depends on, and — where
it matters — why it is built the way it is. Several record a decision that looks
wrong until you know the constraint. Keep that up; the docblocks that were left
to drift are what made this codebase hard to trust.

`docs/ISSUE_AUDIT.md` is the inventory: 192 findings, all now fixed, and why
each was fixed the way it was. Read it before trusting any claim about how
something works — including a claim in this file.

## Conventions

- Prettier, enforced by `npm run format:check` in CI.
- ES modules everywhere except `content/injector.js` and
  `content/page-sniffer.js`, which are classic scripts and cannot import.
- No dependencies in the extension. If you need a library, you probably need a
  different design — `utils/pdf-text.js` is what that looks like in practice.
- JSDoc on anything exported.
