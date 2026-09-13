import fs from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { z } from "zod";

import {
  compilePipeline,
  serializePipeline,
  findUnexportableSteps,
  findUnresolvedTemplates,
  redactSecrets,
} from "../script-gen/pipeline-compiler.js";
import { emitPython } from "../script-gen/python-emitter.js";
import { emitNode } from "../script-gen/node-emitter.js";
import { checkRobots } from "../ethics/robots-parser.js";
import { ALL_STEP_TYPES } from "../utils/step-types.js";
import { VERSION } from "../utils/version.js";
import {
  formatRows,
  defaultFilename as rowFilename,
} from "../exporters/row-formatters.js";
import {
  scanRows,
  scanText,
  summarizeFindings,
} from "../ethics/pii-detector.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(__dirname, "..");
const ROOT = resolveRootFromArgs(process.argv.slice(2)) ?? DEFAULT_ROOT;
const TRANSPORT_MODE =
  resolveArgValue(process.argv.slice(2), "--transport") ??
  process.env.MCP_TRANSPORT ??
  "stdio";
const HTTP_PORT = Number(
  resolveArgValue(process.argv.slice(2), "--port") ?? process.env.PORT ?? 3000,
);

// Loopback by default. The previous app.listen(HTTP_PORT) bound every
// interface, so the server was reachable from the local network with no
// authentication at all — while repo_write_file was a registered tool.
const HTTP_HOST =
  resolveArgValue(process.argv.slice(2), "--host") ??
  process.env.HOST ??
  "127.0.0.1";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * Whether tools that modify the workspace may run.
 *
 * Over stdio the client is a process the user started, so writes are allowed.
 * Over HTTP anyone who can reach the port is the client, so they are refused
 * unless explicitly enabled.
 */
const WRITES_ALLOWED =
  TRANSPORT_MODE === "stdio" || process.argv.slice(2).includes("--allow-write");
const PIPELINES_DIR = path.join(ROOT, "pipelines");
const httpSessions = new Map();
const httpSessionServers = new Map();

const server = new McpServer({
  name: "verquill-v3",
  version: VERSION,
});
const toolDefinitions = [];
const registerTool = server.tool.bind(server);

server.tool = (...args) => {
  toolDefinitions.push(args);
  return registerTool(...args);
};

function createServerInstance() {
  const instance = new McpServer({
    name: "verquill-v3",
    version: VERSION,
  });

  for (const [name, description, inputSchema, handler] of toolDefinitions) {
    instance.tool(name, description, inputSchema, handler);
  }

  return instance;
}

// Derived from the shared vocabulary rather than hand-maintained. The old
// hardcoded list was missing 11 real step types — pipeline_validate reported
// FILL and AUTO_EXTRACT as "unsupported" for pipelines the UI had just built —
// and listed FORM_FILL, which is not a step type at all.
const supportedStepTypes = new Set(ALL_STEP_TYPES);

server.tool(
  "repo_list_files",
  "List files and folders inside the Verquill workspace.",
  {
    directory: z.string().optional(),
    maxDepth: z.number().int().min(0).max(10).optional(),
  },
  async ({ directory = ".", maxDepth = 3 }) => {
    const baseDir = resolveWorkspacePath(directory);
    const entries = await listTree(baseDir, maxDepth);
    return textResult({ root: ROOT, directory, maxDepth, entries });
  },
);

server.tool(
  "repo_read_file",
  "Read a text file from the workspace with optional line bounds.",
  {
    path: z.string(),
    startLine: z.number().int().min(1).optional(),
    endLine: z.number().int().min(1).optional(),
  },
  async ({ path: filePath, startLine = 1, endLine }) => {
    const resolved = resolveWorkspacePath(filePath);
    const content = await fs.readFile(resolved, "utf8");
    const lines = content.split(/\r?\n/);
    const start = Math.max(1, startLine);
    const finish = Math.min(endLine ?? lines.length, lines.length);
    const slice = lines.slice(start - 1, finish);
    return textResult({
      path: toWorkspaceRelative(resolved),
      startLine: start,
      endLine: finish,
      content: slice.join("\n"),
    });
  },
);

