// End-to-end checks that drive the side panel the way a person does: clicking
// palette items, filling config inputs, pressing Run.
//
// e2e/run.mjs exercises the worker through its message bus. This file exercises
// the UI on top of it, which is the half a user actually touches.
import test from "node:test";
import assert from "node:assert/strict";
import { launch, startSite } from "./harness.mjs";

const SITE = `<!doctype html><html><head><title>Shop</title></head><body>
  <h1 id="title">Test Shop</h1>
  <ul>
    <li class="row"><a class="link" href="/p/1">Alpha</a><b class="price">$1</b></li>
    <li class="row"><a class="link" href="/p/2">Beta</a><b class="price">$2</b></li>
    <li class="row"><a class="link" href="/p/3">Gamma</a><b class="price">$3</b></li>
    <li class="row"><a class="link" href="/p/4">Delta</a><b class="price">$4</b></li>
  </ul>
  <div id="count">0</div>
  <button id="bump">+</button>
  <script>
    let n = 0;
    document.getElementById('bump').addEventListener('click', () => {
      document.getElementById('count').textContent = String(++n);
    });
  </script>
</body></html>`;

let env;
let site;
let tabId;

test.before(async () => {
  site = await startSite({ "/": SITE });
  env = await launch();

  const page = await env.ctx.newPage();
  await page.goto(site.url("/"));
  tabId = await env.panel.evaluate(
    (url) =>
      new Promise((resolve) => {
        chrome.tabs.query({}, (tabs) =>
          resolve(tabs.find((t) => t.url === url)?.id ?? null),
        );
      }),
    site.url("/"),
  );
});

test.after(async () => {
  await env?.close();
  await site?.close();
});

const step = (type, config, extra = {}) => ({
  id: `s_${type}_${Math.random().toString(36).slice(2, 6)}`,
  type,
  config,
  ...extra,
});

/** Drive the worker, then read what it stored. */
async function runPipeline(steps, { waitMs = 12000 } = {}) {
  const started = await env.send("pipeline:start", {
    tabId,
    targetOrigin: site.origin,
    pipeline: { name: "e2e", steps },
  });
  assert.equal(started.ok, true, JSON.stringify(started));
  const runId = started.result.runId;

  const deadline = Date.now() + waitMs;
  let status = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    const s = await env.send("pipeline:status", { runId });
    if (s.ok && s.result.known && !s.result.active) break;
    if (s.ok) status = s.result;
  }

  const dl = await env.send("data:download", { runId });
  return { runId, status, rows: dl.ok ? (dl.result.rows ?? []) : [] };
}

// ── the panel as a UI ────────────────────────────────────────────────────────

test("the palette opens and its items come from the registry", async () => {
  await env.panel.locator("#btn-master-run").waitFor();

  // The empty board offers a way in.
  const opener = env.panel.locator('[data-action="open-palette"]').first();
  await opener.click();

  const items = env.panel.locator(".palette-item");
  const count = await items.count();
  assert.ok(count >= 15, `only ${count} palette items rendered`);

  const labels = await env.panel
    .locator(".palette-item-label")
    .allTextContents();
  for (const type of ["CLICK", "FILL", "EXTRACT", "LOOP", "EXPORT"]) {
    assert.ok(labels.includes(type), `${type} is missing from the palette`);
  }
});

test("clicking a palette item puts a step on the board", async () => {
  await env.panel.locator('.palette-item[data-type="CLICK"]').click();
  await env.panel.locator(".node-card").first().waitFor({ timeout: 5000 });
  assert.equal(await env.panel.locator(".node-card").count(), 1);
});

