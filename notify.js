import crypto from "crypto";
import express from "express";
import {
  clearNotifyTarget,
  getNotifyTarget,
  setNotifyTarget,
} from "./storage.js";

// 外部助理把提醒轉進 LINE。
// POST /notify 需要 Authorization: Bearer <NOTIFY_TOKEN>。
// 推送對象優先序: JSON to > 聊天裡的「訂閱轉發」> NOTIFY_LINE_TO。

export const LINE_TEXT_MAX = 5000;
export const LINE_PUSH_MAX_MESSAGES = 5;
// 「（1/5）\n」最多 6 個 UTF-16 code unit,拆則時要預留,才不會超過 LINE 單則上限。
export const MARKER_RESERVE = 6;
export const NOTIFY_MAX_CHARS =
  (LINE_TEXT_MAX - MARKER_RESERVE) * LINE_PUSH_MAX_MESSAGES;

const LINE_ID = /^[UCR][0-9a-f]{32}$/i;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const NOTIFY_HELP = [
  "🔔 提醒轉發:",
  "- 訂閱轉發:把這個聊天設成提醒的推送對象",
  "- 取消轉發:取消這個聊天的轉發",
  "- 轉發狀態:查看目前轉發到哪裡",
  "- 我的ID:顯示使用者、群組或聊天室 ID",
].join("\n");

export function notifyToken() {
  const value = process.env.NOTIFY_TOKEN;
  if (typeof value !== "string" || value.trim().length === 0) return null;
  return value;
}

export function isLineId(value) {
  return typeof value === "string" && LINE_ID.test(value.trim());
}

// 先 hash 再比,兩邊長度固定,避免 timingSafeEqual 因長度不同丟例外,也避免逐字短路。
export function tokensMatch(provided, expected) {
  if (typeof provided !== "string" || typeof expected !== "string") return false;
  const actual = crypto.createHash("sha256").update(provided).digest();
  const wanted = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(actual, wanted);
}

function authorizationHeader(req) {
  const value = req.headers?.authorization;
  if (Array.isArray(value)) return value[0] || "";
  return typeof value === "string" ? value : "";
}

function bearerToken(req) {
  const match = authorizationHeader(req).match(/^Bearer\s+(\S+)\s*$/i);
  return match ? match[1] : null;
}

export function authorizeNotify(req) {
  const expected = notifyToken();
  if (!expected) return { status: 503, error: "notify_disabled" };
  const provided = bearerToken(req);
  const matches = tokensMatch(provided ?? "", expected);
  if (!provided || !matches) return { status: 401, error: "unauthorized" };
  return null;
}