server.tool(
  "repo_write_file",
  "Write a text file within the workspace.",
  {
    path: z.string(),
    content: z.string(),
  },
  async ({ path: filePath, content }) => {
    assertWritesAllowed("repo_write_file");
    const resolved = resolveWorkspacePath(filePath);
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, content, "utf8");
    return textResult({
      path: toWorkspaceRelative(resolved),
      bytesWritten: Buffer.byteLength(content, "utf8"),
    });
  },
);

server.tool(
  "repo_search_text",
  "Search the workspace for a literal string or regular expression.",
  {
    query: z.string(),
    regex: z.boolean().optional(),
    caseSensitive: z.boolean().optional(),
    include: z
      .string()
      .optional()
      .describe(
        'Directory to search under, relative to the workspace root (e.g. "content"). Not a glob — use filePattern to filter file names.',
      ),
    filePattern: z
      .string()
      .optional()
      .describe(
        'Regular expression matched against each file\'s workspace-relative path, e.g. "\\.mjs$".',
      ),
    maxResults: z.number().int().min(1).max(200).optional(),
  },
  async ({
    query,
    regex = false,
    caseSensitive = false,
    include = ".",
    filePattern,
    maxResults = 50,
  }) => {
    // `include` was described only as an optional string and passed straight to
    // resolveWorkspacePath, so anyone who reasonably tried "**/*.js" got an
    // unhelpful path error (G-07). Say so, and offer the thing they wanted.
    if (/[*?[\]]/.test(include)) {
      throw new Error(
        `include is a directory, not a glob (got "${include}"). Use include for the directory and filePattern for a file-name regular expression.`,
      );
    }

    let nameFilter = null;
    if (filePattern) {
      try {
        nameFilter = new RegExp(filePattern);
      } catch (err) {
        throw new Error(
          `filePattern is not a valid regular expression: ${err.message}`,
        );
      }
    }

    const literal = caseSensitive ? query : query.toLowerCase();
    const matches = [];
    const files = await collectFiles(resolveWorkspacePath(include));

    for (const file of files) {
      if (matches.length >= maxResults) break;
      if (nameFilter && !nameFilter.test(toWorkspaceRelative(file))) continue;
      const content = await safeReadText(file);
      if (content == null) continue;
      // Built per file. One /g regex shared across the loop happened to work
      // with String.match, which resets lastIndex — but it is one edit away
      // from being a bug that skips matches (G-08).
      const needle = regex
        ? new RegExp(query, caseSensitive ? "g" : "gi")
        : null;
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const haystack = caseSensitive ? line : line.toLowerCase();
        const hit = regex
          ? line.match(needle)
          : haystack.includes(literal)
            ? [query]
            : null;
        if (!hit) continue;
        matches.push({
          path: toWorkspaceRelative(file),
          line: i + 1,
          excerpt: line.trim(),
        });
        if (matches.length >= maxResults) break;
      }
    }

    return textResult({
      query,
      regex,
      caseSensitive,
      include,
      maxResults,
      matches,
    });
  },
);

server.tool(
  "pdf_extract_text",
  "Extract text from a PDF file (local path, HTTP/HTTPS URL, or uploaded base64 payload).",
  {
    source: z.string().optional(),
    fileBase64: z.string().optional(),
    fileName: z.string().optional(),
    maxPages: z.number().int().min(1).max(1000).optional(),
    joinPages: z.boolean().optional(),
  },
  async ({ source, fileBase64, fileName, maxPages = 50, joinPages = true }) => {
    const { bytes, resolvedSource } = await readPdfBytes({
      source,
      fileBase64,
      fileName,
    });
    const doc = await getDocument({ data: bytes, disableWorker: true }).promise;
    const pageCount = doc.numPages;
    const limit = Math.min(pageCount, maxPages);

    const pages = [];
    for (let pageNo = 1; pageNo <= limit; pageNo++) {
      const page = await doc.getPage(pageNo);
      const textContent = await page.getTextContent();
      const text = textContent.items
        .map((item) => item?.str ?? "")
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();

      pages.push({ page: pageNo, text, chars: text.length });
    }

    return textResult({
      source: resolvedSource,
      pageCount,
      extractedPages: limit,
      truncated: limit < pageCount,
      pages,
      text: joinPages ? pages.map((p) => p.text).join("\n\n") : undefined,
    });
  },
);

