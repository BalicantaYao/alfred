// 驗證問助理:點名與前綴、允許清單、假的 fetch / LINE、購物指令優先。
//   node scripts/verify-assistant.js
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alfred-assistant-"));
const USER = "U" + "ab".repeat(16);
const OTHER = "U" + "12".repeat(16);
const GROUP = "C" + "cd".repeat(16);
const GROUP_B = "C" + "34".repeat(16);
const ROOM = "R" + "ef".repeat(16);
const BOT = "U" + "99".repeat(16);
const WEBHOOK = "https://assistant.example/hook";
const TOKEN = "Bearer super-secret-assistant-token";
const PHRASE = "PHRASE_DO_NOT_LOG_9f3a";
const BODY_SECRET = "BODY_DO_NOT_LOG_77";
const URL_SECRET = "http://secret-host.example/path?token=abc";
const CRED_SECRET = "https://user:s3cret@assistant.example/hook";

for (const key of [
  "ASSISTANT_WEBHOOK_URL",
  "ASSISTANT_WEBHOOK_AUTH",
  "ASSISTANT_ALLOWED_USER_IDS",
  "ASSISTANT_ALLOWED_GROUP_IDS",
  "ASSISTANT_ACK",
  "ASSISTANT_ACK_TEXT",
  "ASSISTANT_ERROR_TEXT",
  "ASSISTANT_WEBHOOK_TIMEOUT_MS",
  "ASSISTANT_PROFILE_TIMEOUT_MS",
  "LINE_BOT_USER_ID",
  "NOTIFY_OWNER_ID",
  "NOTIFY_LINE_TO",
  "NOTIFY_TOKEN",
  "DATABASE_URL",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "LLM_PROVIDER",
]) {
  delete process.env[key];
}
process.env.DATA_DIR = tmp;
process.env.LINE_CHANNEL_SECRET = "test-channel-secret";
process.env.LINE_CHANNEL_ACCESS_TOKEN = "test-channel-token";

const assistant = await import("../assistant.js");
const index = await import("../index.js");

let passed = 0;
const logs = [];
const calls = [];
const replies = [];
const pushes = [];
const profile = { group: 0, room: 0, user: 0 };

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

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
  } catch (err) {
    err.message = `${name}: ${err.message}`;
    throw err;
  }
}

function installFetch(impl) {
  assistant.setAssistantFetch(async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : null;
    const call = {
      url,
      method: options.method,
      headers: { ...options.headers },
      body,
      redirect: options.redirect,
      signal: options.signal,
    };
    calls.push(call);
    if (impl) return impl(call, options);
    return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) };
  });
}

let replyImpl = async (body) => {
  replies.push(body);
};
let pushImpl = async (body) => {
  pushes.push(body);
};

const lineClient = {
  pushMessage(body, retryKey) {
    return pushImpl(body, retryKey);
  },
  replyMessage(body) {
    return replyImpl(body);
  },
  getGroupMemberProfile(groupId, userId) {
    profile.group += 1;
    return Promise.resolve({ displayName: "小明", groupId, userId });
  },
  getRoomMemberProfile(roomId, userId) {
    profile.room += 1;
    return Promise.resolve({ displayName: "小明", roomId, userId });
  },
  getProfile(userId) {
    profile.user += 1;
    return Promise.resolve({ displayName: "小明", userId });
  },
};

function resetCase() {
  calls.length = 0;
  replies.length = 0;
  pushes.length = 0;
  profile.group = 0;
  profile.room = 0;
  profile.user = 0;
  delete process.env.ASSISTANT_ALLOWED_USER_IDS;
  delete process.env.ASSISTANT_ALLOWED_GROUP_IDS;
  delete process.env.ASSISTANT_ACK;
  delete process.env.ASSISTANT_ACK_TEXT;
  delete process.env.ASSISTANT_ERROR_TEXT;
  delete process.env.ASSISTANT_WEBHOOK_TIMEOUT_MS;
  delete process.env.ASSISTANT_PROFILE_TIMEOUT_MS;
  delete process.env.NOTIFY_OWNER_ID;
  process.env.ASSISTANT_WEBHOOK_URL = WEBHOOK;
  process.env.ASSISTANT_WEBHOOK_AUTH = TOKEN;
  process.env.LINE_BOT_USER_ID = BOT;
  installFetch();
  replyImpl = async (body) => {
    replies.push(body);
  };
  pushImpl = async (body) => {
    pushes.push(body);
  };
}

