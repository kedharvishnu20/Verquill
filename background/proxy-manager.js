// === proxy-manager.js ===
/**
 * @module proxy-manager
 * @description Manages user-supplied proxy pool: parsing all 5 input formats,
 *   health-checking, 4 rotation modes (round-robin / random / sticky / geo),
 *   and applying proxies via Chrome Proxy API PAC script.
 *
 *   Design decision: PAC-script approach is used for all proxy types including
 *   SOCKS because chrome.proxy.settings.set() with PAC is the only MV3-compatible
 *   way to dynamically rotate proxies without requiring a native host. For HTTP
 *   proxies where SOCKS is unavailable, we fall back to fixed proxy config.
 *
 *   Credentials (user/pass) are stored ONLY in chrome.storage.session and are
 *   purged automatically when the browser session ends. Pool metadata (host,
 *   port, type, country, alive, latencyMs, failCount) goes to chrome.storage.local.
 *
 * @dependencies logger, strings
 *
 * NOT CURRENTLY REACHED BY A PIPELINE RUN. selectProxy, rotateProxy and
 * _applyProxy are exposed only through the proxy:select / proxy:rotate /
 * proxy:test messages, and nothing sends them — _executePipeline never touches
 * this module. The Settings tab's "Update Pool" button parses and stores a
 * pool that is then never applied. See docs/ISSUE_AUDIT.md A-05: whether to
 * wire this up or remove it is an open product decision, so treat everything
 * here as untested against real traffic.
 */

import { logger } from "../utils/logger.js";

const MODULE = "proxy-manager";

// ── Constants ────────────────────────────────────────────────────────────────
const STORAGE_KEY_POOL = "vq_proxy_pool"; // local: pool metadata (no creds)
const STORAGE_KEY_CREDS = "vq_proxy_creds"; // session: user/pass per host:port
const STORAGE_KEY_REGION = "vq_proxy_region"; // local: the country geo mode wants
const PROXY_HEALTH_TIMEOUT_MS = 5000;
const HEALTH_CHECK_URL = "https://httpbin.org/ip";

/**
 * @typedef {Object} ProxyEntry
 * @property {string}  host
 * @property {number}  port
 * @property {string}  [user]
 * @property {string}  [pass]
 * @property {'http'|'https'|'socks4'|'socks5'} type
 * @property {string}  [country]       ISO-3166-1 alpha-2
 * @property {number|null} latencyMs   null = untested
 * @property {boolean} alive           default true
 * @property {number}  failCount       consecutive failures
 * @property {number}  lastTestedAt    epoch ms
 */

// ── Module state ──────────────────────────────────────────────────────────────
let _pool = []; // Array<ProxyEntry> (creds stripped)
let _credMap = new Map(); // host:port → {user, pass}
// Two cursors, not one. Round-robin and sticky both advanced the same counter,
// so switching modes — or assigning a sticky proxy to a new domain — perturbed
// the round-robin order for reasons nothing in the UI explains (audit B-34).
let _rrIndex = 0; // round-robin cursor
let _stickyIndex = 0; // next proxy to hand a domain that has none
let _stickyMap = new Map(); // domain → ProxyEntry

// ── Rotation mode ─────────────────────────────────────────────────────────────
let _rotationMode = "round-robin"; // 'round-robin' | 'random' | 'sticky' | 'geo'

// ── Parser helpers ────────────────────────────────────────────────────────────

/**
 * The ports that mean SOCKS often enough to guess from.
 *
 * 1080 is the registered one and 1081 the usual second instance; 9050 and 9150
 * are Tor's daemon and Tor Browser's bundled client, which between them are
 * most of the SOCKS proxies anyone pastes into a tool like this. Guessing
 * `http` for those produced a proxy that connected and then failed every
 * request, with nothing saying why.
 *
 * Deliberately short. This is a guess for a line that did not say, and a long
 * list of maybes would start guessing wrong for HTTP proxies on unusual ports —
 * write `socks5://host:port` and nothing is inferred at all.
 */
const SOCKS_PORTS = new Set([1080, 1081, 9050, 9150]);

/**
 * Infer protocol from port when not specified.
 * @param {number} port
 * @returns {'socks5'|'http'}
 */