server.tool(
  "pipeline_compile",
  "Compile a Verquill pipeline recipe into an AST.",
  {
    recipeJson: z.string().optional(),
    recipe: z.any().optional(),
  },
  async ({ recipeJson, recipe }) => {
    const input = recipe ?? parseMaybeJson(recipeJson) ?? null;
    const result = compilePipeline(input);
    return textResult(result);
  },
);

server.tool(
  "pipeline_validate",
  "Validate a pipeline recipe and report unsupported step types.",
  {
    recipeJson: z.string().optional(),
    recipe: z.any().optional(),
  },
  async ({ recipeJson, recipe }) => {
    const input = recipe ?? parseMaybeJson(recipeJson) ?? null;
    const compiled = compilePipeline(input);
    const flattened = flattenSteps(input?.steps ?? []);
    const unsupported = flattened
      .filter(
        (step) =>
          step.type && !supportedStepTypes.has(String(step.type).toUpperCase()),
      )
      .map((step) => ({ id: step.id ?? null, type: step.type }));

    const warnings = [];
    if (!input?.targetOrigin) warnings.push("targetOrigin is missing.");
    if (flattened.length === 0) warnings.push("No steps were provided.");
    if (unsupported.length > 0)
      warnings.push(
        `Unsupported step types: ${unsupported.map((step) => step.type).join(", ")}`,
      );

    return textResult({
      errors: compiled.errors,
      warnings,
      unsupportedSteps: unsupported,
      stepCount: flattened.length,
      ok: compiled.errors.length === 0 && unsupported.length === 0,
    });
  },
);

server.tool(
  "pipeline_list",
  "List saved pipeline files from the reusable pipelines folder.",
  {
    directory: z.string().optional(),
    recursive: z.boolean().optional(),
    maxDepth: z.number().int().min(0).max(10).optional(),
  },
  async ({ directory = "pipelines", recursive = true, maxDepth = 4 }) => {
    const resolvedDir = resolveWorkspacePath(directory);
    const entries = await listPipelineFiles(resolvedDir, {
      recursive,
      maxDepth,
    });
    return textResult({ root: ROOT, directory, recursive, maxDepth, entries });
  },
);

server.tool(
  "pipeline_save",
  "Save a pipeline recipe to disk so it can be reused later.",
  {
    name: z.string().optional(),
    path: z.string().optional(),
    recipeJson: z.string().optional(),
    recipe: z.any().optional(),
    overwrite: z.boolean().optional(),
  },
  async ({
    name,
    path: relativePath,
    recipeJson,
    recipe,
    overwrite = false,
  }) => {
    assertWritesAllowed("pipeline_save");
    const input = recipe ?? parseMaybeJson(recipeJson) ?? null;
    const { ast, errors } = compilePipeline(input);
    if (!ast) return textResult({ errors });

    const targetPath = resolvePipelinePath(relativePath ?? name ?? ast.name);
    if (!overwrite) {
      try {
        await fs.access(targetPath);
        return textResult({
          errors: [
            `Pipeline already exists at ${toWorkspaceRelative(targetPath)}. Set overwrite=true to replace it.`,
          ],
        });
      } catch {
        // file does not exist
      }
    }

    const record = {
      ...ast,
      meta: {
        ...ast.meta,
        savedAt: new Date().toISOString(),
        source: "mcp",
      },
    };

    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, JSON.stringify(record, null, 2), "utf8");
    return textResult({
      path: toWorkspaceRelative(targetPath),
      saved: true,
      name: record.name,
      stepCount: record.meta.stepCount,
    });
  },
);

server.tool(
  "pipeline_load",
  "Load a saved pipeline file back into the conversation.",
  {
    path: z.string().optional(),
    name: z.string().optional(),
  },
  async ({ path: relativePath, name }) => {
    const targetPath = resolvePipelinePath(relativePath ?? name);
    const content = await fs.readFile(targetPath, "utf8");
    const pipeline = JSON.parse(content);
    const compiled = compilePipeline(pipeline);
    return textResult({
      path: toWorkspaceRelative(targetPath),
      pipeline,
      errors: compiled.errors,
    });
  },
);

