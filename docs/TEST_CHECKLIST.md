# Verquill — Manual Test Checklist

> **Read this first.** `npm test` now covers 137 automated cases; this file is
> only for what needs a real browser. Roughly half of the cases below exercise
> code that is not reachable from the UI and cannot currently be performed at
> all:
>
> | Cases         | Subsystem                 | Audit |
> | ------------- | ------------------------- | ----- |
> | TC-01 → TC-07 | Proxy rotation            | A-05  |
> | TC-08 → TC-14 | Form fill caps and ethics | A-07  |
> | TC-34 → TC-35 | Captcha gate              | A-06  |
>
> TC-19 → TC-22 (checkpoint and resume) were unperformable until the IndexedDB
> schema collision was fixed (A-03) and are now worth running.

> 35 test cases. Mark each ✅ when passed, ❌ with fail notes.

---

## 🌐 Proxy Rotation (TC-01 → TC-07)

| #     | Test Case                                                                                | Expected                                  | Status |
| ----- | ---------------------------------------------------------------------------------------- | ----------------------------------------- | ------ |
| TC-01 | Paste `IP:PORT` single line → parsed as ProxyEntry with `type=http`                      | Entry added, no error                     |        |
| TC-02 | Paste `socks5://user:pass@host:1080` → parsed with type=socks5, creds in session storage | Entry metadata in local, creds in session |        |
| TC-03 | Upload CSV with `host,port,username,password,type` header → all rows parsed              | Entries added, dupe skipped               |        |
| TC-04 | Round-robin mode: 3 alive proxies → each selected in sequence, wraps around              | Sequential, no repeat before wrap         |        |
| TC-05 | Sticky mode: same domain returns same proxy across 5 calls                               | Same ProxyEntry returned                  |        |
| TC-06 | Mark proxy `failCount = 3` → `alive = false`, skipped in rotation                        | Dead proxy not selected                   |        |
| TC-07 | `testAllProxies({ autoRemoveDead: true })` → dead proxies removed from pool              | Pool shrinks by dead count                |        |

---

## 📋 Form Fill Caps & Ethics (TC-08 → TC-14)

| #     | Test Case                                                                                  | Expected                                              | Status |
| ----- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------- | ------ |
| TC-08 | Try to fill `input[type=password]` via FORM_FILL step                                      | `EthicsBlock.PasswordField` thrown in `execute()`     |        |
| TC-09 | Try to fill `input[type=hidden]`                                                           | `EthicsBlock.HiddenField` thrown                      |        |
| TC-10 | 501 rows without confirmed flag → ethics block                                             | `EthicsBlock.SubmitCapExceeded` thrown before row 501 |        |
| TC-11 | 5001 rows with confirmed flag → still blocked                                              | `EthicsBlock.SubmitCapExceeded` thrown at 5001        |        |
| TC-12 | Set `interRowDelay.min = 500` → fill attempt blocked                                       | `EthicsBlock.DelayFloor` thrown                       |        |
| TC-13 | Submit selector targets `https://other.com` while pipeline origin is `https://example.com` | `EthicsBlock.DomainMismatch` thrown                   |        |
| TC-14 | All 5 field transforms verified: trim, lowercase, normalize-phone, iso-date, pad-zero-5    | Each returns expected output                          |        |

---

## 🔑 API Key Encryption (TC-15 → TC-18)

