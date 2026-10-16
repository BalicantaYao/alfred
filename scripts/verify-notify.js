// 驗證提醒轉發:純函式、檔案儲存、HTTP(假的 LINE client),以及真正啟動 index.js。
//   node scripts/verify-notify.js
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alfred-notify-"));
const TOKEN = "notify-test-token";
const PHRASE = "PHRASE_DO_NOT_LOG_9f3a";
const WRONG_TOKEN = "notify-test-token-nope";
const USER = "U" + "ab".repeat(16);
const OTHER = "U" + "12".repeat(16);
const GROUP = "C" + "cd".repeat(16);
const ROOM = "R" + "ef".repeat(16);
const RETRY = "123e4567-e89b-12d3-a456-426614174000";
const RETRY_B = "123e4567-e89b-12d3-a456-426614174001";

process.env.DATA_DIR = tmp;
delete process.env.DATABASE_URL;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.LLM_PROVIDER;
delete process.env.NOTIFY_LINE_TO;
delete process.env.NOTIFY_OWNER_ID;
process.env.LINE_CHANNEL_SECRET = "test-channel-secret";
process.env.LINE_CHANNEL_ACCESS_TOKEN = "test-channel-token";
process.env.NOTIFY_TOKEN = TOKEN;

const index = await import("../index.js");
const notify = await import("../notify.js");
const shopping = await import("../shoppingList.js");
const storage = await import("../storage.js");

let passed = 0;

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
  } catch (err) {
    err.message = `${name}: ${err.message}`;
    throw err;
  }
}

function hasLoneSurrogate(text) {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function resetRelay() {
  storage.clearNotifyTarget();
  delete process.env.NOTIFY_LINE_TO;
  delete process.env.NOTIFY_OWNER_ID;
  process.env.NOTIFY_TOKEN = TOKEN;
}

const pushes = [];
const replies = [];
let pushImpl = async (body, retryKey) => {
  pushes.push({ body, retryKey });
  return { sentMessages: [] };
};
const mockClient = {
  pushMessage(body, retryKey) {
    return pushImpl(body, retryKey);
  },
  async replyMessage(body) {
    replies.push(body);
  },
};

function signWebhook(raw) {
  return crypto.createHmac("sha256", process.env.LINE_CHANNEL_SECRET).update(raw).digest("base64");
}

function listen(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
    server.on("error", reject);
  });
}