server.tool(
  "pipeline_serialize",
  "Serialize a pipeline with sensitive values redacted.",
  {
    pipelineJson: z.string().optional(),
    pipeline: z.any().optional(),
  },
  async ({ pipelineJson, pipeline }) => {
    const input = pipeline ?? parseMaybeJson(pipelineJson) ?? null;
    return textResult({ serialized: serializePipeline(input) });
  },
);

server.tool(
  "pipeline_emit_python",
  "Compile a pipeline recipe and emit a Python automation script.",
  {
    recipeJson: z.string().optional(),
    recipe: z.any().optional(),
  },
  async ({ recipeJson, recipe }) => {
    const input = recipe ?? parseMaybeJson(recipeJson) ?? null;
    const { ast, errors } = compilePipeline(input);
    if (!ast) return textResult({ errors });
    // Same order and same treatment as the extension's script:export handler,
    // so both surfaces produce the same file: scan for templates first, then
    // rewrite credentials into environment markers the script resolves at run
    // time (B-14, B-16).
    const templates = findUnresolvedTemplates(ast);
    const secrets = redactSecrets(ast);
    return textResult({
      errors,
      unexportable: findUnexportableSteps(ast),
      unresolvedTemplates: templates,
      secrets,
      code: emitPython(ast),
    });
  },
);

server.tool(
  "pipeline_emit_node",
  "Compile a pipeline recipe and emit a Node automation script.",
  {
    recipeJson: z.string().optional(),
    recipe: z.any().optional(),
  },
  async ({ recipeJson, recipe }) => {
    const input = recipe ?? parseMaybeJson(recipeJson) ?? null;
    const { ast, errors } = compilePipeline(input);
    if (!ast) return textResult({ errors });
    // Same order and same treatment as the extension's script:export handler,
    // so both surfaces produce the same file: scan for templates first, then
    // rewrite credentials into environment markers the script resolves at run
    // time (B-14, B-16).
    const templates = findUnresolvedTemplates(ast);
    const secrets = redactSecrets(ast);
    return textResult({
      errors,
      unexportable: findUnexportableSteps(ast),
      unresolvedTemplates: templates,
      secrets,
      code: emitNode(ast),
    });
  },
);

/**
 * Where a run's script and its output go.
 *
 * Under the repo rather than the system temp directory, for one reason that
 * matters more than tidiness: the emitted script does `import { chromium } from
 * "playwright"`, and Node resolves that from the script's own location. A file
 * in /tmp resolves nothing.
 */
const RUN_DIR = path.join(ROOT, ".vq-mcp-runs");

/**
 * A browser for the emitted script to drive, when the environment has not
 * named one.
 *
 * Headless Playwright reaches for a separate "headless shell" build by default,
 * so a machine carrying full Chromium but not that variant fails at launch with
 * a message about installing browsers. Looking for what is actually there costs
 * one directory read and saves that entirely; finding nothing is fine, because
 * the script's own default then applies and the failure is reported with the
 * install command.
 */
async function _findBrowser() {
  if (process.env.VQ_BROWSER_PATH) return process.env.VQ_BROWSER_PATH;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!base) return null;
  let entries = [];
  try {
    entries = await fs.readdir(base);
  } catch {
    return null;
  }
  for (const dir of entries.filter((d) => d.startsWith("chromium-")).sort()) {
    for (const rel of [
      "chrome-linux/chrome",
      "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
      "chrome-win/chrome.exe",
    ]) {
      const candidate = path.join(base, dir, rel);
      try {
        await fs.access(candidate);
        return candidate;
      } catch {
        // Try the next layout.
      }
    }
  }
  return null;
}

/** One JSON object per line is what the emitted script prints per row. */
function _rowsFromStdout(stdout) {
  const rows = [];
  const noise = [];
  for (const line of String(stdout).split("\n")) {
    const text = line.trim();
    if (!text) continue;
    if (text.startsWith("{") || text.startsWith("[")) {
      try {
        rows.push(JSON.parse(text));
        continue;
      } catch {
        // Not a row after all — a log line that happens to start with a brace.
      }
    }
    noise.push(text);
  }
  return { rows, noise };
}

