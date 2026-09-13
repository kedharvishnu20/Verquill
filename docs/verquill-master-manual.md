# Verquill Master Manual

> **Scope, and what is checked.** The file inventory and the per-module export
> lists are verified against the tree by `tests/doc-drift.test.mjs`: every
> `Source:` link resolves, and every documented export appears in the file it
> is attributed to. Those two things cannot silently rot any more.
>
> The prose around them is not checked and is not generated. It describes
> behaviour and intent, which no test can confirm, so where it disagrees with
> the code the code is right — and the disagreement is a bug in this file worth
> fixing rather than a note to leave standing.

This is the single authoritative document for Verquill v3.

It is written for two audiences at once:

- humans who need a full architectural and operational manual
- MCP-capable agents that need the repo structure, message contracts, and tool/API details

It consolidates the content previously split across multiple docs.

## 1. What Verquill v3 Is

Verquill v3 is a Manifest V3 Chrome extension for browser automation, extraction, checkpointing, and export.

It also ships with a standalone MCP server so external clients can inspect the repository, validate and emit pipelines, scan for PII, check robots permissions, and manage reusable pipeline files.

The design has two execution planes:

- the Chrome extension plane, which runs the live browser automation workflow
- the MCP plane, which exposes repository and pipeline capabilities to outside clients

## 2. System Overview

End-to-end runtime flow:

1. A pipeline is created, edited, uploaded, or loaded in the side panel.
2. The side panel persists that pipeline in tab-scoped local storage.
3. The user starts a run.
4. The service worker validates the run through ethics gates.
5. The service worker starts execution and maintains run state.
6. Content scripts perform page-level work and return results.
7. Checkpoint modules store cursor and row data.
8. Exporters write rows, screenshots, and sniffer output.
9. The side panel receives status and logs.
10. The MCP server can inspect the same workspace, compile pipelines, save/load pipeline files, and emit scripts.

## 3. Repository Map

### 3.1 Core extension files

- [manifest.json](../manifest.json)
- [background/service-worker.js](../background/service-worker.js)
- [background/ethics-engine.js](../background/ethics-engine.js)
- [background/proxy-manager.js](../background/proxy-manager.js)
- [background/rate-limiter.js](../background/rate-limiter.js)
- [background/api-key-manager.js](../background/api-key-manager.js)
- [content/injector.js](../content/injector.js)
- [content/form-filler.js](../content/form-filler.js)

### 3.2 Pipeline and UI files

- [sidepanel/index.html](../sidepanel/index.html)
- [sidepanel/pipeline-builder.js](../sidepanel/pipeline-builder.js)
- [script-gen/pipeline-compiler.js](../script-gen/pipeline-compiler.js)
- [script-gen/python-emitter.js](../script-gen/python-emitter.js)
- [script-gen/node-emitter.js](../script-gen/node-emitter.js)

### 3.3 Checkpoint and data files

- [checkpoint/cursor-store.js](../checkpoint/cursor-store.js)
- [checkpoint/row-buffer.js](../checkpoint/row-buffer.js)
- [checkpoint/resume-manager.js](../checkpoint/resume-manager.js)

### 3.4 Export and utility files

- [exporters/text-exporters.js](../exporters/text-exporters.js)
- [exporters/stream-writer.js](../exporters/stream-writer.js)
- [utils/logger.js](../utils/logger.js)
- [utils/levenshtein.js](../utils/levenshtein.js)
- [utils/color-utils.js](../utils/color-utils.js)

### 3.5 MCP files

- [mcp/server.mjs](../mcp/server.mjs)
- [mcp/README.md](../mcp/README.md)

## 4. Manifest and Runtime Wiring

The extension is defined in [manifest.json](../manifest.json).

### 4.1 Important manifest fields

- `manifest_version`: `3`
- `name`: `Verquill v3`
- `version`: `3.0.0`
- `minimum_chrome_version`: `120`
- `background.service_worker`: `background/service-worker.js`
- `background.type`: `module`
- `side_panel.default_path`: `sidepanel/index.html`
- `permissions`: includes `activeTab`, `scripting`, `storage`, `alarms`, `sidePanel`, `proxy`, `declarativeNetRequest`, `webRequest`, `tabs`, `notifications`, `downloads`
- `host_permissions`: `<all_urls>`
- `content_scripts`: `content/page-sniffer.js` at `document_start`, `content/injector.js` at `document_idle`
- `web_accessible_resources`: extension assets and implementation folders

