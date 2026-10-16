import { tokensMatch } from "./notify.js";

// 群組裡被點名,或主人一對一傳來的非指令訊息,轉給外部助理。
// 助理之後用既有的 POST /notify(帶 replyTo)把答案推回 LINE。
// 這個檔不改 /notify 的合約,方便跟提醒轉發一起留著。

export const DEFAULT_ACK_TEXT = "收到，我想一下 🤔";
export const DEFAULT_ERROR_TEXT = "助理暫時連不上，請稍後再試";
export const DEFAULT_WEBHOOK_TIMEOUT_MS = 5000;
export const DEFAULT_PROFILE_TIMEOUT_MS = 400;
export const ASSISTANT_PAYLOAD_KEYS = [
  "text",
  "rawText",
  "sourceType",
  "userId",
  "groupId",
  "roomId",
  "replyTo",
  "messageId",
  "timestamp",
  "displayName",
];

const ALFRED_PREFIX =
  /^(?:[@＠][\s\u3000]*)?alfred(?![a-z0-9_])(?:[\s\u3000]*[:：,，、.。!！?？])?[\s\u3000]*/i;
const DISABLE_WORDS = new Set(["0", "false", "off", "no", "disable", "disabled"]);

let cachedBotUserId = null;
let fetchOverride = null;
let urlWarning = null;

export function resetAssistantStateForTests() {
  cachedBotUserId = null;
  fetchOverride = null;
  urlWarning = null;
}

export function setAssistantFetch(fn) {
  fetchOverride = typeof fn === "function" ? fn : null;
}

export function botUserId() {
  const fromEnv = process.env.LINE_BOT_USER_ID;
  if (typeof fromEnv === "string" && fromEnv.trim()) return fromEnv.trim();
  return cachedBotUserId;
}

export function resetBotUserIdCache() {
  cachedBotUserId = null;
}

export async function warmBotUserId(lineClient) {
  if (typeof process.env.LINE_BOT_USER_ID === "string" && process.env.LINE_BOT_USER_ID.trim()) {
    return;
  }
  if (typeof lineClient?.getBotInfo !== "function") return;

  let timer;
  let timedOut = false;
  const infoPromise = Promise.resolve()
    .then(() => lineClient.getBotInfo())
    .catch((err) => {
      console.error(`assistant bot info failed name=${err?.name || "Error"}`);
      return null;
    });
  try {
    const info = await Promise.race([
      infoPromise,
      new Promise((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve(null);
        }, 3000);
        timer.unref?.();
      }),
    ]);
    if (timedOut) {
      console.error("assistant bot info failed name=TimeoutError");
      return;
    }
    const id = info?.userId;
    if (typeof id !== "string" || !id.trim()) return;
    if (typeof process.env.LINE_BOT_USER_ID === "string" && process.env.LINE_BOT_USER_ID.trim()) {
      return;
    }
    cachedBotUserId = id.trim();
  } finally {
    clearTimeout(timer);
  }
}

function noteUrlProblem(warn) {
  if (!warn || urlWarning === warn) return;
  urlWarning = warn;
  console.error(`assistant webhook disabled reason=${warn}`);
}

function parseAssistantUrl() {
  const raw = process.env.ASSISTANT_WEBHOOK_URL;
  if (typeof raw !== "string" || !raw.trim()) return { url: null };
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    return { url: null, warn: "invalid_url" };
  }
  if (url.protocol !== "https:") return { url: null, warn: "not_https" };
  if (url.username || url.password) return { url: null, warn: "url_credentials" };
  return { url: url.href };
}

export function assistantWebhookUrl() {
  const parsed = parseAssistantUrl();
  if (parsed.warn) noteUrlProblem(parsed.warn);
  return parsed.url;
}

