// Running a pipeline on a schedule, without a server.
//
// Both external reviews called this disqualifying, and they were right: a
// scraper you have to remember to press Run on is a demo. What they assumed is
// that fixing it needs a cloud runner and a subscription. It does not.
// `chrome.alarms` is already a granted permission, used for nothing but a
// service-worker heartbeat.
//
// What that buys is real, and what it costs is real too, and both have to be
// said in the panel rather than discovered:
//
//   - **Chrome has to be running.** There is no machine anywhere else. A
//     schedule set for 3am runs at 3am if the laptop is awake, and does not if
//     it is shut.
//   - **A minute is the floor.** MV3 clamps alarms, so "every 10 seconds" is
//     not a thing this can offer, and pretending otherwise would just be a
//     schedule that quietly fires at a different rate than the one on screen.
//   - **A missed window is reported, not hidden.** This is the part that
//     decides whether the feature can be trusted: a nightly run that did not
//     happen because the laptop was shut has to say so, or the gap in the data
//     looks like the site having no results that night.
//
// And one thing it deliberately does not do: catch up. Waking to find nine
// missed windows and running nine scrapes back to back is a worse outcome than
// the gap — it hammers the site, and it is nobody's idea of "every hour".
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// A minimal chrome, so the module under test is exercised rather than mocked
// around. The worker harness's alarms stub is a no-op and would let a broken
// sync pass.
const alarms = new Map();
globalThis.chrome = {
  alarms: {
    async create(name, info) {
      alarms.set(name, info);
    },
    async clear(name) {
      return alarms.delete(name);
    },
    async getAll() {
      return [...alarms].map(([name, info]) => ({ name, ...info }));
    },
    onAlarm: { addListener() {} },
  },
  storage: {
    local: {
      _d: {},
      async get(k) {
        return k in this._d ? { [k]: this._d[k] } : {};
      },
      async set(o) {
        Object.assign(this._d, o);
      },
    },
  },
  runtime: { async sendMessage() {} },
};

const sched = await import("../background/scheduler.js");
const {
  normaliseSchedule,
  missedWindows,
  saveSchedule,
  listSchedules,
  deleteSchedule,
  syncAlarms,
  alarmName,
  scheduleIdFromAlarm,
  MIN_PERIOD_MINUTES,
} = sched;

const MIN = 60_000;
const PIPELINE = { name: "nightly", steps: [{ id: "s1", type: "WEBSITE" }] };
const base = (over = {}) => ({
  name: "nightly",
  url: "https://shop.test/",
  everyMinutes: 60,
  pipeline: PIPELINE,
  ...over,
});

// ── What a schedule is allowed to be ─────────────────────────────────────────

test("a period Chrome will not honour is raised to the one it will", () => {
  // Silently firing at a different rate than the number on screen is how a
  // user concludes the feature is broken. Clamped, and the floor is exported
  // so the panel can say it before they type.
  const { schedule, note } = normaliseSchedule(base({ everyMinutes: 0.16 }));
  assert.equal(schedule.everyMinutes, MIN_PERIOD_MINUTES);
  assert.match(note, /minute/i);
});

test("a schedule opens a tab, so it needs a real page to open", () => {
  // `javascript:` and `file:` in a field that becomes a tab the browser opens
  // on a timer, unattended, is a different feature to the one being built.
  for (const url of ["javascript:alert(1)", "file:///etc/passwd", "", "shop"]) {
    assert.throws(
      () => normaliseSchedule(base({ url })),
      /http/i,
      `${url} should not be schedulable`,
    );
  }
  assert.equal(normaliseSchedule(base()).schedule.url, "https://shop.test/");
});

test("a schedule with no pipeline is refused rather than stored", () => {
  assert.throws(() => normaliseSchedule(base({ pipeline: null })), /step/i);
  assert.throws(
    () => normaliseSchedule(base({ pipeline: { steps: [] } })),
    /step/i,
  );
});

test("a new schedule is on, and carries its own id", () => {
  const { schedule } = normaliseSchedule(base());
  assert.equal(schedule.enabled, true);
  assert.match(schedule.id, /\S/);
  assert.equal(schedule.lastRunAt, null);
});

// ── The part that decides whether it can be trusted ──────────────────────────

test("a window that passed while the browser was shut is counted", () => {
  const now = Date.UTC(2026, 0, 2, 9, 0);
  const schedule = normaliseSchedule(base({ everyMinutes: 60 })).schedule;
  schedule.lastRunAt = now - 5 * 60 * MIN;
  // Five hours since the last run, one of which is the run happening now.
  assert.equal(missedWindows(schedule, now), 4);
});