function signWebhook(raw) {
  return crypto.createHmac("sha256", process.env.LINE_CHANNEL_SECRET).update(raw).digest("base64");
}

function listen(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
    server.on("error", reject);
  });
}

async function post(server, { pathname = "/webhook", headers = {}, body, raw } = {}) {
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
  return { status: res.status, text };
}

function groupSource(extra = {}) {
  return { type: "group", groupId: GROUP, userId: USER, ...extra };
}

function event({
  text,
  replyToken = "reply-1",
  source,
  messageId = "m1",
  timestamp = 1760598000000,
  mention,
  displayName,
}) {
  const message = { type: "text", id: messageId, text };
  if (mention) message.mention = { mentionees: mention };
  const src = source || groupSource();
  if (displayName) src.displayName = displayName;
  return {
    type: "message",
    replyToken,
    timestamp,
    source: src,
    message,
  };
}

function selfMention(text, label = "@Alfred") {
  const index = text.indexOf(label);
  assert.ok(index >= 0);
  return [{ index, length: label.length, userId: BOT, isSelf: true }];
}

async function postEvents(server, events) {
  const raw = JSON.stringify({ events });
  return post(server, {
    raw,
    headers: {
      "content-type": "application/json",
      "x-line-signature": signWebhook(raw),
    },
  });
}

function assertPayload(body, expected) {
  assert.deepEqual(Object.keys(body), assistant.ASSISTANT_PAYLOAD_KEYS);
  assert.deepEqual(body, expected);
  assert.equal(JSON.stringify(body).includes(TOKEN), false);
}

let server;

