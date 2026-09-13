// The MCP runner, proved by running it.
//
// The tests in mcp-server.test.mjs pin the runner's *shape* — that it emits the
// pipeline's own script rather than growing a second step engine, that it
// refuses what it cannot run before launching anything. None of that is
// evidence it scrapes. This file launches a real browser against a real page
// and checks the rows that come back, because "MCP cannot scrape" was the
// finding and only rows close it.
//
// Skipped, loudly, when Playwright has no browser on this machine: a test that
// silently passes because it never ran is worse than one that is missing.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm, readdir, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compilePipeline } from "../script-gen/pipeline-compiler.js";
import { emitNode } from "../script-gen/node-emitter.js";

// fileURLToPath, not .pathname: on Windows the latter keeps a leading slash
// ("/D:/a/Verquill"), which is not a directory any process can chdir into.
const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** The same search the MCP runner does, so the two agree about what exists. */
async function findBrowser() {
  if (process.env.FS_BROWSER_PATH) return process.env.FS_BROWSER_PATH;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!base) return null;
  let dirs = [];
  try {
    dirs = await readdir(base);
  } catch {
    return null;
  }
  for (const d of dirs.filter((x) => x.startsWith("chromium-")).sort()) {
    const candidate = join(base, d, "chrome-linux/chrome");
    try {
      await access(candidate);
      return candidate;
    } catch {
      // next
    }
  }
  return null;
}

const browser = await findBrowser();

test(
  "a pipeline run through the emitted script returns the page's rows",
  { skip: browser ? false : "no Playwright browser on this machine" },
  async () => {
    const site = http.createServer((_q, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        `<table><tbody>
        <tr><td class="t">Widget</td><td class="p">10.00</td></tr>
        <tr><td class="t">Gadget</td><td class="p">25.50</td></tr>
        <tr><td class="t">Gizmo</td><td class="p">7.10</td></tr>
      </tbody></table>`,
      );
    });
    await new Promise((r) => site.listen(0, "127.0.0.1", r));
    const origin = `http://127.0.0.1:${site.address().port}`;
    const dir = await mkdtemp(join(tmpdir(), "fs-mcp-"));

    try {
      const { ast } = compilePipeline({
        name: "live",
        steps: [
          { id: "s1", type: "WEBSITE", config: { url: origin } },
          {
            id: "s2",
            type: "LOOP",
            config: { type: "elements", selector: "tr", max: 10 },
            children: [
              {
                id: "s3",
                type: "EXTRACT",
                config: {
                  fields: [
                    { name: "title", selector: ".t" },
                    { name: "price", selector: ".p" },
                  ],
                },
              },
            ],
          },
        ],
      });

      // Written under the repo, because the script imports playwright and Node
      // resolves that from the script's own location.
      const file = join(ROOT, `.fs-mcp-runs-test-${Date.now()}.mjs`);
      await writeFile(file, emitNode(ast), "utf8");
      const out = await new Promise((resolve) => {
        const child = spawn(process.execPath, [file], {
          cwd: ROOT,
          env: { ...process.env, FS_BROWSER_PATH: browser },
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => (stdout += d));
        child.stderr.on("data", (d) => (stderr += d));
        child.on("close", (code) => resolve({ code, stdout, stderr }));
      });
      await rm(file, { force: true });

      assert.equal(
        out.code,
        0,
        `the script failed:\n${out.stderr.slice(0, 800)}`,
      );
      const rows = out.stdout
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("{"))
        .map((l) => JSON.parse(l));

      assert.deepEqual(rows, [
        { title: "Widget", price: "10.00" },
        { title: "Gadget", price: "25.50" },
        { title: "Gizmo", price: "7.10" },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await new Promise((r) => site.close(r));
    }
  },
);