### 4.2 Runtime model

- Service worker orchestrates all cross-context state and execution.
- Side panel is the authoring and monitoring surface.
- Content script does page interaction.
- Background modules provide safety, proxies, key storage, rate limiting, and checkpointing.

## 5. Side Panel Manual

Source: [sidepanel/index.html](../sidepanel/index.html) and [sidepanel/pipeline-builder.js](../sidepanel/pipeline-builder.js)

### 5.1 Main responsibilities

- create and edit pipeline steps
- persist pipeline JSON per active tab
- upload previously saved pipeline JSON
- download the current pipeline JSON
- start, pause, and stop runs
- show logs, progress, and partial-data download controls
- manage settings like proxy pool and captcha API keys

### 5.2 UI sections

- header/navigation tabs
- run bar
- pipeline board toolbar
- pipeline canvas
- monitor panel
- settings panel

### 5.3 Important DOM controls

- `btn-master-run`: start the pipeline run
- `btn-master-stop`: stop the current run
- `btn-export-script`: export generated script
- `btn-upload-pipeline`: load a pipeline JSON file
- `btn-download-pipeline`: download the active pipeline JSON
- `btn-clear-pipeline`: remove the current pipeline from state and storage
- `btn-download-partial`: download partial collected rows

### 5.4 Side panel state variables

#### `SK`

Storage key namespace.

- `SK.PIPELINE`: tab-scoped key used for the active pipeline

#### `_tabId`

- current active tab used by the side panel
- updated on startup and tab activation
- used when starting runs and when persisting tab-scoped pipelines

#### `_pipeline`

- full in-memory pipeline object
- expected to contain `steps`
- mutated by add, remove, edit, upload, and reordering actions

#### `_expandedNodeId`

- the currently expanded card id in the board UI

#### `_insertCtx`

- insertion context used when adding a new step
- fields:
  - `index`
  - `parentId`
  - `branchKey`

#### `_runState`

Side panel run UI state.

- `active`: whether a run is currently active in UI
- `timer`: interval handle for elapsed time updates
- `startTs`: start timestamp
- `runId`: current run id from service worker

#### `_dragSourceId`

- current drag source step id

#### `_keyListening`

- whether keyboard registration is waiting for a shortcut capture

#### `_boardState`

Board pan and zoom state.

- `scale`: current zoom factor
- `x`, `y`: current board translation
- `minScale`, `maxScale`: zoom limits
- `panning`: current pan mode flag
- `startX`, `startY`: pointer start positions
- `originX`, `originY`: board origin at pan start
- `fittedOnce`: whether fit-to-content has already been applied

#### DOM refs

- `elCanvas`
- `elPalette`
- `elPaletteSearch`
- `elPaletteContent`
- `elBoardViewport`
- `elBoardStage`
- `elPipelineWires`
- `elBoardZoomLabel`

### 5.5 Pipeline authoring flow

1. User clicks a palette item or insert control.
2. `_addStep(type)` creates a step object from `STEP_REGISTRY[type].def`.
3. The step gets a generated id.
4. Nested insertion uses `_insertCtx`.
5. The new step is inserted into `_pipeline.steps` or into `children` / `ifBranch` / `elseBranch`.
6. `saveState()` writes the result to `chrome.storage.local`.
7. `renderPipeline()` redraws the board and wires.

### 5.6 Import pipeline flow

1. User clicks `btn-upload-pipeline`.
2. File input opens.
3. The file is read as text.
4. JSON is parsed.
5. `_normalizeImportedPipeline()` validates the top-level structure.
6. `_normalizeImportedStep()` recursively normalizes each step.
7. Missing or duplicate ids are replaced with generated ids.
8. The normalized pipeline replaces `_pipeline`.
9. State is saved and the pipeline is rendered.

Import normalization rules:

- top-level object must have `steps` array
- `type` is normalized to uppercase
- missing `config` becomes `{}`
- `LOOP` may use `children`
- `IF_ELSE` may use `ifBranch` and `elseBranch`

### 5.7 Export pipeline flow

1. User clicks `btn-download-pipeline`.
2. If `_pipeline.steps` is empty, a warning is logged.
3. Current pipeline is cloned into a JSON payload.
4. Metadata is added under `meta`:
   - `exportedAt`
   - `source`
5. A Blob is created and downloaded as a timestamped JSON file.