async function post(server, { path: pathname = "/notify", headers = {}, body, raw } = {}) {
  const { port } = server.address();
  const payload = raw != null ? raw : body == null ? undefined : JSON.stringify(body);
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: "POST",
    headers: {
      ...(raw == null && body != null ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: payload,
    signal: AbortSignal.timeout(5000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

function authHeaders(extra = {}) {
  return { authorization: `Bearer ${TOKEN}`, ...extra };
}

let server;

async function main() {
  await check("import 時不會自己 listen", () => {
    const servers = process._getActiveHandles().filter((handle) => handle instanceof net.Server);
    assert.equal(servers.length, 0);
  });

  await check("tokensMatch 不同長度不會丟例外", () => {
    assert.equal(notify.tokensMatch("a", "ab"), false);
    assert.equal(notify.tokensMatch(TOKEN, TOKEN), true);
    assert.equal(notify.tokensMatch(TOKEN, WRONG_TOKEN), false);
  });

  await check("Markdown 轉成可讀純文字,程式碼內容保留", () => {
    const plain = notify.markdownToPlain(
      "## 明天\r\n**10:00** 看牙醫\n地點:[診所](https://maps.example/a)\n\n\n> 記得帶健保卡\n---\n`a_b`\n```js\n**keep**\n```"
    );
    assert.match(plain, /^明天/);
    assert.match(plain, /10:00 看牙醫/);
    assert.match(plain, /診所 \(https:\/\/maps\.example\/a\)/);
    assert.match(plain, /記得帶健保卡/);
    assert.equal(plain.includes("**10:00**"), false);
    assert.equal(plain.includes("##"), false);
    assert.equal(plain.includes("---"), false);
    assert.match(plain, /a_b/);
    assert.match(plain, /\*\*keep\*\*/);
  });

  await check("5000 字一則,5001 字拆成兩則且不超過上限", () => {
    const exact = notify.splitLineText("a".repeat(notify.LINE_TEXT_MAX));
    assert.equal(exact.length, 1);
    assert.equal(exact[0].length, notify.LINE_TEXT_MAX);
    assert.equal(exact[0].startsWith("（"), false);

    const split = notify.splitLineText("a".repeat(notify.LINE_TEXT_MAX + 1));
    assert.equal(split.length, 2);
    assert.ok(split.every((part) => part.length <= notify.LINE_TEXT_MAX));
    assert.match(split[0], /^（1\/2）\na+$/);
    assert.match(split[1], /^（2\/2）\na+$/);
  });

  await check("依段落切開,文字本身還在", () => {
    const left = "甲".repeat(3000);
    const right = "乙".repeat(3000);
    const parts = notify.splitLineText(`${left}\n\n${right}`);
    assert.equal(parts.length, 2);
    assert.match(parts[0], /甲{100}$/);
    assert.match(parts[1], /乙{100}$/);
    assert.equal(parts[0].includes("乙"), false);
  });

  await check("不會把 emoji 切成半個", () => {
    const emoji = "😀";
    assert.equal(emoji.length, 2);
    const text = "a".repeat(4993) + emoji + "b".repeat(200);
    const parts = notify.splitLineText(text);
    assert.ok(parts);
    assert.ok(parts.every((part) => part.length <= notify.LINE_TEXT_MAX && !hasLoneSurrogate(part)));
    assert.match(parts.join("\n"), /😀/);
  });

  await check("剛好塞進 5 則,多一字就整批拒絕", () => {
    const fit = notify.prepareMessages("a".repeat(notify.NOTIFY_MAX_CHARS));
    assert.equal(fit.messages.length, notify.LINE_PUSH_MAX_MESSAGES);
    assert.ok(fit.messages.every((part) => part.length <= notify.LINE_TEXT_MAX));
    const overflow = notify.prepareMessages("a".repeat(notify.NOTIFY_MAX_CHARS + 1));
    assert.equal(overflow.error, "text_too_long");
    assert.equal(overflow.maxChars, notify.NOTIFY_MAX_CHARS);
  });

  await check("轉發指令不會被購物清單吃掉,購物回覆也不會被包一層", async () => {
    resetRelay();
    for (const command of ["訂閱轉發", "取消轉發", "轉發狀態", "我的ID"]) {
      assert.equal(shopping.handleShoppingCommand(USER, command), null);
      assert.notEqual(notify.handleNotifyCommand(command, { userId: USER }), null);
    }
    assert.equal(notify.handleNotifyCommand("買 牛奶", { userId: USER }), null);
    assert.equal(notify.handleNotifyCommand("清單", { userId: USER }), null);

    const direct = shopping.handleShoppingCommand("owner-a", "買 牛奶 @家樂福");
    const via = await index.buildReply("買 牛奶 @家樂福", "owner-b", { userId: "owner-b" });
    assert.equal(via, direct);
    assert.match(via, /^已加入:牛奶\(家樂福\)/);

    const listed = shopping.handleShoppingCommand("owner-a", "清單");
    const listedVia = await index.buildReply("清單", "owner-b", { userId: "owner-b" });
    assert.equal(listedVia, listed);

    shopping.handleShoppingCommand("owner-a", "清空清單");
    const cleared = await index.buildReply("清空清單", "owner-b", { userId: "owner-b" });
    assert.equal(cleared, "購物清單已清空 🧹");
    assert.equal(await index.buildReply("今天天氣真好", USER, { userId: USER }), null);

    const help = await index.buildReply("幫助", USER, { userId: USER });
    assert.ok(help.includes(shopping.SHOPPING_HELP));
    assert.match(help, /訂閱轉發/);
  });

  await check("訂閱記群組 ID,換聊天取消不會清掉,重載後還在", async () => {
    resetRelay();
    const subscribed = await index.buildReply("訂閱轉發", GROUP, {
      groupId: GROUP,
      userId: USER,
    });
    assert.match(subscribed, new RegExp(GROUP));
    assert.equal(storage.getNotifyTarget(), GROUP);
    assert.match(await index.buildReply("轉發狀態", GROUP, { groupId: GROUP, userId: USER }), /已訂閱:這個聊天/);

    const idReply = await index.buildReply("我的ID", GROUP, { groupId: GROUP, userId: USER });
    assert.match(idReply, new RegExp(`使用者 ID: ${USER}`));
    assert.match(idReply, new RegExp(`群組 ID: ${GROUP}`));
    assert.match(idReply, /轉發會送到: /);

    const otherCancel = await index.buildReply("取消轉發", USER, { userId: USER });
    assert.match(otherCancel, /不是轉發對象/);
    assert.equal(storage.getNotifyTarget(), GROUP);

    await storage.flushWrites();
    const notifyFile = path.join(tmp, "notify-target.json");
    const saved = JSON.parse(fs.readFileSync(notifyFile, "utf8"));
    assert.equal(saved.targetId, GROUP);
    fs.writeFileSync(notifyFile, JSON.stringify({ targetId: USER }));
    await storage.initNotifyStorage();
    assert.equal(storage.getNotifyTarget(), USER);
    fs.writeFileSync(notifyFile, JSON.stringify({ targetId: GROUP }));
    await storage.initNotifyStorage();
    assert.equal(storage.getNotifyTarget(), GROUP);

    const lists = JSON.parse(fs.readFileSync(path.join(tmp, "shopping-lists.json"), "utf8"));
    for (const value of Object.values(lists)) assert.ok(Array.isArray(value));
    assert.equal(lists[GROUP], undefined);

    const cancelled = await index.buildReply("取消轉發", GROUP, { groupId: GROUP, userId: USER });
    assert.match(cancelled, /已取消轉發/);
    assert.equal(storage.getNotifyTarget(), null);

    const room = await index.buildReply("訂閱轉發", ROOM, { roomId: ROOM, userId: USER });
    assert.match(room, new RegExp(ROOM));
    assert.equal(storage.getNotifyTarget(), ROOM);
    storage.clearNotifyTarget();
  });

  await check("NOTIFY_OWNER_ID 擋住別人訂閱,但我的ID 仍看得到自己的 ID", async () => {
    resetRelay();
    process.env.NOTIFY_OWNER_ID = USER;
    storage.setNotifyTarget(ROOM);
    const denied = await index.buildReply("訂閱轉發", GROUP, { groupId: GROUP, userId: OTHER });
    assert.match(denied, /只有主人/);
    assert.equal(storage.getNotifyTarget(), ROOM);
    const status = await index.buildReply("轉發狀態", GROUP, { groupId: GROUP, userId: OTHER });
    assert.equal(status.includes(ROOM), false);
    assert.match(status, /不是轉發對象/);
    const mine = await index.buildReply("我的id", OTHER, { userId: OTHER });
    assert.match(mine, new RegExp(OTHER));

    const allowed = await index.buildReply("訂閱轉發", GROUP, { groupId: GROUP, userId: USER });
    assert.match(allowed, /已改為這個聊天/);
    assert.equal(storage.getNotifyTarget(), GROUP);
    resetRelay();
  });

  const serversBefore = process._getActiveHandles().filter((handle) => handle instanceof net.Server);
  server = await listen(index.createApp(mockClient));
  assert.equal(
    process._getActiveHandles().filter((handle) => handle instanceof net.Server).length,
    serversBefore.length + 1
  );

  const logs = [];
  const originalConsole = {};
  for (const method of ["log", "info", "warn", "error", "debug"]) {
    originalConsole[method] = console[method];
    console[method] = (...args) => {
      logs.push(
        args
          .map((part) => {
            if (typeof part === "string") return part;
            if (part instanceof Error) return part.name;
            return String(part);
          })
          .join(" ")
      );
    };
  }

  try {
    await check("沒設定 token 時拒絕,而且不推播", async () => {
      pushes.length = 0;
      delete process.env.NOTIFY_TOKEN;
      const res = await post(server, {
        headers: { authorization: `Bearer ${TOKEN}` },
        body: { text: PHRASE },
      });
      assert.equal(res.status, 503);
      assert.equal(res.json.error, "notify_disabled");
      assert.equal(pushes.length, 0);
      process.env.NOTIFY_TOKEN = TOKEN;
    });

    await check("錯誤、缺 token、或 query 帶 token 都是 401", async () => {
      pushes.length = 0;
      for (const headers of [
        {},
        { authorization: `Bearer ${WRONG_TOKEN}` },
        { authorization: "Token abc" },
        { authorization: `Bearer ${TOKEN} extra` },
      ]) {
        const res = await post(server, { headers, body: { text: "hi", to: USER } });
        assert.equal(res.status, 401);
        assert.equal(res.json.error, "unauthorized");
      }
      const sneaky = await post(server, {
        path: `/notify?token=${TOKEN}`,
        body: { text: "hi", to: USER },
      });
      assert.equal(sneaky.status, 401);
      assert.equal(pushes.length, 0);
    });

    await check("壞掉的 JSON 在驗證失敗時仍是 401,驗證通過才是 400", async () => {
      const denied = await post(server, {
        headers: { authorization: "Bearer nope", "content-type": "application/json" },
        raw: "{",
      });
      assert.equal(denied.status, 401);
      const bad = await post(server, {
        headers: authHeaders({ "content-type": "application/json" }),
        raw: "{",
      });
      assert.equal(bad.status, 400);
      assert.equal(bad.json.error, "invalid_json");
    });

    await check("內文過大回 413", async () => {
      const res = await post(server, {
        headers: authHeaders({ "content-type": "application/json" }),
        raw: `{"text":"${"a".repeat(150 * 1024)}"}`,
      });
      assert.equal(res.status, 413);
      assert.equal(res.json.error, "body_too_large");
    });

    await check("缺文字、型別錯誤、不是物件都拒絕", async () => {
      const missing = await post(server, { headers: authHeaders(), body: { to: USER } });
      assert.equal(missing.status, 400);
      assert.equal(missing.json.error, "text_required");
      const blank = await post(server, { headers: authHeaders(), body: { text: "  \n" } });
      assert.equal(blank.status, 400);
      assert.equal(blank.json.error, "text_required");
      const number = await post(server, { headers: authHeaders(), body: { text: 1, to: USER } });
      assert.equal(number.json.error, "text_required");
      const array = await post(server, {
        headers: authHeaders({ "content-type": "application/json" }),
        raw: "[]",
      });
      assert.equal(array.status, 400);
      assert.equal(array.json.error, "invalid_body");
      const plain = await post(server, {
        headers: authHeaders({ "content-type": "text/plain" }),
        raw: JSON.stringify({ text: "hi", to: USER }),
      });
      assert.equal(plain.status, 400, JSON.stringify(plain));
      assert.equal(plain.json && plain.json.error, "invalid_body", JSON.stringify(plain));
    });

    await check("沒有對象是 422,環境變數格式錯是 500,都不會推", async () => {
      resetRelay();
      pushes.length = 0;
      const none = await post(server, { headers: authHeaders(), body: { text: "hi" } });
      assert.equal(none.status, 422);
      assert.equal(none.json.error, "no_target");
      process.env.NOTIFY_LINE_TO = "not-a-line-id";
      const badEnv = await post(server, { headers: authHeaders(), body: { text: "hi" } });
      assert.equal(badEnv.status, 500);
      assert.equal(badEnv.json.error, "invalid_target");
      assert.equal(pushes.length, 0);
      delete process.env.NOTIFY_LINE_TO;
    });

    await check("to、訂閱、NOTIFY_LINE_TO 的優先序", async () => {
      resetRelay();
      pushes.length = 0;
      process.env.NOTIFY_LINE_TO = `  ${USER}  `;
      const fromEnv = await post(server, { headers: authHeaders(), body: { text: "from env" } });
      assert.equal(fromEnv.status, 200);
      assert.equal(fromEnv.json.to, USER);
      assert.equal(pushes.at(-1).body.to, USER);
      assert.equal(pushes.at(-1).retryKey, undefined);

      storage.setNotifyTarget(GROUP);
      const fromStored = await post(server, { headers: authHeaders(), body: { text: "from store" } });
      assert.equal(fromStored.json.to, GROUP);

      const override = await post(server, {
        headers: authHeaders(),
        body: { text: "once", to: ` ${ROOM} ` },
      });
      assert.equal(override.status, 200);
      assert.equal(override.json.to, ROOM);
      assert.equal(storage.getNotifyTarget(), GROUP);

      const badTo = await post(server, {
        headers: authHeaders(),
        body: { text: "nope", to: "U123" },
      });
      assert.equal(badTo.status, 400);
      assert.equal(badTo.json.error, "invalid_target");
      assert.equal(pushes.at(-1).body.to, ROOM);
    });

    await check("idempotency key 轉成 X-Line-Retry-Key 的參數,錯的 key 不推", async () => {
      resetRelay();
      storage.setNotifyTarget(USER);
      pushes.length = 0;
      const upper = RETRY.toUpperCase();
      const res = await post(server, {
        headers: authHeaders(),
        body: { text: "retry me", idempotencyKey: `  ${upper}  ` },
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.retryKey, RETRY);
      assert.equal(pushes[0].retryKey, RETRY);
      assert.equal(pushes[0].body.messages[0].type, "text");

      const again = await post(server, {
        headers: authHeaders(),
        body: { text: "retry me", idempotencyKey: RETRY },
      });
      assert.equal(again.status, 200);
      assert.equal(pushes.length, 2);
      assert.equal(pushes[1].retryKey, RETRY);

      const fromHeader = await post(server, {
        headers: authHeaders({ "idempotency-key": RETRY_B, "x-line-retry-key": RETRY }),
        body: { text: "header" },
      });
      assert.equal(fromHeader.json.retryKey, RETRY_B);
      assert.equal(pushes[2].retryKey, RETRY_B);

      const bodyWins = await post(server, {
        headers: authHeaders({ "idempotency-key": RETRY_B }),
        body: { text: "body wins", idempotencyKey: RETRY },
      });
      assert.equal(bodyWins.json.retryKey, RETRY);

      const bad = await post(server, {
        headers: authHeaders(),
        body: { text: "bad", idempotencyKey: "not-a-uuid" },
      });
      assert.equal(bad.status, 400);
      assert.equal(bad.json.error, "invalid_idempotency_key");
      assert.equal(pushes.length, 4);
    });

    await check("長文一次 push 拆多則,超長則完全不推", async () => {
      resetRelay();
      storage.setNotifyTarget(USER);
      pushes.length = 0;
      const res = await post(server, {
        headers: authHeaders(),
        body: { text: "a".repeat(6000) },
      });
      assert.equal(res.status, 200);
      assert.equal(pushes.length, 1);
      assert.ok(res.json.messageCount >= 2);
      assert.ok(res.json.messageCount <= 5);
      assert.equal(pushes[0].body.messages.length, res.json.messageCount);
      assert.ok(pushes[0].body.messages.every((message) => message.text.length <= 5000));

      const tooLong = await post(server, {
        headers: authHeaders(),
        body: { text: "a".repeat(notify.NOTIFY_MAX_CHARS + 1) },
      });
      assert.equal(tooLong.status, 400);
      assert.equal(tooLong.json.error, "text_too_long");
      assert.equal(pushes.length, 1);
    });

    await check("Markdown 推出去是純文字,回應與 log 都不含內文或 token", async () => {
      resetRelay();
      storage.setNotifyTarget(USER);
      pushes.length = 0;
      const before = logs.length;
      const res = await post(server, {
        headers: authHeaders(),
        body: { text: `**${PHRASE}** 看 [牙醫](https://dentist.example/a)` },
      });
      assert.equal(res.status, 200);
      assert.equal(res.text.includes(PHRASE), false);
      assert.equal(res.text.includes(TOKEN), false);
      const text = pushes[0].body.messages[0].text;
      assert.match(text, new RegExp(PHRASE));
      assert.equal(text.includes("**"), false);
      assert.match(text, /牙醫 \(https:\/\/dentist\.example\/a\)/);
      const written = logs.slice(before).join("\n");
      assert.match(written, /notify ok/);
      assert.equal(written.includes(PHRASE), false);
      assert.equal(written.includes(TOKEN), false);
    });

    await check("LINE 失敗不回傳上游 body,409 與其他狀態分開", async () => {
      resetRelay();
      storage.setNotifyTarget(USER);
      pushes.length = 0;
      pushImpl = async () => {
        const err = new Error(`upstream ${PHRASE} ${TOKEN}`);
        err.status = 429;
        err.body = `{"message":"${PHRASE}"}`;
        throw err;
      };
      const limited = await post(server, {
        headers: authHeaders(),
        body: { text: PHRASE },
      });
      assert.equal(limited.status, 502);
      assert.equal(limited.json.error, "line_push_failed");
      assert.equal(limited.json.status, 429);
      assert.equal(limited.json.to, USER);
      assert.equal(limited.text.includes(PHRASE), false);
      assert.equal(limited.text.includes(TOKEN), false);

      pushImpl = async () => {
        const err = new Error("in progress");
        err.status = 409;
        throw err;
      };
      const conflict = await post(server, {
        headers: authHeaders(),
        body: { text: "again", idempotencyKey: RETRY },
      });
      assert.equal(conflict.status, 409);
      assert.equal(conflict.json.status, 409);
      pushImpl = async (body, retryKey) => {
        pushes.push({ body, retryKey });
        return { sentMessages: [] };
      };
    });

    await check("webhook 仍驗簽名,簽過的購物指令照常回覆", async () => {
      const webhook = await post(server, {
        path: "/webhook",
        headers: { "content-type": "application/json" },
        raw: "{}",
      });
      assert.equal(webhook.status, 401);

      const raw = JSON.stringify({
        events: [
          {
            type: "message",
            replyToken: "reply-1",
            source: { type: "user", userId: USER },
            message: { type: "text", id: "1", text: "買 雞蛋" },
          },
        ],
      });
      const before = replies.length;
      const signed = await post(server, {
        path: "/webhook",
        headers: {
          "content-type": "application/json",
          "x-line-signature": signWebhook(raw),
        },
        raw,
      });
      assert.equal(signed.status, 200);
      assert.equal(replies.length, before + 1);
      assert.equal(replies.at(-1).replyToken, "reply-1");
      assert.match(replies.at(-1).messages[0].text, /^已加入:雞蛋/);

      const chat = JSON.stringify({
        events: [
          {
            type: "message",
            replyToken: "reply-2",
            source: { type: "user", userId: USER },
            message: { type: "text", id: "2", text: "今天天氣真好" },
          },
        ],
      });
      const ignored = await post(server, {
        path: "/webhook",
        headers: {
          "content-type": "application/json",
          "x-line-signature": signWebhook(chat),
        },
        raw: chat,
      });
      assert.equal(ignored.status, 200);
      assert.equal(replies.length, before + 1);

      const forged = await post(server, {
        path: "/webhook",
        headers: {
          "content-type": "application/json",
          "x-line-signature": signWebhook('{"events":[]}'),
        },
        raw,
      });
      assert.equal(forged.status, 401);

      const { port } = server.address();
      const health = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(5000) });
      assert.equal(health.status, 200);
      assert.match(await health.text(), /Alfred LINE Bot is running/);
    });

    await check("這段驗證的 log 沒有 token 或訊息內文", () => {
      const blob = logs.join("\n");
      assert.equal(blob.includes(TOKEN), false);
      assert.equal(blob.includes(WRONG_TOKEN), false);
      assert.equal(blob.includes(PHRASE), false);
      assert.match(blob, /notify push failed/);
    });
  } finally {
    for (const method of Object.keys(originalConsole)) {
      console[method] = originalConsole[method];
    }
  }

  await check("直接執行 index.js 時,沒有 token 會關閉端點且 webhook 仍是 401", () =>
    smokeProcess()
  );

  console.log(`OK ${passed}`);
}

async function smokeProcess() {
  const childDir = fs.mkdtempSync(path.join(os.tmpdir(), "alfred-notify-boot-"));
  const child = spawn(process.execPath, ["index.js"], {
    cwd: root,
    env: {
      PATH: process.env.PATH || "",
      PORT: "0",
      DATA_DIR: childDir,
      LINE_CHANNEL_SECRET: "test-channel-secret",
      LINE_CHANNEL_ACCESS_TOKEN: "test-channel-token",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (buf) => {
    out += buf.toString();
  });
  child.stderr.on("data", (buf) => {
    out += buf.toString();
  });

  let port;
  try {
    port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`boot timeout\n${out}`));
      }, 8000);
      const timerPoll = setInterval(() => {
        const match = out.match(/listening on port (\d+)/);
        if (match && Number(match[1]) > 0) {
          cleanup();
          child.off("exit", onExit);
          resolve(Number(match[1]));
        }
      }, 20);
      function cleanup() {
        clearTimeout(timer);
        clearInterval(timerPoll);
      }
      function onExit(code) {
        cleanup();
        reject(new Error(`exited ${code}\n${out}`));
      }
      child.once("exit", onExit);
    });

    const notifyRes = await fetch(`http://127.0.0.1:${port}/notify`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer super-secret-token",
      },
      body: JSON.stringify({ text: "should-not-send" }),
      signal: AbortSignal.timeout(5000),
    });
    const body = await notifyRes.json();
    assert.equal(notifyRes.status, 503);
    assert.equal(body.error, "notify_disabled");
    const webhook = await fetch(`http://127.0.0.1:${port}/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(webhook.status, 401);
    assert.match(out, /NOTIFY_TOKEN 未設定/);
    assert.equal(out.includes("should-not-send"), false);
    assert.equal(out.includes("super-secret-token"), false);
  } finally {
    if (child.exitCode == null) child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => {
        if (child.exitCode != null) resolve();
        else child.once("exit", () => resolve());
      }),
      new Promise((resolve) =>
        setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 2000)
      ),
    ]);
    fs.rmSync(childDir, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  await storage.closeStorage();
  fs.rmSync(tmp, { recursive: true, force: true });
}
