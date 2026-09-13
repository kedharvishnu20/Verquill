// === pipeline-capabilities.js ===
/**
 * What a pipeline someone else wrote is able to do to you.
 *
 * A pipeline is not a document. It is a program: it opens pages, reads
 * cookies, sets request headers, calls APIs and uploads files. Handing one
 * between strangers — which is the entire point of a marketplace — is
 * therefore a supply-chain problem, not a sharing problem. "Amazon product
 * scraper, 4.8 stars" is an excellent disguise for a SESSION step that dumps
 * your logged-in cookies and an API step that POSTs them somewhere.
 *
 * The registry already saw this coming. `SESSION`'s own note in
 * `utils/step-types.js` says a shared pipeline should not "carry someone's
 * cookies out with it". This module is that sentence made enforceable.
 *
 * Two jobs, and they are deliberately different in kind:
 *
 *   1. **Describe.** Turn a pipeline into a plain list of what it can do, in
 *      words that mean something to a person: "reads your cookies for
 *      amazon.com", not "contains a SESSION step". Nobody consents to a step
 *      type.
 *
 *   2. **Refuse.** One combination is not a disclosure, it is an attack:
 *      reading credentials AND sending data to somewhere the pipeline never
 *      said it was for. That is blocked outright rather than warned about,
 *      because a warning is a thing people click through, and there is no
 *      legitimate scraper that needs it.
 *
 * The refusal is deliberately narrow. A gate that fires on everything is one
 * people learn to bypass, and then it protects nobody — the same reasoning
 * `ethics/pii-detector.js` is built on. Reading cookies is fine. Calling a
 * third-party API is fine. Doing both in one pipeline is the thing that has no
 * innocent explanation.
 *
 * Unknown is treated as dangerous. A URL that is entirely a template —
 * `{{item.href}}` — cannot be resolved to an origin at import time, so it is
 * counted as third-party rather than waved through. Failing open here would
 * make the whole check decorative, since an attacker picks the URL.
 */

/**
 * Severity is about what the reader should do, not how the code feels.
 *
 *   info   — worth knowing, needs no decision
 *   notice — a real capability; read it before you accept
 *   danger — touches credentials or sends data off the machine
 */
export const SEVERITY = { INFO: "info", NOTICE: "notice", DANGER: "danger" };

/** Verdicts an analysis can reach. */
export const VERDICT = {
  /** Nothing here needs a decision. */
  ALLOW: "allow",
  /** Real capabilities; show them and get consent. */
  REVIEW: "review",
  /** Credential access plus an undeclared destination. Not offered. */
  BLOCKED: "blocked",
};

/**
 * Headers whose presence means the request is carrying an identity.
 *
 * Matched case-insensitively against header *names* only. The values are never
 * read, logged or reported — the same rule the PII detector holds to: a
 * warning about a secret must not itself repeat the secret.
 */
const AUTH_HEADER_NAMES = [
  "authorization",
  "cookie",
  "x-api-key",
  "x-auth-token",
  "authentication",
  "proxy-authorization",
];