### 5.8 Run start flow

1. User clicks Run Pipeline.
2. Side panel checks `_pipeline.steps.length`.
3. Side panel checks `_tabId` and the current tab URL.
4. Side panel sends `pipeline:start` to the service worker.
5. On success, the UI switches to running state.
6. The monitor timer starts and logs show in the run panel.

### 5.9 Run stop flow

1. User clicks Stop Execution.
2. Side panel sends `pipeline:stop` with the current `runId`.
3. The service worker updates its run state.
4. The UI switches back to stopped state.

### 5.10 Monitor and log flow

- `pipeline:status` updates current step, progress, and state label.
- `pipeline:log` adds timestamped logs.
- error logs increment the error counter.

## 6. Step Registry and Supported Actions

> **Note.** The authoritative list is [`utils/step-types.js`](../utils/step-types.js),
> which the side panel, the script emitters and the MCP server all read. The
> list below is a snapshot and was missing `UPLOAD_ACTIVITY`, `PDF_EXTRACTION`
> and `AUTO_EXTRACT`; a test now keeps the code in step, but not this file.

The side panel step registry includes:

- `WEBSITE`
- `NAVIGATE`
- `CLICK`
- `FILL`
- `HOVER`
- `SELECT`
- `SCROLL`
- `KEYBOARD`
- `DRAG_DROP`
- `WAIT`
- `IF_ELSE`
- `LOOP`
- `PAGINATE`
- `EXTRACT`
- `SCREENSHOT`
- `EXPORT`
- `API`
- `API_SNIFFER`

The `STEP_REGISTRY` values define:

- `icon`
- `cat`
- `desc`
- `def`

`def` is the default config object cloned into new step configs.

## 7. Service Worker Manual

Source: [background/service-worker.js](../background/service-worker.js)

### 7.1 Main responsibilities

- own active run state
- apply ethics gates before execution
- dispatch steps to content scripts
- handle screenshots
- buffer rows and finalize exports
- maintain proxy, captcha, and key workflows
- respond to side panel control messages

### 7.2 Core state variables

#### `MODULE`

- logger tag: `service-worker`

#### `_sleep(ms)`

- small async delay helper used across execution flows

#### `MSG`

Message name map used by all handlers.

#### `_runStates`

Map of active or in-flight runs.

Stored run state fields:

- `active`
- `paused`
- `runId`
- `tabId`
- `enableSniffer`
- `results`
- `screenshots`
- optional `networks`

#### `_handlers`

Registry of handler functions keyed by message name.

### 7.3 Startup lifecycle

On `activate`:

- logs activation
- calls `initSessionKey()` to create or rehydrate the session AES key
- calls `loadPool()` to restore proxy pool
- starts heartbeat alarm

On `install`:

- logs install event
- calls `self.skipWaiting()`

### 7.4 Heartbeat lifecycle

`_startHeartbeat()` creates alarm `vq_sw_heartbeat` roughly every 20 seconds.

Heartbeat listener:

- logs debug heartbeat
- keeps service worker alive during active use

### 7.5 Message bus

`chrome.runtime.onMessage.addListener(...)` routes requests to `_handlers`.

All registered handlers are async and respond through `sendResponse`.

### 7.6 Pipeline start flow

Handler: `pipeline:start`

Input expectations:

- `pipeline`
- `tabId`
- `targetOrigin`
- `targetPath`
- `bypassRobots`
- optional timing and captcha fields

Flow:

1. Ensure `pipeline` exists.
2. Detect whether any step is `API_SNIFFER`.
3. Build `runId`.
4. Create `runState` and store it in `_runStates`.
5. Persist `vq_run_log` in `chrome.storage.local`.
6. Run `runEthicsGates(...)`.
7. On hard block, delete run state and throw `EthicsBlock`.
8. On success, log warnings and start `_executePipeline(...)` asynchronously.

Returned result:

- `runId`
- `warnings[]`

### 7.7 Network sniff flow

Handler: `network:sniff`

Flow:

- identify active run by `tabId`
- require `runState.active`
- require `runState.enableSniffer`
- append captured request/response data to `runState.networks`

Stored sniff fields:

- `timestamp`
- `method`
- `url`
- `status`
- `requestBody`
- `responseBody`
- `type`

### 7.8 Step execution helpers

#### `_captureScreenshot(tabId, config, runId)`

Stores screenshots in `runState.screenshots` and logs capture count.