export function assistantAuthHeader() {
  const value = process.env.ASSISTANT_WEBHOOK_AUTH;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function boundedInt(raw, fallback, min, max) {
  if (raw == null || String(raw).trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

export function assistantTimeoutMs() {
  return boundedInt(
    process.env.ASSISTANT_WEBHOOK_TIMEOUT_MS,
    DEFAULT_WEBHOOK_TIMEOUT_MS,
    100,
    20000
  );
}

export function profileTimeoutMs() {
  return boundedInt(process.env.ASSISTANT_PROFILE_TIMEOUT_MS, DEFAULT_PROFILE_TIMEOUT_MS, 0, 3000);
}

function disabledWord(value) {
  return DISABLE_WORDS.has(String(value).trim().toLowerCase());
}

export function ackText() {
  const flag = process.env.ASSISTANT_ACK;
  if (typeof flag === "string" && disabledWord(flag)) return null;
  if (!Object.prototype.hasOwnProperty.call(process.env, "ASSISTANT_ACK_TEXT")) {
    return DEFAULT_ACK_TEXT;
  }
  const custom = process.env.ASSISTANT_ACK_TEXT;
  if (typeof custom !== "string" || !custom.trim() || disabledWord(custom)) return null;
  return safeSlice(custom.trim(), 1000);
}

export function assistantErrorText() {
  const custom = process.env.ASSISTANT_ERROR_TEXT;
  if (typeof custom === "string" && custom.trim()) return safeSlice(custom.trim(), 1000);
  return DEFAULT_ERROR_TEXT;
}

export function assistantHelpSuffix() {
  if (!assistantWebhookUrl()) return "";
  return (
    "\n\n🧠 問助理:\n" +
    "- 群組或聊天室:標記我,或傳以 Alfred / @Alfred 開頭的話\n" +
    "- 一對一:直接傳,不用標記(購物清單、轉發指令和 help 仍照常處理)\n" +
    "我會先回覆一句,答案稍後送到這個聊天。"
  );
}

function parseIdList(raw) {
  if (typeof raw !== "string") return null;
  const items = raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return items.length > 0 ? items : null;
}

function idsMatch(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = left.trim().toLowerCase();
  const b = right.trim().toLowerCase();
  if (!a || !b) return false;
  return tokensMatch(a, b);
}

function idInList(id, raw) {
  const list = parseIdList(raw);
  if (!list) return true;
  return list.some((item) => idsMatch(id, item));
}

function configuredOwnerId() {
  const value = process.env.NOTIFY_OWNER_ID;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

// 沒設 NOTIFY_OWNER_ID 時,一對一的對方就視為主人(個人 bot)。
// 有設的話只有那個使用者 ID 的一對一會轉發。
export function isOwnerDirect(userId) {
  const owner = configuredOwnerId();
  if (!owner) return true;
  return idsMatch(userId, owner);
}

function isHighSurrogate(code) {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code) {
  return code >= 0xdc00 && code <= 0xdfff;
}

function safeSlice(text, max) {
  if (text.length <= max) return text;
  let cut = max;
  if (isHighSurrogate(text.charCodeAt(cut - 1))) cut -= 1;
  if (cut <= 0) return "";
  return text.slice(0, cut);
}

export function hasAlfredPrefix(text) {
  return ALFRED_PREFIX.test(String(text).trim());
}

export function stripAlfredPrefix(text) {
  return String(text).trim().replace(ALFRED_PREFIX, "").trim();
}

function botMentionInfo(event) {
  const mentionees = event?.message?.mention?.mentionees;
  const info = { spans: [], mentioned: false };
  if (!Array.isArray(mentionees)) return info;
  const botId = botUserId();
  for (const mentionee of mentionees) {
    if (!mentionee || typeof mentionee !== "object") continue;
    const self =
      mentionee.isSelf === true ||
      (botId && typeof mentionee.userId === "string" && idsMatch(mentionee.userId, botId));
    if (!self) continue;
    info.mentioned = true;
    if (
      Number.isInteger(mentionee.index) &&
      Number.isInteger(mentionee.length) &&
      mentionee.index >= 0 &&
      mentionee.length > 0
    ) {
      info.spans.push({ index: mentionee.index, length: mentionee.length });
    }
  }
  return info;
}

function markSpan(drop, text, start, length) {
  let from = start;
  let to = start + length;
  if (from >= text.length || to <= 0) return;
  if (from < 0) from = 0;
  if (to > text.length) to = text.length;
  if (from > 0 && isLowSurrogate(text.charCodeAt(from)) && isHighSurrogate(text.charCodeAt(from - 1))) {
    from -= 1;
  }
  if (to < text.length && isHighSurrogate(text.charCodeAt(to - 1)) && isLowSurrogate(text.charCodeAt(to))) {
    to += 1;
  }
  for (let i = from; i < to; i += 1) drop[i] = true;
}

function stripSpans(text, spans) {
  if (!spans.length || !text) return text;
  const drop = new Array(text.length).fill(false);
  for (const span of spans) markSpan(drop, text, span.index, span.length);
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    if (!drop[i]) out += text[i];
  }
  return out;
}

function collapseSpaces(text) {
  return text.replace(/[ \t\u3000]{2,}/g, " ").trim();
}

export function resolveAddress(event) {
  const rawText = typeof event?.message?.text === "string" ? event.message.text : "";
  const mention = botMentionInfo(event);
  const withoutMention = collapseSpaces(stripSpans(rawText, mention.spans));
  const prefixed = hasAlfredPrefix(withoutMention) || hasAlfredPrefix(rawText);
  const text = hasAlfredPrefix(withoutMention) ? stripAlfredPrefix(withoutMention) : withoutMention;
  return {
    addressed: mention.mentioned || prefixed,
    text,
    rawText,
  };
}

export function commandTextFor(event) {
  const address = resolveAddress(event);
  if (address.addressed) return address.text;
  return typeof event?.message?.text === "string" ? event.message.text.trim() : "";
}

function cleanName(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? safeSlice(trimmed, 80) : null;
}

function inlineDisplayName(event) {
  return cleanName(event?.source?.displayName) || cleanName(event?.message?.displayName);
}

export function buildAssistantPayload(event, address, displayName) {
  const source = event?.source || {};
  const groupId = typeof source.groupId === "string" && source.groupId ? source.groupId : null;
  const roomId = typeof source.roomId === "string" && source.roomId ? source.roomId : null;
  const userId = typeof source.userId === "string" && source.userId ? source.userId : null;
  const name = cleanName(displayName) || inlineDisplayName(event);
  return {
    text: address.text,
    rawText: address.rawText,
    sourceType: typeof source.type === "string" ? source.type : null,
    userId,
    groupId,
    roomId,
    replyTo: groupId || roomId || userId,
    messageId: typeof event?.message?.id === "string" ? event.message.id : null,
    timestamp:
      typeof event?.timestamp === "number" && Number.isFinite(event.timestamp) ? event.timestamp : null,
    displayName: name,
  };
}

export function classifyForward(event) {
  if (!assistantWebhookUrl()) return { forward: false };
  const rawText = typeof event?.message?.text === "string" ? event.message.text : "";
  if (!rawText.trim()) return { forward: false };

  const source = event?.source || {};
  const address = resolveAddress(event);
  let candidate = false;
  if (source.type === "group" || source.type === "room") candidate = address.addressed;
  else if (source.type === "user") candidate = isOwnerDirect(source.userId);
  if (!candidate) return { forward: false };

  if (!idInList(source.userId, process.env.ASSISTANT_ALLOWED_USER_IDS)) {
    return { forward: false, skip: "user_not_allowed" };
  }
  if (
    source.type === "group" &&
    !idInList(source.groupId, process.env.ASSISTANT_ALLOWED_GROUP_IDS)
  ) {
    return { forward: false, skip: "group_not_allowed" };
  }
  return { forward: true };
}

async function drain(response) {
  if (!response) return;
  try {
    if (response.body && typeof response.body.cancel === "function") {
      await response.body.cancel();
      return;
    }
  } catch {
    // 改走下面的讀取
  }
  try {
    if (typeof response.arrayBuffer === "function") await response.arrayBuffer();
    else if (typeof response.text === "function") await response.text();
  } catch {
    // 回應本文不重要,也不記 log
  }
}

export async function postAssistantWebhook(payload, fetchFn) {
  const url = assistantWebhookUrl();
  if (!url) {
    const err = new Error("assistant_unconfigured");
    err.name = "AssistantUnconfigured";
    throw err;
  }
  const headers = { "Content-Type": "application/json" };
  const auth = assistantAuthHeader();
  if (auth) headers.Authorization = auth;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), assistantTimeoutMs());
  try {
    const response = await (fetchFn || fetchOverride || globalThis.fetch)(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
      redirect: "error",
    });
    await drain(response);
    if (!response || response.ok !== true) {
      const err = new Error("assistant_rejected");
      err.name = "AssistantRejected";
      const status = Number(response?.status);
      if (Number.isInteger(status)) err.status = status;
      throw err;
    }
  } finally {
    clearTimeout(timer);
  }
}

