import { calendarConfigured, fetchCalendarEvents } from "../calendar.js";
import {
  BACK_TO_BACK_MINUTES,
  digestWindow,
  formatCalendarDigest,
  normalizeGoogleEvents,
} from "../digest.js";
import { getTimeZone } from "../time.js";

export const CALENDAR_DIGEST_JOB_ID = "calendar-digest";

function skipPrefix() {
  return process.env.CALENDAR_SKIP_TITLE_PREFIX ?? "出遊：";
}

// 之後要加別的排程,比照這個形狀:{ id, ready?, run }。
// run 回傳要推播的文字,或 null 表示這次不送。
export function createCalendarDigestJob({ fetchEvents } = {}) {
  return {
    id: CALENDAR_DIGEST_JOB_ID,
    ready() {
      return Boolean(fetchEvents) || calendarConfigured();
    },
    async run({ now, timeZone }) {
      const zone = timeZone || getTimeZone();
      const window = digestWindow(now, zone);
      const raw = fetchEvents
        ? await fetchEvents(window)
        : await fetchCalendarEvents({ timeMin: window.timeMin, timeMax: window.timeMax, now });
      const events = normalizeGoogleEvents(raw, { skipPrefix: skipPrefix(), timeZone: zone });
      return formatCalendarDigest(events, {
        now,
        timeZone: zone,
        backToBackMinutes: BACK_TO_BACK_MINUTES,
      });
    },
  };
}

export const calendarDigestJob = createCalendarDigestJob();

export async function previewCalendarDigest(now = new Date()) {
  if (!calendarConfigured()) {
    return "尚未設定 Google 日曆憑證,無法預覽。請先設定 service account 或 OAuth 環境變數。";
  }
  try {
    const text = await calendarDigestJob.run({ now, timeZone: getTimeZone() });
    if (text) return text;
    const prefix = skipPrefix();
    const skipNote = prefix ? `(標題以「${prefix}」開頭的活動不會列入)` : "";
    return `今天和明天沒有要提醒的行程${skipNote}。`;
  } catch (err) {
    console.error("Calendar preview error:", err);
    return "讀取 Google 日曆失敗,請稍後再試。詳情請看伺服器 log。";
  }
}
