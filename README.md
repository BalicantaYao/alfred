# Alfred — LINE Bot

一個串接 LINE Messaging API 的 Bot,使用 Node.js + Express + LINE 官方 SDK,可直接部署到 [Railway](https://railway.app/)。

## 功能

- 接收 LINE Webhook 事件(含 X-Line-Signature 簽名驗證)
- 🛒 **購物清單**:在聊天中管理待買事項,可依購買地點(蝦皮、家樂福⋯)分組
- 📅 **Google Calendar 每日行程提醒**:每天固定時間把今天的行程推播到指定聊天,也可隨時輸入「行程」查詢
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

## 📅 Google Calendar 每日行程提醒

設定完成後,Bot 每天固定時間(預設台北時間 08:00)會把當天的 Google Calendar
行程推播到指定的聊天(個人或群組),也可以隨時輸入指令查詢:

| 指令 | 說明 |
|------|------|
| `行程` / `今日行程` | 查看今天的行程 |
| `id` | 查詢目前聊天的 LINE ID(設定推播對象用) |

### 設定步驟

1. **建立服務帳戶**
   1. 到 [Google Cloud Console](https://console.cloud.google.com/) 建立專案(或用現有的)
   2. 啟用 **Google Calendar API**(APIs & Services → Enable APIs)
   3. 到 **IAM & Admin → Service Accounts** 建立服務帳戶(不用給任何專案角色)
   4. 進入服務帳戶 → **Keys → Add Key → JSON**,下載金鑰檔
2. **把行事曆分享給服務帳戶**
   - 打開 [Google Calendar](https://calendar.google.com/) → 行事曆設定 →「與特定使用者共用」
   - 加入服務帳戶的 email(金鑰 JSON 裡的 `client_email`,長得像
     `xxx@專案名.iam.gserviceaccount.com`),權限選「查看所有活動詳細資訊」即可
3. **取得推播對象 ID**
   - 部署後對 Bot(或在群組裡)輸入 `id`,Bot 會回覆這個聊天的 LINE ID
4. **設定環境變數**(Railway → Variables)

   | 環境變數 | 說明 |
   |----------|------|
   | `GOOGLE_SERVICE_ACCOUNT_KEY` | 服務帳戶金鑰 JSON。建議轉成 base64 再貼(`base64 -w0 key.json`),原始 JSON 也可以 |
   | `GOOGLE_CALENDAR_ID` | 行事曆 ID,個人主行事曆就是你的 Gmail 地址 |
   | `REMINDER_TO` | 推播對象的 LINE ID(第 3 步查到的值)。沒設定就只能手動查詢,不會每日推播 |
   | `REMINDER_TIME` | 每天推播時間 `HH:mm`,預設 `08:00` |
   | `REMINDER_TZ` | 時區,預設 `Asia/Taipei` |

注意:LINE 的 push message 有免費額度(目前每月 200 則),每天一則提醒綽綽有餘。

### 💾 資料儲存

設定 `DATABASE_URL` 環境變數後,清單資料存在 PostgreSQL。在 Railway 上:

1. 專案裡按 **Create → Database → Add PostgreSQL** 新增資料庫服務
2. 在 Bot 服務的 **Variables** 加上 `DATABASE_URL = ${{Postgres.DATABASE_URL}}`

首次啟動會自動建表;如果資料庫是空的且存在舊的 `data/shopping-lists.json`,會自動匯入。

沒設定 `DATABASE_URL` 時,fallback 存在本機 JSON 檔 `data/shopping-lists.json`
(可用 `DATA_DIR` 改路徑),適合本機開發。注意:Railway 的檔案系統在**重新部署後會清空**,
正式環境請使用 PostgreSQL。

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
├── index.js          # Express server + LINE webhook 處理
├── shoppingList.js   # 購物清單指令解析
├── calendar.js       # Google Calendar 整合(服務帳戶,查詢今日行程)
├── reminder.js       # 每日行程提醒排程(node-cron)
├── storage.js        # 儲存層:PostgreSQL(DATABASE_URL)或本機 JSON 檔 fallback
├── llmParser.js      # LLM 自由格式意圖解析(選用,支援 Claude / Gemini)
├── scripts/
│   └── verify-db.js  # 儲存層手動驗證腳本
├── package.json
├── railway.json      # Railway 部署設定
├── .env.example      # 環境變數範本
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