server.tool(
  "pipeline_run",
  "Run a pipeline and return the rows it scraped. Requires playwright to be installed.",
  {
    recipeJson: z.string().optional(),
    recipe: z.any().optional(),
    timeoutMs: z.number().int().min(1000).max(600000).optional(),
    keepScript: z.boolean().optional(),
  },
  async ({ recipeJson, recipe, timeoutMs = 120000, keepScript = false }) => {
    const input = recipe ?? parseMaybeJson(recipeJson) ?? null;
    const { ast, errors } = compilePipeline(input);
    if (!ast) return textResult({ ok: false, errors });

    // Refused before anything launches, not discovered halfway through. A step
    // with no standalone equivalent emits a throw, so running first would burn
    // a browser launch to arrive at a message we already have.
    const unexportable = findUnexportableSteps(ast);
    if (unexportable.length) {
      return textResult({
        ok: false,
        reason: "this pipeline contains steps a standalone script cannot run",
        unexportable,
        hint:
          "Those steps are extension-only — the sniffer needs the browser's " +
          "own network hooks, and answering a challenge needs a person. Run " +
          "the pipeline in the extension, or take those steps out.",
      });
    }
    const unresolved = findUnresolvedTemplates(ast);
    if (unresolved.length) {
      return textResult({
        ok: false,
        reason: "this pipeline has templates nothing will fill in at run time",
        unresolvedTemplates: unresolved,
      });
    }

    // The script *is* the runner. There is no second step engine here on
    // purpose: a pipeline executed by its own emitted script cannot silently
    // mean something different from the script the user exports, and the one
    // definition of what a step does stays in one place. It also means this
    // tool inherits the emitters' limits exactly, which is the honest bargain.
    const secrets = redactSecrets(ast);
    const code = emitNode(ast);
    await fs.mkdir(RUN_DIR, { recursive: true });
    const scriptPath = path.join(
      RUN_DIR,
      `run_${randomUUID().slice(0, 8)}.mjs`,
    );
    await fs.writeFile(scriptPath, code, "utf8");

    const browserPath = await _findBrowser();
    const started = Date.now();
    let out;
    try {
      out = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [scriptPath], {
          cwd: ROOT,
          env: browserPath
            ? { ...process.env, VQ_BROWSER_PATH: browserPath }
            : process.env,
        });
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(
            new Error(
              `the run passed ${Math.round(timeoutMs / 1000)}s and was stopped`,
            ),
          );
        }, timeoutMs);
        child.stdout.on("data", (d) => (stdout += d));
        child.stderr.on("data", (d) => (stderr += d));
        child.on("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve({ code, stdout, stderr });
        });
      });
    } catch (err) {
      if (!keepScript) await fs.rm(scriptPath, { force: true });
      return textResult({ ok: false, error: err.message });
    }

    if (!keepScript) await fs.rm(scriptPath, { force: true });
    const { rows, noise } = _rowsFromStdout(out.stdout);
    const missingPlaywright = /Cannot find package 'playwright'/.test(
      out.stderr,
    );

    return textResult({
      ok: out.code === 0,
      rowCount: rows.length,
      rows,
      elapsedMs: Date.now() - started,
      exitCode: out.code,
      // Kept apart from the rows so a log line can never be mistaken for data.
      log: noise.slice(0, 40),
      stderr: String(out.stderr).slice(0, 4000),
      ...(missingPlaywright
        ? {
            hint:
              "The generated script needs Playwright. Install it in this " +
              "repository (`npm install playwright && npx playwright install " +
              "chromium`) and run this again.",
          }
        : {}),
      // Named, never valued: a credential moved into an environment marker is
      // still a credential (C-03, B-16).
      secretsMovedToEnv: secrets,
      ...(browserPath ? { browser: browserPath } : {}),
      ...(keepScript ? { scriptPath } : {}),
    });
  },
);

server.tool(
  "pii_scan_text",
  "Scan plain text for common PII patterns.",
  {
    text: z.string(),
    limit: z.number().int().min(1).max(200).optional(),
  },
  async ({ text, limit = 50 }) => {
    const findings = scanText(text).slice(0, limit);
    return textResult({ findings, summary: summarizeFindings(findings) });
  },
);

