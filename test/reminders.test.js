import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alfred-reminders-"));

let handleReminderCommand;
let loadReminders;
let setSubscription;

test.before(async () => {
  delete process.env.DATABASE_URL;
  process.env.DATA_DIR = dir;
  process.env.REMINDER_TIMEZONE = "Asia/Taipei";
  process.env.REMINDER_DEFAULT_TIME = "08:00";
  process.env.REMINDER_ENABLED = "true";
  delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64;
  delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON_PATH;
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  delete process.env.GOOGLE_REFRESH_TOKEN;

  ({ handleReminderCommand, loadReminders, setSubscription } = await import("../reminders.js"));
  await loadReminders();
});

test.after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test("subscribe, change time, status, and cancel", async () => {
  const first = await handleReminderCommand("U1", "訂閱提醒 8：20");
  assert.match(first, /已訂閱每日行事曆提醒/);
  assert.match(first, /08:20\(台北時間\)/);
  assert.match(first, /尚未設定 Google 日曆/);

  const same = await handleReminderCommand("U1", "提醒時間 08:20");
  assert.match(same, /已經訂閱/);

  const changed = await handleReminderCommand("U1", "提醒時間 21:05");
  assert.match(changed, /已改為 21:05/);

  await loadReminders();
  const status = await handleReminderCommand("U1", "提醒狀態");
  assert.match(status, /已訂閱,每天 21:05/);

  const removed = await handleReminderCommand("U1", "取消提醒");
  assert.match(removed, /已取消/);
  await loadReminders();
  assert.match(await handleReminderCommand("U1", "提醒"), /未訂閱/);
  assert.match(await handleReminderCommand("U1", "取消提醒"), /目前沒有訂閱/);
});

test("invalid times do not subscribe, and the default time comes from the environment", async () => {
  assert.match(await handleReminderCommand("U2", "訂閱提醒 25:00"), /時間格式不對/);
  assert.match(await handleReminderCommand("U2", "提醒時間"), /請指定時間/);
  assert.match(await handleReminderCommand("U2", "提醒狀態"), /未訂閱/);

  process.env.REMINDER_DEFAULT_TIME = "07:45";
  assert.match(await handleReminderCommand("U2", "訂閱提醒"), /07:45/);
  process.env.REMINDER_DEFAULT_TIME = "08:00";

  assert.equal(await handleReminderCommand("U2", "買 牛奶 @家樂福"), null);
});

test("a disabled scheduler is mentioned, and other jobs can be stored", async () => {
  process.env.REMINDER_ENABLED = "false";
  try {
    assert.match(await handleReminderCommand("U3", "訂閱提醒"), /REMINDER_ENABLED/);
  } finally {
    process.env.REMINDER_ENABLED = "true";
  }

  setSubscription("U3", "ping", "22:00");
  await loadReminders();
  const saved = JSON.parse(fs.readFileSync(path.join(dir, "reminders.json"), "utf8"));
  assert.equal(saved.U3.ping.time, "22:00");
  assert.equal(saved.U3["calendar-digest"].time, "08:00");
});

test("preview without credentials explains what is missing", async () => {
  assert.match(await handleReminderCommand("U4", "預覽提醒"), /尚未設定 Google 日曆憑證/);
});
