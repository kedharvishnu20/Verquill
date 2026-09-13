# Verquill v3 — Known Limitations

> Platform constraints and accepted trade-offs. Bugs live in
> [ISSUE_AUDIT.md](ISSUE_AUDIT.md); this file is for things that are the way
> they are on purpose, or because MV3 leaves no alternative.

---

## MV3 Service Worker Constraints

| Limitation                    | Impact                                                                                                                                                                                                                | Workaround                                                                                                                              |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| SW can be killed at any time  | The run is lost, not just a row: `_runStates` is an in-memory Map and is not persisted. The panel's Stop button stays visible and rows already written to IndexedDB are orphaned under a forgotten runId (audit D-01) | None yet                                                                                                                                |
| SW has no DOM access          | All DOM work must go through content scripts                                                                                                                                                                          | `chrome.tabs.sendMessage` to `content/injector.js`. (`chrome.scripting` is used only to register the network sniffer, not for DOM work) |
| SW lifecycle is unpredictable | Module-scope state (session key) resets on kill                                                                                                                                                                       | AES-GCM key re-initialized on every `activate` event                                                                                    |
| `type: "module"` SW           | Top-level `await` works; dynamic imports limited                                                                                                                                                                      | Static imports only in SW; dynamic imports tested                                                                                       |

---

## Proxy Limitations

| Limitation                                                   | Notes                                                                                                          |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `chrome.proxy` requires `proxy` permission                   | Listed in manifest; user is informed on install                                                                |
| SOCKS5 authentication not supported by Chrome Proxy API      | Authenticated SOCKS5 proxies may fail; use HTTP proxied alternatives                                           |
| PAC script applies to ALL tabs (not per-tab)                 | Rotating proxy during multi-tab runs affects all tabs                                                          |
| Background health check uses extension's network (not proxy) | Health check result may differ from actual proxy behavior in content scripts                                   |
| No per-request proxy selection                               | Chrome's proxy API is session-scope; you cannot proxy one request differently than another in the same session |

---

## Form Filler Limitations

| Limitation                              | Notes                                                                                                                                  |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| React fiber hack is fragile             | React's internal fiber keys change between versions; hack is best-effort and may fail on React 19+                                     |
| `file` input type (`<input type=file>`) | DataTransfer assignment works in most browsers but may be blocked by strict site CSPs                                                  |
| Shadow DOM fields                       | `document.querySelector()` does not pierce shadow roots, so a field inside a closed or nested shadow root is not reachable by selector |
| CAPTCHA auto-solve rate limits          | Third-party CAPTCHA APIs have their own rate limits independent of Verquill's ethics gate                                              |
| Custom web components                   | Non-standard input components (e.g., `<my-input>`) may not respond to native events; manual handler required                           |

---

## Data Parsing

| Limitation                     | Notes                                                                                                                                                                                                                                         |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No data-file input             | A list can be pasted into LOOP, or read from a dotted path the run already holds (`utils/loop-items.js`), but there is no file picker. `MAX_LIST_ITEMS` caps a paste at 10,000 — past that the paste is a file, and a file needs a permission |
| Pasted CSV is not a CSV parser | The list reader handles a delimiter and a header row, which covers a copied spreadsheet column. It is not a full RFC 4180 parser: an embedded newline inside a quoted field will split the row                                                |
| Dedupe keys are hashed         | `utils/row-dedupe.js` keys on the fields you name, not the whole row. Two records that agree on every named field are one record, by design — naming too few fields silently merges distinct rows                                             |
| The seen-set is bounded        | Past its bound the oldest keys are forgotten, so a duplicate separated by more than that many rows is not caught. The run says so rather than reporting a clean dedupe                                                                        |

---

## Script Export

