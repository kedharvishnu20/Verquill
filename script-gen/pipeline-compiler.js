// === pipeline-compiler.js ===
/**
 * @module pipeline-compiler
 * @description Compiles a pipeline JSON recipe into an AST suitable for
 *   consumption by the script emitters (Python, Node, Lua).
 *   Also validates the pipeline structure and resolves step references.
 *
 * @dependencies logger
 */

import { logger } from "../utils/logger.js";
import { isExportableStepType, STEP_TYPES } from "../utils/step-types.js";
import { VERSION } from "../utils/version.js";

const MODULE = "pipeline-compiler";

/**
 * Compile and validate a pipeline recipe into an AST.
 * @param {object} recipe - Raw pipeline JSON
 * @returns {{ ast: object, errors: string[] }}
 */
export function compilePipeline(recipe) {
  const errors = [];
  if (!recipe || typeof recipe !== "object") {
    return { ast: null, errors: ["Pipeline must be an object"] };
  }
  if (!Array.isArray(recipe.steps)) {
    return { ast: null, errors: ["Pipeline must have a steps array"] };
  }

  const mapSteps = (stepList) => {
    if (!Array.isArray(stepList)) return [];
    return stepList.map((step, i) => {
      if (!step.type) errors.push(`Step ${i + 1} is missing a type`);
      const mapped = {
        id: step.id ?? `step_${i + 1}`,
        type: (step.type ?? "").toUpperCase(),
        label: step.label ?? step.type ?? `Step ${i + 1}`,
        config: step.config ?? {},
      };
      if (Array.isArray(step.children)) {
        mapped.children = mapSteps(step.children);
      }
      if (Array.isArray(step.ifBranch)) {
        mapped.ifBranch = mapSteps(step.ifBranch);
      }
      if (Array.isArray(step.elseBranch)) {
        mapped.elseBranch = mapSteps(step.elseBranch);
      }
      return mapped;
    });
  };

  const steps = mapSteps(recipe.steps);

  const ast = {
    name: recipe.name ?? "Untitled",
    version: recipe.version ?? VERSION,
    targetOrigin: recipe.targetOrigin ?? "",
    steps,
    meta: {
      compiledAt: new Date().toISOString(),
      stepCount: steps.length,
    },
  };

  logger.info(MODULE, "compiled", {
    name: ast.name,
    steps: steps.length,
    errors: errors.length,
  });
  return { ast, errors };
}

/**
 * Serialize a pipeline to a safe shareable JSON string.
 * Strips any sensitive config values (proxy credentials, API keys).
 * @param {object} pipeline
 * @returns {string}
 */
export function serializePipeline(pipeline) {
  const REDACT = /pass(word)?|secret|token|key|cred|auth/i;
  const sanitize = (obj) => {
    if (!obj || typeof obj !== "object") return obj;
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (REDACT.test(k)) out[k] = "[REDACTED]";
      else if (typeof v === "object") out[k] = sanitize(v);
      else out[k] = v;
    }
    return out;
  };
  return JSON.stringify(sanitize(pipeline), null, 2);
}

/**
 * Steps the script emitters cannot express.
 *
 * The emitters used to fall through to a `# TODO` comment for anything they did
 * not handle, so an exported script looked complete, ran, and silently did less
 * than the pipeline it came from. Callers use this to tell the user what will
 * be missing before they download it.
 *
 * @param {object} ast - compiled pipeline
 * @returns {Array<{ id: string, type: string, reason: string }>}
 */
export function findUnexportableSteps(ast) {
  const found = [];

  const walk = (steps) => {
    for (const step of Array.isArray(steps) ? steps : []) {
      if (!isExportableStepType(step.type)) {
        found.push({
          id: step.id ?? null,
          type: step.type,
          reason: STEP_TYPES[step.type]
            ? "runs inside the extension and has no standalone equivalent"
            : "unknown step type",
        });
      }
      walk(step.children);
      walk(step.ifBranch);
      walk(step.elseBranch);
    }
  };

  walk(ast?.steps);
  return found;
}

/**
 * Config keys whose value is a credential by name.
 * The same list drives serializePipeline's redaction.
 */
const SECRET_KEY =
  /pass(word)?|secret|token|api[-_]?key|\bkey\b|cred|auth|bearer/i;

