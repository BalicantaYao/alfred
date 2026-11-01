# Alfred — LINE Bot

一個串接 LINE Messaging API 的 Bot,使用 Node.js + Express + LINE 官方 SDK,可直接部署到 [Railway](https://railway.app/)。

## 功能

- 接收 LINE Webhook 事件(含 X-Line-Signature 簽名驗證)
- 🔔 **提醒轉發**:外部助理 `POST /notify`,Alfred 把同一段文字推到主人的 LINE 聊天
- 🧠 **問助理**:群組裡點名 Alfred,或主人一對一傳來的非指令訊息,轉給外部助理;助理再用 `/notify` 把答案推回來
- 群組裡沒被點名、也不是指令的訊息不回覆,避免洗版
- `GET /` 健康檢查端點

## 提醒轉發

個人助理(跑在別的地方)可以把日曆提醒、週末出遊建議等文字 POST 給 Alfred,Alfred 再用 LINE push 送到主人的聊天。

這不是 LINE Webhook,不要把 `/notify` 填進 Webhook URL。

### 推到哪個聊天

優先序:

1. 這次請求 JSON 裡的 `to`(使用者、群組或聊天室 ID)
2. 在 LINE 裡輸入 `訂閱轉發` 記下來的那個聊天
3. 環境變數 `NOTIFY_LINE_TO`

三個都沒有時回 `422`,不會亂推。`to` 只影響這一次,不會改掉訂閱。

`訂閱轉發` 記住的對象:有 `DATABASE_URL` 時寫進 `notify_targets`,否則寫進 `data/notify-target.json`。

| 指令 | 說明 |
|------|------|
| `我的ID` | 顯示這個聊天的使用者 / 群組 / 聊天室 ID |
| `訂閱轉發` | 把這個聊天設成預設推送對象(再訂閱別的聊天會蓋過) |
| `取消轉發` | 取消這個聊天的訂閱。`NOTIFY_LINE_TO` 若有設,仍會推到那裡 |
| `轉發狀態` | 查看目前預設推到哪裡 |
| `help` / `幫助` | 顯示轉發指令;有啟用問助理時一併顯示問助理說明 |

一對一聊天推給使用者;在群組裡訂閱則推給整個群組(用的是群組 ID,不是發言者的 ID)。

Bot 若有加進別人也能說話的群組,建議設定 `NOTIFY_OWNER_ID`(自己的使用者 ID)。設了之後,只有主人可以訂閱或取消;`我的ID` 仍可供任何人查自己的 ID。

### 呼叫方式

```bash
curl -sS -X POST "$ALFRED_URL/notify" \
  -H "Authorization: Bearer $NOTIFY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text":"明天 10:00 看牙醫","idempotencyKey":"123e4567-e89b-12d3-a456-426614174000"}'
```

成功時:

```json
{ "ok": true, "to": "Uxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", "messageCount": 1, "retryKey": "123e4567-e89b-12d3-a456-426614174000" }
```

| 欄位 | 說明 |
|------|------|
| `text` | 要推的文字。可含簡單 Markdown(`**粗體**`、`# 標題`、`[文字](網址)`、程式碼區塊),送出前會轉成純文字 |
| `to` | 選填。這一次的 LINE ID,蓋過訂閱與 `NOTIFY_LINE_TO` |
| `idempotencyKey` | 選填。UUID。也接受 header `Idempotency-Key` 或 `X-Line-Retry-Key`(body 優先) |

Alfred 會把這組 UUID 放進 LINE 的 `X-Line-Retry-Key`。同一個 key 在 24 小時內重送,LINE 不會再推一次,所以助理逾時重試時要沿用同一組 key。沒帶 key 就不會去重。

LINE 單則文字上限 5000 字,一次 push 最多 5 則。較長的內容會依段落切開,並標 `（1/2）` 這種序號;超過 5 則能裝下的長度會直接拒絕,不會只送出前面一段。

伺服器 log 只記推送結果、對象 ID、字數與則數,不記 token,也不記訊息內文。

| HTTP | `error` | 說明 |
|------|---------|------|
| 200 |  | 已交給 LINE |
| 401 | `unauthorized` | 沒帶 Bearer,或 token 不對 |
| 503 | `notify_disabled` | 伺服器沒設定 `NOTIFY_TOKEN` |
| 400 | `invalid_json` / `invalid_body` / `text_required` / `text_too_long` / `invalid_target` / `invalid_idempotency_key` | 請求內容有問題。`invalid_body` 包含 Content-Type 不是 `application/json`。`text_too_long` 會附 `maxChars` |
| 413 | `body_too_large` | 內文超過 128kb |
| 422 | `no_target` | 沒有 `to`、沒有訂閱,也沒有 `NOTIFY_LINE_TO` |
| 409 | `line_push_failed` | LINE 認為這組 retry key 還在處理,可稍後用同一組 key 再試 |
| 502 | `line_push_failed` | LINE 拒絕或暫時失敗。`status` 是 LINE 回的 HTTP 狀態(例如 429 表示額度用完) |

Push 會計入 LINE 官方帳號的訊息則數。回覆「我的ID」這類指令不算 push。

### 💾 資料儲存

設定 `DATABASE_URL` 後,轉發對象存在 PostgreSQL 的 `notify_targets`。在 Railway 上:

1. 專案裡按 **Create → Database → Add PostgreSQL** 新增資料庫服務
2. 在 Bot 服務的 **Variables** 加上 `DATABASE_URL = ${{Postgres.DATABASE_URL}}`

首次啟動會自動建立 `notify_targets`(若還沒有)。沒設定 `DATABASE_URL` 時,fallback 存在本機 JSON 檔 `data/notify-target.json`(可用 `DATA_DIR` 改目錄),適合本機開發。注意:Railway 的檔案系統在**重新部署後會清空**,正式環境請使用 PostgreSQL。

## 問助理

有設定 `ASSISTANT_WEBHOOK_URL` 時,Alfred 會把「講給 Alfred 聽」的訊息用 HTTPS POST 轉給外部助理。助理想好之後,用上面的 `POST /notify` 把答案推回同一個聊天(`to` 用轉發 body 裡的 `replyTo`)。`訂閱轉發` 這類指令和 `help` 仍在 Alfred 裡處理,不會轉出去。

會轉發的訊息:

- **群組或聊天室**:LINE webhook 的 `message.mention.mentionees` 裡有 `isSelf: true`,或 `userId` 等於 Bot 自己的 ID。沒有標記資料時,文字以 `alfred` 或 `@alfred` 開頭(大小寫不拘,全形 `＠` 也可以)也算。
- **一對一**:主人傳來、而且不是上面那些指令的文字。主人是 `NOTIFY_OWNER_ID`;沒設的話,任何一對一都當成主人。

不會轉發:群組裡沒點名的閒聊、允許清單以外的人、`http://` 網址、轉發指令與 `help`(含 `@Alfred 訂閱轉發` 這種點名後的指令)。

點名後如果剩下的文字是指令(例如 `@Alfred 訂閱轉發`、`alfred help`),Alfred 照指令回覆,不轉發。其餘點名或主人一對一的文字會轉給助理。

助理 webhook 應盡快回 **2xx**,不要等模型跑完。Alfred 等到 2xx 才用 reply token(不計 push 則數)回一句 `收到，我想一下 🤔`。逾時、連線失敗或非 2xx 則改回 `助理暫時連不上，請稍後再試`,一樣用 reply token,程序不會因此崩潰。確認句可用環境變數改字或關掉;關掉之後,成功時不回覆,失敗仍會回錯誤句。真正的答案之後由助理呼叫 `/notify` 推回來,那一次才計入 push 則數。

### 轉發的 JSON

`Authorization` 的值是 `ASSISTANT_WEBHOOK_AUTH` 的全文。環境變數設成 `Bearer whsec_xxx`,送出的就是 `Authorization: Bearer whsec_xxx`,不會再加一層 Bearer。沒設這個變數就省略該標頭。

```json
{
  "text": "明天會下雨嗎",
  "rawText": "@Alfred 明天會下雨嗎",
  "sourceType": "group",
  "userId": "Uxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "groupId": "Cxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "roomId": null,
  "replyTo": "Cxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "messageId": "1234567890",
  "timestamp": 1760598000000,
  "displayName": "小明"
}
```

| 欄位 | 說明 |
|------|------|
| `text` | 拿掉 Bot 標記或開頭的 `alfred` / `@alfred` 之後的文字 |
| `rawText` | LINE 原文 |
| `sourceType` | `user`、`group` 或 `room` |
| `userId` / `groupId` / `roomId` | 沒有的是 `null` |
| `replyTo` | 答案要推回的 ID:群組 ID,否則聊天室 ID,否則使用者 ID |
| `messageId` | LINE 訊息 ID |
| `timestamp` | webhook 的毫秒時間戳 |
| `displayName` | 發言者顯示名稱。webhook 裡已有就直接用;否則在 `ASSISTANT_PROFILE_TIMEOUT_MS`(預設 400)內查 LINE profile,查不到是 `null`。設成 `0` 就不查 |

伺服器 log 只記轉發成敗、來源類型、`replyTo`、HTTP 狀態與錯誤名稱,不記 token,也不記訊息內文。

允許清單(都可省略):

| 變數 | 沒設 | 有設 |
|------|------|------|
| `ASSISTANT_ALLOWED_USER_IDS` | 不限制發言者 | 只有逗號分隔的這些使用者 ID 會轉發 |
| `ASSISTANT_ALLOWED_GROUP_IDS` | 不限制群組 | 只有這些群組裡的點名會轉發。一對一和聊天室不受影響 |

### 啟用步驟

1. 助理開一個 HTTPS endpoint,收到上面的 JSON 後先回 2xx,背景再產生答案。
2. Railway 設定 `ASSISTANT_WEBHOOK_URL` 和 `ASSISTANT_WEBHOOK_AUTH`。
3. 同一個 bot 照「提醒轉發」設好 `NOTIFY_TOKEN`。助理回覆時:

   ```bash
   curl -sS -X POST "$ALFRED_URL/notify" \
     -H "Authorization: Bearer $NOTIFY_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"text":"明天北部有雨","to":"<payload.replyTo>"}'
   ```

4. Bot 有加進別人也能說話的群組時,設 `NOTIFY_OWNER_ID`(一對一只收主人)以及需要的允許清單。
5. 標記事件若沒有 `isSelf`,把 Bot 的使用者 ID 設成 `LINE_BOT_USER_ID`。沒設也能靠開頭的 `alfred` / `@alfred`。程序啟動後會試一次 `getBotInfo`,成功的話就不用設這個變數。
6. 重新部署。群組裡點名 Alfred,或主人直接傳一對一,應先看到確認句,再看到助理經 `/notify` 推回的答案。

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
   | `DATABASE_URL` | (建議)PostgreSQL 連線字串,設 `${{Postgres.DATABASE_URL}}` 引用同專案的資料庫服務 |
   | `NOTIFY_TOKEN` | (要用轉發時)長隨機字串,跟外部助理共用。沒設則 `POST /notify` 一律拒絕 |
   | `NOTIFY_LINE_TO` | (選填)預設推送的 LINE ID。可用聊天指令 `訂閱轉發` 代替 |
   | `NOTIFY_OWNER_ID` | (選填)允許訂閱/取消的使用者 ID;也是問助理的一對一主人 |
   | `ASSISTANT_WEBHOOK_URL` | (要用問助理時)外部助理的 HTTPS webhook |
   | `ASSISTANT_WEBHOOK_AUTH` | (建議)轉發時 `Authorization` 標頭的完整值,例如 `Bearer …` |
   | `ASSISTANT_ALLOWED_USER_IDS` | (選填)逗號分隔。有設才限制誰可以觸發轉發 |
   | `ASSISTANT_ALLOWED_GROUP_IDS` | (選填)逗號分隔。有設才限制哪些群組的點名會轉發 |
   | `ASSISTANT_ACK` | (選填)設 `false` 關掉成功時的確認句 |
   | `ASSISTANT_ACK_TEXT` | (選填)確認句,預設 `收到，我想一下 🤔` |
   | `LINE_BOT_USER_ID` | (選填)Bot 的使用者 ID,標記沒有 `isSelf` 時用來辨認 |

3. 部署完成後,到 **Settings → Networking → Generate Domain** 產生公開網址,例如 `https://alfred-production.up.railway.app`
4. 回到 LINE Developers Console 的「Messaging API」分頁:
   - **Webhook URL** 填入:`https://<你的-railway-網域>/webhook`
   - 開啟 **Use webhook**
   - 點 **Verify** 確認回傳成功
5. 建議把「Auto-reply messages」關掉(LINE Official Account Manager → 回應設定),不然官方帳號的罐頭回覆會跟 Bot 的回覆同時出現

用手機掃描「Messaging API」分頁的 QR code 加 Bot 為好友,傳訊息測試。

要啟用提醒轉發的話,部署後再做這幾步:

1. `openssl rand -hex 32` 產生 `NOTIFY_TOKEN`,設到 Railway,也設到外部助理。
2. 加 Bot 為好友(或把 Bot 拉進要收提醒的群組),傳 `我的ID`。
3. 在那個聊天傳 `訂閱轉發`。或把畫面上的 ID 設成 `NOTIFY_LINE_TO` 後重新部署。
4. 群組裡有其他人時,把 `我的ID` 顯示的使用者 ID 設成 `NOTIFY_OWNER_ID`。
5. 用上面的 `curl` 打一次,確認手機收到,而且回應裡的 `to` 是預期的 ID。

要啟用問助理的話,再設 `ASSISTANT_WEBHOOK_URL`(https)和 `ASSISTANT_WEBHOOK_AUTH`,部署後在群組點名 Bot 測一次。助理那側用 payload 的 `replyTo` 當 `/notify` 的 `to`。細節在上面的「問助理」。

## 本機開發

```bash
npm install
cp .env.example .env   # 填入你的 LINE 憑證
npm run dev
npm test               # 轉發端點、問助理(假的 fetch / LINE)與轉發對象儲存
```

本機測試 Webhook 需要公開網址,可以用 [ngrok](https://ngrok.com/):

```bash
ngrok http 3000
```

然後把 LINE 的 Webhook URL 暫時指到 `https://xxxx.ngrok.io/webhook`。

## 專案結構

```
├── index.js          # Express server + LINE webhook 處理
├── notify.js         # POST /notify、轉發指令、長文拆則
├── assistant.js      # 點名 / 主人一對一轉給外部助理
├── storage.js        # 轉發對象:PostgreSQL(DATABASE_URL)或本機 JSON 檔 fallback
├── scripts/
│   ├── verify-db.js         # 轉發對象儲存層驗證
│   ├── verify-notify.js     # 轉發端點驗證(假的 LINE client)
│   └── verify-assistant.js  # 問助理驗證(假的 fetch / LINE)
├── package.json
├── railway.json      # Railway 部署設定
├── .env.example      # 環境變數範本
└── README.md
```

## 擴充回覆邏輯

編輯 `index.js` 裡的 `buildReply()`:

```js
function buildReply(text, source) {
  if (text === "天氣") return "今天天氣不錯 ☀️";
  return null; // 回傳 null 表示不在這裡回覆,交給問助理的規則決定要不要轉發
}
```

要回覆貼圖、圖片、Flex Message 等其他格式,參考 [LINE Messaging API 文件](https://developers.line.biz/en/docs/messaging-api/message-types/)。
