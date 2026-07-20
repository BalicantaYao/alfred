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
import { buildTodayAgenda, calendarEnabled } from "./calendar.js";
import { startDailyReminder } from "./reminder.js";

// DATABASE_URL 有設但連不上時直接讓程序失敗,交給 Railway restart,
// 避免默默 fallback 到 ephemeral 檔案系統造成資料無聲流失
await loadLists();

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

  await client.replyMessage({
    replyToken: event.replyToken,
    messages: [{ type: "text", text: replyText }],
  });
}

async function buildReply(text, ownerId) {
  if (text === "help" || text === "幫助") {
    const calendarNote = calendarEnabled()
      ? "\n\n📅 行事曆指令:\n- 行程:查看今天的 Google Calendar 行程\n- id:查詢這個聊天的 ID(設定每日提醒推播對象用)"
      : "";
    const llmNote = llmEnabled()
      ? "\n\n也可以直接用自然語言,例如:\n「幫我記一下要去蝦皮買行動電源跟手機殼」\n「牛奶買到了」"
      : "";
    return `我是 Alfred 🤖\n\n${SHOPPING_HELP}${calendarNote}${llmNote}`;
  }

  // 查詢聊天 ID,用來設定每日行程提醒的推播對象(REMINDER_TO)
  if (/^id$/i.test(text)) {
    return `這個聊天的 ID:\n${ownerId}\n\n把它設成 REMINDER_TO 環境變數,就會收到每日行程提醒`;
  }

  // 今日行程查詢
  if (/^(?:行程|今日行程|今天行程)$/.test(text)) {
    if (!calendarEnabled()) {
      return "還沒設定 Google Calendar 🙈\n請參考 README 設定 GOOGLE_SERVICE_ACCOUNT_KEY 與 GOOGLE_CALENDAR_ID";
    }
    try {
      return await buildTodayAgenda();
    } catch (err) {
      console.error("Calendar error:", err);
      return "查詢行事曆失敗了,請稍後再試 😢";
    }
  }

  // 1. 精確指令(免費、零延遲)
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
      // API 失敗時不擋住回覆,fallback 到 echo
      console.error("LLM parse error:", err);
    }
  }

  return `你說了:${text}`;
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

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Alfred LINE Bot listening on port ${port}`);
});

// 每天定時推播今日行程(需設定 Google Calendar 與 REMINDER_TO,詳見 README)
startDailyReminder(client);