server.tool(
  "pii_scan_rows",
  "Scan rows for common PII patterns.",
  {
    rowsJson: z.string().optional(),
    rows: z.any().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  },
  async ({ rowsJson, rows, limit = 50 }) => {
    const input = rows ?? parseMaybeJson(rowsJson) ?? [];
    const findings = scanRows(Array.isArray(input) ? input : [], limit);
    return textResult({ findings, summary: summarizeFindings(findings) });
  },
);

server.tool(
  "robots_check",
  "Check whether a path is allowed by robots.txt for an origin.",
  {
    origin: z.string(),
    path: z.string(),
    userAgent: z.string().optional(),
  },
  async ({ origin, path: targetPath, userAgent }) => {
    const result = await checkRobots(origin, targetPath, userAgent);
    return textResult(result);
  },
);

server.tool(
  "rows_to_text",
  "Render rows as CSV, JSON, JSONL, TSV, XML, or Markdown text.",
  {
    rowsJson: z.string(),
    format: z.enum(["csv", "json", "jsonl", "tsv", "xml", "markdown"]),
    filename: z.string().optional(),
  },
  async ({ rowsJson, format, filename }) => {
    const rows = parseMaybeJson(rowsJson) ?? [];
    const text = renderRows(rows, format);
    return textResult({
      format,
      filename: filename ?? defaultFilename(format),
      text,
    });
  },
);

server.tool(
  "pipeline_report",
  "Summarize the pipeline and the generated artifacts in one response.",
  {
    recipeJson: z.string().optional(),
    recipe: z.any().optional(),
  },
  async ({ recipeJson, recipe }) => {
    const input = recipe ?? parseMaybeJson(recipeJson) ?? null;
    const compiled = compilePipeline(input);
    const flattened = flattenSteps(input?.steps ?? []);
    const report = {
      root: ROOT,
      name: compiled.ast?.name ?? input?.name ?? "Untitled",
      targetOrigin: compiled.ast?.targetOrigin ?? input?.targetOrigin ?? "",
      stepCount: flattened.length,
      errors: compiled.errors,
      // This used to emit both scripts in full purely to measure .length and
      // throw them away (G-06) — two complete code generations per call, for a
      // byte count nobody can act on. What a caller actually needs to know is
      // what the export will not carry.
      unexportable: compiled.ast ? findUnexportableSteps(compiled.ast) : [],
      unresolvedTemplates: compiled.ast
        ? findUnresolvedTemplates(compiled.ast)
        : [],
    };
    return textResult(report);
  },
);

async function main() {
  if (TRANSPORT_MODE === "stdio" || TRANSPORT_MODE === "both") {
    const stdioServer = createServerInstance();
    await stdioServer.connect(new StdioServerTransport());
  }

  if (TRANSPORT_MODE === "http" || TRANSPORT_MODE === "both") {
    await startHttpServer();
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      level: "error",
      message: error?.message ?? String(error),
    }),
  );
  process.exit(1);
});

function resolveRootFromArgs(args) {
  const value = resolveArgValue(args, "--root");
  return value ? path.resolve(value) : null;
}

/**
 * Read `--name=value` or `--name value`.
 *
 * Only the `=` form used to be accepted, while the README documents the
 * space-separated form — so following the README silently ignored --root and
 * rooted the server at the repository directory instead.
 *
 * @param {string[]} args
 * @param {string} name - flag name, with or without a trailing "="
 */
function resolveArgValue(args, name) {
  const flag = name.endsWith("=") ? name.slice(0, -1) : name;

  const inline = args.find((arg) => arg.startsWith(`${flag}=`));
  if (inline) {
    const value = inline.slice(flag.length + 1).trim();
    if (value) return value;
  }

  const index = args.indexOf(flag);
  if (index !== -1) {
    const next = args[index + 1];
    if (next && !next.startsWith("--")) return next.trim() || null;
  }

  return null;
}

function assertWritesAllowed(toolName) {
  if (WRITES_ALLOWED) return;
  throw new Error(
    `${toolName} is disabled: this server is running over HTTP, where any client ` +
      `that can reach the port could modify the workspace. Restart with ` +
      `--allow-write to enable it.`,
  );
}

