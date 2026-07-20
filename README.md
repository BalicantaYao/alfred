# Alfred — LINE Bot

一個串接 LINE Messaging API 的 Bot,使用 Node.js + Express + LINE 官方 SDK,可直接部署到 [Railway](https://railway.app/)。

## 功能

- 接收 LINE Webhook 事件(含 X-Line-Signature 簽名驗證)
- 回覆文字訊息(echo bot,可在 `index.js` 的 `buildReply()` 擴充自己的邏輯)
- `GET /` 健康檢查端點

## 事前準備:建立 LINE Channel

1. 到 [LINE Developers Console](https://developers.line.biz/console/) 登入
2. 建立一個 Provider(如果還沒有)
3. 建立 **Messaging API** channel
4. 記下兩個值:
   - **Channel secret**:在「Basic settings」分頁
   - **Channel access token**:在「Messaging API」分頁,點「Issue」產生 long-lived token

## 部署到 Railway

1. 到 [Railway](https://railway.app/) 建立新專案,選擇 **Deploy from GitHub repo**,連結這個 repo
2. 在專案的 **Variables** 設定環境變數:

   | 變數 | 值 |
   |------|-----|
   | `LINE_CHANNEL_SECRET` | LINE Channel secret |
   | `LINE_CHANNEL_ACCESS_TOKEN` | LINE Channel access token |

3. 部署完成後,到 **Settings → Networking → Generate Domain** 產生公開網址,例如 `https://alfred-production.up.railway.app`
4. 回到 LINE Developers Console 的「Messaging API」分頁:
   - **Webhook URL** 填入:`https://<你的-railway-網域>/webhook`
   - 開啟 **Use webhook**
   - 點 **Verify** 確認回傳成功
5. 建議把「Auto-reply messages」關掉(LINE Official Account Manager → 回應設定),不然官方帳號的罐頭回覆會跟 Bot 的回覆同時出現

用手機掃描「Messaging API」分頁的 QR code 加 Bot 為好友,傳訊息測試。

## 本機開發

```bash
npm install
cp .env.example .env   # 填入你的 LINE 憑證
npm run dev
```

本機測試 Webhook 需要公開網址,可以用 [ngrok](https://ngrok.com/):

```bash
ngrok http 3000
```

然後把 LINE 的 Webhook URL 暫時指到 `https://xxxx.ngrok.io/webhook`。

## 專案結構

```
├── index.js        # Express server + LINE webhook 處理
├── package.json
├── railway.json    # Railway 部署設定
├── .env.example    # 環境變數範本
└── README.md
```

## 擴充回覆邏輯

編輯 `index.js` 裡的 `buildReply()`:

```js
function buildReply(text) {
  if (text === "天氣") return "今天天氣不錯 ☀️";
  return `你說了:${text}`;
}
```

要回覆貼圖、圖片、Flex Message 等其他格式,參考 [LINE Messaging API 文件](https://developers.line.biz/en/docs/messaging-api/message-types/)。
