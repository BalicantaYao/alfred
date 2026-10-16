import path from "node:path";
import { pathToFileURL } from "node:url";
import express from "express";
import * as line from "@line/bot-sdk";
import {
  applyParsedIntent,
  getItems,
  handleShoppingCommand,
  loadLists,
  SHOPPING_HELP,
} from "./shoppingList.js";
import { llmEnabled, parseShoppingIntent } from "./llmParser.js";
import { handleReminderCommand, loadReminders, REMINDER_HELP, remindersSchedulerEnabled } from "./reminders.js";
import { startScheduler } from "./scheduler.js";
import { calendarDigestJob } from "./jobs/calendarDigest.js";

const config = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
});

const app = express();

// Railway 健康檢查 / 瀏覽器直接開啟時的回應
app.get("/", (req, res) => {
  res.send("Alfred LINE Bot is running.");
});

// LINE Webhook 入口。line.middleware 會驗證 X-Line-Signature,
// 不要在這條路由之前掛 express.json(),否則簽名驗證會失敗
app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err);
    res.sendStatus(500);
  }
});

async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") {
    return;
  }

  const userText = event.message.text.trim();
  // 群組/聊天室共用一份清單,一對一聊天則是個人清單
  const ownerId =
    event.source.groupId || event.source.roomId || event.source.userId;
  const replyText = await buildReply(userText, ownerId);
  // 沒有比對到任何指令時不回覆,避免在群組裡對一般聊天訊息洗版
  if (replyText === null) {
    return;
  }

  await client.replyMessage({
    replyToken: event.replyToken,
    messages: [{ type: "text", text: replyText }],
  });
}

export async function buildReply(text, ownerId) {
  if (text === "help" || text === "幫助") {
    const llmNote = llmEnabled()
      ? "\n\n也可以直接用自然語言,例如:\n「幫我記一下要去蝦皮買行動電源跟手機殼」\n「牛奶買到了」"
      : "";
    return `我是 Alfred 🤖\n\n${SHOPPING_HELP}\n\n${REMINDER_HELP}${llmNote}`;
  }

  // 1. 精確指令(免費、零延遲)。提醒先於購物清單,避免指令被誤判
  const reminderReply = await handleReminderCommand(ownerId, text);
  if (reminderReply !== null) return reminderReply;

  const shoppingReply = handleShoppingCommand(ownerId, text);
  if (shoppingReply !== null) {
    return shoppingReply;
  }

  // 2. 自由格式:用 Claude 解析意圖後套用到清單
  if (llmEnabled()) {
    try {
      const parsed = await parseShoppingIntent(text, getItems(ownerId));
      const llmReply = applyParsedIntent(ownerId, parsed);
      if (llmReply !== null) {
        return llmReply;
      }
    } catch (err) {
      console.error("LLM parse error:", err);
    }
  }

  // 不是指令也解析不出意圖:不回覆
  return null;
}

// 簽名驗證失敗時回 401,避免 middleware 錯誤直接變成 500
app.use((err, req, res, next) => {
  if (err instanceof line.SignatureValidationFailed) {
    res.sendStatus(401);
    return;
  }
  if (err instanceof line.JSONParseError) {
    res.sendStatus(400);
    return;
  }
  next(err);
});

export function startAlfred() {
  // 程序內每 30 秒看一次訂閱。同一天的推播用 job_runs 搶鎖,
  // 多個 replica 或重啟也不會重複送到同一個聊天室。
  if (remindersSchedulerEnabled()) {
    startScheduler({
      jobs: [calendarDigestJob],
      push: async (to, text, { retryKey } = {}) => {
        await client.pushMessage({ to, messages: [{ type: "text", text }] }, retryKey);
      },
    });
    console.log("Reminder scheduler started");
  }

  const port = process.env.PORT || 3000;
  return app.listen(port, () => {
    console.log(`Alfred LINE Bot listening on port ${port}`);
  });
}

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

// DATABASE_URL 有設但連不上時直接讓程序失敗,交給 Railway restart,
// 避免默默 fallback 到 ephemeral 檔案系統造成資料無聲流失
if (isDirectRun()) {
  await loadLists();
  await loadReminders();
  startAlfred();
}