function resolveWorkspacePath(targetPath) {
  const resolved = path.resolve(ROOT, targetPath);
  const rootWithSep = ROOT.endsWith(path.sep) ? ROOT : `${ROOT}${path.sep}`;
  if (resolved !== ROOT && !resolved.startsWith(rootWithSep)) {
    throw new Error(`Path escapes workspace root: ${targetPath}`);
  }
  return resolved;
}

function toWorkspaceRelative(resolvedPath) {
  const rel = path.relative(ROOT, resolvedPath);
  return rel || ".";
}

function resolvePipelinePath(target) {
  const raw = String(target ?? "").trim();
  if (!raw) {
    throw new Error("A pipeline name or path is required.");
  }

  const normalized = raw.endsWith(".json") ? raw : `${raw}.json`;
  const basePath =
    normalized.includes(path.sep) || normalized.includes("/")
      ? normalized
      : path.join("pipelines", normalized);
  return resolveWorkspacePath(basePath);
}

async function listPipelineFiles(
  directory,
  { recursive = true, maxDepth = 4 } = {},
  currentDepth = 0,
) {
  const entries = [];
  if (currentDepth > maxDepth) return entries;

  // The pipelines folder does not exist in a fresh clone, and readdir throwing
  // ENOENT made pipeline_list fail instead of reporting an empty library.
  let dirents;
  try {
    dirents = await fs.readdir(directory, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return entries;
    throw err;
  }

  for (const dirent of dirents) {
    const fullPath = path.join(directory, dirent.name);
    if (dirent.isDirectory()) {
      if (recursive && currentDepth < maxDepth) {
        entries.push(
          ...(await listPipelineFiles(
            fullPath,
            { recursive, maxDepth },
            currentDepth + 1,
          )),
        );
      }
      continue;
    }

    if (!dirent.name.toLowerCase().endsWith(".json")) continue;

    const content = await safeReadText(fullPath);
    let summary = null;
    if (content) {
      try {
        const pipeline = JSON.parse(content);
        summary = {
          name: pipeline.name ?? dirent.name.replace(/\.json$/i, ""),
          targetOrigin: pipeline.targetOrigin ?? "",
          stepCount: Array.isArray(pipeline.steps) ? pipeline.steps.length : 0,
          savedAt: pipeline.meta?.savedAt ?? pipeline.meta?.compiledAt ?? null,
        };
      } catch {
        summary = {
          name: dirent.name.replace(/\.json$/i, ""),
          invalidJson: true,
        };
      }
    }

    entries.push({
      path: toWorkspaceRelative(fullPath),
      ...summary,
    });
  }

  return entries;
}

async function startHttpServer() {
  // createMcpExpressApp applies DNS-rebinding protection automatically for
  // loopback hosts; pass the host explicitly so the middleware and the socket
  // agree about what is being protected.
  const app = createMcpExpressApp({ host: HTTP_HOST });

  app.post("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    try {
      let transport;
      if (sessionId && httpSessions.has(sessionId)) {
        transport = httpSessions.get(sessionId);
      } else if (!sessionId && isInitializeRequest(req.body)) {
        const sessionServer = createServerInstance();
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (nextSessionId) => {
            httpSessions.set(nextSessionId, transport);
            httpSessionServers.set(nextSessionId, sessionServer);
          },
        });

        transport.onclose = () => {
          const nextSessionId = transport.sessionId;
          if (!nextSessionId) return;

          httpSessions.delete(nextSessionId);

          const sessionServer = httpSessionServers.get(nextSessionId);
          if (sessionServer) {
            httpSessionServers.delete(nextSessionId);
            sessionServer.close().catch(() => {});
          }
        };

        await sessionServer.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      } else {
        res.status(400).json({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Bad Request: No valid session ID provided",
          },
          id: null,
        });
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: "Internal server error",
          },
          id: null,
        });
      }
      console.error(
        JSON.stringify({
          level: "error",
          message: error?.message ?? String(error),
        }),
      );
    }
  });

  app.get("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    if (!sessionId || !httpSessions.has(sessionId)) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }

    const transport = httpSessions.get(sessionId);
    await transport.handleRequest(req, res);
  });

  app.delete("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    if (!sessionId || !httpSessions.has(sessionId)) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }

    const transport = httpSessions.get(sessionId);
    await transport.handleRequest(req, res);
  });

  await new Promise((resolve) => {
    app.listen(HTTP_PORT, HTTP_HOST, () => {
      console.log(
        `HTTP MCP server listening on http://${HTTP_HOST}:${HTTP_PORT}/mcp`,
      );
      if (!LOOPBACK_HOSTS.has(HTTP_HOST)) {
        console.warn(
          `WARNING: bound to ${HTTP_HOST}, which is reachable beyond this machine. ` +
            `This server has no authentication. DNS-rebinding protection is not ` +
            `applied to non-loopback hosts.`,
        );
      }
      if (!WRITES_ALLOWED) {
        console.log(
          "Workspace writes are disabled over HTTP. Pass --allow-write to enable them.",
        );
      }
      resolve();
    });
  });
}