test("the board survives a reload, because the step was saved", async () => {
  // Wait for the write to land before reloading. saveState() is fire-and-forget
  // from the click handler, so reloading straight away raced it and failed
  // intermittently — on timing, not on behaviour, which is the worst kind of
  // red.
  // The board is stored per tab — `vq_active_pipeline_<tabId>` (E-13) — so
  // waiting on the bare key waits forever. Wait for whichever key the panel
  // actually wrote.
  await env.panel.waitForFunction(
    () =>
      new Promise((resolve) => {
        chrome.storage.local.get(null, (all) =>
          resolve(
            Object.entries(all).some(
              ([k, v]) =>
                k.startsWith("vq_active_pipeline") &&
                (v?.steps ?? []).length > 0,
            ),
          ),
        );
      }),
    null,
    { timeout: 10000 },
  );
  await env.panel.reload();
  // Generous: this is a cold panel boot, and it shares the machine with
  // whatever else the suite is running.
  await env.panel.locator(".node-card").first().waitFor({ timeout: 20000 });
  assert.equal(await env.panel.locator(".node-card").count(), 1);
});

test("a div-button is reachable by keyboard", async () => {
  // E-09: nav pills, node headers and palette items are divs with click
  // handlers. They now carry a role and a tab stop, and Enter activates them.
  const pill = env.panel.locator('.nav-pill[data-tab="monitor"]');
  assert.equal(await pill.getAttribute("role"), "tab");
  assert.equal(await pill.getAttribute("tabindex"), "0");

  await pill.focus();
  await env.panel.keyboard.press("Enter");
  await env.panel.locator("#view-monitor.active").waitFor({ timeout: 3000 });

  const header = env.panel.locator(".node-header").first();
  assert.equal(await header.getAttribute("role"), "button");
  assert.equal(await header.getAttribute("tabindex"), "0");
});

test("clearing the pipeline asks first, and Cancel means cancel", async () => {
  await env.panel
    .locator('.nav-pill[data-tab="pipeline"]')
    .click()
    .catch(() => {});
  await env.panel.locator("#btn-clear-pipeline").click();

  const dialog = env.panel.locator("text=Clear the pipeline?");
  await dialog.waitFor({ timeout: 3000 });
  assert.match(
    await env.panel.locator("body").textContent(),
    /cannot be undone/,
  );

  await env.panel.locator("button", { hasText: "Cancel" }).first().click();
  assert.equal(
    await env.panel.locator(".node-card").count(),
    1,
    "Cancel left the step alone",
  );
});

test("confirming actually clears it", async () => {
  await env.panel.locator("#btn-clear-pipeline").click();
  await env.panel
    .locator("text=Clear the pipeline?")
    .waitFor({ timeout: 3000 });
  await env.panel.locator("button", { hasText: "Clear" }).last().click();
  await env.panel.waitForTimeout(300);
  assert.equal(await env.panel.locator(".node-card").count(), 0);
});

// ── running, through the worker ──────────────────────────────────────────────

test("a LOOP over elements iterates, with templates resolved per item", async () => {
  const { rows } = await runPipeline([
    step(
      "LOOP",
      { type: "elements", selector: ".row", max: 0 },
      {
        children: [
          step("EXTRACT", {
            fields: [{ name: "name", selector: ".link" }],
          }),
        ],
      },
    ),
  ]);

  // Each iteration is scoped to its own .row, so each yields one name.
  assert.equal(rows.length, 4, `got ${rows.length} rows`);
  assert.deepEqual(rows.map((r) => r.name).sort(), [
    "Alpha",
    "Beta",
    "Delta",
    "Gamma",
  ]);
});

test("a LOOP in count mode repeats a page step exactly N times", async () => {
  const page = env.ctx.pages().find((p) => p.url() === site.url("/"));
  await page.evaluate(() => {
    document.getElementById("count").textContent = "0";
  });

  await runPipeline([
    step(
      "LOOP",
      { type: "count", max: 3 },
      { children: [step("CLICK", { selector: "#bump" })] },
    ),
  ]);

  assert.equal(await page.locator("#count").textContent(), "3");
});

