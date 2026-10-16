import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alfred-reply-"));

let buildReply;
let getItems;
let loadLists;
let loadReminders;

test.before(async () => {
  delete process.env.DATABASE_URL;
  process.env.DATA_DIR = dir;
  process.env.LINE_CHANNEL_SECRET ||= "test-secret";
  process.env.LINE_CHANNEL_ACCESS_TOKEN ||= "test-token";
  process.env.REMINDER_ENABLED = "false";
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64;
  delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON_PATH;
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  delete process.env.GOOGLE_REFRESH_TOKEN;

  ({ buildReply } = await import("../index.js"));
  ({ getItems, loadLists } = await import("../shoppingList.js"));
  ({ loadReminders } = await import("../reminders.js"));
  await loadLists();
  await loadReminders();
});

test.after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test("shopping commands still work and reminder commands do not fall through", async () => {
  const owner = "Creply";
  const help = await buildReply("幫助", owner);
  assert.match(help, /購物清單指令/);
  assert.match(help, /訂閱提醒/);

  assert.match(await buildReply("買 牛奶 @家樂福", owner), /已加入:牛奶\(家樂福\)/);
  assert.match(await buildReply("清單", owner), /1\. 牛奶/);
  assert.equal(getItems(owner).length, 1);

  const subscribed = await buildReply("訂閱提醒 08:20", owner);
  assert.match(subscribed, /08:20/);
  assert.equal(getItems(owner).length, 1);
  assert.match(await buildReply("提醒狀態", owner), /已訂閱/);

  assert.match(await buildReply("買到 1", owner), /已刪除:牛奶/);
  assert.match(await buildReply("清空清單", owner), /已清空/);
  assert.equal(await buildReply("今天天氣真好", owner), null);
  assert.match(await buildReply("預覽提醒", owner), /尚未設定 Google 日曆/);
  assert.match(await buildReply("取消提醒", owner), /已取消/);
});