#### `_executeStepList(steps, tabId, runId, ctx)`

Used for nested execution flows. Important behavior:

- creates `liveCtx` with `extracted` object
- resolves template values with `_resolveConfig`
- emits status messages per step
- executes special cases in SW for `WEBSITE`, `NAVIGATE`, `WAIT` (fixed mode only), `PAGINATE`, `SCREENSHOT`, `API`, `EXPORT`, `LOOP`, `IF_ELSE`
- sends normal steps to content runtime with `step:execute`
- pushes extraction rows to row buffer

#### `_executePipeline(runId, pipeline, targetTabId)`

Primary top-level loop executor.

Behavior:

- initializes row buffer
- respects pause flag
- sends progress updates
- executes each resolved top-level step
- saves cursor after each step
- finalizes buffer at end
- emits completion or stop state
- deletes run state

### 7.9 Message handlers and contracts

Handlers registered in service worker:

- `pipeline:start`
- `network:sniff`
- `step:execute`
- `pipeline:pause`
- `pipeline:stop`
- `pipeline:status`
- `proxy:select`
- `proxy:rotate`
- `proxy:test`
- `captcha:solve`
- `key:get`
- `form:rowStart`
- `form:rowResult`
- `checkpoint:save`
- `key:set`
- `proxy:update`
- `script:export`
- `checkpoint:check`
- `data:download`

### 7.10 Service-worker state variables from imported modules

Important supporting functions and module state are defined in imports:

- proxy manager state
- rate limiter buckets and retry state
- key manager session crypto key
- ethics engine cache and thresholds
- checkpoint row buffers and cursor store

## 8. Content Script Manual

Source: [content/injector.js](../content/injector.js)

### 8.1 Main responsibilities

- execute DOM step instructions
- resolve scoped selectors and templated selectors
- support the selector picker
- relay network sniff events
- handle window message bridge from page scripts

### 8.2 Core constants and state

#### `VQ_ORIGIN`

- extension origin base used by the content runtime

#### `CE`

Constant map of content-event names.

#### `_host`

- DOM host element used for the closed shadow root UI bridge

#### `_shadow`

- closed shadow root hosting the extension UI surface in the page

#### `_pickerActive`

- tracks whether selector picker mode is currently active

#### `_pickerResolve`

- promise resolver used by the picker interaction flow

### 8.3 Message bridge

#### In-page `window.postMessage`

Incoming messages with `type` starting `VQ_` are handled.

Special case:

- `VQ_NETWORK_SNIFF` is forwarded to the service worker as `network:sniff`

#### `chrome.runtime.onMessage`

Routes service-worker messages into `_handleEvent(...)`.

### 8.4 Event router

`_handleEvent(type, payload, id)` routes to:

- `_executeStep`
- `_formFillRow`
- `_activateSelectorPicker`

### 8.5 Step dispatcher

`_executeStep(step)` supports:

- `WEBSITE` and `NAVIGATE` are rejected here: the service worker drives the tab
- `CLICK`
- `SCROLL` — `pixel`, `percent`, `selector`, and `infinite` (scroll until the page stops growing)
- `WAIT` — `fixed`, `selector-visible`, `selector-gone`, `DOM-stable`
- `EXTRACT`
- `FILL`
- `TYPE`
- `HOVER`
- `SELECT`
- `KEYBOARD`
- `DRAG_DROP`
- `IF_ELSE`
- `EXPORT`
- `SCREENSHOT`, `LOOP` and `API` are rejected here: they belong to the background runtime
- `PAGINATE` — clicks the Next control and reports whether there was a next page
- `PAGINATE_PROBE` — inspects the Next control without clicking it
- `QUERY_COUNT`
- `QUERY_ELEMENTS`

### 8.6 Selector and scoped-query helpers

Important helpers:

- `_getScopedRoot(context)`
- `_resolveTemplatePath(ctx, expr)`
- `_renderSelectorTemplate(selector, context)`
- `_normalizeScopedSelector(selector, context)`
- `_queryScoped(selector, context, all)`

### 8.7 Extraction flow

`_stepExtract(config, context)`:

- builds extractor list
- queries DOM nodes by selector
- extracts values through field-type logic
- returns an array of row objects

Value extraction behavior depends on field type and element type.

### 8.8 Form fill flow

`_stepFill(config, context)` supports single and multi modes.

Single mode:

- resolves selector
- types text