test("a count loop of zero is refused rather than silently doing nothing", async () => {
  const started = await env.send("pipeline:start", {
    tabId,
    targetOrigin: site.origin,
    pipeline: {
      name: "zero",
      steps: [
        step(
          "LOOP",
          { type: "count", max: 0 },
          { children: [step("CLICK", { selector: "#bump" })] },
        ),
      ],
    },
  });
  assert.equal(started.ok, true, "the run starts");

  // The failure surfaces in the run, not at start. Wait for it to end.
  await new Promise((r) => setTimeout(r, 2000));
  const s = await env.send("pipeline:status", { runId: started.result.runId });
  assert.equal(s.ok, true);
  assert.equal(s.result.active, false, "the run ended rather than hanging");
});

// ── pause and resume, on a live run ──────────────────────────────────────────

test("Pause holds a run and Resume releases it", async () => {
  const started = await env.send("pipeline:start", {
    tabId,
    targetOrigin: site.origin,
    pipeline: {
      name: "pausable",
      steps: [
        step("WAIT", { ms: 300 }),
        step("WAIT", { ms: 300 }),
        step("WAIT", { ms: 300 }),
        step("WAIT", { ms: 300 }),
        step("WAIT", { ms: 300 }),
        step("WAIT", { ms: 300 }),
      ],
    },
  });
  assert.equal(started.ok, true, JSON.stringify(started));
  const runId = started.result.runId;

  await new Promise((r) => setTimeout(r, 400));
  const paused = await env.send("pipeline:pause", { runId });
  assert.equal(paused.ok, true);
  assert.equal(paused.result.paused, true);

  // Long enough that an unpaused run would have finished.
  await new Promise((r) => setTimeout(r, 1500));
  let s = await env.send("pipeline:status", { runId });
  assert.equal(s.result.known, true, "the run is still there");
  assert.equal(s.result.active, true, "and still going, i.e. held");
  assert.equal(s.result.paused, true);

  const resumed = await env.send("pipeline:resume", { runId });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.result.paused, false);

  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 200));
    s = await env.send("pipeline:status", { runId });
    if (!s.result.active) break;
  }
  assert.equal(s.result.active, false, "it finished after Resume");
});

test("pausing a run the worker does not have reports failure", async () => {
  const res = await env.send("pipeline:pause", { runId: "run_never_existed" });
  assert.equal(res.ok, true, "the message is handled");
  assert.equal(res.result.ok, false, "but the run is not");
});

// ── export ───────────────────────────────────────────────────────────────────

test("an EXPORT step actually downloads a file", async () => {
  // A-12 lived here: the worker called URL.createObjectURL, which a service
  // worker does not have, so every export failed and downloaded nothing while
  // the unit tests were green.
  await env.panel.evaluate(() => {
    window.__dl = [];
    chrome.downloads.onCreated.addListener((d) => window.__dl.push(d));
  });

  const { rows } = await runPipeline([
    step("EXTRACT", {
      fields: [
        { name: "name", selector: ".link" },
        { name: "price", selector: ".price" },
      ],
    }),
    step("EXPORT", { format: "csv" }),
  ]);
  assert.equal(rows.length, 4, "the rows were stored");

  await new Promise((r) => setTimeout(r, 1000));
  const dl = await env.panel.evaluate(() => window.__dl ?? []);
  assert.ok(dl.length >= 1, "no download was started");
  // onCreated fires before Chrome has settled a filename, so the URL is what
  // there is to check here. The next test reads the bytes it carries.
  assert.match(dl[0].url ?? "", /^data:text\/csv;base64,/);
});

test("the exported bytes are the rows, with a readable BOM", async () => {
  // The download URL carries the payload, so the test can read what was sent
  // rather than trusting that something was.
  const url = await env.panel.evaluate(() => window.__dl?.[0]?.url ?? "");
  assert.match(url, /^data:text\/csv;base64,/);

  const csv = Buffer.from(url.split(",")[1], "base64").toString("utf8");
  assert.ok(csv.startsWith("\uFEFF"), "the BOM survived as real UTF-8");
  const lines = csv
    .replace(/^\uFEFF/, "")
    .trim()
    .split("\n");
  assert.match(lines[0], /name/);
  assert.match(lines[0], /price/);
  assert.equal(lines.length, 5, "header plus four rows");
  assert.match(csv, /Alpha/);
});

