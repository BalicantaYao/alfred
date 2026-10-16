import { calendarConfigured } from "./calendar.js";
import { CALENDAR_DIGEST_JOB_ID, previewCalendarDigest } from "./jobs/calendarDigest.js";
import { loadReminderSubscriptions, persistReminderOwner } from "./storage.js";
import { getTimeZone, timeZoneLabel } from "./time.js";

// ownerId -> { [jobId]: { time: "HH:MM" } }
let subscriptions = {};

export async function loadReminders() {
  subscriptions = await loadReminderSubscriptions();
}

export function listEnabledSubscriptions() {
  const out = [];
  for (const [ownerId, jobs] of Object.entries(subscriptions)) {
    for (const [jobId, sub] of Object.entries(jobs || {})) {
      if (sub?.time) out.push({ ownerId, jobId, time: sub.time });
    }
  }
  return out;
}

export function setSubscription(ownerId, jobId, time) {
  if (!subscriptions[ownerId]) subscriptions[ownerId] = {};
  subscriptions[ownerId][jobId] = { time };
  persistReminderOwner(ownerId, subscriptions);
}

export function clearSubscription(ownerId, jobId) {
  if (!subscriptions[ownerId]?.[jobId]) return false;
  delete subscriptions[ownerId][jobId];
  if (Object.keys(subscriptions[ownerId]).length === 0) delete subscriptions[ownerId];
  persistReminderOwner(ownerId, subscriptions);
  return true;
}

export function remindersSchedulerEnabled() {
  const value = (process.env.REMINDER_ENABLED ?? "true").toLowerCase();
  return value !== "false" && value !== "0" && value !== "off";
}

export function normalizeTime(input) {
  if (typeof input !== "string") return null;
  const match = input.trim().match(/^(\d{1,2})\s*[:：]\s*(\d{1,2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function defaultReminderTime() {
  return normalizeTime(process.env.REMINDER_DEFAULT_TIME || "08:00") || "08:00";
}

export const REMINDER_HELP = [
  "⏰ 每日行事曆提醒:",
  "- 訂閱提醒:每天推播今天與明天的行程(可加時間,如「訂閱提醒 08:20」)",
  "- 提醒時間 08:20:調整推播時間",
  "- 提醒狀態:查看目前設定",
  "- 預覽提醒:立刻回覆今天與明天的行程(不計入推播額度)",
  "- 取消提醒:停止推播",
].join("\n");

function configNotes() {
  const notes = [];
  if (!calendarConfigured()) {
    notes.push("尚未設定 Google 日曆憑證,在設定完成並重新部署前不會推播。");
  }
  if (!remindersSchedulerEnabled()) {
    notes.push("排程目前已用 REMINDER_ENABLED 停用。");
  }
  return notes.length > 0 ? `\n\n${notes.join("\n")}` : "";
}

function subscribe(ownerId, time) {
  const existing = subscriptions[ownerId]?.[CALENDAR_DIGEST_JOB_ID];
  setSubscription(ownerId, CALENDAR_DIGEST_JOB_ID, time);
  const zone = timeZoneLabel(getTimeZone());
  let text;
  if (!existing) {
    text = `已訂閱每日行事曆提醒,每天 ${time}(${zone})會推播今天與明天的行程。沒有行程的日子不會傳訊息。`;
  } else if (existing.time === time) {
    text = `已經訂閱每日行事曆提醒,時間是每天 ${time}(${zone})。`;
  } else {
    text = `每天的提醒時間已改為 ${time}(${zone})。`;
  }
  text += "\n輸入「提醒狀態」可查看設定,「取消提醒」可停止。";
  text += configNotes();
  return text;
}

function status(ownerId) {
  const sub = subscriptions[ownerId]?.[CALENDAR_DIGEST_JOB_ID];
  const zone = timeZoneLabel(getTimeZone());
  if (!sub) {
    return `每日行事曆提醒:未訂閱。輸入「訂閱提醒」即可開始,預設時間 ${defaultReminderTime()}(${zone})。${configNotes()}`;
  }
  return `每日行事曆提醒:已訂閱,每天 ${sub.time}(${zone})。${configNotes()}`;
}

// 回傳回覆文字;不是提醒指令時回傳 null,讓呼叫端繼續處理購物清單
export async function handleReminderCommand(ownerId, text) {
  const trimmed = text.trim();

  if (trimmed === "訂閱提醒") return subscribe(ownerId, defaultReminderTime());

  const subscribeWithTime = trimmed.match(/^訂閱提醒\s+(.+)$/);
  if (subscribeWithTime) {
    const time = normalizeTime(subscribeWithTime[1]);
    if (!time) return "時間格式不對,請用 24 小時制,例如「訂閱提醒 08:20」。";
    return subscribe(ownerId, time);
  }

  if (trimmed === "提醒時間") return "請指定時間,例如「提醒時間 08:20」。";

  const setTime = trimmed.match(/^提醒時間\s+(.+)$/);
  if (setTime) {
    const time = normalizeTime(setTime[1]);
    if (!time) return "時間格式不對,請用 24 小時制,例如「提醒時間 08:20」。";
    return subscribe(ownerId, time);
  }

  if (trimmed === "取消提醒") {
    if (!clearSubscription(ownerId, CALENDAR_DIGEST_JOB_ID)) {
      return "目前沒有訂閱提醒。輸入「訂閱提醒」即可開始。";
    }
    return "已取消每日行事曆提醒,之後不會再推播。";
  }

  if (trimmed === "提醒狀態" || trimmed === "提醒") return status(ownerId);

  if (trimmed === "預覽提醒") return previewCalendarDigest(new Date());

  return null;
}