/** A URL that is nothing but a placeholder cannot be resolved at import time. */
const LOOKS_TEMPLATED = /\{\{|\$\{/;

/**
 * The origin a step will actually talk to, or a marker saying we cannot know.
 *
 * Returns `{ origin }` when it resolves, `{ unknown: true }` when the host
 * itself is templated or the URL is unparseable. A template in the *path*
 * (`https://api.site.com/{{item.id}}`) still yields a usable origin, which
 * matters because that is the shape most legitimate pipelines have.
 */
export function originOf(url) {
  if (typeof url !== "string" || !url.trim()) return { unknown: true };
  const trimmed = url.trim();

  // A template before the first `/` means the host is chosen at run time.
  const hostPart = trimmed.split("/").slice(0, 3).join("/");
  if (LOOKS_TEMPLATED.test(hostPart)) return { unknown: true };

  try {
    const parsed = new URL(trimmed);
    if (!/^https?:$/.test(parsed.protocol)) return { unknown: true };
    return { origin: parsed.origin };
  } catch {
    return { unknown: true };
  }
}

/** Every step in a pipeline, flattened out of loops and branches. */
export function walkSteps(steps, out = []) {
  for (const step of Array.isArray(steps) ? steps : []) {
    if (!step || typeof step !== "object") continue;
    out.push(step);
    walkSteps(step.children, out);
    walkSteps(step.ifBranch, out);
    walkSteps(step.elseBranch, out);
  }
  return out;
}

/**
 * The headers a step declares, as [name, value] pairs.
 *
 * Values are read only to answer "is this one actually filled in" — an empty
 * `Authorization:` is not a leaked credential and should not be reported as
 * one. Nothing outside this module ever receives a value.
 */
function headerEntriesOf(step) {
  const raw = step?.config?.headers;
  if (typeof raw !== "string" || !raw.trim()) return [];
  // The field accepts JSON or `Name: value` lines, so read both shapes.
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return Object.entries(parsed).map(([k, v]) => [k, String(v ?? "")]);
    }
  } catch {
    /* not JSON; fall through to the line form */
  }
  return raw
    .split("\n")
    .map((line) => {
      const at = line.indexOf(":");
      if (at === -1) return [line.trim(), ""];
      return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
    })
    .filter(([name]) => name);
}

/** Header names a step declares. Names only — never the values. */
function headerNamesOf(step) {
  return headerEntriesOf(step).map(([name]) => name);
}

/**
 * Credential material that must not be published.
 *
 * The import gate and the publish gate are asking different questions, and
 * conflating them is how `scrubCredentials` came to remove nothing. Importing
 * asks "can this pipeline hurt me if I run it", and an auth header alone is
 * survivable — you are handing your own token to a site you chose. Publishing
 * asks "is this safe to make public", where an auth header alone is the whole
 * problem: a filled-in `Authorization` header goes into a public repository
 * verbatim, and is a leaked credential the moment the commit lands.
 *
 * So this is deliberately stricter than `analyzePipeline`, and deliberately
 * separate from it rather than a flag on it — the two callers want different
 * answers and a shared "strict" boolean would eventually be passed wrongly.
 *
 * Covers API as well as SET_HEADERS: both keep a free-text headers field, and
 * a token typed into either is equally public afterwards.
 *
 * @returns {Array<{stepId: string, stepType: string, headers: string[]}>}
 *   Header *names* only. A report of a leaked secret must not repeat it.
 */
export function findPublishBlockers(pipeline) {
  const found = [];
  for (const step of walkSteps(pipeline?.steps)) {
    if (step.type !== "SET_HEADERS" && step.type !== "API") continue;
    const risky = headerEntriesOf(step)
      .filter(([name, value]) => {
        if (!value.trim()) return false; // declared but empty: nothing to leak
        return AUTH_HEADER_NAMES.includes(name.toLowerCase());
      })
      .map(([name]) => name);
    if (risky.length) {
      found.push({
        stepId: step.id || step.type,
        stepType: step.type,
        headers: risky,
      });
    }
  }
  return found;
}

/**
 * Read a pipeline and report what it can do.
 *
 * Pure: takes a pipeline object, returns a description. It never runs a step,
 * touches storage or makes a request, so it is safe to call on a pipeline that
 * arrived from a stranger — which is exactly when it is called.
 *
 * @returns {{
 *   verdict: string,
 *   capabilities: Array<{id,severity,title,detail,steps:string[]}>,
 *   declaredOrigins: string[],
 *   thirdPartyOrigins: string[],
 *   blockedReason: string|null,
 * }}
 */
export function analyzePipeline(pipeline) {
  const steps = walkSteps(pipeline?.steps);
  const capabilities = [];
  const add = (cap) => {
    const existing = capabilities.find((c) => c.id === cap.id);
    if (existing) {
      existing.steps.push(...cap.steps);
      return;
    }
    capabilities.push(cap);
  };

  // ── Where this pipeline says it is for ────────────────────────────────────
  //
  // The sites it opens are its declared territory. A request anywhere else is
  // by definition somewhere the pipeline never told you about.
  const declared = new Set();
  const fromTarget = originOf(pipeline?.targetOrigin);
  if (fromTarget.origin) declared.add(fromTarget.origin);

  for (const step of steps) {
    if (step.type === "WEBSITE" || step.type === "NAVIGATE") {
      const { origin } = originOf(step.config?.url);
      if (origin) declared.add(origin);
    }
  }

  // ── What it reaches for ───────────────────────────────────────────────────
  const thirdParty = new Set();
  let readsCredentials = false;
  let sendsAuthHeaders = false;
  const offSiteSteps = [];

  for (const step of steps) {
    const id = step.id || step.type;

    switch (step.type) {
      case "SESSION": {
        const cookies = step.config?.includeCookies !== false;
        const storage = step.config?.includeStorage !== false;
        if (cookies || storage) readsCredentials = true;
        add({
          id: "credentials",
          severity: SEVERITY.DANGER,
          title: cookies
            ? "Reads and restores your logged-in session"
            : "Reads the page's stored data",
          detail:
            "A SESSION step handles the cookies that keep you signed in. " +
            "Legitimate for a pipeline that scrapes behind a login — and the " +
            "exact thing a malicious one wants.",
          steps: [id],
        });
        break;
      }

      case "SET_HEADERS": {
        const names = headerNamesOf(step);
        const auth = names.filter((n) =>
          AUTH_HEADER_NAMES.includes(n.toLowerCase()),
        );
        if (auth.length) sendsAuthHeaders = true;
        add({
          id: "headers",
          severity: auth.length ? SEVERITY.DANGER : SEVERITY.NOTICE,
          title: auth.length
            ? `Attaches credentials to requests (${auth.join(", ")})`
            : "Sets custom request headers",
          // Names, never values. The value is the secret.
          detail: names.length
            ? `Headers set: ${names.join(", ")}.`
            : "No headers configured yet.",
          steps: [id],
        });
        break;
      }

      case "API":
      case "DOWNLOAD_FILE": {
        const url = step.config?.url;
        // DOWNLOAD_FILE usually takes its URLs from the page rather than a
        // fixed field, so an empty url is normal there and not a destination.
        if (step.type === "DOWNLOAD_FILE" && !url) break;

        const { origin, unknown } = originOf(url);
        const isOffSite = unknown || !declared.has(origin);
        if (isOffSite) {
          thirdParty.add(unknown ? "(decided at run time)" : origin);
          offSiteSteps.push(id);
        }
        add({
          id: "network",
          severity: isOffSite ? SEVERITY.DANGER : SEVERITY.NOTICE,
          title: isOffSite
            ? "Sends requests to a site outside the one it scrapes"
            : "Calls an API on the site it scrapes",
          detail: isOffSite
            ? `Destination: ${unknown ? "chosen at run time from page data" : origin}.`
            : `Destination: ${origin}.`,
          steps: [id],
        });
        break;
      }

      case "UPLOAD_ACTIVITY":
        add({
          id: "upload",
          severity: SEVERITY.DANGER,
          title: "Uploads files from your storage library",
          detail:
            "Sends files you have added to the extension's storage library " +
            "into a page's upload control.",
          steps: [id],
        });
        break;

      case "AUTO_EXTRACT":
        add({
          id: "ai",
          severity: SEVERITY.NOTICE,
          title: "Sends page text to whichever model you configured",
          detail:
            "Only if you have configured a provider. A local model sends " +
            "nothing off your machine; a hosted one is covered by your " +
            "arrangement with them.",
          steps: [id],
        });
        break;

      case "SOLVE_CAPTCHA":
        add({
          id: "captcha",
          severity: SEVERITY.DANGER,
          title: "Attempts to answer a captcha",
          detail:
            "Still needs your per-run authorisation and a per-domain " +
            "attestation. Importing this does not grant either.",
          steps: [id],
        });
        break;

      case "EXPORT":
        add({
          id: "export",
          severity: SEVERITY.INFO,
          title: "Writes the collected rows to a file",
          detail: "Through Chrome's normal download flow.",
          steps: [id],
        });
        break;

      default:
        break;
    }
  }

  // ── The one combination that is not a disclosure ──────────────────────────
  //
  // Credentials in hand plus a destination the pipeline never declared is the
  // shape of exfiltration and has no innocent version. It is refused rather
  // than surfaced, because a dialog explaining it would still have a button on
  // it, and a certain fraction of people click the button.
  let verdict = capabilities.length ? VERDICT.REVIEW : VERDICT.ALLOW;
  let blockedReason = null;

  if ((readsCredentials || sendsAuthHeaders) && thirdParty.size) {
    verdict = VERDICT.BLOCKED;
    blockedReason =
      `This pipeline reads ${readsCredentials ? "your logged-in session" : "credentials"} ` +
      `and also sends requests to ${[...thirdParty].join(", ")}, which is not a site it ` +
      `says it scrapes. That combination is how a shared pipeline steals an account, ` +
      `and no legitimate scraper needs it.`;
  }

  // Nothing dangerous and nothing worth a decision reads as allow, so a plain
  // EXTRACT pipeline imports without a dialog nobody needed.
  if (
    verdict === VERDICT.REVIEW &&
    capabilities.every((c) => c.severity === SEVERITY.INFO)
  ) {
    verdict = VERDICT.ALLOW;
  }

  return {
    verdict,
    capabilities,
    declaredOrigins: [...declared],
    thirdPartyOrigins: [...thirdParty],
    blockedReason,
    offSiteSteps,
  };
}

/** A one-line summary, for a listing card where the full list does not fit. */
export function summarizeCapabilities(analysis) {
  if (!analysis || analysis.verdict === VERDICT.BLOCKED) {
    return "Refused: reads credentials and sends them off-site";
  }
  const dangerous = analysis.capabilities.filter(
    (c) => c.severity === SEVERITY.DANGER,
  );
  if (dangerous.length) {
    return dangerous.map((c) => c.title).join(" · ");
  }
  if (!analysis.capabilities.length) return "Reads pages only";
  return analysis.capabilities.map((c) => c.title).join(" · ");
}

// === END pipeline-capabilities.js ===