test("a schedule that has never run has missed nothing", () => {
  // Nothing was promised before it existed, and reporting "you missed 700
  // windows" on a first run would be nonsense.
  const { schedule } = normaliseSchedule(base());
  assert.equal(missedWindows(schedule, Date.now()), 0);
});

test("a run that happened on time missed nothing", () => {
  const now = Date.now();
  const { schedule } = normaliseSchedule(base({ everyMinutes: 60 }));
  schedule.lastRunAt = now - 61 * MIN;
  assert.equal(missedWindows(schedule, now), 0);
});

test("missed windows are reported, never re-run", () => {
  const src = readFileSync(
    new URL("../background/scheduler.js", import.meta.url),
    "utf8",
  );
  // Waking to nine missed hours and firing nine scrapes back to back hammers
  // the site and is nobody's idea of "every hour".
  assert.match(src, /missed/i);
  assert.ok(!/for \(let i = 0; i < missed/.test(src), "it tries to catch up");
});

// ── Storage and alarms staying in step ───────────────────────────────────────

/** Storage is shared between tests, the way it is between runs. */
const fresh = async () => {
  chrome.storage.local._d = {};
  alarms.clear();
};

test("a saved schedule comes back", async () => {
  await fresh();
  const saved = await saveSchedule(base({ name: "prices" }));
  const all = await listSchedules();
  assert.equal(all.length, 1);
  assert.equal(all[0].name, "prices");
  assert.equal(all[0].id, saved.id);
});

test("saving an existing schedule edits it rather than adding a second", async () => {
  await fresh();
  const saved = await saveSchedule(base({ name: "prices" }));
  await saveSchedule({ ...saved, everyMinutes: 120 });
  const all = await listSchedules();
  assert.equal(all.length, 1);
  assert.equal(all[0].everyMinutes, 120);
});

test("an alarm exists for every enabled schedule and no others", async () => {
  await fresh();
  const on = await saveSchedule(base({ name: "on" }));
  const off = await saveSchedule(base({ name: "off", enabled: false }));
  await syncAlarms();

  assert.ok(alarms.has(alarmName(on.id)), "the enabled one has no alarm");
  assert.ok(!alarms.has(alarmName(off.id)), "a disabled schedule still fires");
  assert.equal(alarms.get(alarmName(on.id)).periodInMinutes, 60);
});

test("deleting a schedule takes its alarm with it", async () => {
  await fresh();
  const one = await saveSchedule(base({ name: "gone" }));
  await syncAlarms();
  assert.ok(alarms.has(alarmName(one.id)));

  await deleteSchedule(one.id);
  await syncAlarms();
  // An orphaned alarm fires forever, for a schedule the user deleted and can
  // no longer see — the worst shape this feature could take.
  assert.ok(!alarms.has(alarmName(one.id)), "the alarm outlived the schedule");
});

test("an alarm names the schedule it belongs to, both ways", () => {
  const id = "sch_abc123";
  assert.equal(scheduleIdFromAlarm(alarmName(id)), id);
  assert.equal(
    scheduleIdFromAlarm("vq_sw_heartbeat"),
    null,
    "the keep-alive alarm must not be read as a schedule",
  );
});

// ── Wiring ───────────────────────────────────────────────────────────────────

test("the worker runs a schedule when its alarm fires", () => {
  const src = readFileSync(
    new URL("../background/service-worker.js", import.meta.url),
    "utf8",
  );
  assert.match(src, /scheduleIdFromAlarm\(/);
  assert.match(src, /schedule:save|schedule:list/);
});

test("a schedule does not start a second copy of itself", () => {
  // An hourly run over a slow site can still be going when the next hour comes
  // round. Two copies of the same pipeline on the same tab is not a schedule
  // running twice, it is a mess.
  const src = readFileSync(
    new URL("../background/service-worker.js", import.meta.url),
    "utf8",
  );
  assert.match(src, /already running/i);
});

test("the panel says what a local schedule cannot do", () => {
  const html = readFileSync(
    new URL("../sidepanel/index.html", import.meta.url),
    "utf8",
  );
  const panel = readFileSync(
    new URL("../sidepanel/pipeline-builder.js", import.meta.url),
    "utf8",
  );
  const both = html + panel;
  // The two limits a user has to know before they rely on it.
  assert.match(both, /Chrome (has to be|must be) running/i);
  assert.match(both, /missed/i);
});