function _inferProtocol(port) {
  return SOCKS_PORTS.has(port) ? "socks5" : "http";
}

/**
 * Normalize a protocol string to our accepted types.
 * @param {string} proto
 * @returns {'http'|'https'|'socks4'|'socks5'}
 */
function _normalizeProtocol(proto) {
  const p = proto.toLowerCase();
  if (p === "socks4") return "socks4";
  if (p === "socks5" || p === "socks") return "socks5";
  if (p === "https") return "https";
  return "http";
}

/**
 * Describe a proxy line safely enough to log.
 *
 * A proxy line is `host:port:user:pass`, so logging the raw text — as the parse
 * failure path used to — put credentials straight into the console, in a module
 * whose logger documents that it never logs them. Nothing beyond scheme and
 * host:port is ever returned.
 *
 * @param {string} line
 * @returns {string}
 */
function _describeProxyLine(line) {
  const trimmed = String(line ?? "").trim();
  if (!trimmed) return "(empty)";

  // scheme://user:pass@host:port -> scheme://host:port
  const withoutUserInfo = trimmed.replace(/\/\/[^@/]*@/, "//");

  const parts = withoutUserInfo.split(":");
  if (parts.length > 2) return `${parts[0]}:${parts[1]}:***`;
  return withoutUserInfo.slice(0, 64);
}

/**
 * Parse a single proxy line in any of the 5 supported text formats.
 * Returns null (and logs) if the line is malformed.
 * @param {string} line
 * @param {number} [index] - line number, for the failure log
 * @returns {ProxyEntry|null}
 */
function _parseLine(line, index) {
  line = line.trim();
  if (!line || line.startsWith("#")) return null;

  try {
    // ── Format 5: JSON object on one line ─────────────────────────────────
    if (line.startsWith("{")) {
      const obj = JSON.parse(line);
      if (!obj.host || !obj.port) throw new Error("Missing host or port");
      return _makeEntry({
        host: String(obj.host),
        port: parseInt(obj.port, 10),
        user: obj.user ?? obj.username ?? undefined,
        pass: obj.pass ?? obj.password ?? undefined,
        type: obj.type
          ? _normalizeProtocol(obj.type)
          : _inferProtocol(parseInt(obj.port, 10)),
        country: obj.country ?? undefined,
      });
    }

    // ── Formats with protocol prefix (socks5://, http://, etc.) ──────────
    // The scheme pattern must allow digits after the first letter. `[a-z]+:`
    // cannot match "socks5:" — it stops at the 5 — so socks4:// and socks5://
    // URLs, both documented in the README, fell through to the plain
    // host:port branch and parsed as host "socks5" with a NaN port. With
    // _makeEntry accepting anything, that entry went into the pool.
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(line)) {
      const url = new URL(line);
      const proto = _normalizeProtocol(url.protocol.replace(":", ""));
      const host = url.hostname;
      const port = parseInt(
        url.port || (proto === "socks5" ? "1080" : "3128"),
        10,
      );
      const user = url.username ? decodeURIComponent(url.username) : undefined;
      const pass = url.password ? decodeURIComponent(url.password) : undefined;
      return _makeEntry({ host, port, user, pass, type: proto });
    }

    // ── Remaining: plain IP:PORT… formats ─────────────────────────────────
    const parts = line.split(":");
    if (parts.length < 2) throw new Error("Cannot parse");

    const host = parts[0];
    const port = parseInt(parts[1], 10);
    if (!host || isNaN(port)) throw new Error("Missing host or port");

    // IP:PORT:USER:PASS
    if (parts.length === 4) {
      return _makeEntry({
        host,
        port,
        user: parts[2],
        pass: parts[3],
        type: _inferProtocol(port),
      });
    }
    // IP:PORT (plain)
    return _makeEntry({ host, port, type: _inferProtocol(port) });
  } catch (err) {
    logger.warn(MODULE, "parse-line-fail", {
      line: index === undefined ? undefined : index + 1,
      value: _describeProxyLine(line),
      error: err.message,
    });
    return null;
  }
}

/**
 * Build a complete ProxyEntry, separating credentials from metadata.
 * @param {{host:string,port:number,user?:string,pass?:string,type:string,country?:string}} opts
 * @returns {ProxyEntry}
 */
