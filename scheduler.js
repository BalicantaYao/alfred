import { listEnabledSubscriptions } from "./reminders.js";
import { claimJobRun, finishJobRun } from "./storage.js";
import { getTimeZone, zonedParts } from "./time.js";

const LINE_TEXT_LIMIT = 5000;
const notReadyLogged = new Set();

export function parseTimeToMinutes(hhmm) {
  const match = /^(\d{2}):(\d{2})$/.exec(hhmm || "");
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

// 已過設定時間、而且還在補送窗口內,才算這輪該送。窗口預設 3 小時,
// 重啟晚幾分鐘還是補得上;過了午夜就改看新的一天,不會補送昨天的。
export function isDue(timeHHMM, parts, catchupMinutes) {
  const target = parseTimeToMinutes(timeHHMM);
  if (target === null) return false;
  const current = parts.hour * 60 + parts.minute;
  if (current < target) return false;
  return current - target <= catchupMinutes;
}

export function getCatchupMinutes() {
  const raw = process.env.REMINDER_CATCHUP_MINUTES;
  if (raw === undefined || raw === "") return 180;
  const minutes = Number(raw);
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 24 * 60) return 180;
  return minutes;
}

function getTickMs() {
  const ms = Number(process.env.REMINDER_TICK_MS ?? 30_000);
  if (!Number.isFinite(ms) || ms < 5_000) return 30_000;
  return ms;
}

function boundText(text) {
  if (text.length <= LINE_TEXT_LIMIT) return text;
  const suffix = "\n…(內容過長已截斷)";
  return text.slice(0, LINE_TEXT_LIMIT - suffix.length) + suffix;
}

function pushGaveUp(err) {
  return err?.status === 400 || err?.status === 403 || err?.status === 404;
}

export async function runSchedulerTick({
  jobs,
  push,
  now = new Date(),
  timeZone = getTimeZone(),
  catchupMinutes = getCatchupMinutes(),
  listSubscriptions = listEnabledSubscriptions,
  claim = claimJobRun,
  finish = finishJobRun,
  log = console,
} = {}) {
  const parts = zonedParts(now, timeZone);
  const jobsById = new Map(jobs.map((job) => [job.id, job]));
  const subscriptions = [...listSubscriptions()].sort(
    (a, b) => a.jobId.localeCompare(b.jobId) || a.ownerId.localeCompare(b.ownerId)
  );

  for (const sub of subscriptions) {
    try {
      await runSubscription(sub, {
        jobsById,
        parts,
        catchupMinutes,
        claim,
        finish,
        push,
        now,
        timeZone,
        log,
      });
    } catch (err) {
      log.error?.("Scheduler item error:", err);
    }
  }
}

async function runSubscription(sub, ctx) {
  const job = ctx.jobsById.get(sub.jobId);
  if (!job) return;
  if (!isDue(sub.time, ctx.parts, ctx.catchupMinutes)) return;

  if (typeof job.ready === "function" && !job.ready()) {
    if (!notReadyLogged.has(job.id)) {
      notReadyLogged.add(job.id);
      ctx.log.log?.(
        `Reminder job skipped: ${job.id} is not ready`
      );
    }
    return;
  }

  const key = `${job.id}|${sub.ownerId}|${ctx.parts.dateKey}`;
  let claimed;
  try {
    claimed = await ctx.claim(key);
  } catch (err) {
    ctx.log.error?.(`Reminder claim failed: ${key}`, err);
    return;
  }
  if (!claimed?.ok) return;

  try {
    const text = await job.run({
      ownerId: sub.ownerId,
      now: ctx.now,
      timeZone: ctx.timeZone,
      dateKey: ctx.parts.dateKey,
    });
    if (text && String(text).trim()) {
      await ctx.push(sub.ownerId, boundText(String(text)), { retryKey: claimed.retryKey });
      ctx.log.log?.(`Reminder sent: ${job.id} -> ${sub.ownerId}`);
    } else {
      ctx.log.log?.(`Reminder quiet: ${job.id} -> ${sub.ownerId}`);
    }
    await ctx.finish(key, "done");
  } catch (err) {
    const status = pushGaveUp(err) ? "done" : "failed";
    const detail = err?.status
      ? `${err.status} ${String(err.body || err.message || "").slice(0, 300)}`
      : err;
    ctx.log.error?.(
      status === "done"
        ? `Reminder push rejected, will not retry today: ${job.id} -> ${sub.ownerId}`
        : `Reminder failed, will retry: ${job.id} -> ${sub.ownerId}`,
      detail
    );
    try {
      await ctx.finish(key, status);
    } catch (finishErr) {
      ctx.log.error?.("Reminder finish failed:", finishErr);
    }
  }
}

export function startScheduler({ jobs, push }) {
  let timeZone = getTimeZone();
  try {
    Intl.DateTimeFormat("en-US", { timeZone });
  } catch {
    console.error(`Invalid REMINDER_TIMEZONE=${timeZone}, falling back to Asia/Taipei`);
    timeZone = "Asia/Taipei";
  }

  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    runSchedulerTick({ jobs, push, timeZone })
      .catch((err) => console.error("Scheduler tick error:", err))
      .finally(() => {
        running = false;
      });
  };

  const startup = setTimeout(tick, 5_000);
  const timer = setInterval(tick, getTickMs());
  return () => {
    clearTimeout(startup);
    clearInterval(timer);
  };
}