async function main() {
  const originalConsole = {};
  for (const method of ["log", "info", "warn", "error", "debug"]) {
    originalConsole[method] = console[method];
    console[method] = (...args) => {
      logs.push(
        args
          .map((part) => {
            if (typeof part === "string") return part;
            if (part instanceof Error) return `${part.name} ${part.message}`;
            return String(part);
          })
          .join(" ")
      );
    };
  }

  try {
    await check("http 網址與內含帳密的網址不會啟用,log 不含網址", () => {
      assistant.resetAssistantStateForTests();
      process.env.ASSISTANT_WEBHOOK_URL = URL_SECRET;
      assert.equal(assistant.assistantWebhookUrl(), null);
      process.env.ASSISTANT_WEBHOOK_URL = CRED_SECRET;
      assert.equal(assistant.assistantWebhookUrl(), null);
      const blob = logs.join("\n");
      assert.equal(blob.includes("secret-host"), false);
      assert.equal(blob.includes("token=abc"), false);
      assert.equal(blob.includes("s3cret"), false);
      assert.match(blob, /reason=not_https/);
      assert.match(blob, /reason=url_credentials/);
      delete process.env.ASSISTANT_WEBHOOK_URL;
    });

    await check("確認句可改、可關,失敗句有預設", () => {
      delete process.env.ASSISTANT_ACK;
      delete process.env.ASSISTANT_ACK_TEXT;
      assert.equal(assistant.ackText(), assistant.DEFAULT_ACK_TEXT);
      process.env.ASSISTANT_ACK_TEXT = " 想一下 ";
      assert.equal(assistant.ackText(), "想一下");
      process.env.ASSISTANT_ACK = "false";
      assert.equal(assistant.ackText(), null);
      delete process.env.ASSISTANT_ACK;
      process.env.ASSISTANT_ACK_TEXT = "off";
      assert.equal(assistant.ackText(), null);
      process.env.ASSISTANT_ACK_TEXT = "";
      assert.equal(assistant.ackText(), null);
      delete process.env.ASSISTANT_ACK_TEXT;
      process.env.ASSISTANT_ERROR_TEXT = " 等一下 ";
      assert.equal(assistant.assistantErrorText(), "等一下");
      delete process.env.ASSISTANT_ERROR_TEXT;
      assert.equal(assistant.assistantErrorText(), assistant.DEFAULT_ERROR_TEXT);
    });

    await check("標記、前綴與 UTF-16 索引", () => {
      process.env.LINE_BOT_USER_ID = BOT;
      const asked = "@Alfred 明天會下雨嗎";
      const mentioned = assistant.resolveAddress(
        event({ text: asked, mention: selfMention(asked) })
      );
      assert.equal(mentioned.addressed, true);
      assert.equal(mentioned.text, "明天會下雨嗎");
      assert.equal(mentioned.rawText, asked);

      const byId = assistant.resolveAddress(
        event({
          text: asked,
          mention: [{ index: 0, length: 7, userId: BOT }],
        })
      );
      assert.equal(byId.addressed, true);
      assert.equal(byId.text, "明天會下雨嗎");

      delete process.env.LINE_BOT_USER_ID;
      assistant.resetBotUserIdCache();
      const withoutBotId = assistant.resolveAddress(
        event({
          text: "@管家 明天會下雨嗎",
          mention: [{ index: 0, length: "@管家".length, userId: BOT }],
        })
      );
      assert.equal(withoutBotId.addressed, false);
      const label = "@管家";
      const selfOnly = assistant.resolveAddress(
        event({
          text: `${label} 明天會下雨嗎`,
          mention: [{ index: 0, length: label.length, isSelf: true }],
        })
      );
      assert.equal(selfOnly.addressed, true);
      assert.equal(selfOnly.text, "明天會下雨嗎");

      const other = assistant.resolveAddress(
        event({
          text: "@Bob 天氣",
          mention: [{ index: 0, length: 4, userId: OTHER }],
        })
      );
      assert.equal(other.addressed, false);

      const all = assistant.resolveAddress(
        event({
          text: "@All 天氣",
          mention: [{ index: 0, length: 4, type: "all" }],
        })
      );
      assert.equal(all.addressed, false);

      assert.equal(assistant.resolveAddress(event({ text: "ALFRED: 明天" })).text, "明天");
      assert.equal(assistant.resolveAddress(event({ text: "@alfred 明天" })).addressed, true);
      assert.equal(assistant.resolveAddress(event({ text: "＠Alfred　你好" })).text, "你好");
      assert.equal(assistant.resolveAddress(event({ text: "@ alfred 嗨" })).text, "嗨");
      assert.equal(assistant.resolveAddress(event({ text: "alfred" })).text, "");
      assert.equal(assistant.resolveAddress(event({ text: "alfredo 明天" })).addressed, false);
      assert.equal(assistant.resolveAddress(event({ text: "今天 alfred 在嗎" })).addressed, false);

      const wave = "👋 @Alfred 天氣";
      assert.equal(wave.indexOf("@Alfred"), 3);
      const waved = assistant.resolveAddress(
        event({
          text: wave,
          mention: [{ index: 3, length: 7, isSelf: true }],
        })
      );
      assert.equal(waved.text, "👋 天氣");
      assert.equal(hasLoneSurrogate(waved.text), false);

      const split = assistant.resolveAddress(
        event({
          text: "👋hi",
          mention: [{ index: 1, length: 1, isSelf: true }],
        })
      );
      assert.equal(split.text, "hi");
      assert.equal(hasLoneSurrogate(split.text), false);

      const middle = "請 @Alfred 看明天";
      const mid = assistant.resolveAddress(
        event({
          text: middle,
          mention: [{ index: middle.indexOf("@Alfred"), length: 7, isSelf: true }],
        })
      );
      assert.equal(mid.text, "請 看明天");
      process.env.LINE_BOT_USER_ID = BOT;
    });

    await check("payload 欄位固定,replyTo 依群組、聊天室、一對一", () => {
      const address = { text: "明天", rawText: "@Alfred 明天" };
      const group = assistant.buildAssistantPayload(
        event({
          text: address.rawText,
          messageId: "m-g",
          timestamp: 1760598000000,
          source: groupSource(),
        }),
        address,
        "小明"
      );
      assertPayload(group, {
        text: "明天",
        rawText: "@Alfred 明天",
        sourceType: "group",
        userId: USER,
        groupId: GROUP,
        roomId: null,
        replyTo: GROUP,
        messageId: "m-g",
        timestamp: 1760598000000,
        displayName: "小明",
      });

      const room = assistant.buildAssistantPayload(
        event({
          text: "hi",
          source: { type: "room", roomId: ROOM, userId: USER },
          messageId: "m-r",
        }),
        { text: "hi", rawText: "hi" },
        null
      );
      assert.equal(room.replyTo, ROOM);
      assert.equal(room.groupId, null);
      assert.equal(room.displayName, null);

      const direct = assistant.buildAssistantPayload(
        event({
          text: "hi",
          source: { type: "user", userId: USER },
        }),
        { text: "hi", rawText: "hi" },
        null
      );
      assert.equal(direct.replyTo, USER);
      assert.equal(direct.groupId, null);
      assert.equal(direct.roomId, null);
    });

    await check("誰該轉發:點名、主人一對一、允許清單", () => {
      process.env.ASSISTANT_WEBHOOK_URL = WEBHOOK;
      process.env.LINE_BOT_USER_ID = BOT;
      delete process.env.NOTIFY_OWNER_ID;
      delete process.env.ASSISTANT_ALLOWED_USER_IDS;
      delete process.env.ASSISTANT_ALLOWED_GROUP_IDS;

      const mention = event({ text: "@Alfred 明天", mention: selfMention("@Alfred 明天") });
      assert.equal(assistant.classifyForward(mention).forward, true);
      assert.equal(assistant.classifyForward(event({ text: "今天天氣真好" })).forward, false);
      assert.equal(assistant.classifyForward(event({ text: "alfred 明天" })).forward, true);
      assert.equal(
        assistant.classifyForward(
          event({ text: "明天", source: { type: "room", roomId: ROOM, userId: USER } })
        ).forward,
        false
      );
      assert.equal(
        assistant.classifyForward(
          event({
            text: "@Alfred 明天",
            source: { type: "room", roomId: ROOM, userId: USER },
            mention: selfMention("@Alfred 明天"),
          })
        ).forward,
        true
      );

      assert.equal(
        assistant.classifyForward(
          event({ text: "明天", source: { type: "user", userId: OTHER } })
        ).forward,
        true
      );
      process.env.NOTIFY_OWNER_ID = USER;
      assert.equal(
        assistant.classifyForward(
          event({ text: "明天", source: { type: "user", userId: USER } })
        ).forward,
        true
      );
      assert.equal(
        assistant.classifyForward(
          event({ text: "alfred 明天", source: { type: "user", userId: OTHER } })
        ).forward,
        false
      );

      process.env.ASSISTANT_ALLOWED_USER_IDS = ` ${OTHER.toLowerCase()} , ${USER.toUpperCase()} `;
      assert.equal(assistant.classifyForward(mention).forward, true);
      process.env.ASSISTANT_ALLOWED_USER_IDS = OTHER;
      assert.equal(assistant.classifyForward(mention).forward, false);
      assert.equal(assistant.classifyForward(mention).skip, "user_not_allowed");

      delete process.env.ASSISTANT_ALLOWED_USER_IDS;
      process.env.ASSISTANT_ALLOWED_GROUP_IDS = GROUP_B;
      assert.equal(assistant.classifyForward(mention).forward, false);
      assert.equal(assistant.classifyForward(mention).skip, "group_not_allowed");
      assert.equal(
        assistant.classifyForward(
          event({ text: "明天", source: { type: "user", userId: USER } })
        ).forward,
        true
      );
      assert.equal(
        assistant.classifyForward(
          event({
            text: "@Alfred 明天",
            source: { type: "room", roomId: ROOM, userId: USER },
            mention: selfMention("@Alfred 明天"),
          })
        ).forward,
        true
      );
      delete process.env.ASSISTANT_WEBHOOK_URL;
      assert.equal(assistant.classifyForward(mention).forward, false);
    });

    await check("顯示名稱:事件裡有就不用查,慢的查詢會放棄", async () => {
      process.env.ASSISTANT_PROFILE_TIMEOUT_MS = "0";
      const named = event({ text: "@Alfred hi", displayName: "內嵌" });
      let called = false;
      const name = await assistant.lookupDisplayName(named, {
        getGroupMemberProfile() {
          called = true;
          return Promise.resolve({ displayName: "不該用" });
        },
      });
      assert.equal(name, "內嵌");
      assert.equal(called, false);

      delete process.env.ASSISTANT_PROFILE_TIMEOUT_MS;
      const looked = await assistant.lookupDisplayName(
        event({ text: "hi", source: { type: "user", userId: USER } }),
        {
          getProfile(userId) {
            assert.equal(userId, USER);
            return Promise.resolve({ displayName: " 主人 " });
          },
        }
      );
      assert.equal(looked, "主人");

      process.env.ASSISTANT_PROFILE_TIMEOUT_MS = "60";
      const slow = await assistant.lookupDisplayName(event({ text: "hi" }), {
        getGroupMemberProfile() {
          return new Promise(() => {});
        },
      });
      assert.equal(slow, null);

      const broken = await assistant.lookupDisplayName(
        event({ text: "hi", source: { type: "user", userId: USER } }),
        {
          getProfile() {
            throw new Error("profile down");
          },
        }
      );
      assert.equal(broken, null);
      delete process.env.ASSISTANT_PROFILE_TIMEOUT_MS;
    });

    await check("getBotInfo 記到 Bot ID,失敗不丟出、不覆寫", async () => {
      delete process.env.LINE_BOT_USER_ID;
      assistant.resetBotUserIdCache();
      let callsToInfo = 0;
      await assistant.warmBotUserId({
        getBotInfo() {
          callsToInfo += 1;
          return Promise.resolve({ userId: `  ${BOT}  ` });
        },
      });
      assert.equal(assistant.botUserId(), BOT);
      assert.equal(
        assistant.resolveAddress(
          event({
            text: "@Alfred hi",
            mention: [{ index: 0, length: 7, userId: BOT }],
          })
        ).addressed,
        true
      );

      await assistant.warmBotUserId({
        getBotInfo() {
          callsToInfo += 1;
          return Promise.reject(Object.assign(new Error(`nope ${TOKEN}`), { name: "LineError" }));
        },
      });
      assert.equal(assistant.botUserId(), BOT);
      assert.match(logs.at(-1), /name=LineError/);
      assert.equal(logs.at(-1).includes(TOKEN), false);

      process.env.LINE_BOT_USER_ID = OTHER;
      callsToInfo = 0;
      await assistant.warmBotUserId({
        getBotInfo() {
          callsToInfo += 1;
          return Promise.resolve({ userId: BOT });
        },
      });
      assert.equal(callsToInfo, 0);
      assert.equal(assistant.botUserId(), OTHER);
      process.env.LINE_BOT_USER_ID = BOT;
    });

    await check("POST 帶完整 Authorization,逾時與非 2xx 都不含本文", async () => {
      process.env.ASSISTANT_WEBHOOK_URL = WEBHOOK;
      process.env.ASSISTANT_WEBHOOK_AUTH = `  ${TOKEN}  `;
      process.env.ASSISTANT_WEBHOOK_TIMEOUT_MS = "20000";
      const payload = { text: PHRASE, rawText: PHRASE };
      await assistant.postAssistantWebhook(payload, async (url, options) => {
        assert.equal(url, WEBHOOK);
        assert.equal(options.method, "POST");
        assert.equal(options.headers.Authorization, TOKEN);
        assert.equal(options.headers["Content-Type"], "application/json");
        assert.equal(options.redirect, "error");
        assert.equal(JSON.parse(options.body).text, PHRASE);
        return {
          ok: true,
          status: 204,
          body: { cancel: async () => {} },
        };
      });

      await assert.rejects(
        assistant.postAssistantWebhook(payload, async () => ({
          ok: false,
          status: 502,
          arrayBuffer: async () => Buffer.from(BODY_SECRET),
        })),
        (err) => err.name === "AssistantRejected" && err.status === 502
      );

      process.env.ASSISTANT_WEBHOOK_TIMEOUT_MS = "80";
      const started = Date.now();
      await assert.rejects(
        assistant.postAssistantWebhook(payload, (url, options) => {
          return new Promise((resolve, reject) => {
            options.signal.addEventListener("abort", () => {
              const err = new Error(`aborted ${TOKEN} ${PHRASE}`);
              err.name = "AbortError";
              reject(err);
            });
          });
        }),
        (err) => err.name === "AbortError"
      );
      assert.ok(Date.now() - started < 2000);
      delete process.env.ASSISTANT_WEBHOOK_AUTH;
      await assistant.postAssistantWebhook({ text: "x" }, async (url, options) => {
        assert.equal(options.headers.Authorization, undefined);
        return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) };
      });
      process.env.ASSISTANT_WEBHOOK_AUTH = TOKEN;
    });

    server = await listen(index.createApp(lineClient));

    await check("沒簽名的 webhook 仍是 401", async () => {
      const res = await post(server, {
        raw: "{}",
        headers: { "content-type": "application/json" },
      });
      assert.equal(res.status, 401);
    });

    await check("群組點名轉發,確認句用 reply token,body 與標頭正確", async () => {
      resetCase();
      const text = `@Alfred 明天會下雨嗎 ${PHRASE}`;
      const res = await postEvents(server, [
        event({
          text,
          replyToken: "reply-mention",
          messageId: "m-weather",
          mention: selfMention(text),
        }),
      ]);
      assert.equal(res.status, 200);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, WEBHOOK);
      assert.equal(calls[0].method, "POST");
      assert.equal(calls[0].redirect, "error");
      assert.equal(calls[0].headers.Authorization, TOKEN);
      assert.equal(calls[0].headers["Content-Type"], "application/json");
      assertPayload(calls[0].body, {
        text: `明天會下雨嗎 ${PHRASE}`,
        rawText: text,
        sourceType: "group",
        userId: USER,
        groupId: GROUP,
        roomId: null,
        replyTo: GROUP,
        messageId: "m-weather",
        timestamp: 1760598000000,
        displayName: "小明",
      });
      assert.equal(profile.group, 1);
      assert.equal(replies.length, 1);
      assert.equal(replies[0].replyToken, "reply-mention");
      assert.equal(replies[0].messages[0].text, assistant.DEFAULT_ACK_TEXT);
      assert.equal(pushes.length, 0);
    });

    await check("沒點名的群組閒聊不轉發也不回覆", async () => {
      resetCase();
      const res = await postEvents(server, [
        event({ text: `今天天氣真好 ${PHRASE}`, replyToken: "reply-chat" }),
      ]);
      assert.equal(res.status, 200);
      assert.equal(calls.length, 0);
      assert.equal(replies.length, 0);
      assert.equal(profile.group, 0);
      assert.equal(pushes.length, 0);
    });

    await check("開頭 alfred 當成點名,聊天室點名的 replyTo 是 room", async () => {
      resetCase();
      const prefixed = await postEvents(server, [
        event({ text: `Alfred, ${PHRASE}`, replyToken: "reply-prefix", messageId: "m-prefix" }),
      ]);
      assert.equal(prefixed.status, 200);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].body.text, PHRASE);
      assert.equal(calls[0].body.rawText, `Alfred, ${PHRASE}`);
      assert.equal(replies[0].messages[0].text, assistant.DEFAULT_ACK_TEXT);

      resetCase();
      const roomText = "@Alfred 聊天室";
      const room = await postEvents(server, [
        event({
          text: roomText,
          replyToken: "reply-room",
          messageId: "m-room",
          source: { type: "room", roomId: ROOM, userId: USER },
          mention: selfMention(roomText),
        }),
      ]);
      assert.equal(room.status, 200);
      assert.equal(calls[0].body.replyTo, ROOM);
      assert.equal(calls[0].body.sourceType, "room");
      assert.equal(calls[0].body.groupId, null);
      assert.equal(profile.room, 1);
      assert.equal(profile.group, 0);
    });

    await check("購物、轉發指令與 help 優先,點名後的指令也不轉發", async () => {
      resetCase();
      const listed = await postEvents(server, [
        event({
          text: "@Alfred 清單",
          replyToken: "reply-list",
          mention: selfMention("@Alfred 清單"),
        }),
      ]);
      assert.equal(listed.status, 200);
      assert.equal(calls.length, 0);
      assert.match(replies[0].messages[0].text, /購物清單是空的/);

      resetCase();
      const added = await postEvents(server, [
        event({ text: "alfred 買 牛奶 @家樂福", replyToken: "reply-add" }),
      ]);
      assert.equal(added.status, 200);
      assert.equal(calls.length, 0);
      assert.match(replies[0].messages[0].text, /^已加入:牛奶\(家樂福\)/);

      resetCase();
      const plain = await postEvents(server, [
        event({ text: "買 電池", replyToken: "reply-plain" }),
      ]);
      assert.equal(plain.status, 200);
      assert.equal(calls.length, 0);
      assert.match(replies[0].messages[0].text, /^已加入:電池/);

      resetCase();
      const directAdd = await postEvents(server, [
        event({
          text: "買 雞蛋",
          replyToken: "reply-egg",
          source: { type: "user", userId: USER },
        }),
      ]);
      assert.equal(directAdd.status, 200);
      assert.equal(calls.length, 0);
      assert.match(replies[0].messages[0].text, /^已加入:雞蛋/);

      resetCase();
      const subscribed = await postEvents(server, [
        event({
          text: "訂閱轉發",
          replyToken: "reply-sub",
          source: { type: "user", userId: USER },
        }),
      ]);
      assert.equal(subscribed.status, 200);
      assert.equal(calls.length, 0);
      assert.match(replies[0].messages[0].text, /已訂閱轉發/);

      resetCase();
      const helped = await postEvents(server, [
        event({
          text: "@Alfred help",
          replyToken: "reply-help",
          mention: selfMention("@Alfred help"),
        }),
      ]);
      assert.equal(helped.status, 200);
      assert.equal(calls.length, 0);
      assert.match(replies[0].messages[0].text, /問助理/);
      assert.equal(await index.buildReply(`明天 ${PHRASE}`, USER, { userId: USER }), null);
    });

    await check("主人一對一才轉發,允許清單擋下來時不回確認", async () => {
      resetCase();
      process.env.NOTIFY_OWNER_ID = USER;
      const mine = await postEvents(server, [
        event({
          text: PHRASE,
          replyToken: "reply-dm",
          messageId: "m-dm",
          source: { type: "user", userId: USER },
        }),
      ]);
      assert.equal(mine.status, 200);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].body.text, PHRASE);
      assert.equal(calls[0].body.replyTo, USER);
      assert.equal(calls[0].body.groupId, null);
      assert.equal(profile.user, 1);
      assert.equal(profile.group, 0);
      assert.equal(replies[0].messages[0].text, assistant.DEFAULT_ACK_TEXT);

      resetCase();
      process.env.NOTIFY_OWNER_ID = USER;
      const stranger = await postEvents(server, [
        event({
          text: `alfred ${PHRASE}`,
          replyToken: "reply-stranger",
          source: { type: "user", userId: OTHER },
        }),
      ]);
      assert.equal(stranger.status, 200);
      assert.equal(calls.length, 0);
      assert.equal(replies.length, 0);

      resetCase();
      process.env.ASSISTANT_ALLOWED_USER_IDS = OTHER;
      const blocked = await postEvents(server, [
        event({
          text: `@Alfred ${PHRASE}`,
          replyToken: "reply-blocked",
          mention: selfMention(`@Alfred ${PHRASE}`),
        }),
      ]);
      assert.equal(blocked.status, 200);
      assert.equal(calls.length, 0);
      assert.equal(replies.length, 0);
      assert.match(logs.at(-1), /reason=user_not_allowed/);
      assert.equal(logs.at(-1).includes(PHRASE), false);

      resetCase();
      process.env.ASSISTANT_ALLOWED_GROUP_IDS = GROUP_B;
      process.env.NOTIFY_OWNER_ID = USER;
      const wrongGroup = await postEvents(server, [
        event({
          text: "@Alfred 群組",
          mention: selfMention("@Alfred 群組"),
        }),
      ]);
      assert.equal(wrongGroup.status, 200);
      assert.equal(calls.length, 0);
      assert.match(logs.at(-1), /reason=group_not_allowed/);

      const stillDirect = await postEvents(server, [
        event({
          text: "一對一還可以",
          replyToken: "reply-still",
          messageId: "m-still",
          source: { type: "user", userId: USER },
        }),
      ]);
      assert.equal(stillDirect.status, 200);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].body.replyTo, USER);
    });

    await check("確認句可關;失敗回錯誤句且 webhook 仍 200;不 push", async () => {
      resetCase();
      process.env.ASSISTANT_ACK = "off";
      process.env.ASSISTANT_ACK_TEXT = "不該出現";
      const quiet = await postEvents(server, [
        event({
          text: "@Alfred 悄悄",
          replyToken: "reply-quiet",
          mention: selfMention("@Alfred 悄悄"),
        }),
      ]);
      assert.equal(quiet.status, 200);
      assert.equal(calls.length, 1);
      assert.equal(replies.length, 0);
      assert.equal(pushes.length, 0);

      resetCase();
      process.env.ASSISTANT_ACK_TEXT = "好,我看看";
      installFetch(async () => ({
        ok: false,
        status: 503,
        arrayBuffer: async () => Buffer.from(BODY_SECRET),
      }));
      const failed = await postEvents(server, [
        event({
          text: `@Alfred ${PHRASE}`,
          replyToken: "reply-fail",
          mention: selfMention(`@Alfred ${PHRASE}`),
        }),
      ]);
      assert.equal(failed.status, 200);
      assert.equal(calls.length, 1);
      assert.equal(replies.length, 1);
      assert.equal(replies[0].replyToken, "reply-fail");
      assert.equal(replies[0].messages[0].text, assistant.DEFAULT_ERROR_TEXT);
      assert.equal(pushes.length, 0);
      assert.match(logs.at(-1) || logs.join("\n"), /status=503/);

      resetCase();
      process.env.ASSISTANT_WEBHOOK_TIMEOUT_MS = "100";
      installFetch(
        (call, options) =>
          new Promise((resolve, reject) => {
            options.signal.addEventListener("abort", () => {
              const err = new Error(`aborted ${TOKEN} ${PHRASE} ${BODY_SECRET}`);
              err.name = "AbortError";
              reject(err);
            });
          })
      );
      const timed = await postEvents(server, [
        event({
          text: "@Alfred 等太久",
          replyToken: "reply-timeout",
          mention: selfMention("@Alfred 等太久"),
        }),
      ]);
      assert.equal(timed.status, 200);
      assert.equal(replies[0].messages[0].text, assistant.DEFAULT_ERROR_TEXT);
      assert.equal(pushes.length, 0);

      resetCase();
      installFetch(async () => {
        const err = new Error(`network ${TOKEN} ${PHRASE}`);
        err.name = "FetchError";
        throw err;
      });
      replyImpl = async () => {
        const err = new Error(`reply ${TOKEN} ${PHRASE}`);
        err.name = "ReplyError";
        throw err;
      };
      const blown = await postEvents(server, [
        event({
          text: `@Alfred ${PHRASE}`,
          replyToken: "reply-blow",
          mention: selfMention(`@Alfred ${PHRASE}`),
        }),
      ]);
      assert.equal(blown.status, 200);
      assert.match(logs.join("\n"), /name=FetchError/);
      assert.match(logs.join("\n"), /name=ReplyError/);
    });

    await check("貼圖與 follow 不轉發;同一則 webhook 裡指令與點名各走各的", async () => {
      resetCase();
      const ignored = await postEvents(server, [
        {
          type: "message",
          replyToken: "reply-sticker",
          source: groupSource(),
          message: { type: "sticker", id: "s1" },
        },
        { type: "follow", replyToken: "reply-follow", source: { type: "user", userId: USER } },
      ]);
      assert.equal(ignored.status, 200);
      assert.equal(calls.length, 0);
      assert.equal(replies.length, 0);

      resetCase();
      const text = "@Alfred 同時";
      const mixed = await postEvents(server, [
        event({
          text: "買 蘋果",
          replyToken: "reply-apple",
          messageId: "m-apple",
          source: { type: "user", userId: USER },
        }),
        event({
          text,
          replyToken: "reply-both",
          messageId: "m-both",
          mention: selfMention(text),
        }),
      ]);
      assert.equal(mixed.status, 200);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].body.text, "同時");
      assert.equal(calls[0].body.messageId, "m-both");
      assert.equal(replies.length, 2);
      assert.ok(replies.some((reply) => /已加入:蘋果/.test(reply.messages[0].text)));
      assert.ok(replies.some((reply) => reply.messages[0].text === assistant.DEFAULT_ACK_TEXT));
      assert.equal(pushes.length, 0);
    });

    await check("事件自帶顯示名稱時不查 profile", async () => {
      resetCase();
      lineClient.getGroupMemberProfile = () => {
        profile.group += 1;
        throw new Error("should not be called");
      };
      const text = "@Alfred 名字";
      const res = await postEvents(server, [
        event({
          text,
          displayName: "內嵌名",
          mention: selfMention(text),
          messageId: "m-name",
        }),
      ]);
      assert.equal(res.status, 200);
      assert.equal(profile.group, 0);
      assert.equal(calls[0].body.displayName, "內嵌名");
      lineClient.getGroupMemberProfile = (groupId, userId) => {
        profile.group += 1;
        return Promise.resolve({ displayName: "小明", groupId, userId });
      };
    });

    await check("這段驗證的 log 沒有 token、網址密文或訊息內文", () => {
      const blob = logs.join("\n");
      assert.equal(blob.includes(TOKEN), false);
      assert.equal(blob.includes("super-secret-assistant-token"), false);
      assert.equal(blob.includes(PHRASE), false);
      assert.equal(blob.includes(BODY_SECRET), false);
      assert.equal(blob.includes("secret-host"), false);
      assert.equal(blob.includes("s3cret"), false);
      assert.match(blob, /assistant forward ok/);
      assert.match(blob, /assistant forward failed/);
    });
  } finally {
    for (const method of Object.keys(originalConsole)) {
      console[method] = originalConsole[method];
    }
    if (server) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(`OK ${passed}`);
}

try {
  await main();
} catch (err) {
  console.error(err);
  process.exitCode = 1;
}