export function notifyAuthMiddleware(req, res, next) {
  const auth = authorizeNotify(req);
  if (!auth) {
    next();
    return;
  }
  // 沒驗證過就不要解析 JSON。把 body 排掉,避免連線卡在未讀的 request 上。
  req.resume();
  res.status(auth.status).json({ ok: false, error: auth.error });
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isJsonRequest(req) {
  const value = req.headers?.["content-type"];
  if (typeof value !== "string") return false;
  return /^application\/json\b/i.test(value.split(";")[0].trim());
}

export function markdownToPlain(input) {
  const slots = [];
  const stash = (content) => {
    const token = `\u0000${slots.length}\u0000`;
    slots.push(content);
    return token;
  };

  let text = String(input)
    .replace(/\u0000/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
  text = text.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_, code) =>
    stash(code.replace(/\n$/, ""))
  );
  text = text.replace(/`([^`\n]+)`/g, (_, code) => stash(code));
  text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, url) =>
    alt ? `${alt} (${url})` : url
  );
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) =>
    label === url ? url : `${label} (${url})`
  );
  text = text.replace(/^(?:---|\*\*\*|___)\s*$/gm, "");
  text = text.replace(/^#{1,6}\s+/gm, "");
  text = text.replace(/^(?:>\s?)+/gm, "");
  text = text.replace(/\*\*([^*\n]+)\*\*/g, "$1");
  text = text.replace(/__([^_\n]+)__/g, "$1");
  text = text.replace(/~~([^~\n]+)~~/g, "$1");
  text = text.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, "$1$2");
  text = text.replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?:;]|$)/g, "$1$2");
  text = text.replace(/\n{3,}/g, "\n\n");
  text = text.replace(/\u0000(\d+)\u0000/g, (_, index) => slots[Number(index)] ?? "");
  return text.trim();
}

function safeHardCut(text, limit) {
  let cut = Math.min(limit, text.length);
  if (cut <= 0) return 0;
  const prev = text.charCodeAt(cut - 1);
  if (prev >= 0xd800 && prev <= 0xdbff) cut -= 1;
  return cut;
}

function cutIndex(text, limit) {
  const hard = safeHardCut(text, limit);
  const minBreak = Math.floor(limit * 0.4);
  const paragraph = text.lastIndexOf("\n\n", hard);
  if (paragraph >= minBreak) return paragraph;
  const line = text.lastIndexOf("\n", hard);
  if (line >= minBreak) return line;
  return hard;
}

// 回傳要推的純文字陣列;塞不進 5 則就回 null,呼叫端要整批拒絕,不能只送前面幾則。
export function splitLineText(text) {
  if (text.length <= LINE_TEXT_MAX) return [text];

  const limit = LINE_TEXT_MAX - MARKER_RESERVE;
  const parts = [];
  let rest = text;
  while (rest.length > 0) {
    if (parts.length === LINE_PUSH_MAX_MESSAGES) return null;
    if (rest.length <= limit) {
      const last = rest.replace(/\n+$/, "");
      if (last) parts.push(last);
      break;
    }
    const cut = cutIndex(rest, limit);
    if (cut <= 0) return null;
    const piece = rest.slice(0, cut).replace(/\n+$/, "");
    const next = rest.slice(cut).replace(/^\n+/, "");
    if (next.length >= rest.length) return null;
    if (piece) parts.push(piece);
    rest = next;
  }

  if (parts.length === 0 || parts.length > LINE_PUSH_MAX_MESSAGES) return null;
  if (parts.length === 1) return parts;
  return parts.map((part, index) => `（${index + 1}/${parts.length}）\n${part}`);
}

export function prepareMessages(raw) {
  if (typeof raw !== "string") return { error: "text_required", status: 400 };
  if (raw.length > 100000) {
    return { error: "text_too_long", status: 400, maxChars: NOTIFY_MAX_CHARS };
  }
  const plain = markdownToPlain(raw);
  if (!plain) return { error: "text_required", status: 400 };
  const messages = splitLineText(plain);
  if (!messages) {
    return { error: "text_too_long", status: 400, maxChars: NOTIFY_MAX_CHARS };
  }
  return { messages };
}

function configuredEnvTarget() {
  const raw = process.env.NOTIFY_LINE_TO;
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  return value || null;
}

function resolveTarget(body) {
  if (Object.prototype.hasOwnProperty.call(body, "to") && body.to !== undefined) {
    if (typeof body.to !== "string" || !isLineId(body.to)) {
      return { error: "invalid_target", status: 400 };
    }
    return { to: body.to.trim() };
  }

  const stored = getNotifyTarget();
  if (stored) {
    if (!isLineId(stored)) return { error: "invalid_target", status: 500 };
    return { to: stored };
  }

  const envTo = configuredEnvTarget();
  if (envTo) {
    if (!isLineId(envTo)) return { error: "invalid_target", status: 500 };
    return { to: envTo };
  }
  return { error: "no_target", status: 422 };
}

function headerValue(req, name) {
  const value = req.headers?.[name];
  if (Array.isArray(value)) return value[0];
  return value == null || value === "" ? null : value;
}

function normalizeRetryKey(value) {
  if (typeof value !== "string" || !UUID.test(value.trim())) {
    return { error: "invalid_idempotency_key" };
  }
  return { key: value.trim().toLowerCase() };
}

function readRetryKey(req, body) {
  if (
    Object.prototype.hasOwnProperty.call(body, "idempotencyKey") &&
    body.idempotencyKey != null
  ) {
    return normalizeRetryKey(body.idempotencyKey);
  }
  const fromHeader =
    headerValue(req, "idempotency-key") ?? headerValue(req, "x-line-retry-key");
  if (fromHeader == null) return { key: null };
  return normalizeRetryKey(fromHeader);
}

function numberStatus(err) {
  const status = Number(err?.status ?? err?.statusCode);
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : null;
}

export async function notifyHandler(req, res, { pushMessage }) {
  const auth = authorizeNotify(req);
  if (auth) {
    res.status(auth.status).json({ ok: false, error: auth.error });
    return;
  }
  // express.json() 在沒解析時也會把 req.body 設成 {}。Content-Type 不對就不要當成空的 JSON。
  if (!isJsonRequest(req)) {
    req.resume();
    res.status(400).json({ ok: false, error: "invalid_body" });
    return;
  }
  if (!isPlainObject(req.body)) {
    res.status(400).json({ ok: false, error: "invalid_body" });
    return;
  }

  const prepared = prepareMessages(req.body.text);
  if (prepared.error) {
    const payload = { ok: false, error: prepared.error };
    if (prepared.maxChars) payload.maxChars = prepared.maxChars;
    res.status(prepared.status).json(payload);
    return;
  }

  const retry = readRetryKey(req, req.body);
  if (retry.error) {
    res.status(400).json({ ok: false, error: retry.error });
    return;
  }

  const target = resolveTarget(req.body);
  if (target.error) {
    res.status(target.status).json({ ok: false, error: target.error });
    return;
  }

  try {
    await pushMessage(
      {
        to: target.to,
        messages: prepared.messages.map((text) => ({ type: "text", text })),
      },
      retry.key || undefined
    );
  } catch (err) {
    const status = numberStatus(err);
    console.error(
      `notify push failed to=${target.to} status=${status ?? "unknown"}`
    );
    const payload = { ok: false, error: "line_push_failed", to: target.to };
    if (status != null) payload.status = status;
    res.status(status === 409 ? 409 : 502).json(payload);
    return;
  }

  console.log(
    `notify ok to=${target.to} parts=${prepared.messages.length} chars=${prepared.messages.reduce((sum, part) => sum + part.length, 0)} retry=${retry.key ? "yes" : "no"}`
  );
  res.status(200).json({
    ok: true,
    to: target.to,
    messageCount: prepared.messages.length,
    retryKey: retry.key,
  });
}

export function mountNotify(app, deps) {
  app.post(
    "/notify",
    notifyAuthMiddleware,
    express.json({ limit: "128kb" }),
    (req, res, next) => {
      notifyHandler(req, res, deps).catch(next);
    }
  );
}

export function handleNotifyBodyError(err, req, res) {
  if (req.path !== "/notify") return false;
  if (
    err?.type === "entity.parse.failed" ||
    (err instanceof SyntaxError && (err.status === 400 || err.statusCode === 400))
  ) {
    res.status(400).json({ ok: false, error: "invalid_json" });
    return true;
  }
  if (err?.type === "entity.too.large" || err.status === 413 || err.statusCode === 413) {
    res.status(413).json({ ok: false, error: "body_too_large" });
    return true;
  }
  console.error(`notify error name=${err?.name || "Error"}`);
  if (!res.headersSent) {
    res.status(500).json({ ok: false, error: "internal_error" });
  }
  return true;
}

function chatIdOf(source) {
  if (!source) return null;
  return source.groupId || source.roomId || source.userId || null;
}

function ownerLock() {
  const value = process.env.NOTIFY_OWNER_ID;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function lockedOut(source) {
  const owner = ownerLock();
  if (!owner) return false;
  const userId = source?.userId;
  return typeof userId !== "string" || !tokensMatch(userId, owner);
}

function normalizeCommand(text) {
  return String(text).replace(/^[\s\u3000]+|[\s\u3000]+$/g, "");
}

function myIdReply(source) {
  const chatId = chatIdOf(source);
  const lines = [];
  if (source?.userId) lines.push(`使用者 ID: ${source.userId}`);
  if (source?.groupId) lines.push(`群組 ID: ${source.groupId}`);
  if (source?.roomId) lines.push(`聊天室 ID: ${source.roomId}`);
  if (lines.length === 0) return "找不到這個聊天的 ID。";
  if (!chatId || !isLineId(chatId)) {
    lines.push("", "這個 ID 不是 LINE 的使用者、群組或聊天室格式,無法設成轉發對象。");
    return lines.join("\n");
  }
  lines.push("", `轉發會送到: ${chatId}`);
  lines.push("輸入「訂閱轉發」,或把這個 ID 設成 NOTIFY_LINE_TO。");
  return lines.join("\n");
}

function statusReply(source) {
  const chatId = chatIdOf(source);
  const stored = getNotifyTarget();
  if (lockedOut(source)) {
    return stored && chatId && stored === chatId
      ? "這個聊天是轉發對象。"
      : "這個聊天目前不是轉發對象。";
  }

  const envTo = configuredEnvTarget();
  const lines = ["轉發狀態"];
  if (chatId) lines.push(`這個聊天 ID: ${chatId}`);
  if (stored && isLineId(stored)) {
    lines.push(
      stored === chatId ? "已訂閱:這個聊天會收到轉發。" : `已訂閱的對象: ${stored}`
    );
  } else {
    lines.push("尚未訂閱轉發。");
  }
  lines.push(envTo ? `NOTIFY_LINE_TO: ${envTo}` : "NOTIFY_LINE_TO: 未設定");
  const effective = stored && isLineId(stored) ? stored : envTo && isLineId(envTo) ? envTo : null;
  if (effective) {
    const via = stored && isLineId(stored) ? "訂閱" : "NOTIFY_LINE_TO";
    lines.push(`目前預設推送到: ${effective}（${via}）`);
  } else {
    lines.push("目前沒有預設推送對象。輸入「訂閱轉發」或設定 NOTIFY_LINE_TO。");
  }
  return lines.join("\n");
}

const OWNER_ONLY = "只有主人可以變更轉發對象。";

// 是轉發指令就回覆文字,否則 null,讓購物清單接著處理。
export function handleNotifyCommand(text, source = {}) {
  const command = normalizeCommand(text);
  if (command === "我的ID" || command.toLowerCase() === "我的id") {
    return myIdReply(source);
  }
  if (command === "轉發狀態") return statusReply(source);

  if (command !== "訂閱轉發" && command !== "取消轉發") return null;
  if (lockedOut(source)) return OWNER_ONLY;

  const chatId = chatIdOf(source);
  if (!chatId || !isLineId(chatId)) {
    return "找不到可用的聊天 ID。請傳「我的ID」查看。";
  }

  if (command === "取消轉發") {
    if (getNotifyTarget() !== chatId) return "這個聊天目前不是轉發對象。";
    clearNotifyTarget();
    return "已取消轉發。這個聊天不會再收到訂閱轉發。\n若設了 NOTIFY_LINE_TO,提醒仍會推到那個 ID。";
  }

  const previous = getNotifyTarget();
  setNotifyTarget(chatId);
  if (previous && previous !== chatId) {
    return `已改為這個聊天。之後的提醒會推到這裡。\nID: ${chatId}`;
  }
  return `已訂閱轉發。之後的提醒會推到這個聊天。\nID: ${chatId}`;
}