function _makeEntry({ host, port, user, pass, type, country }) {
  // This used to accept anything, so the try/catch skip paths in
  // parseProxyJSON and parseProxyCSV were dead and entries with port: NaN
  // entered the pool.
  const cleanHost = String(host ?? "").trim();
  if (!cleanHost) throw new Error("Missing host");

  const cleanPort = Number(port);
  if (!Number.isInteger(cleanPort) || cleanPort < 1 || cleanPort > 65535) {
    throw new Error(`Invalid port: ${port}`);
  }

  host = cleanHost;
  port = cleanPort;

  return {
    host,
    port,
    user, // kept in memory for immediate use; persisted only to session
    pass,
    type,
    country: country ?? null,
    latencyMs: null,
    alive: true,
    failCount: 0,
    lastTestedAt: 0,
  };
}

/**
 * Deduplicate pool by host:port.
 * @param {ProxyEntry[]} entries
 * @returns {ProxyEntry[]}
 */
function _deduplicate(entries) {
  const seen = new Map();
  for (const entry of entries) {
    const key = `${entry.host}:${entry.port}`;
    if (seen.has(key)) {
      logger.warn(MODULE, "dupe-skipped", { key });
    } else {
      seen.set(key, entry);
    }
  }
  return [...seen.values()];
}

// ── Public parsers ────────────────────────────────────────────────────────────

/**
 * Parse a multiline text block (paste) into ProxyEntry[].
 * @param {string} text
 * @returns {ProxyEntry[]}
 */
export function parseProxyText(text) {
  const raw = String(text ?? "");

  // README lists "CSV with header: host,port,username,password,type" as a
  // supported paste format, but this function only ever tried the line
  // formats — so a pasted CSV had every row rejected. parseProxyCSV existed
  // and was never called from anywhere.
  const firstLine = raw.split(/\r?\n/).find((l) => l.trim()) ?? "";
  if (/^\s*host\s*,/i.test(firstLine)) {
    return parseProxyCSV(raw);
  }

  const lines = raw.split(/\r?\n/);
  const entries = lines.map(_parseLine).filter(Boolean);
  return _deduplicate(entries);
}

/**
 * Parse a JSON array of proxy objects.
 * @param {string|object[]} input - JSON string or already-parsed array
 * @returns {ProxyEntry[]}
 */
export function parseProxyJSON(input) {
  let arr;
  if (typeof input === "string") {
    try {
      arr = JSON.parse(input);
    } catch (e) {
      logger.error(MODULE, "json-parse-fail", { error: e.message });
      return [];
    }
  } else {
    arr = input;
  }
  if (!Array.isArray(arr)) {
    logger.error(MODULE, "json-not-array", {});
    return [];
  }
  const entries = arr
    .map((obj) => {
      try {
        return _makeEntry({
          host: String(obj.host),
          port: parseInt(obj.port, 10),
          user: obj.user ?? obj.username ?? undefined,
          pass: obj.pass ?? obj.password ?? undefined,
          type: obj.type
            ? _normalizeProtocol(obj.type)
            : _inferProtocol(parseInt(obj.port, 10)),
          country: obj.country ?? undefined,
        });
      } catch (err) {
        // Never log the entry itself — a JSON proxy record carries pass/password.
        logger.warn(MODULE, "json-entry-skip", {
          host: typeof obj?.host === "string" ? obj.host : "(missing)",
          port: Number.isFinite(Number(obj?.port))
            ? Number(obj.port)
            : "(missing)",
          error: err.message,
        });
        return null;
      }
    })
    .filter(Boolean);
  return _deduplicate(entries);
}

/**
 * Parse a CSV string (header row required: host,port,username,password,type)
 * @param {string} csv
 * @returns {ProxyEntry[]}
 */