async function listTree(directory, maxDepth, currentDepth = 0) {
  const entries = [];
  if (currentDepth > maxDepth) return entries;

  const dirents = await fs.readdir(directory, { withFileTypes: true });
  for (const dirent of dirents) {
    const fullPath = path.join(directory, dirent.name);
    entries.push({
      path: toWorkspaceRelative(fullPath),
      type: dirent.isDirectory() ? "directory" : "file",
    });
    if (dirent.isDirectory() && currentDepth < maxDepth) {
      entries.push(...(await listTree(fullPath, maxDepth, currentDepth + 1)));
    }
  }

  return entries;
}

async function collectFiles(directory) {
  const stats = await fs.stat(directory);
  if (!stats.isDirectory()) return [directory];

  const files = [];
  const dirents = await fs.readdir(directory, { withFileTypes: true });
  for (const dirent of dirents) {
    if (shouldSkip(dirent.name)) continue;
    const fullPath = path.join(directory, dirent.name);
    if (dirent.isDirectory()) {
      files.push(...(await collectFiles(fullPath)));
    } else {
      files.push(fullPath);
    }
  }
  return files;
}

async function safeReadText(filePath) {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size > 2_000_000) return null;
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

function shouldSkip(name) {
  return [".git", "node_modules", "dist", "build", ".vscode"].includes(name);
}

function parseMaybeJson(value) {
  if (!value) return null;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function readPdfBytes({ source, fileBase64, fileName }) {
  if (fileBase64) {
    return {
      bytes: decodeBase64Input(fileBase64),
      resolvedSource: fileName ? `upload:${fileName}` : "upload:inline",
    };
  }

  if (!source) {
    throw new Error(
      "Provide either source or fileBase64 for pdf_extract_text.",
    );
  }

  if (isHttpUrl(source)) {
    const response = await fetch(source);
    if (!response.ok) {
      throw new Error(
        `Failed to fetch PDF: ${response.status} ${response.statusText}`,
      );
    }
    const arr = await response.arrayBuffer();
    return { bytes: new Uint8Array(arr), resolvedSource: source };
  }

  const resolved = resolveWorkspacePath(source);
  const bytes = await fs.readFile(resolved);
  return {
    bytes: new Uint8Array(bytes),
    resolvedSource: toWorkspaceRelative(resolved),
  };
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function decodeBase64Input(input) {
  const normalized = String(input).trim();
  const raw = normalized.startsWith("data:")
    ? (normalized.split(",", 2)[1] ?? "")
    : normalized;

  if (!raw) {
    throw new Error("fileBase64 is empty.");
  }

  const bytes = Buffer.from(raw, "base64");
  if (bytes.length === 0) {
    throw new Error("Invalid fileBase64 payload.");
  }
  return new Uint8Array(bytes);
}

function flattenSteps(steps, output = []) {
  for (const step of Array.isArray(steps) ? steps : []) {
    output.push(step);
    flattenSteps(step.children, output);
    flattenSteps(step.ifBranch, output);
    flattenSteps(step.elseBranch, output);
  }
  return output;
}

// Formatting is shared with the extension (exporters/row-formatters.js) so the
// MCP output matches what a pipeline exports. The local copies derived headers
// from Object.keys(rows[0]), so any column missing from the first row was
// dropped from CSV, TSV and Markdown entirely.
const renderRows = formatRows;
const defaultFilename = rowFilename;

function textResult(data) {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}
