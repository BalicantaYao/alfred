import cron from "node-cron";
import { buildTodayAgenda, calendarEnabled, DEFAULT_TZ } from "./calendar.js";

// 每天固定時間把今日行程推播到指定聊天。
// 需要的環境變數:
//   REMINDER_TO    推播對象的 LINE ID(userId / groupId,對 Bot 輸入「id」可查)
//   REMINDER_TIME  每天推播時間 HH:mm,預設 08:00
//   REMINDER_TZ    時區,預設 Asia/Taipei

export function startDailyReminder(client) {
  if (!calendarEnabled()) {
    console.log("Daily reminder disabled: GOOGLE_SERVICE_ACCOUNT_KEY / GOOGLE_CALENDAR_ID not set");
    return false;
  }
  const to = process.env.REMINDER_TO;
  if (!to) {
    console.log("Daily reminder disabled: REMINDER_TO not set (對 Bot 輸入「id」可查聊天 ID)");
    return false;
  }

  const time = process.env.REMINDER_TIME || "08:00";
  const match = time.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    console.error(`Invalid REMINDER_TIME "${time}", expected HH:mm`);
    return false;
  }
  const [, hour, minute] = match;

  cron.schedule(
    `${Number(minute)} ${Number(hour)} * * *`,
    async () => {
      try {
        const text = await buildTodayAgenda();
        await client.pushMessage({ to, messages: [{ type: "text", text }] });
      } catch (err) {
        console.error("Daily reminder error:", err);
      }
    },
    { timezone: DEFAULT_TZ }
  );

  console.log(`Daily reminder scheduled at ${time} (${DEFAULT_TZ}) -> ${to}`);
  return true;
}