| Limitation                          | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Six step types cannot be exported   | UPLOAD_ACTIVITY, API_SNIFFER, PDF_EXTRACTION, AUTO_EXTRACT and PAGE_JSON need the extension itself; SOLVE_CAPTCHA is left out for a different reason — a generated script carries neither the run authorisation nor the domain attestation, so it would be the act with the consent removed (K-15). All six emit an explicit failure and are reported before download, rather than the silent `# TODO` comment they used to produce (audit B-13) |
| Templates are not resolved          | `{{loop.index}}` and friends are a runtime feature of the executor. The emitters copy config strings verbatim, so templates appear literally in the generated script (audit B-16)                                                                                                                                                                                                                                                                |
| Only proxy credentials are redacted | The README's "credentials are always redacted" claim covers the proxy env vars only. A password typed into a FILL step is emitted as written (audit B-14)                                                                                                                                                                                                                                                                                        |
| No Rust / Go emitters               | Out of scope                                                                                                                                                                                                                                                                                                                                                                                                                                     |

---

## API Key Manager

| Limitation                           | Notes                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Keys last one browser session        | The AES key is stored alongside the ciphertext in `chrome.storage.session`, which Chrome clears on browser close. Until Batch 1 the key lived in module scope only, so keys became unreadable roughly thirty seconds after being saved — see the Storage and secrets section of the README for what the encryption is and is not worth |
| No Claude / Anthropic validator      | Anthropic's validation endpoint requires a test call which costs tokens; validation skipped, key stored as-is                                                                                                                                                                                                                          |
| DeathByCaptcha uses user:pass format | Not supported by the standard key entry UI; enter as `user:pass` string in the key field                                                                                                                                                                                                                                               |

---

## Side Panel

| Limitation                                                              | Notes                                                                                                                                             |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `showSaveFilePicker` not available in side panels in some Chrome builds | Falls back to Blob download automatically                                                                                                         |
| Auto-Map requires active tab                                            | The tab must be on the target form page when clicking Auto-Map                                                                                    |
| Drag-and-drop reorders root steps only                                  | Dragging a step inside a LOOP or an IF/ELSE branch silently does nothing, while the drop target still highlights as though it worked (audit E-05) |

---

## Ethics Engine

| Limitation                         | Notes                                                                                                                 |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Geo-distance calculation           | Uses a simplified region-to-region comparison rather than true Haversine distance (> 5000km criterion is approximate) |
| robots.txt TTL is 15 min           | A site could update robots.txt mid-run; Verquill will not re-check until cache expires                                |
| `robots.txt` fetch failure = allow | If robots.txt is unreachable (network error), Verquill warns but does not block (conservative but permissive)         |

---

## Not reachable from the UI

Nothing. This section used to list four subsystems that existed, mostly worked,
and were called by nothing — which is a worse state than either shipping them
or deleting them, because a reader cannot tell from the outside which of the
two a given line is.

All four are resolved:

| Subsystem                                                      | Audit | Outcome                                                                                 |
| -------------------------------------------------------------- | ----- | --------------------------------------------------------------------------------------- |
| Proxy pool — parsing, rotation, health checks, PAC application | A-05  | Wired. Runs during a scrape, rotating per run                                           |
| Captcha solving — 2captcha, Anti-Captcha, and detection        | A-06  | Wired behind SOLVE_CAPTCHA, with `captcha-check.js` replacing the larger detector       |
| FILL — `form-filler.js` and its ethics gates                   | A-07  | Wired. The injector loads it on demand                                                  |
| Data-file input — `csv-parser.js`, `json-parser.js`            | F-02  | Deleted. LOOP takes a pasted list or a run-context path instead; see Data Parsing above |

`field-auto-mapper.js` went the fourth way: deleted, with its one useful part
(`fieldMatchScore`) moved into `utils/levenshtein.js`, where
`utils/extraction-schema.js` now calls it.

This is checked rather than promised. `npm run lint` fails on a reference to a
name that does not exist, and `tests/doc-drift.test.mjs` fails if a
current-state document starts describing a file that was deleted.

_Last reviewed against the code at the industrial-readiness pass._