export async function lookupDisplayName(event, lineClient) {
  const inline = inlineDisplayName(event);
  if (inline) return inline;
  const timeout = profileTimeoutMs();
  if (timeout === 0 || !lineClient) return null;
  const source = event?.source || {};
  const userId = source.userId;
  if (typeof userId !== "string" || !userId) return null;

  let request;
  try {
    if (
      source.type === "group" &&
      source.groupId &&
      typeof lineClient.getGroupMemberProfile === "function"
    ) {
      request = lineClient.getGroupMemberProfile(source.groupId, userId);
    } else if (
      source.type === "room" &&
      source.roomId &&
      typeof lineClient.getRoomMemberProfile === "function"
    ) {
      request = lineClient.getRoomMemberProfile(source.roomId, userId);
    } else if (typeof lineClient.getProfile === "function") {
      request = lineClient.getProfile(userId);
    }
  } catch {
    return null;
  }
  if (!request || typeof request.then !== "function") return null;

  const settled = Promise.resolve(request).then(
    (profile) => profile,
    () => null
  );
  let timer;
  try {
    const profile = await Promise.race([
      settled,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), timeout);
      }),
    ]);
    return cleanName(profile?.displayName);
  } finally {
    clearTimeout(timer);
  }
}

async function replyText(lineClient, event, text) {
  if (!text || !event?.replyToken || typeof lineClient?.replyMessage !== "function") return;
  try {
    await lineClient.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: "text", text }],
    });
  } catch (err) {
    console.error(`assistant reply failed name=${err?.name || "Error"}`);
  }
}

export async function maybeForwardToAssistant(event, lineClient) {
  let decision;
  try {
    decision = classifyForward(event);
  } catch (err) {
    console.error(`assistant handler failed name=${err?.name || "Error"}`);
    return;
  }
  if (!decision.forward) {
    if (decision.skip) {
      console.log(`assistant skip reason=${decision.skip} source=${event?.source?.type || ""}`);
    }
    return;
  }

  const address = resolveAddress(event);
  let payload = null;
  try {
    const displayName = await lookupDisplayName(event, lineClient);
    payload = buildAssistantPayload(event, address, displayName);
    await postAssistantWebhook(payload);
    console.log(
      `assistant forward ok source=${payload.sourceType || ""} replyTo=${payload.replyTo || ""}`
    );
  } catch (err) {
    const status = Number.isInteger(err?.status) ? String(err.status) : "unknown";
    const sourceType = payload?.sourceType || event?.source?.type || "";
    console.error(
      `assistant forward failed source=${sourceType} status=${status} name=${err?.name || "Error"}`
    );
    await replyText(lineClient, event, assistantErrorText());
    return;
  }

  const ack = ackText();
  if (ack) await replyText(lineClient, event, ack);
}
