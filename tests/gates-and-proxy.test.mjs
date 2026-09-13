// Two ethics gates that were not gates, and a proxy protocol guess.
//
// A gate that cannot fire is worse than a missing one: it makes the list of
// safeguards look longer than it is. A gate that fires on the wrong evidence is
// worse still — people learn to dismiss it, and that costs the gates that
// matter.
import test from "node:test";
import assert from "node:assert/strict";

globalThis.chrome = {
  storage: {
    local: {
      async get() {
        return {};
      },
      async set() {},
      async remove() {},
    },
    session: {
      async get() {
        return {};
      },
      async set() {},
      async remove() {},
    },
  },
};

const { runEthicsGates } = await import("../background/ethics-engine.js");
const proxy = await import("../background/proxy-manager.js");

const step = (type, config = {}, extra = {}) => ({
  id: Math.random().toString(36).slice(2),
  type,
  config,
  ...extra,
});

/** Gate 1 reads robots.txt; there is no network here, so keep it off the path. */
const gates = (opts) =>
  runEthicsGates({ targetOrigin: "", targetPath: "/", ...opts });

const codes = (result) => result.warnings.map((w) => w.code);

// ── Gate 4: captcha volume (VQ-15) ───────────────────────────────────────────

test("a pipeline with no captcha step does not warn about captcha volume", async () => {
  // It used to measure the row delay of the first FORM_FILL step. A pipeline
  // with no FORM_FILL fell back to the 1200ms default, "estimated" 3000 solves
  // an hour, and warned — with no captcha step anywhere in it.
  const r = await gates({
    steps: [step("FORM_FILL", { interRowDelay: { min: 1200 } })],
    captcha: { enabled: true },
  });
  assert.ok(!codes(r).includes("HighCaptchaVolume"));
});

test("many captcha solves inside a loop do warn", async () => {
  const r = await gates({
    steps: [
      step(
        "LOOP",
        { type: "elements", selector: ".r", max: 200 },
        {
          children: [step("SOLVE_CAPTCHA", {})],
        },
      ),
    ],
    captcha: { enabled: true },
    timing: { min: 1000 },
  });
  assert.ok(codes(r).includes("HighCaptchaVolume"));
});

test("a couple of solves in a long run does not", async () => {
  // Getting through a login twice is a person, not a machine.
  const r = await gates({
    steps: [step("SOLVE_CAPTCHA", {}), step("SOLVE_CAPTCHA", {})],
    captcha: { enabled: true },
    timing: { min: 1000 },
  });
  assert.ok(!codes(r).includes("HighCaptchaVolume"));
});

test("the count is bounded by the pipeline, not only by the pacing", async () => {
  // 3600000/500 is 7200 solves an hour, but the pipeline only asks for three.
  const r = await gates({
    steps: [
      step(
        "LOOP",
        { type: "elements", selector: ".r", max: 3 },
        {
          children: [step("SOLVE_CAPTCHA", {})],
        },
      ),
    ],
    captcha: { enabled: true },
    timing: { min: 500 },
  });
  assert.ok(!codes(r).includes("HighCaptchaVolume"));
});

// ── Gate 5: proxy geography (VQ-14) ──────────────────────────────────────────

test("gate 5 warns when no live proxy is in the country asked for", async () => {
  // The old version compared a proxy entry and a region that no caller ever
  // passed, so it could not fire in any pipeline, ever.
  const r = await gates({
    steps: [],
    proxyCountries: ["US", "DE"],
    region: "GB",
  });
  const w = r.warnings.find((x) => x.code === "ProxyGeoMismatch");
  assert.ok(w, "expected the gate to fire");
  assert.match(w.message, /US, DE/);
});

test("gate 5 is quiet when the pool can honour the region", async () => {
  const r = await gates({ steps: [], proxyCountries: ["us"], region: "US" });
  assert.ok(!codes(r).includes("ProxyGeoMismatch"));
});

test("gate 5 says so when the pool has no countries at all", async () => {
  const r = await gates({ steps: [], proxyCountries: [], region: "GB" });
  const w = r.warnings.find((x) => x.code === "ProxyGeoMismatch");
  assert.match(w.message, /no proxy in the pool says which country/i);
});

test("asking for no region asks nothing of the pool", async () => {
  const r = await gates({ steps: [], proxyCountries: [], region: "" });
  assert.ok(!codes(r).includes("ProxyGeoMismatch"));
});

// ── The region the gate reads is the one geo rotation uses ───────────────────

test("geo rotation and the gate read one setting", async () => {
  // Before this, selectProxy's geo mode read a targetCountry nobody passed and
  // behaved exactly like random — a fourth rotation mode that was really the
  // second one.
  proxy.setTargetCountry("gb");
  assert.equal(proxy.getTargetCountry(), "GB");
  proxy.setTargetCountry("");
  assert.equal(proxy.getTargetCountry(), "");
});

test("only live proxies count towards the region", async () => {
  proxy.addToPool([
    { host: "1.1.1.1", port: 8080, type: "http", country: "GB" },
    { host: "2.2.2.2", port: 8080, type: "http", country: "US" },
  ]);
  const all = proxy.poolCountries();
  assert.ok(all.includes("GB") && all.includes("US"));
});

// ── VQ-17: what port means SOCKS ─────────────────────────────────────────────

test("Tor's ports are read as SOCKS, not as HTTP", () => {
  // 9050 and 9150 are the Tor daemon and Tor Browser's bundled client. Guessing
  // http for those produced a proxy that connected and then failed every
  // request, with nothing saying why.
  const parsed = proxy.parseProxyText(
    ["10.0.0.1:9050", "10.0.0.2:9150", "10.0.0.3:1081", "10.0.0.4:8080"].join(
      "\n",
    ),
  );
  assert.deepEqual(
    parsed.map((p) => p.type),
    ["socks5", "socks5", "socks5", "http"],
  );
});

test("a line that names its protocol is not guessed at", () => {
  const parsed = proxy.parseProxyText("http://10.0.0.5:9050");
  assert.equal(parsed[0].type, "http");
});