Multi mode:

- iterates field list
- types each mapped value
- optionally clicks submit selector

### 8.9 Screenshot flow

`_stepScreenshot(...)` returns a flag so the service worker can capture the screenshot.

### 8.10 Selector picker flow

`_pickSelector(stepId, key)`:

- asks user for specific vs bulk mode
- sends picker request to page
- writes selected selector back to input field
- dispatches change event so state saves

### 8.11 Common state variables used by content runtime

- `_pickerActive`
- `_pickerResolve`

## 9. Pipeline Model and Compiler

Source: [script-gen/pipeline-compiler.js](../script-gen/pipeline-compiler.js)

### 9.1 Compiler entry points

- `compilePipeline(recipe)`
- `serializePipeline(pipeline)`

### 9.2 Compiler responsibilities

- validate top-level recipe shape
- normalize steps into AST
- recurse through `children`, `ifBranch`, `elseBranch`
- attach metadata such as compile timestamp and step count
- redact sensitive values when serializing pipeline JSON

### 9.3 Expected pipeline structure

Top-level shape:

```json
{
  "name": "Example",
  "version": "1.0.0",
  "targetOrigin": "https://example.com",
  "steps": []
}
```

Common recursive fields:

- `children`
- `ifBranch`
- `elseBranch`

### 9.4 AST metadata

- `meta.compiledAt`
- `meta.stepCount`

## 10. Script Emitters

### 10.1 Python emitter

Source: [script-gen/python-emitter.js](../script-gen/python-emitter.js)

Main entry:

- `emitPython(pipeline)`

Responsibilities:

- emit runnable Python 3.11 script text
- support navigation, clicks, waits, extraction, form fill, scrolling, loops, conditionals, API calls, export placeholders

### 10.2 Node emitter

Source: [script-gen/node-emitter.js](../script-gen/node-emitter.js)

Main entry:

- `emitNode(pipeline)`

Responsibilities mirror the Python emitter for Node 20 ESM.

## 11. Safety, Ethics, and Limits

### 11.1 robots parser

Source: [ethics/robots-parser.js](../ethics/robots-parser.js)

Key state and behavior:

- `CACHE_TTL_MS = 15 minutes`
- `VQ_USER_AGENT = 'Verquill'`
- `_cache` map stores parsed robots content

Behavior:

- longest matching rule wins
- wildcard `*` supported
- `$` end anchor supported

### 11.2 PII detector

Source: [ethics/pii-detector.js](../ethics/pii-detector.js)

Detects:

- SSN
- Visa
- Mastercard
- Amex
- email
- phone

Functions:

- `scanRows(rows, limit)`
- `scanText(text)`
- `summarizeFindings(findings)`

### 11.3 Ethics engine

Source: [background/ethics-engine.js](../background/ethics-engine.js)

Important constants:

- `MAX_FORM_ROWS_DEFAULT = 500`
- `MAX_FORM_ROWS_CONFIRMED = 5000`
- `MIN_INTER_ROW_DELAY_MS = 800`
- `ROBOTS_CACHE_TTL_MS = 15 * 60 * 1000`

Important types:

- `EthicsBlock`
- `EthicsWarn`

Main gate function:

- `runEthicsGates(opts)`

Gates:

1. robots.txt check
2. PII scan
3. rate-limit estimate
4. captcha estimate
5. proxy geo consistency
6. domain lock

### 11.4 Hard blocks

The ethics engine enforces hard blocks for:

- password fields in form filling
- hidden fields in form filling
- exceeding allowed row counts
- delays below floor
- domain mismatch against declared origin

## 12. Proxy, Rate, and Key Management

### 12.1 Proxy manager

Source: [background/proxy-manager.js](../background/proxy-manager.js)

Important state:

- `_pool`: proxy entries without creds
- `_credMap`: host:port to credentials
- `_rrIndex`: round-robin index
- `_stickyMap`: sticky-domain mapping
- `_rotationMode`: current rotation mode

Storage keys:

- `STORAGE_KEY_POOL`
- `STORAGE_KEY_CREDS`

Main exports:

- `parseProxyText(text)`
- `parseProxyJSON(input)`
- `parseProxyCSV(csv)`
- `loadPool()`
- `savePool()`
- `addToPool(entries)`
- `clearPool()`
- `getPool()`
- `setRotationMode(mode)`
- `selectProxy(context)`
- `testProxy(entry, retryCount)`
- `testAllProxies(options)`
- `markProxyFailure(host, port, retryCount)`
- `rotateProxy(context)`
- `_applyProxy(entry)`
- `clearProxy()`