| #     | Test Case                                                                       | Expected                                         | Status |
| ----- | ------------------------------------------------------------------------------- | ------------------------------------------------ | ------ |
| TC-15 | Store a 2captcha key → retrieve it → decrypts to original value                 | Plaintext matches                                |        |
| TC-16 | Kill SW (go to chrome://extensions and restart) → re-retrieve key               | Returns null (session purged) — correct behavior |        |
| TC-17 | Call `validateApiKey('2captcha')` with invalid key → returns `{ valid: false }` | Returns false, not throws                        |        |
| TC-18 | Network failure during validation → returns `{ valid: null, error: 'network' }` | Distinguishable from invalid                     |        |

---

## 🔖 Checkpoint & Resume (TC-19 → TC-22)

| #     | Test Case                                                             | Expected                         | Status |
| ----- | --------------------------------------------------------------------- | -------------------------------- | ------ |
| TC-19 | Start a pipeline, push 50 rows to buffer → buffer auto-flushes to IDB | `data_rows` store has 50 entries |        |
| TC-20 | Push 30 rows, wait 31 seconds → timer flush fires                     | Rows in IDB without manual flush |        |
| TC-21 | Simulate SW kill mid-run → `detectIncompleteRuns()` returns the run   | Run appears in resume list       |        |
| TC-22 | Resume from cursor at rowIndex=143 → pipeline starts from row 144     | Skips first 143 rows             |        |

---

## ⏳ SmartSleep Edge Cases (TC-23 → TC-25)

| #     | Test Case                                                                             | Expected                           | Status |
| ----- | ------------------------------------------------------------------------------------- | ---------------------------------- | ------ |
| TC-23 | `waitForSelector('#does-not-exist', 1000)` → rejects after 1s                         | Promise rejects with timeout error |        |
| TC-24 | `waitForNetworkIdle()` while 3 XHRs in flight → resolves only after all complete      | Does not resolve premature         |        |
| TC-25 | `waitForDOMStable(300)` while rapid mutations → does not resolve until 300ms of quiet | Correctly waits for stability      |        |

---

## 🔍 PII Detection (TC-26 → TC-27)

| #     | Test Case                                                                              | Expected                           | Status |
| ----- | -------------------------------------------------------------------------------------- | ---------------------------------- | ------ |
| TC-26 | Scan CSV with SSN `123-45-6789` in a column → `scanText()` returns `[{ type: 'SSN' }]` | Finding returned, value not logged |        |
| TC-27 | Scan clean CSV with no PII → returns empty array                                       | No false positives                 |        |

---

## 🤖 Auto-Map Scoring (TC-28 → TC-29)

| #     | Test Case                                                                 | Expected             | Status |
| ----- | ------------------------------------------------------------------------- | -------------------- | ------ |
| TC-28 | Column "email" vs field with `placeholder="Email Address"` → score > 0.70 | Proposal generated   |        |
| TC-29 | Column "xyz123" vs all available fields → no proposal above threshold     | No proposal returned |        |

---

## 📤 Export Streaming (TC-30 → TC-31)

| #     | Test Case                                                         | Expected                          | Status |
| ----- | ----------------------------------------------------------------- | --------------------------------- | ------ |
| TC-30 | Export 15,000 rows as CSV → completes without OOM                 | File downloaded, all rows present |        |
| TC-31 | Export 1 row as Markdown → correct table header + separator + row | Valid Markdown table              |        |

---

## ⚡ MV3 SW Lifecycle (TC-32 → TC-33)

| #     | Test Case                                                                                   | Expected                      | Status |
| ----- | ------------------------------------------------------------------------------------------- | ----------------------------- | ------ |
| TC-32 | Send unknown message type to SW → returns `{ ok: false, error: 'Unknown message type: …' }` | No uncaught promise rejection |        |
| TC-33 | SW receives `pipeline:start` while pipeline already running → returns error                 | Does not start duplicate run  |        |

---

## 🤖 Captcha Gate (TC-34 → TC-35)

| #     | Test Case                                                                                                        | Expected                                            | Status |
| ----- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ------ |
| TC-34 | Call `solveCaptcha()` without `recipeEnabled: true` flag → throws                                                | `EthicsBlock` thrown in solveCaptcha(), not just UI |        |
| TC-35 | Call `solveCaptcha()` with all gates passing but no provider key stored → throws "No captcha provider available" | Descriptive error, no silent failure                |        |

---

## Running the Tests

Since Verquill has no bundler, tests are manual unless you add a test harness.

**Recommended manual test flow:**

1. Load extension in Chrome (Developer mode)
2. Open `chrome://extensions/` → Verquill → Inspect views → Service Worker
3. In the SW console, run each module function directly using dynamic import
4. For content script tests, open a test page and use the injector console

**Automated test harness — built, and the checklist above is now the part it
cannot reach.**

This section described the harness as future work long after it existed. What
runs today:

| Command              | What it covers                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------- |
| `npm test`           | 1422 unit tests — `node:test` with jsdom and fake-indexeddb, no Jest                              |
| `npm run e2e`        | 85 checks driving the unpacked extension in a real Chromium against a local server                |
| `npm run challenges` | 8 checks against real pages mirrored into the repo, so the suite does not depend on a third party |
| `npm run lint`       | oxlint; `no-undef` is an error, which catches a reference the syntax check cannot see             |
| `npm run check`      | Every source file parses as an ES module                                                          |

`npm test`, `npm run lint`, `npm run check`, `npm run format:check` and
`npm run build` gate every push on Linux and Windows. The browser suites run
nightly rather than per pull request — four minutes is slow enough that a gate
gets worked around rather than waited for.

Keep the manual checklist above for what none of that reaches: whether the
panel is legible, whether a run against a site you actually care about returns
what you expected, and whether an ethics warning reads as a warning.

---

_Verquill v3 — Test Checklist v1.0_