export function parseProxyCSV(csv) {
  const lines = csv.trim().split(/\r?\n/);
  const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const idx = (field) => header.indexOf(field);

  const iHost = idx("host");
  const iPort = idx("port");
  const iUser = Math.max(idx("username"), idx("user"));
  const iPass = Math.max(idx("password"), idx("pass"));
  const iType = idx("type");
  const iCountry = idx("country");

  if (iHost === -1 || iPort === -1) {
    logger.error(MODULE, "csv-missing-header", { header });
    return [];
  }

  const entries = lines
    .slice(1)
    .map((line, i) => {
      const cols = line.split(",").map((c) => c.trim());
      if (cols.length < 2) {
        logger.warn(MODULE, "csv-row-skip", { row: i + 1 });
        return null;
      }
      try {
        return _makeEntry({
          host: cols[iHost],
          port: parseInt(cols[iPort], 10),
          user: iUser >= 0 ? cols[iUser] : undefined,
          pass: iPass >= 0 ? cols[iPass] : undefined,
          type:
            iType >= 0 && cols[iType]
              ? _normalizeProtocol(cols[iType])
              : _inferProtocol(parseInt(cols[iPort], 10)),
          country: iCountry >= 0 ? cols[iCountry]?.toUpperCase() : undefined,
        });
      } catch (err) {
        logger.warn(MODULE, "csv-entry-fail", {
          row: i + 1,
          error: err.message,
        });
        return null;
      }
    })
    .filter(Boolean);

  return _deduplicate(entries);
}

// ── Pool management ───────────────────────────────────────────────────────────

/**
 * Load the pool from chrome.storage.local (no credentials).
 * Credentials are re-hydrated from session storage.
 */
export async function loadPool() {
  try {
    const { [STORAGE_KEY_POOL]: meta, [STORAGE_KEY_CREDS]: creds } =
      await chrome.storage.local.get([STORAGE_KEY_POOL]);
    const sessionItems = await chrome.storage.session.get([STORAGE_KEY_CREDS]);
    const sessionCreds = sessionItems[STORAGE_KEY_CREDS] ?? {};

    _pool = (meta ?? []).map((entry) => ({
      ...entry,
      user: undefined,
      pass: undefined,
    }));

    _credMap = new Map(Object.entries(sessionCreds));
    const regionItems = await chrome.storage.local.get([STORAGE_KEY_REGION]);
    _targetCountry = String(
      regionItems?.[STORAGE_KEY_REGION] ?? "",
    ).toUpperCase();
    logger.info(MODULE, "pool-loaded", { count: _pool.length });
  } catch (err) {
    logger.error(MODULE, "pool-load-fail", { error: err.message });
    _pool = [];
  }
}

/**
 * Persist pool metadata (no credentials) to chrome.storage.local.
 * Credentials saved separately to chrome.storage.session.
 */
export async function savePool() {
  // Strip credentials before persisting locally
  const meta = _pool.map(({ user, pass, ...rest }) => rest); // eslint-disable-line no-unused-vars
  // Serialize credential map
  const credObj = Object.fromEntries(_credMap.entries());

  try {
    await chrome.storage.local.set({
      [STORAGE_KEY_POOL]: meta,
      [STORAGE_KEY_REGION]: _targetCountry,
    });
    await chrome.storage.session.set({ [STORAGE_KEY_CREDS]: credObj });
    logger.info(MODULE, "pool-saved", { count: meta.length });
  } catch (err) {
    logger.error(MODULE, "pool-save-fail", { error: err.message });
    throw err;
  }
}

/**
 * Add entries to the pool (merges with deduplication).
 * @param {ProxyEntry[]} entries
 */
export function addToPool(entries) {
  const existing = new Map(_pool.map((e) => [`${e.host}:${e.port}`, e]));
  for (const entry of entries) {
    const key = `${entry.host}:${entry.port}`;
    if (!existing.has(key)) {
      const { user, pass, ...meta } = entry;
      _pool.push(meta);
      if (user || pass) {
        _credMap.set(key, { user: user ?? "", pass: pass ?? "" });
      }
      existing.set(key, meta);
    }
  }
}

/**
 * Clear the entire pool from memory and storage.
 */
export async function clearPool() {
  _pool = [];
  _credMap = new Map();
  _rrIndex = 0;
  _stickyIndex = 0;
  _stickyMap = new Map();
  try {
    await chrome.storage.local.set({ [STORAGE_KEY_POOL]: [] });
    await chrome.storage.session.remove([STORAGE_KEY_CREDS]);
    logger.info(MODULE, "pool-cleared", {});
  } catch (err) {
    logger.error(MODULE, "pool-clear-fail", { error: err.message });
  }
}

