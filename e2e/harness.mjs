// Launches Chromium with the extension loaded, and hands tests the pieces they
// need: the service worker, the side panel as a page, and a local site to run
// pipelines against.
//
// This is the layer the 442 unit tests cannot reach. They mock `chrome`, jsdom
// the DOM, and fake IndexedDB — which proves the logic and proves nothing about
// whether Chrome will load the manifest, whether on-demand injection works, or
// whether a step reaches a real page.
import { chromium } from "playwright";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

const EXT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

/**
 * A local site to point pipelines at. Real HTTP, real origin, real navigation —
 * data: and file: URLs behave differently enough to be worthless here.
 *
 * @param {Record<string,string>} routes - path → HTML
 */
export async function startSite(routes) {
  const server = http.createServer((req, res) => {
    const path = req.url.split("?")[0];
    if (path === "/robots.txt") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(routes["/robots.txt"] ?? "User-agent: *\nDisallow:\n");
      return;
    }
    const body = routes[path];
    if (body === undefined) {
      res.writeHead(404, { "Content-Type": "text/html" });
      res.end("<h1>404</h1>");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    url: (p) => `http://127.0.0.1:${port}${p}`,
    /**
     * `server.close()` alone stops accepting and then waits for every open
     * connection to end. Chrome holds its keep-alive sockets open long after
     * the page using them is gone, so the wait was the test: the work in a
     * challenge took under a second and the test took seventy, all of it here,
     * and it grew with every challenge that had left sockets behind. The
     * sockets are dropped first, then the server closes immediately.
     */
    close: () =>
      new Promise((r) => {
        server.closeAllConnections?.();
        server.close(r);
      }),
  };
}

/**
 * Launch Chromium with the extension loaded.
 *
 * `npm run e2e` passes --test-concurrency=1: each file launches its own browser
 * with its own profile, and two of them competing for the machine made the
 * panel checks fail intermittently on timing rather than on behaviour. A flaky
 * suite is worse than a slow one — it teaches you to re-run instead of to look.
 */
export async function launch() {
  const userDataDir = await mkdtemp(join(tmpdir(), "vq-e2e-"));
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    executablePath: CHROME,
    headless: true,
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      "--no-sandbox",
    ],
  });

  const consoleErrors = [];
  ctx.on("weberror", (e) => consoleErrors.push(String(e.error())));

  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 20000 });
  const extensionId = new URL(sw.url()).host;

  /**
   * Send a message to the service worker's bus, the way the panel does.
   *
   * Sent from an extension page rather than from `sw.evaluate`, because the
   * worker can be terminated between calls and a page survives that — which is
   * also how the real panel talks to it.
   */
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel/index.html`);
  await page.waitForLoadState("domcontentloaded");

  const send = (type, payload) =>
    page.evaluate(
      ([t, p]) =>
        new Promise((resolve) => {
          chrome.runtime.sendMessage({ type: t, payload: p }, (res) =>
            resolve(
              chrome.runtime.lastError
                ? { ok: false, error: chrome.runtime.lastError.message }
                : res,
            ),
          );
        }),
      [type, payload ?? {}],
    );

  return {
    ctx,
    sw,
    extensionId,
    panel: page,
    send,
    consoleErrors,
    async close() {
      await ctx.close().catch(() => {});
      await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    },
  };
}