/** Selectors that say "this is a password field" without needing the value. */
const PASSWORD_SELECTOR =
  /type\s*=\s*["']?password|#pass|\bpassword\b|\bpwd\b/i;

/** Header names that carry a credential. */
const SECRET_HEADER =
  /^(authorization|proxy-authorization|x-api-key|api-key|x-auth-token|cookie)$/i;

const ENV_MARKER = (name) => `__VQ_ENV__${name}__`;

/**
 * Replace credentials in a compiled AST with environment-variable markers.
 *
 * The emitters only ever replaced *proxy* credentials, while the README said
 * "credentials are always redacted" — so a FILL step holding a password, or an
 * API step with an Authorization header, was written into the downloaded script
 * in plaintext (B-14). Both emitters resolve these markers at runtime through a
 * small helper, so this runs once here rather than at every emit site.
 *
 * Detection is by key name, by header name, and by password-shaped selectors.
 * A password typed into a field this cannot recognise is still emitted as
 * written — there is nothing in the config that distinguishes it from any other
 * text — so the return value lists what was replaced and callers report it.
 *
 * @param {object} ast - compiled pipeline; mutated in place
 * @returns {Array<{ env: string, stepId: string|null, type: string, where: string }>}
 */
export function redactSecrets(ast) {
  const found = [];
  let n = 0;

  const claim = (stepId, type, where) => {
    const env = `VQ_SECRET_${++n}`;
    found.push({ env, stepId: stepId ?? null, type, where });
    return ENV_MARKER(env);
  };

  const redactHeaders = (raw, step) => {
    if (typeof raw !== "string" || !raw.includes(":")) return raw;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return raw; // not JSON we can reason about; left alone and reported below
    }
    if (!parsed || typeof parsed !== "object") return raw;
    let changed = false;
    for (const k of Object.keys(parsed)) {
      if (SECRET_HEADER.test(k) && typeof parsed[k] === "string" && parsed[k]) {
        parsed[k] = claim(step.id, step.type, `headers.${k}`);
        changed = true;
      }
    }
    return changed ? JSON.stringify(parsed) : raw;
  };

  const walkConfig = (cfg, step, path = "config") => {
    if (!cfg || typeof cfg !== "object") return;
    for (const [k, v] of Object.entries(cfg)) {
      if (v && typeof v === "object") {
        walkConfig(v, step, `${path}.${k}`);
      } else if (typeof v === "string" && v && SECRET_KEY.test(k)) {
        cfg[k] = claim(step.id, step.type, `${path}.${k}`);
      }
    }
  };

  const walk = (steps) => {
    for (const step of Array.isArray(steps) ? steps : []) {
      const cfg = step.config;
      if (cfg && typeof cfg === "object") {
        if (step.type === "API") {
          cfg.headers = redactHeaders(cfg.headers, step);
        }
        if (step.type === "FILL" || step.type === "TYPE") {
          if (cfg.text && PASSWORD_SELECTOR.test(String(cfg.selector ?? ""))) {
            cfg.text = claim(step.id, step.type, "config.text");
          }
          for (const f of Array.isArray(cfg.fields) ? cfg.fields : []) {
            if (f?.value && PASSWORD_SELECTOR.test(String(f.selector ?? ""))) {
              f.value = claim(step.id, step.type, `fields[${f.selector}]`);
            }
          }
        }
        walkConfig(cfg, step);
      }
      walk(step.children);
      walk(step.ifBranch);
      walk(step.elseBranch);
    }
  };

  walk(ast?.steps);
  return found;
}

/**
 * Templates left in a compiled AST.
 *
 * `{{loop.index}}` and friends are resolved by the extension's executor at run
 * time. The emitters copy config strings verbatim, so a template appears
 * literally in the generated script and the script requests a URL with braces
 * in it (B-16). Nothing can resolve them standalone, so the honest thing is to
 * name them before the download rather than ship a script that looks fine.
 *
 * @param {object} ast
 * @returns {Array<{ stepId: string|null, type: string, where: string, template: string }>}
 */
export function findUnresolvedTemplates(ast) {
  const found = [];

  const scan = (value, step, path) => {
    if (typeof value === "string") {
      for (const m of value.matchAll(/\{\{([^}]+)\}\}/g)) {
        // The one template a script does resolve for itself: both emitters
        // build a DOWNLOAD_FILE name out of the URL they are about to fetch.
        if (
          step.type === "DOWNLOAD_FILE" &&
          path === "config.filename" &&
          DOWNLOAD_FILE_VARS.includes(m[1].trim())
        ) {
          continue;
        }
        found.push({
          stepId: step.id ?? null,
          type: step.type,
          where: path,
          template: m[0],
        });
      }
    } else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) scan(v, step, `${path}.${k}`);
    }
  };

  const walk = (steps) => {
    for (const step of Array.isArray(steps) ? steps : []) {
      scan(step.config, step, "config");
      walk(step.children);
      walk(step.ifBranch);
      walk(step.elseBranch);
    }
  };

  walk(ast?.steps);
  return found;
}

/**
 * The `{{...}}` fields a generated script can fill in for a downloaded file.
 *
 * Everything else in a filename template — {{extracted.title}}, {{item.href}} —
 * comes from a run context a standalone script does not have, so the emitters
 * refuse the whole step rather than dropping the value and saving files under
 * names the user did not ask for.
 */
export const DOWNLOAD_FILE_VARS = Object.freeze([
  "file.name",
  "file.stem",
  "file.ext",
  "file.index",
  "file.host",
]);

/**
 * A filename template, split the way both emitters need it.
 *
 * Path segments first, values second — the same order the extension resolves
 * them in, and the reason a value from the page cannot introduce a directory.
 *
 * @param {string} template
 * @returns {{segments: Array<Array<{lit?: string, var?: string}>>, unsupported: string[]}}
 */
export function parseFilenameTemplate(template) {
  const unsupported = [];
  const segments = String(template ?? "")
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => {
      const parts = [];
      let at = 0;
      for (const m of segment.matchAll(/\{\{([^}]+)\}\}/g)) {
        if (m.index > at) parts.push({ lit: segment.slice(at, m.index) });
        const name = m[1].trim();
        if (DOWNLOAD_FILE_VARS.includes(name)) parts.push({ var: name });
        else unsupported.push(m[0]);
        at = m.index + m[0].length;
      }
      if (at < segment.length) parts.push({ lit: segment.slice(at) });
      return parts;
    });
  return { segments, unsupported };
}

// === END pipeline-compiler.js ===