test("rows survive as CSV with a header row", async () => {
  const { formatRows } = await import("../exporters/row-formatters.js");
  const { rows } = await runPipeline([
    step("EXTRACT", {
      fields: [
        { name: "name", selector: ".link" },
        { name: "price", selector: ".price" },
      ],
    }),
  ]);
  const clean = rows.map(({ runId: _r, ...rest }) => rest);
  const csv = formatRows(clean, "csv");
  const lines = csv.trim().split("\n");
  assert.match(lines[0], /name/);
  assert.match(lines[0], /price/);
  assert.equal(lines.length, 5, "header plus four rows");
});

// ── rate limiting, observed ──────────────────────────────────────────────────

test("the executor paces a run instead of hammering the page", async () => {
  // F-09: burst of ten, then one acting step per second. Fifteen clicks must
  // therefore take at least ~4s, where an unpaced run finishes almost at once.
  const page = env.ctx.pages().find((p) => p.url() === site.url("/"));
  // Measured as a delta rather than from a reset: a run from an earlier test
  // can still be draining, and this test is about pacing, not isolation.
  const before = Number(await page.locator("#count").textContent());

  const started = Date.now();
  await runPipeline(
    [
      step(
        "LOOP",
        { type: "count", max: 15 },
        { children: [step("CLICK", { selector: "#bump" })] },
      ),
    ],
    { waitMs: 30000 },
  );
  const elapsed = Date.now() - started;

  const after = Number(await page.locator("#count").textContent());
  assert.ok(after - before >= 15, `only ${after - before} clicks landed`);
  assert.ok(
    elapsed >= 3000,
    `15 clicks took ${elapsed}ms — the token bucket is not being consulted`,
  );
});

// ── Detect table, end to end ─────────────────────────────────────────────────

test("the page is read and offered as tables", async () => {
  const res = await env.send("content:detect", { tabId });
  assert.equal(res.ok, true, JSON.stringify(res));

  const { candidates } = res.result;
  assert.ok(candidates.length >= 1, "found no tables on a page full of them");

  const top = candidates[0];
  assert.equal(top.selector, ".row", `picked ${top.selector}`);
  assert.equal(top.count, 4);
  assert.ok(top.fields.length >= 2, "a table needs columns");

  const names = top.fields.map((f) => f.name);
  assert.ok(names.includes("link"), names.join(", "));
  assert.ok(names.includes("price"), names.join(", "));
  assert.ok(
    names.includes("link url"),
    `the href needs its own column: ${names}`,
  );
  assert.equal(new Set(names).size, names.length, `duplicate names: ${names}`);

  // Sample rows are what the user reads to decide.
  assert.equal(top.sampleRows[0].link, "Alpha");
  assert.equal(top.sampleRows[1].link, "Beta");
  assert.equal(top.sampleRows[0]["link url"], "/p/1");
});

test("a detected table scrapes for real, without a selector being typed", async () => {
  // The whole point: from "read the page" to rows in IndexedDB, with the user
  // having chosen a table rather than written a selector.
  const detected = (await env.send("content:detect", { tabId })).result
    .candidates[0];

  const extractFields = detected.fields.map((f) => ({
    name: f.name,
    selector: f.selector,
    type: f.kind === "text" ? "text" : "attribute",
    ...(f.kind === "href" ? { attribute: "href" } : {}),
    ...(f.kind === "src" ? { attribute: "src" } : {}),
  }));

  const { rows } = await runPipeline([
    step(
      "LOOP",
      { type: "elements", selector: detected.selector, max: 0 },
      { children: [step("EXTRACT", { fields: extractFields })] },
    ),
  ]);

  assert.equal(rows.length, 4, `got ${rows.length} rows`);
  const names = rows.map((r) => r.link).sort();
  assert.deepEqual(names, ["Alpha", "Beta", "Delta", "Gamma"]);
  const prices = rows.map((r) => r.price).sort();
  assert.deepEqual(prices, ["$1", "$2", "$3", "$4"]);
});

