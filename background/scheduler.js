// === scheduler.js ===
/**
 * @module scheduler
 * @description Running a pipeline on a schedule, with no server anywhere.
 *
 *   Both external reviews called the absence of this disqualifying, and both
 *   assumed fixing it meant a cloud runner and a subscription. It does not.
 *   `chrome.alarms` is already a granted permission, used until now for
 *   nothing but a service-worker heartbeat. A schedule is a stored pipeline
 *   and an alarm; the run happens in the browser the user already has open.
 *
 *   That buys something real and costs something real, and both belong on
 *   screen rather than in a support thread:
 *
 *   - **Chrome has to be running.** There is no machine anywhere else. A
 *     schedule set for 3am runs at 3am if the laptop is awake and does not if
 *     it is shut. Nothing here can change that, so the panel says it.
 *   - **A minute is the floor.** MV3 clamps alarm periods, so "every 10
 *     seconds" is not on offer. Accepting it and firing at a different rate
 *     would be worse than refusing it.
 *   - **A missed window is reported.** This is the part that decides whether
 *     the feature can be trusted at all: a nightly run that did not happen
 *     because the laptop was shut has to say so, or the gap in the data looks
 *     exactly like the site having had no results that night.
 *
 *   And one thing it deliberately will not do: catch up. Waking to nine missed
 *   hours and firing nine scrapes back to back hammers the site and is nobody's
 *   idea of "every hour". The windows are counted, named, and let go.
 *
 * @dependencies utils/logger.js
 */

import { logger } from "../utils/logger.js";

const MODULE = "scheduler";

/** Where schedules live. Local rather than session: they outlive the browser. */
export const SCHEDULE_STORAGE_KEY = "vq_schedules_v1";

/** So a schedule's alarm is never confused with the keep-alive heartbeat. */
const ALARM_PREFIX = "vq_schedule_";

/**
 * The shortest period Chrome will honour for an alarm.
 *
 * Exported so the panel can say it before the user types a number, rather than
 * silently rounding one up afterwards.
 */
export const MIN_PERIOD_MINUTES = 1;

/** Past this, a schedule list is a cron server and belongs somewhere else. */
export const MAX_SCHEDULES = 20;

/** The alarm belonging to a schedule. */
export function alarmName(id) {
  return `${ALARM_PREFIX}${id}`;
}

/**
 * The schedule an alarm belongs to, or null if the alarm is not one of ours.
 *
 * The heartbeat shares the alarm namespace, and reading it as a schedule would
 * start a pipeline every minute.
 */
export function scheduleIdFromAlarm(name) {
  const s = String(name ?? "");
  return s.startsWith(ALARM_PREFIX) ? s.slice(ALARM_PREFIX.length) : null;
}

/**
 * Check a schedule and fill in what it did not say.
 *
 * @param {object} input
 * @returns {{schedule: object, note: string}} `note` is empty unless something
 *   was changed rather than accepted — a silent clamp is how a user ends up
 *   believing a schedule runs at a rate it does not.
 * @throws when the schedule could not run at all
 */
