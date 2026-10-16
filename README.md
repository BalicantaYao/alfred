# Alfred — LINE Bot

一個串接 LINE Messaging API 的 Bot,使用 Node.js + Express + LINE 官方 SDK,可直接部署到 [Railway](https://railway.app/)。

## 功能

- 接收 LINE Webhook 事件(含 X-Line-Signature 簽名驗證)
- 🛒 **購物清單**:在聊天中管理待買事項,可依購買地點(蝦皮、家樂福⋯)分組
- ⏰ **每日行事曆提醒**:訂閱後,在設定的時間推播今天與明天的 Google 日曆行程
- 回覆文字訊息(echo bot,可在 `index.js` 的 `buildReply()` 擴充自己的邏輯)
- `GET /` 健康檢查端點

## 購物清單指令

| 指令 | 說明 |
|------|------|
| `買 牛奶 @家樂福` | 新增待買項目,`@` 後面是要去買的地方(可省略,會歸到「未分類」) |
| `加 電池` | 同「買」 |
| `清單` | 查看購物清單,依地點分組並編號 |
| `買到 2` | 買到了,刪除第 2 項(可一次多個:`買到 1 3`,也可用「刪除」) |
| `清空清單` | 刪除全部項目 |
| `help` / `幫助` | 顯示指令說明 |

一對一聊天是個人清單;把 Bot 加進群組的話,整個群組共用一份清單。

### 🧠 自由格式輸入(選用,支援 Claude 或 Gemini)

設定 `ANTHROPIC_API_KEY` 或 `GEMINI_API_KEY` 其中一個環境變數後,不用記指令格式,直接用自然語言也可以:

- 「幫我記一下要去蝦皮買行動電源跟手機殼」→ 自動拆成兩個項目加入蝦皮分類
- 「家樂福要買牛奶,另外記得買電池」→ 牛奶歸家樂福,電池歸未分類
- 「牛奶買到了」→ 從清單刪除牛奶(簡稱也能對應,例如「電源」會對到「行動電源」)
- 「我要買什麼?」→ 顯示清單

運作方式:訊息先走精確指令(免 API 費用、零延遲),不是指令才交給 LLM
解析成結構化意圖再套用到清單。與購物無關的訊息會維持原本的 echo 回覆。
API 呼叫失敗也會自動 fallback,不會擋住回覆。

**供應商設定:**

| 環境變數 | 說明 |
|----------|------|
| `ANTHROPIC_API_KEY` | 使用 Claude([platform.claude.com](https://platform.claude.com/) 取得,需儲值) |
| `GEMINI_API_KEY` | 使用 Gemini([Google AI Studio](https://aistudio.google.com/) 取得,有免費額度) |
| `LLM_PROVIDER` | 兩個 key 都設定時指定用哪個:`claude` 或 `gemini`(預設 claude) |
| `ANTHROPIC_MODEL` | Claude 模型,預設 `claude-opus-4-8` |
| `GEMINI_MODEL` | Gemini 模型,預設 `gemini-3.5-flash` |

兩種供應商都用結構化輸出(JSON schema)保證回傳合法的意圖 JSON,解析品質相近;
Gemini 的免費額度對個人 Bot 的訊息量通常已足夠。

### 💾 資料儲存

設定 `DATABASE_URL` 環境變數後,清單資料存在 PostgreSQL。在 Railway 上:

1. 專案裡按 **Create → Database → Add PostgreSQL** 新增資料庫服務
2. 在 Bot 服務的 **Variables** 加上 `DATABASE_URL = ${{Postgres.DATABASE_URL}}`

首次啟動會自動建表;如果資料庫是空的且存在舊的 `data/shopping-lists.json`,會自動匯入。

沒設定 `DATABASE_URL` 時,fallback 存在本機 JSON 檔 `data/shopping-lists.json`
(可用 `DATA_DIR` 改路徑),適合本機開發。注意:Railway 的檔案系統在**重新部署後會清空**,
正式環境請使用 PostgreSQL。

提醒訂閱存在同一層儲存(`reminder_subscriptions`;沒有資料庫時是 `data/reminders.json`)。
每次推播還會寫一筆執行紀錄(`job_runs` / `data/job-runs.json`),用來避免重複送出。

## 每日行事曆提醒

Alfred 會在程序裡每 30 秒看一次訂閱。到了聊天室設定的時間(預設每天 08:00,時區預設 `Asia/Taipei`),
就推播今天與明天的行程。沒有可報告的行程時不送訊息。

每個聊天室可以設自己的時間,提醒跟 webhook 跑在同一個服務裡,不需要另外設 Railway cron。
Postgres 的 `job_runs` 以「工作 + 聊天室 + 日期」當主鍵搶鎖:多個 replica、或送到一半重啟,
同一天也只會送出一次。送給 LINE 時附上 retry key,即使送出後程序立刻掛掉,重試也不會再投遞同一則。
JSON fallback 只適合單一行程的本機開發;正式環境請使用 `DATABASE_URL`。

程序若在提醒時間當下沒有醒著,預設 3 小時內會補送(`REMINDER_CATCHUP_MINUTES`)。
補送不跨過午夜。若你是在今天的提醒時間之後才訂閱、而且還在補送窗口內,會馬上補一則。

所有訂閱的聊天室收到的是同一本日曆,也就是環境變數指定的那一本。

### 指令

| 指令 | 說明 |
|------|------|
| `訂閱提醒` | 訂閱每日行程推播,時間用 `REMINDER_DEFAULT_TIME`(預設 08:00) |
| `訂閱提醒 08:20` | 訂閱並指定時間(24 小時制,可用全形冒號) |
| `提醒時間 08:20` | 改時間;還沒訂閱的話會直接訂閱 |
| `提醒狀態` | 查看這個聊天室的設定 |
| `預覽提醒` | 立刻用回覆訊息看今天與明天的行程,不消耗 push 額度 |
| `取消提醒` | 停止推播 |

一對一聊天記在使用者身上;群組裡下指令則整個群組收到同一份提醒。標題以 `出遊：` 開頭的活動會略過(可用 `CALENDAR_SKIP_TITLE_PREFIX` 改)。自己已拒絕、已取消的活動也不列入。

行程會標出兩件事:

- 時間重疊:後面那場標 `⚠️`,並列出撞到的行程
- 緊接上一場:間隔 0 分鐘標 `⚡ 緊接`,10 分鐘以內標間隔分鐘數

全天活動只列出標題,不跟有時間的活動互相比衝突。

### Google 日曆(唯讀)

擇一即可。**建議用 service account**:OAuth 同意畫面若還在「Testing」,refresh token 7 天就會失效。

1. 到 [Google Cloud Console](https://console.cloud.google.com/) 建立或選一個專案
2. 啟用 **Google Calendar API**
3. 建立 service account,新增一把 JSON 金鑰
4. 打開 Google 日曆 → 目標日曆的「設定和共用」→「與特定使用者共用」,把 service account 的 `client_email` 加進去,權限選「查看所有活動詳情」
5. 同一個設定頁的「整合日曆」複製**日曆 ID**(自己的主日曆通常就是 Gmail 地址)
6. 金鑰轉成一行 base64,設到 Railway:

   ```bash
   # Linux
   base64 -w 0 alfred-calendar.json
   # macOS
   base64 < alfred-calendar.json | tr -d '\n'
   ```

Service account 自己的 `primary` 日曆是空的,一定要設 `GOOGLE_CALENDAR_ID`,並完成上面的分享。多本日曆用逗號分隔。

OAuth 替代做法:在 [OAuth Playground](https://developers.google.com/oauthplayground/) 用你自己的 OAuth client,授權 scope `https://www.googleapis.com/auth/calendar.readonly`,換到 refresh token 後填 `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`、`GOOGLE_REFRESH_TOKEN`。這時 `GOOGLE_CALENDAR_ID` 可以是 `primary`。

設定完成並重新部署後,先傳 `預覽提醒`。看得到行程再傳 `訂閱提醒`。若重新部署時已經過了今天的提醒時間、但還在補送窗口內,會補送一則;否則等明天。

### LINE push 額度

回覆訊息(包含 `預覽提醒`)不計入每月則數。排程用的是 push,會計入官方帳號方案的訊息則數。計價是收訊人數,不是 API 次數:一對一聊天每天 1 則,一個月大約 30 則;群組會乘上成員人數。沒有行程的日子不會推播,也不扣則數。

額度用完時 LINE 會回 429,那天會在補送窗口內重試,仍失敗就等到明天。方案上限見 [Messaging API pricing](https://developers.line.biz/en/docs/messaging-api/pricing/),目前用量可在 LINE Official Account Manager 查看,或呼叫 `GET /v2/bot/message/quota`。

### 之後加別的排程

`scheduler.js` 只認識 `{ id, ready?, run }`。`run` 回傳要推播的文字,回傳 `null` 表示這次不送。把新的 job 放進 `startAlfred()` 的 `jobs` 陣列,再用 `setSubscription(ownerId, jobId, "HH:MM")` 寫入訂閱(或做一組新的指令)。搶鎖、補送、retry key 不用重寫。`jobId` 不要包含 `|`。

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
   | `DATABASE_URL` | (建議)PostgreSQL 連線字串,設 `${{Postgres.DATABASE_URL}}` 引用同專案的資料庫服務。提醒訂閱與防重複送出也用這顆資料庫 |
   | `GOOGLE_SERVICE_ACCOUNT_JSON_BASE64` | (提醒功能)service account JSON 金鑰的 base64。見上方「Google 日曆」 |
   | `GOOGLE_CALENDAR_ID` | (提醒功能)日曆 ID。service account 不要用 `primary` |

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
npm test               # 單元測試 + 假日曆/假 LINE 的排程驗證 + 購物清單儲存驗證
npm run dev
```

本機測試 Webhook 需要公開網址,可以用 [ngrok](https://ngrok.com/):

```bash
ngrok http 3000
```

然後把 LINE 的 Webhook URL 暫時指到 `https://xxxx.ngrok.io/webhook`。

## 專案結構

```
├── index.js                 # Express server + LINE webhook + 啟動排程
├── shoppingList.js          # 購物清單指令解析
├── reminders.js             # 提醒訂閱指令
├── scheduler.js             # 程序內排程、補送窗口、防重複送出
├── calendar.js              # Google Calendar 唯讀(service account 或 OAuth)
├── digest.js                # 行程摘要排版(衝突、緊接、略過出遊)
├── time.js                  # Asia/Taipei 時間換算
├── storage.js               # 儲存層:PostgreSQL(DATABASE_URL)或本機 JSON 檔 fallback
├── llmParser.js             # LLM 自由格式意圖解析(選用,支援 Claude / Gemini)
├── jobs/calendarDigest.js   # 每日行事曆這一個排程工作
├── scripts/
│   ├── verify-db.js         # 購物清單儲存層手動驗證
│   └── verify-reminders.js  # 用假日曆與假 LINE push 跑一次排程
├── test/                    # node --test
├── package.json
├── railway.json             # Railway 部署設定
├── .env.example             # 環境變數範本
└── README.md
```

## 擴充回覆邏輯

編輯 `index.js` 裡的 `buildReply()`:

```js
async function buildReply(text, ownerId) {
  if (text === "天氣") return "今天天氣不錯 ☀️";
  return null; // 回傳 null 表示不回覆
}
```

要回覆貼圖、圖片、Flex Message 等其他格式,參考 [LINE Messaging API 文件](https://developers.line.biz/en/docs/messaging-api/message-types/)。