### 12.2 Rate limiter

Source: [background/rate-limiter.js](../background/rate-limiter.js)

Important state:

- `_buckets`
- `_retryState`

Constants:

- `DEFAULT_CAPACITY = 10`
- `DEFAULT_REFILL_RATE = 1`

Main exports:

- `initBucket(domain, options)`
- `acquire(domain, count)`
- `backoff(domain, baseMs, maxMs, maxAttempts)`
- `resetRetry(domain)`

### 12.3 API key manager

Source: [background/api-key-manager.js](../background/api-key-manager.js)

Important state:

- `_sessionCryptoKey`: in-memory AES-GCM key

Important constants:

- `SESSION_KEY_KEYS`
- `SESSION_KEY_SK`

Main exports:

- `initSessionKey()`
- `setApiKey(provider, keyValue)`
- `getApiKey(provider)`
- `removeApiKey(provider)`
- `listProviders()`
- `hasApiKey(provider)`
- `validateApiKey(provider)`
- `checkCaptchaGates(flags)`
- `solveCaptcha(params)`

## 13. Checkpointing, Rows, and Resume

### 13.1 Row buffer

Source: [checkpoint/row-buffer.js](../checkpoint/row-buffer.js)

Important state:

- `_buffers`
- `_flushTimers`
- `_idbDB`

Important constants:

- `FLUSH_INTERVAL_MS = 30000`
- `FLUSH_ROWS_COUNT = 50`
- `DB_NAME = 'verquill_v3'`
- `STORE_ROWS = 'data_rows'`

Main exports:

- `initBuffer(runId)`
- `pushRow(runId, row)`
- `flush(runId)`
- `finalizeBuffer(runId)`
- `readAllRows(runId)`
- `clearRows(runId)`

### 13.2 Cursor store

Source: [checkpoint/cursor-store.js](../checkpoint/cursor-store.js)

Important state:

- `_db`

Important constants:

- `DB_NAME = 'verquill_v3'`
- `DB_VERSION = 1`
- `STORE_CURSORS = 'cursors'`

Main exports:

- `saveCursor(cursor)`
- `loadCursor(runId)`
- `listCursors()`
- `deleteCursor(runId)`

### 13.3 Resume manager

Source: [checkpoint/resume-manager.js](../checkpoint/resume-manager.js)

Main exports:

- `detectIncompleteRuns()`
- `markRunCompleted(runId)`
- `getResumePayload()`

## 14. Export

This chapter used to open with two data-parsing sections, `csv-parser.js` and
`json-parser.js`. Both were complete, imported by nothing, and have been
deleted — LOOP takes a pasted list or a dotted path into the run context
instead (`utils/loop-items.js`).

### 14.1 Text exporters

Source: [exporters/text-exporters.js](../exporters/text-exporters.js)

Main exports:

- `exportRows(rows, format, filename)`

This module used to carry six per-format wrappers (`exportCSV`, `exportJSON`,
`exportJSONL`, `exportTSV`, `exportXML`, `exportMarkdown`). They were
declarations and manual entries and nothing else — the panel has always called
`exportRows` with a format argument. They are gone; formatting itself lives in
`row-formatters.js`.

### 14.2 Stream writer

Source: [exporters/stream-writer.js](../exporters/stream-writer.js)

Important constants:

- `CHUNK_SIZE = 1000`

Main exports:

- `createWriter(filename, mimeType)`

## 15. Utility Modules

### 15.1 Logger

Source: [utils/logger.js](../utils/logger.js)

Important state:

- `LEVELS`
- `CURRENT_LEVEL`
- `_buffer`
- `MAX_BUFFER`

### 15.2 Levenshtein and matching

Source: [utils/levenshtein.js](../utils/levenshtein.js)

Main exports:

- `levenshteinDistance(a, b)`
- `levenshteinNormalized(a, b)`
- `tokenize(input)`
- `jaccardSimilarity(setA, setB)`
- `fieldMatchScore(colName, fieldSignal)`

### 15.3 Color utilities

Source: [utils/color-utils.js](../utils/color-utils.js)

Main exports:

