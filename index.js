import path from "path";
import { pathToFileURL } from "url";
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
import { initNotifyStorage } from "./storage.js";
import {
  handleNotifyBodyError,
  handleNotifyCommand,
  mountNotify,
  notifyToken,
  NOTIFY_HELP,
} from "./notify.js";
import {
  assistantHelpSuffix,
  assistantWebhookUrl,
  commandTextFor,
  maybeForwardToAssistant,
  warmBotUserId,
} from "./assistant.js";

// DATABASE_URL 有設但連不上時直接讓程序失敗,交給 Railway restart,
// 避免默默 fallback 到 ephemeral 檔案系統造成資料無聲流失
await loadLists();
await initNotifyStorage();

if (!notifyToken()) {
  console.log("NOTIFY_TOKEN 未設定,POST /notify 已關閉");
}

if (assistantWebhookUrl()) {
  console.log("助理轉發已啟用");
} else if (
  typeof process.env.ASSISTANT_WEBHOOK_URL === "string" &&
  process.env.ASSISTANT_WEBHOOK_URL.trim()
) {
  console.log("ASSISTANT_WEBHOOK_URL 不是可用的 https 網址,助理轉發已關閉");
} else {
  console.log("ASSISTANT_WEBHOOK_URL 未設定,助理轉發已關閉");
}

const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
});

export function createApp(lineClient) {
  const config = {
    channelSecret: process.env.LINE_CHANNEL_SECRET,
  };

  const app = express();

  app.get("/", (req, res) => {
    res.send("Alfred LINE Bot is running.");
  });

  // express.json() 只掛在 /notify。對整個 app 使用會吃掉 webhook 的 raw body,簽名驗證會失敗。
  mountNotify(app, {
    pushMessage: (body, retryKey) => lineClient.pushMessage(body, retryKey),
  });

  app.post("/webhook", line.middleware(config), async (req, res) => {
    try {
      await Promise.all(req.body.events.map((event) => handleEvent(event, lineClient)));
      res.sendStatus(200);
    } catch (err) {
      console.error("Webhook error:", err);
      res.sendStatus(500);
    }
  });

  app.use((err, req, res, next) => {
    if (err instanceof line.SignatureValidationFailed) {
      res.sendStatus(401);
      return;
    }
    if (err instanceof line.JSONParseError) {
      res.sendStatus(400);
      return;
    }
    if (handleNotifyBodyError(err, req, res)) return;
    next(err);
  });

  return app;
}

async function handleEvent(event, lineClient) {
  if (event.type !== "message" || event.message.type !== "text") {
    return;
  }
  if (typeof event.message?.text !== "string") return;

  const source = event.source || {};
  // 群組/聊天室共用一份清單,一對一聊天則是個人清單
  const ownerId = source.groupId || source.roomId || source.userId;
  // 有點名時用拿掉標記後的文字,購物清單和轉發指令仍優先,不會轉給助理
  const commandText = commandTextFor(event);
  const replyText = await buildReply(commandText, ownerId, source);
  if (replyText !== null) {
    await lineClient.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: "text", text: replyText }],
    });
    return;
  }

  // 沒有比對到指令:群組閒聊不轉發。點名或主人一對一才交給助理。
  try {
    await maybeForwardToAssistant(event, lineClient);
  } catch (err) {
    console.error(`assistant handler failed name=${err?.name || "Error"}`);
  }
}

export async function buildReply(text, ownerId, source = {}) {
  if (text === "help" || text === "幫助") {
    const llmNote = llmEnabled()
      ? "\n\n也可以直接用自然語言,例如:\n「幫我記一下要去蝦皮買行動電源跟手機殼」\n「牛奶買到了」"
      : "";
    return `我是 Alfred 🤖\n\n${SHOPPING_HELP}${llmNote}\n\n${NOTIFY_HELP}${assistantHelpSuffix()}`;
  }

  // 轉發指令先處理,避免被 LLM 當成購物意圖
  const notifyReply = handleNotifyCommand(text, source);
  if (notifyReply !== null) return notifyReply;

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
      console.error("LLM parse error:", err);
    }
  }

  // 不是指令也解析不出意圖:不回覆
  return null;
}

const app = createApp(client);

function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

if (isMainModule()) {
  void warmBotUserId(client);
  const port = process.env.PORT || 3000;
  const server = app.listen(port, () => {
    const bound = server.address();
    console.log(`Alfred LINE Bot listening on port ${bound?.port || port}`);
  });
}