export function normaliseSchedule(input = {}) {
  let note = "";

  const url = String(input.url ?? "").trim();
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("A schedule needs a full http:// or https:// address.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    // This value becomes a tab the browser opens on a timer, unattended.
    // `javascript:` or `file:` there is a different feature entirely.
    throw new Error(
      `A schedule can only open an http:// or https:// page, not ${parsed.protocol}`,
    );
  }

  const steps = input.pipeline?.steps;
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error("A schedule needs a pipeline with at least one step.");
  }

  let everyMinutes = Number(input.everyMinutes);
  if (!Number.isFinite(everyMinutes) || everyMinutes < MIN_PERIOD_MINUTES) {
    everyMinutes = MIN_PERIOD_MINUTES;
    note = `Chrome will not fire an alarm more often than once a minute, so this runs every ${MIN_PERIOD_MINUTES} minute(s).`;
  }
  everyMinutes = Math.round(everyMinutes);

  return {
    schedule: {
      id:
        input.id ||
        `sch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name: String(input.name ?? "").slice(0, 80) || parsed.hostname,
      url: parsed.href,
      everyMinutes,
      pipeline: { name: input.pipeline.name ?? "", steps },
      enabled: input.enabled !== false,
      lastRunAt: input.lastRunAt ?? null,
      lastStatus: input.lastStatus ?? null,
      createdAt: input.createdAt ?? Date.now(),
    },
    note,
  };
}

/**
 * How many firings this schedule should have had and did not.
 *
 * Chrome fires an overdue alarm once when the browser comes back, and does not
 * say how long it was down. The stored `lastRunAt` does: everything between it
 * and now, minus the run happening at this moment, is a window that passed
 * with the browser shut or the extension unloaded.
 *
 * @param {object} schedule
 * @param {number} now
 * @returns {number}
 */
export function missedWindows(schedule, now = Date.now()) {
  // Never run: nothing was promised before the schedule existed, so reporting
  // hundreds of missed windows on the first firing would be nonsense.
  if (!schedule?.lastRunAt) return 0;
  const period = Math.max(1, Number(schedule.everyMinutes) || 1) * 60_000;
  const elapsed = now - schedule.lastRunAt;
  return Math.max(0, Math.floor(elapsed / period) - 1);
}

/** Every stored schedule. */
export async function listSchedules() {
  const stored = await chrome.storage.local.get(SCHEDULE_STORAGE_KEY);
  const list = stored?.[SCHEDULE_STORAGE_KEY];
  return Array.isArray(list) ? list : [];
}

/** One schedule by id, or null. */
export async function getSchedule(id) {
  return (await listSchedules()).find((s) => s.id === id) ?? null;
}

/**
 * Add or replace a schedule.
 *
 * @param {object} input
 * @returns {Promise<object>} the stored schedule
 */
export async function saveSchedule(input) {
  const { schedule, note } = normaliseSchedule(input);
  const list = await listSchedules();
  const at = list.findIndex((s) => s.id === schedule.id);

  if (at === -1 && list.length >= MAX_SCHEDULES) {
    throw new Error(
      `${MAX_SCHEDULES} schedules is the limit; delete one before adding another.`,
    );
  }
  if (at === -1) list.push(schedule);
  else list[at] = schedule;

  await chrome.storage.local.set({ [SCHEDULE_STORAGE_KEY]: list });
  logger.info(MODULE, "saved", {
    id: schedule.id,
    everyMinutes: schedule.everyMinutes,
  });
  return { ...schedule, note };
}

/** Record what happened on a firing, so the next one can count the gap. */
export async function markRun(id, status) {
  const list = await listSchedules();
  const at = list.findIndex((s) => s.id === id);
  if (at === -1) return null;
  list[at] = { ...list[at], lastRunAt: Date.now(), lastStatus: status };
  await chrome.storage.local.set({ [SCHEDULE_STORAGE_KEY]: list });
  return list[at];
}

/** Remove a schedule. Its alarm goes with it on the next sync. */
export async function deleteSchedule(id) {
  const list = await listSchedules();
  const kept = list.filter((s) => s.id !== id);
  await chrome.storage.local.set({ [SCHEDULE_STORAGE_KEY]: kept });
  await chrome.alarms.clear(alarmName(id));
  return kept.length !== list.length;
}

/**
 * Make the alarms match the stored schedules.
 *
 * Both directions matter. A schedule with no alarm never runs, which is the
 * obvious half. An alarm with no schedule fires forever, for something the
 * user deleted and can no longer see or stop — which is the worse half, and
 * the one that only shows up after an uninstall-reinstall or a storage wipe.
 */
export async function syncAlarms() {
  const list = await listSchedules();
  const wanted = new Map(
    list.filter((s) => s.enabled).map((s) => [alarmName(s.id), s]),
  );

  const existing = await chrome.alarms.getAll();
  for (const alarm of existing) {
    if (scheduleIdFromAlarm(alarm.name) === null) continue; // not ours
    if (!wanted.has(alarm.name)) await chrome.alarms.clear(alarm.name);
  }

  const live = new Set(
    existing.map((a) => a.name).filter((n) => wanted.has(n)),
  );
  for (const [name, schedule] of wanted) {
    if (live.has(name)) continue;
    await chrome.alarms.create(name, {
      periodInMinutes: schedule.everyMinutes,
      delayInMinutes: schedule.everyMinutes,
    });
  }

  logger.info(MODULE, "alarms-synced", { schedules: wanted.size });
  return wanted.size;
}

// === END scheduler.js ===