- `stepColor(stepType)`
- `fieldColor(fieldIndex, customPalette)`
- `hexToRGB(hex)`
- `relativeLuminance(hex)`
- `badgeTextColor(backgroundHex)`
- `hexToRGBA(hex, opacity)`

## 16. Full Activity Contracts

This section explains the major activity types in procedural order.

### 16.1 Build and edit

User actions:

- add step
- delete step
- insert between steps
- edit config fields
- drag and drop reorder
- expand/collapse details

Internal actions:

- step is mutated in `_pipeline`

### 16.2 Upload pipeline

Expected file:

- JSON object with `steps` array

Workflow:

1. User chooses file.
2. File is parsed.
3. Input is normalized.
4. State is replaced and rendered.
5. Tab-scoped storage is updated.

### 16.3 Download pipeline

Output:

- pretty-printed JSON
- timestamped filename

### 16.4 Start execution

Inputs sent from side panel:

- `pipeline`
- `tabId`
- `targetOrigin`
- `targetPath`
- timing settings
- captcha flags
- row count / confirmation data when relevant

Execution phases:

1. ethics gates
2. run state creation
3. asynchronous execution loop
4. step dispatch
5. checkpointing
6. export/finalization

### 16.5 Pause and stop

- pause preserves active run state
- stop terminates the active loop and clears state

### 16.6 Extraction

- content script extracts rows
- SW stores rows in memory and IDB
- monitor UI reflects row count

### 16.7 Export

Can include:

- rows
- screenshots
- API-sniffer results

### 16.8 Resume

- incomplete runs are detected from checkpoint storage
- user can download partial data

### 16.9 Script generation

- pipeline AST is compiled
- Python or Node code is emitted
- output is downloaded as a script file

## 17. Message Contracts

These are the key payload families used internally.

### 17.1 `pipeline:start`

The canonical shape is:

```json
{
  "type": "pipeline:start",
  "payload": {
    "pipeline": {
      "name": "Example",
      "targetOrigin": "https://example.com",
      "steps": []
    },
    "tabId": 123
  }
}
```

### 17.2 `pipeline:status`

```json
{
  "type": "pipeline:status",
  "payload": {
    "state": "running",
    "currentStepId": "s_1",
    "progress": {
      "current": 1,
      "total": 5
    },
    "runId": "run_123",
    "tabId": 123
  }
}
```

### 17.3 `pipeline:log`

```json
{
  "type": "pipeline:log",
  "payload": {
    "level": "info-log",
    "message": "Pipeline started.",
    "runId": "run_123",
    "tabId": 123
  }
}
```

### 17.4 `step:execute`

Used for single-step test execution and content-runtime dispatch.

### 17.5 `network:sniff`

Used by the page sniffer bridge to capture request/response payloads.

### 17.6 `key:set`, `key:get`

Used for captcha and API-key workflows.

### 17.7 `proxy:update`, `proxy:select`, `proxy:rotate`, `proxy:test`

Used for proxy pool management.

### 17.8 `script:export`

Used for compiled code export.

### 17.9 `checkpoint:check`, `data:download`

Used for resume and partial data download flows.

## 18. MCP Manual

Source: [mcp/server.mjs](../mcp/server.mjs)

### 18.1 Purpose

The MCP server exposes the Verquill workspace to external clients with:

- file listing
- file read/write
- search
- pipeline compile/validate/serialize
- pipeline save/load/list
- Python and Node emission
- PII scanning
- robots checking
- row rendering
- pipeline reporting

### 18.2 Transport variables

- `ROOT`: workspace root
- `TRANSPORT_MODE`: `stdio`, `http`, or `both`
- `HTTP_PORT`: HTTP listening port
- `PIPELINES_DIR`: pipeline file directory
- `httpSessions`: active HTTP transport sessions

### 18.3 Workspace rules

- every workspace path is resolved against `ROOT`
- path traversal outside root is blocked
- search skips large files and common generated directories

### 18.4 MCP tool catalog

Repository tools:

- `repo_list_files`
- `repo_read_file`
- `repo_write_file`
- `repo_search_text`

Pipeline tools:

- `pipeline_compile`
- `pipeline_validate`
- `pipeline_serialize`
- `pipeline_emit_python`
- `pipeline_emit_node`
- `pipeline_list`
- `pipeline_save`
- `pipeline_load`
- `pipeline_report`

Safety tools:

- `pii_scan_text`
- `pii_scan_rows`
- `robots_check`

Formatting tools:

- `rows_to_text`