/** Get pool metadata (no credentials). */
export function getPool() {
  return [..._pool];
}

/** Set rotation mode. */
export function setRotationMode(mode) {
  const valid = ["round-robin", "random", "sticky", "geo"];
  if (!valid.includes(mode)) throw new Error(`Invalid rotation mode: ${mode}`);
  _rotationMode = mode;
  logger.info(MODULE, "rotation-mode-set", { mode });
}

/**
 * The country geo rotation should exit through, as an ISO-3166-1 alpha-2 code.
 *
 * Held here because two things need it and neither should own it: `selectProxy`
 * in geo mode, and the preflight gate that warns when no proxy in the pool
 * claims to be there. Before this, geo mode read a `targetCountry` nobody
 * passed and quietly behaved like random.
 */
let _targetCountry = "";

/** @param {string} code - ISO-3166-1 alpha-2, or "" for no preference. */
export function setTargetCountry(code) {
  _targetCountry = String(code ?? "")
    .trim()
    .toUpperCase();
  logger.info(MODULE, "target-country-set", { country: _targetCountry });
}

/** @returns {string} */
export function getTargetCountry() {
  return _targetCountry;
}

/**
 * The countries the live pool claims, for the preflight gate.
 *
 * Only the alive ones: a dead proxy in the right country does not make the
 * region reachable, and warning as though it did would be the same kind of
 * comfort the old gate gave.
 *
 * @returns {string[]}
 */
export function poolCountries() {
  return _pool
    .filter((p) => p.alive !== false && p.country)
    .map((p) => p.country);
}

// ── Proxy selection ───────────────────────────────────────────────────────────

/**
 * Get alive proxies.
 * @returns {ProxyEntry[]}
 */
function _aliveProxies() {
  return _pool.filter((p) => p.alive);
}

/**
 * Select next proxy according to the current rotation mode.
 * @param {{ domain?: string, targetCountry?: string }} [context]
 * @returns {ProxyEntry|null}
 */
export function selectProxy(context = {}) {
  const alive = _aliveProxies();
  if (alive.length === 0) {
    logger.error(MODULE, "no-alive-proxies", {});
    return null;
  }

  switch (_rotationMode) {
    case "round-robin": {
      const entry = alive[_rrIndex % alive.length];
      _rrIndex = (_rrIndex + 1) % alive.length;
      return _attachCreds(entry);
    }
    case "random": {
      const entry = alive[Math.floor(Math.random() * alive.length)];
      return _attachCreds(entry);
    }
    case "sticky": {
      const domain = context.domain ?? "__default__";
      if (_stickyMap.has(domain)) {
        const stuck = _stickyMap.get(domain);
        // Re-check still alive
        const stillAlive = _pool.find(
          (p) => p.host === stuck.host && p.port === stuck.port && p.alive,
        );
        if (stillAlive) return _attachCreds(stillAlive);
      }
      // Assign a new one, from the sticky cursor.
      const entry = alive[_stickyIndex % alive.length];
      _stickyIndex = (_stickyIndex + 1) % alive.length;
      _stickyMap.set(domain, entry);
      return _attachCreds(entry);
    }
    case "geo": {
      const country = String(
        context.targetCountry ?? _targetCountry ?? "",
      ).toUpperCase();
      const geoMatch = alive.filter(
        (p) => p.country?.toUpperCase() === country,
      );
      const candidates = geoMatch.length > 0 ? geoMatch : alive;
      const entry = candidates[Math.floor(Math.random() * candidates.length)];
      if (geoMatch.length === 0) {
        logger.warn(MODULE, "geo-no-match", { country });
      }
      return _attachCreds(entry);
    }
    default: {
      logger.warn(MODULE, "unknown-rotation-mode", { mode: _rotationMode });
      return _attachCreds(alive[0]);
    }
  }
}

/**
 * Attach credentials from credMap to a copy of the entry.
 * @param {ProxyEntry} entry
 * @returns {ProxyEntry}
 */
function _attachCreds(entry) {
  const key = `${entry.host}:${entry.port}`;
  const creds = _credMap.get(key) ?? {};
  return { ...entry, user: creds.user, pass: creds.pass };
}

