import express from "express";
import * as line from "@line/bot-sdk";
import {
  handleShoppingCommand,
  loadLists,
  SHOPPING_HELP,
} from "./shoppingList.js";

loadLists();

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
  const replyText = buildReply(userText, ownerId);

  await client.replyMessage({
    replyToken: event.replyToken,
    messages: [{ type: "text", text: replyText }],
  });
}

function buildReply(text, ownerId) {
  if (text === "help" || text === "幫助") {
    return `我是 Alfred 🤖\n\n${SHOPPING_HELP}\n\n其他文字我會直接回覆你`;
  }

  const shoppingReply = handleShoppingCommand(ownerId, text);
  if (shoppingReply !== null) {
    return shoppingReply;
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