### 18.5 MCP request patterns

All tools validate inputs with zod and return JSON text content.

Example save pipeline request:

```json
{
  "name": "lead-gen-v1",
  "recipe": {
    "name": "Lead Gen",
    "targetOrigin": "https://example.com",
    "steps": []
  },
  "overwrite": false
}
```

Example load pipeline request:

```json
{
  "name": "lead-gen-v1"
}
```

### 18.6 HTTP mode

The HTTP endpoint is exposed at:

```text
http://localhost:3000/mcp
```

CLI examples:

```bash
npm start -- --root "c:\MY SPACE\MY LAPTOP\project works\fully automated web scraper\verquill-v3"
```

```bash
npm run start:http -- --root "c:\MY SPACE\MY LAPTOP\project works\fully automated web scraper\verquill-v3" --port 3000
```

### 18.7 Pipeline file storage model

Saved pipelines live in the `pipelines/` folder.

Typical file format:

```json
{
  "name": "Lead Gen",
  "version": "1.0.0",
  "targetOrigin": "https://example.com",
  "steps": [],
  "meta": {
    "compiledAt": "2026-04-03T12:00:00.000Z",
    "stepCount": 0,
    "savedAt": "2026-04-03T12:01:00.000Z",
    "source": "mcp"
  }
}
```

## 19. Practical Examples

### 19.1 Minimal pipeline JSON

```json
{
  "name": "Demo",
  "version": "1.0.0",
  "targetOrigin": "https://example.com",
  "steps": [
    {
      "id": "s_1",
      "type": "NAVIGATE",
      "config": {
        "url": "https://example.com",
        "wait": true
      }
    },
    {
      "id": "s_2",
      "type": "WAIT",
      "config": {
        "ms": 1000
      }
    }
  ]
}
```

### 19.2 Extraction pipeline sample

```json
{
  "name": "Extract Products",
  "targetOrigin": "https://example.com",
  "steps": [
    {
      "id": "s_1",
      "type": "NAVIGATE",
      "config": {
        "url": "https://example.com/products"
      }
    },
    {
      "id": "s_2",
      "type": "EXTRACT",
      "config": {
        "fields": [
          {
            "name": "title",
            "selector": "h1"
          },
          {
            "name": "price",
            "selector": ".price"
          }
        ]
      }
    }
  ]
}
```

### 19.3 API sniffing pipeline sample

```json
{
  "name": "Sniff APIs",
  "targetOrigin": "https://example.com",
  "steps": [
    {
      "id": "s_1",
      "type": "API_SNIFFER",
      "config": {
        "enabled": true
      }
    }
  ]
}
```

## 20. Failure Modes and Recovery

Common failure causes:

- no active tab
- missing pipeline
- receiving end not available in content runtime
- blocked by robots or domain lock
- proxy issues
- captcha solve failure
- invalid pipeline JSON upload

Recovery behaviors:

- optional steps are skipped
- partial data is still retrievable
- checkpoints persist progress
- runs can be resumed if incomplete

## 21. Maintenance Rules

If you add a new pipeline step:

1. add it to `STEP_REGISTRY`
2. add handling in the service worker if orchestration is needed
3. add handling in the content runtime if DOM work is needed
4. add it to compiler/emitter support if it must export to scripts
5. document it here

If you add a new message:

1. add the constant in the source module
2. wire sender and receiver
3. document request and response shapes here

If you add a new MCP tool:

1. register it in `mcp/server.mjs`
2. validate inputs with zod
3. document tool input and output here

## 22. Quick Navigation Summary

- Human workflow guide: this document
- Detailed contracts and examples: this document
- Module reference: this document
- MCP tool reference: this document
- Pipeline import/export behavior: this document

This master manual is intended to replace the fragmented documentation set so there is one source of truth for both people and MCP clients.

## 23. Archive / Bin Folder

The repository may contain a `bin/` folder for files that are useful during development but are not part of the shipped extension or MCP source tree.

Typical archive candidates:

- `patch-sw.mjs`
- `patch-export.mjs`
- `test-emit.mjs`
- generated dependency trees such as `mcp/node_modules`

Archive policy:

- keep source modules, manifests, docs, and lockfiles in the main tree
- move temporary patch helpers and throwaway test drivers into `bin/`
- keep generated dependencies out of the main source tree when they can be recreated with `npm install`
- prefer documenting why a file was archived instead of deleting it silently