test("a page with nothing repeating returns no tables, not a bad guess", async () => {
  const page = await env.ctx.newPage();
  await page.setContent(
    "<main><h1 class='t'>One product</h1><div class='p'>$9.99</div></main>",
  );
  const id = await env.panel.evaluate(
    () =>
      new Promise((resolve) => {
        chrome.tabs.query({}, (tabs) =>
          resolve(tabs.find((t) => t.url === "about:blank")?.id ?? null),
        );
      }),
  );
  if (id) {
    const res = await env.send("content:detect", { tabId: id });
    if (res.ok) assert.equal(res.result.candidates.length, 0);
  }
  await page.close();
});

// ── expanding a card ─────────────────────────────────────────────────────────
//
// Two defects lived here. Only one card could be open at a time, so comparing
// two steps' settings — what you are doing when a selector works in one place
// and not another — was impossible. And opening one called renderPipeline(),
// which rebuilds the whole canvas with innerHTML and rebinds every config input
// and drag handler on it, in order to change a `display` rule.
//
// These drive the real panel because that is the only place the claim can be
// settled: reading the source shows a class being toggled, not that the canvas
// survived it.

/** Clear the board and put `n` CLICK steps on it. */
async function _freshSteps(n) {
  await env.panel
    .locator('.nav-pill[data-tab="pipeline"]')
    .click()
    .catch(() => {});
  if ((await env.panel.locator(".node-card").count()) > 0) {
    await env.panel.locator("#btn-clear-pipeline").click();
    await env.panel
      .locator("text=Clear the pipeline?")
      .waitFor({ timeout: 3000 });
    await env.panel.locator("button", { hasText: "Clear" }).last().click();
    await env.panel
      .locator(".node-card")
      .first()
      .waitFor({ state: "detached" });
  }
  for (let i = 0; i < n; i++) {
    await env.panel.locator('[data-action="open-palette"]').first().click();
    await env.panel.locator('.palette-item[data-type="CLICK"]').click();
    await env.panel.locator(".node-card").nth(i).waitFor({ timeout: 5000 });
  }
}

test("more than one step can be open at the same time", async () => {
  await _freshSteps(3);
  const headers = env.panel.locator(".node-header");

  // A newly added step opens itself, so collapse everything first: the claim is
  // that opening is additive, not that three happen to be open.
  for (let i = 0; i < 3; i++) {
    const card = env.panel.locator(".node-card").nth(i);
    if ((await card.getAttribute("class")).includes("expanded")) {
      await headers.nth(i).click();
    }
  }
  assert.equal(await env.panel.locator(".node-card.expanded").count(), 0);

  await headers.nth(0).click();
  await headers.nth(2).click();

  assert.equal(
    await env.panel.locator(".node-card.expanded").count(),
    2,
    "opening a second card closed the first",
  );

  // And closing one must delete a single id rather than reset the set, which
  // would close everything as a side effect of closing one.
  await headers.nth(0).click();
  assert.equal(await env.panel.locator(".node-card.expanded").count(), 1);
});

test("opening a card does not rebuild the canvas", async () => {
  // The proof: put a property on a DOM node that exists only in memory, then
  // toggle. innerHTML would replace the node and take the property with it, so
  // if it survives, nothing was rebuilt.
  await env.panel.evaluate(() => {
    document
      .querySelectorAll(".node-card")
      .forEach((el, i) => (el.__survivedRebuild = `card-${i}`));
  });

  await env.panel.locator(".node-header").nth(0).click();
  await env.panel.locator(".node-header").nth(1).click();

  assert.deepEqual(
    await env.panel.evaluate(() =>
      [...document.querySelectorAll(".node-card")].map(
        (el) => el.__survivedRebuild ?? null,
      ),
    ),
    ["card-0", "card-1", "card-2"],
    "the canvas was rebuilt in order to open a card",
  );
});