// ── Health checking ───────────────────────────────────────────────────────────

/**
 * Test a single proxy entry for liveness.
 * Updates `alive`, `latencyMs`, `failCount`, `lastTestedAt` in-place.
 * Non-blocking: returns a Promise.
 * @param {ProxyEntry} entry
 * @param {number} [retryCount=3]
 * @returns {Promise<ProxyEntry>}
 */
export async function testProxy(entry, retryCount = 3) {
  const key = `${entry.host}:${entry.port}`;
  const poolEntry = _pool.find((p) => `${p.host}:${p.port}` === key);
  if (!poolEntry) {
    logger.warn(MODULE, "test-proxy-not-in-pool", { key });
    return entry;
  }

  const start = Date.now();

  // _applyProxy sets a browser-wide PAC script, so a health check hijacks every
  // tab's traffic for its duration. Nothing used to put it back: after checking
  // a pool the user's whole browser stayed routed through whichever proxy was
  // tested last. Snapshot the current settings and restore them in `finally`.
  const previous = await _snapshotProxySettings();

  try {
    await _applyProxy(entry);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROXY_HEALTH_TIMEOUT_MS);
    const res = await fetch(HEALTH_CHECK_URL, {
      method: "HEAD",
      signal: controller.signal,
    });
    clearTimeout(timer);

    const latencyMs = Date.now() - start;
    poolEntry.alive = res.ok;
    poolEntry.latencyMs = latencyMs;
    poolEntry.failCount = res.ok ? 0 : poolEntry.failCount + 1;
    poolEntry.lastTestedAt = Date.now();

    if (!res.ok) {
      logger.warn(MODULE, "proxy-test-fail", {
        host: entry.host,
        port: entry.port,
        status: res.status,
      });
    } else {
      logger.info(MODULE, "proxy-test-ok", {
        host: entry.host,
        port: entry.port,
        latencyMs,
      });
    }
  } catch (err) {
    poolEntry.alive = false;
    poolEntry.failCount = (poolEntry.failCount ?? 0) + 1;
    poolEntry.lastTestedAt = Date.now();
    poolEntry.latencyMs = null;
    logger.warn(MODULE, "proxy-test-error", {
      host: entry.host,
      port: entry.port,
      error: err.message,
    });

    if (poolEntry.failCount >= retryCount) {
      poolEntry.alive = false;
      logger.info(MODULE, "proxy-marked-dead", {
        host: entry.host,
        port: entry.port,
        failCount: poolEntry.failCount,
      });
    }
  } finally {
    await _restoreProxySettings(previous);
  }

  return poolEntry;
}

/**
 * Read the current browser proxy configuration so a health check can put it
 * back. Returns null when it cannot be read, in which case the restore clears
 * to direct rather than leaving a test proxy in place.
 * @returns {Promise<object|null>}
 */
async function _snapshotProxySettings() {
  try {
    return await new Promise((resolve, reject) => {
      chrome.proxy.settings.get({ incognito: false }, (details) => {
        if (chrome.runtime.lastError)
          reject(new Error(chrome.runtime.lastError.message));
        else resolve(details?.value ?? null);
      });
    });
  } catch (err) {
    logger.warn(MODULE, "proxy-snapshot-fail", { error: err.message });
    return null;
  }
}

/**
 * Put back what _snapshotProxySettings read. Clears to a direct connection if
 * there was nothing to restore — never leaves a tested proxy applied.
 * @param {object|null} previous
 */
async function _restoreProxySettings(previous) {
  try {
    if (!previous || previous.mode === "system" || previous.mode === "direct") {
      await clearProxy();
      return;
    }
    await new Promise((resolve, reject) => {
      chrome.proxy.settings.set({ value: previous, scope: "regular" }, () => {
        if (chrome.runtime.lastError)
          reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      });
    });
  } catch (err) {
    logger.error(MODULE, "proxy-restore-fail", { error: err.message });
  }
}

/**
 * Test all proxies in the pool concurrently (non-blocking relative to pipeline).
 * @param {object} [opts]
 * @param {boolean} [opts.autoRemoveDead=false]
 * @param {number}  [opts.retryCount=3]
 * @returns {Promise<void>}
 */
