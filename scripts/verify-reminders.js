// 用假的 Google 日曆與 LINE push,跑過排程器一次。
//   node scripts/verify-reminders.js
//
// 驗證:訂閱指令、購物清單不受影響、行程摘要內容、沒行程不推播、
// 同一天不重複送、送失敗會用同一組 LINE retry key 重試、
// 並行 tick 只會有一個搶到鎖、別的 job 可以一起掛上。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alfred-reminders-"));
delete process.env.DATABASE_URL;
process.env.DATA_DIR = tmp;
process.env.REMINDER_DEFAULT_TIME = "08:00";
process.env.REMINDER_TIMEZONE = "Asia/Taipei";
process.env.REMINDER_CATCHUP_MINUTES = "180";
delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64;
delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON_PATH;
delete process.env.GOOGLE_CLIENT_ID;
delete process.env.GOOGLE_CLIENT_SECRET;
delete process.env.GOOGLE_REFRESH_TOKEN;

const { loadReminders, handleReminderCommand, setSubscription } = await import("../reminders.js");
const { getItems, handleShoppingCommand } = await import("../shoppingList.js");
const { runSchedulerTick } = await import("../scheduler.js");
const { createCalendarDigestJob } = await import("../jobs/calendarDigest.js");
const { closeStorage } = await import("../storage.js");

const log = { log() {}, error() {} };
const now = new Date("2026-10-16T00:20:00.000Z"); // 台北 08:20

const sampleEvents = [
  {
    summary: "家族聚餐",
    status: "confirmed",
    start: { date: "2026-10-16" },
    end: { date: "2026-10-17" },
  },
  {
    summary: "週會",
    status: "confirmed",
    start: { dateTime: "2026-10-16T09:00:00+08:00" },
    end: { dateTime: "2026-10-16T10:00:00+08:00" },
    location: "3F 會議室",
  },
  {
    summary: "客戶會議",
    status: "confirmed",
    start: { dateTime: "2026-10-16T10:00:00+08:00" },
    end: { dateTime: "2026-10-16T10:45:00+08:00" },
    hangoutLink: "https://meet.google.com/abc-defg-hij",
  },
  {
    summary: "設計討論",
    status: "confirmed",
    start: { dateTime: "2026-10-16T10:30:00+08:00" },
    end: { dateTime: "2026-10-16T11:00:00+08:00" },
    location: "https://zoom.us/j/123456789",
  },
  {
    summary: "出遊：墾丁",
    status: "confirmed",
    start: { dateTime: "2026-10-16T13:00:00+08:00" },
    end: { dateTime: "2026-10-16T18:00:00+08:00" },
  },
  {
    summary: "已拒絕的會",
    status: "confirmed",
    start: { dateTime: "2026-10-16T15:00:00+08:00" },
    end: { dateTime: "2026-10-16T16:00:00+08:00" },
    attendees: [{ self: true, responseStatus: "declined" }],
  },
  {
    summary: "牙醫",
    status: "confirmed",
    start: { dateTime: "2026-10-17T15:00:00+08:00" },
    end: { dateTime: "2026-10-17T16:00:00+08:00" },
    location: "大安診所",
  },
];

let mode = "events";
const job = createCalendarDigestJob({
  fetchEvents: async () => {
    if (mode === "throw") {
      mode = "events";
      throw new Error("calendar down");
    }
    if (mode === "empty") return [];
    return sampleEvents;
  },
});

const pushes = [];
async function push(to, text, meta) {
  pushes.push({ to, text, retryKey: meta?.retryKey });
}

function tick(at = now, jobs = [job]) {
  return runSchedulerTick({ jobs, push, now: at, timeZone: "Asia/Taipei", log });
}

try {
  await loadReminders();

  const owner = "Udigest";
  assert.match(await handleReminderCommand(owner, "訂閱提醒 08:20"), /08:20/);
  handleShoppingCommand(owner, "買 牛奶 @家樂福");
  assert.equal(getItems(owner).length, 1);
  assert.match(handleShoppingCommand(owner, "清單"), /牛奶/);

  await tick();
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].to, owner);
  const digest = pushes[0].text;
  assert.match(digest, /09:00–10:00 週會/);
  assert.match(digest, /3F 會議室/);
  assert.match(digest, /https:\/\/meet\.google\.com\/abc-defg-hij/);
  assert.match(digest, /⚡ 緊接「週會」/);
  assert.match(digest, /⚠️ 與「客戶會議」時間重疊/);
  assert.match(digest, /全天 家族聚餐/);
  assert.match(digest, /牙醫/);
  assert.match(digest, /大安診所/);
  assert.match(digest, /https:\/\/zoom\.us\/j\/123456789/);
  assert.doesNotMatch(digest, /出遊：墾丁/);
  assert.doesNotMatch(digest, /已拒絕的會/);
  console.log("--- mocked morning digest ---");
  console.log(digest);

  // 模擬重啟:訂閱與 job_runs 都在檔案裡,再跑一次不該再推。
  await loadReminders();
  await tick();
  assert.equal(pushes.length, 1);
  const runs = JSON.parse(fs.readFileSync(path.join(tmp, "job-runs.json"), "utf8"));
  assert.equal(runs[`calendar-digest|${owner}|2026-10-16`].status, "done");
  assert.equal(getItems(owner).length, 1);

  mode = "empty";
  assert.match(await handleReminderCommand("Uquiet", "訂閱提醒 08:20"), /已訂閱/);
  await tick();
  assert.equal(pushes.length, 1);

  assert.match(await handleReminderCommand("Uflaky", "提醒時間 08:20"), /08:20/);
  mode = "throw";
  await tick();
  assert.equal(pushes.filter((item) => item.to === "Uflaky").length, 0);
  const flakyKey = "calendar-digest|Uflaky|2026-10-16";
  const afterFailure = JSON.parse(fs.readFileSync(path.join(tmp, "job-runs.json"), "utf8"));
  assert.equal(afterFailure[flakyKey].status, "failed");
  await tick();
  const flakyPushes = pushes.filter((item) => item.to === "Uflaky");
  assert.equal(flakyPushes.length, 1);
  assert.equal(flakyPushes[0].retryKey, afterFailure[flakyKey].retryKey);

  assert.match(await handleReminderCommand("Urace", "訂閱提醒 08:20"), /08:20/);
  await Promise.all([tick(), tick()]);
  assert.equal(pushes.filter((item) => item.to === "Urace").length, 1);

  assert.match(await handleReminderCommand("Uearly", "訂閱提醒 18:00"), /18:00/);
  await tick();
  assert.equal(pushes.filter((item) => item.to === "Uearly").length, 0);

  assert.match(await handleReminderCommand("Ulate", "訂閱提醒 08:20"), /08:20/);
  await tick(new Date("2026-10-16T06:00:00.000Z"));
  assert.equal(pushes.filter((item) => item.to === "Ulate").length, 0);

  setSubscription("Uping", "ping", "08:20");
  const pingPushes = [];
  await runSchedulerTick({
    jobs: [job, { id: "ping", async run() { return "pong"; } }],
    push: async (to, text) => {
      if (to === "Uping") pingPushes.push(text);
    },
    now,
    timeZone: "Asia/Taipei",
    log,
  });
  assert.deepEqual(pingPushes, ["pong"]);

  console.log("OK");
} finally {
  await closeStorage();
  fs.rmSync(tmp, { recursive: true, force: true });
}