test("adding a step does not send a scrolled board back to the top", async () => {
  // renderPipeline is still right for a structural change, but the redraw used
  // to discard the scrolled position along with the nodes, sending someone who
  // added a step at step 20 back to step 1.
  //
  // The viewport is shrunk rather than the board lengthened: twenty palette
  // clicks would cost more than the rest of this file, and the assertion is
  // about scrollTop surviving a redraw, not about how the overflow arose.
  const scrolled = await env.panel.evaluate(() => {
    const vp = document.getElementById("board-viewport");
    vp.style.height = "90px";
    vp.style.minHeight = "90px";
    vp.scrollTop = vp.scrollHeight;
    return vp.scrollTop;
  });
  assert.ok(scrolled > 0, "the board did not become scrollable");

  await env.panel.locator('[data-action="open-palette"]').last().click();
  await env.panel.locator('.palette-item[data-type="WAIT"]').click();
  await env.panel.locator(".node-card").nth(3).waitFor({ timeout: 5000 });

  const after = await env.panel.evaluate(
    () => document.getElementById("board-viewport").scrollTop,
  );
  assert.ok(
    after >= scrolled,
    `the board jumped on redraw (${scrolled} to ${after})`,
  );

  await env.panel.evaluate(() => {
    const vp = document.getElementById("board-viewport");
    vp.style.height = "";
    vp.style.minHeight = "";
  });
});

// ── settings sections must not be squashed ───────────────────────────────────
//
// The Settings view is a flex column, so each accordion section inherited
// flex-shrink: 1 and gave up height rather than overflowing. Open two of them
// and every section was squeezed slightly, while `overflow: hidden` on the
// section sliced the bottom off whichever ran past its shrunk height — the AI
// Gateway's Save and Test Connection buttons were cut in half.
//
// The part that made it a bug rather than a blemish: because nothing
// overflowed, the view's own `overflow-y: auto` had nothing to scroll and no
// scrollbar appeared, so those buttons could not be reached at all.
test("two open settings sections overflow into a scroll, not into each other", async () => {
  await env.panel.setViewportSize({ width: 400, height: 700 });
  await env.panel.locator('.nav-pill[data-tab="config"]').click();

  for (const name of ["CAPTCHA SOLVER", "AI GATEWAY"]) {
    const header = env.panel
      .locator("#view-config .accordion-header", { hasText: name })
      .first();
    if (
      !(await header.locator("xpath=..").getAttribute("class"))?.includes(
        "open",
      )
    ) {
      await header.click();
    }
  }
  await env.panel.waitForTimeout(200);

  // No section may clip its own content. This is the squash, measured.
  const clipped = await env.panel.evaluate(() =>
    [...document.querySelectorAll("#view-config .accordion-section")]
      .filter((el) => el.scrollHeight > el.clientHeight + 1)
      .map((el) => el.querySelector(".accordion-header")?.textContent?.trim()),
  );
  assert.deepEqual(
    clipped,
    [],
    "a settings section is cutting off its content",
  );

  // And the content that no longer fits has to be reachable.
  const view = await env.panel.evaluate(() => {
    const v = document.getElementById("view-config");
    return { scrollH: v.scrollHeight, clientH: v.clientHeight };
  });
  assert.ok(
    view.scrollH > view.clientH,
    "the settings view did not become scrollable, so the overflow is unreachable",
  );

  // The button the report was actually about.
  const btn = env.panel.locator("#btn-gateway-test");
  await btn.scrollIntoViewIfNeeded();
  await btn.click({ trial: true });
});