export async function testAllProxies({
  autoRemoveDead = false,
  retryCount = 3,
} = {}) {
  logger.info(MODULE, "health-check-start", { count: _pool.length });

  // Sequential, not Promise.allSettled: every testProxy call swaps a global,
  // browser-wide PAC script, so running them concurrently meant N tests
  // fighting over one setting and measuring each other's proxies. The latency
  // and alive/dead results this produced were meaningless.
  for (const entry of [..._pool]) {
    await testProxy(entry, retryCount).catch((err) =>
      logger.warn(MODULE, "proxy-test-threw", { error: err.message }),
    );
  }

  if (autoRemoveDead) {
    const before = _pool.length;
    _pool = _pool.filter((p) => p.alive);
    logger.info(MODULE, "auto-removed-dead", {
      removed: before - _pool.length,
    });
  }

  await savePool();
  logger.info(MODULE, "health-check-complete", {
    alive: _pool.filter((p) => p.alive).length,
    total: _pool.length,
  });
}

/**
 * Mark a proxy as failed. If failCount >= retryCount, mark dead.
 * @param {string} host
 * @param {number} port
 * @param {number} [retryCount=3]
 */
export async function markProxyFailure(host, port, retryCount = 3) {
  const key = `${host}:${port}`;
  const entry = _pool.find((p) => `${p.host}:${p.port}` === key);
  if (!entry) return false;
  entry.failCount = (entry.failCount ?? 0) + 1;
  const died = entry.failCount >= retryCount;
  if (died) {
    entry.alive = false;
    logger.warn(MODULE, "proxy-dead", {
      host,
      port,
      failCount: entry.failCount,
    });
  }
  // Persisted, because the in-memory pool does not survive the worker.
  //
  // This used to mutate `_pool` and stop. An MV3 service worker is torn down
  // whenever it goes idle, so a proxy marked dead was alive again minutes
  // later and got selected for the next run — the count never reaching the
  // threshold because it kept restarting from zero. The health state is only
  // worth keeping if it outlives the process that learned it.
  await savePool().catch(() => {});
  return died;
}

/**
 * Rotate to the next proxy and apply it (called after consecutive failures).
 * @param {object} [context]
 * @returns {Promise<ProxyEntry|null>}
 */
export async function rotateProxy(context = {}) {
  const next = selectProxy(context);
  if (!next) {
    logger.error(MODULE, "rotate-fail-no-alive", {});
    return null;
  }
  await _applyProxy(next);
  logger.info(MODULE, "proxy-rotated", { host: next.host, port: next.port });
  return next;
}

// ── Chrome Proxy API application ──────────────────────────────────────────────

/**
 * Apply a proxy via chrome.proxy.settings.set() using a PAC script.
 * @param {ProxyEntry} entry
 * @returns {Promise<void>}
 */
export async function _applyProxy(entry) {
  // Build PAC script string dynamically
  let proxyStr;
  if (entry.type === "socks4") {
    proxyStr = `SOCKS4 ${entry.host}:${entry.port}`;
  } else if (entry.type === "socks5") {
    proxyStr = `SOCKS5 ${entry.host}:${entry.port}`;
  } else if (entry.type === "https") {
    proxyStr = `HTTPS ${entry.host}:${entry.port}`;
  } else {
    proxyStr = `PROXY ${entry.host}:${entry.port}`;
  }

  const pacScript = `function FindProxyForURL(url, host) { return "${proxyStr}"; }`;

  await new Promise((resolve, reject) => {
    chrome.proxy.settings.set(
      {
        value: { mode: "pac_script", pacScript: { data: pacScript } },
        scope: "regular",
      },
      () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve();
        }
      },
    );
  });

  logger.info(MODULE, "proxy-applied", {
    host: entry.host,
    port: entry.port,
    type: entry.type,
  });
}

/**
 * Clear proxy settings (use direct connection).
 * @returns {Promise<void>}
 */
export async function clearProxy() {
  await new Promise((resolve, reject) => {
    chrome.proxy.settings.clear({ scope: "regular" }, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve();
      }
    });
  });
  logger.info(MODULE, "proxy-cleared", {});
}

// === END proxy-manager.js ===
