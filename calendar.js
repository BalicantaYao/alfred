import crypto from "node:crypto";

// Google Calendar 整合(服務帳戶)。
// 用內建 crypto 做 JWT 簽名換 access token,不需要整包 googleapis。
// 需要的環境變數:
//   GOOGLE_SERVICE_ACCOUNT_KEY  服務帳戶金鑰 JSON(原文或 base64)
//   GOOGLE_CALENDAR_ID          行事曆 ID(通常是你的 Gmail 地址)

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/calendar.readonly";

export const DEFAULT_TZ = process.env.REMINDER_TZ || "Asia/Taipei";

export function calendarEnabled() {
  return Boolean(
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY && process.env.GOOGLE_CALENDAR_ID
  );
}

let serviceAccount = null;

function getServiceAccount() {
  if (serviceAccount) return serviceAccount;
  let raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY.trim();
  // Railway 的環境變數貼多行 JSON 容易出錯,也接受 base64 編碼
  if (!raw.startsWith("{")) {
    raw = Buffer.from(raw, "base64").toString("utf8");
  }
  serviceAccount = JSON.parse(raw);
  return serviceAccount;
}

function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

let cachedToken = null; // { token, expiresAt }

async function getAccessToken() {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.token;
  }

  const sa = getServiceAccount();
  const iat = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat,
      exp: iat + 3600,
    })
  );
  const signature = crypto
    .createSign("RSA-SHA256")
    .update(`${header}.${claims}`)
    .sign(sa.private_key, "base64url");

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${header}.${claims}.${signature}`,
    }),
  });
  if (!res.ok) {
    throw new Error(`Google token exchange failed (${res.status}): ${await res.text()}`);
  }
  const data = await res.json();
  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  return cachedToken.token;
}

// 取得某時區的 UTC 偏移字串,如 "+08:00"
function tzOffsetString(date, tz) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    timeZoneName: "longOffset",
  }).formatToParts(date);
  const name = parts.find((p) => p.type === "timeZoneName")?.value || "GMT";
  const m = name.match(/GMT([+-]\d{2}:\d{2})/);
  return m ? m[1] : "+00:00";
}

// 某時刻在指定時區的年月日,如 "2026-07-20"
function localDateString(date, tz) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

// 撈今天(指定時區)的行程,回傳 Calendar API 的 event 陣列(已展開重複行程、依時間排序)
export async function getTodayEvents(now = new Date(), tz = DEFAULT_TZ) {
  const token = await getAccessToken();
  const offset = tzOffsetString(now, tz);
  const today = localDateString(now, tz);
  const tomorrow = localDateString(new Date(now.getTime() + 24 * 3600 * 1000), tz);

  const params = new URLSearchParams({
    timeMin: `${today}T00:00:00${offset}`,
    timeMax: `${tomorrow}T00:00:00${offset}`,
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "50",
    timeZone: tz,
  });
  const calendarId = encodeURIComponent(process.env.GOOGLE_CALENDAR_ID);
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events?${params}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) {
    throw new Error(`Calendar API failed (${res.status}): ${await res.text()}`);
  }
  const data = await res.json();
  return data.items || [];
}

function formatTime(dateTime, tz) {
  return new Intl.DateTimeFormat("zh-TW", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(dateTime));
}

// 把 event 陣列排成 LINE 訊息文字
export function formatAgenda(events, now = new Date(), tz = DEFAULT_TZ) {
  const monthDay = new Intl.DateTimeFormat("zh-TW", {
    timeZone: tz,
    month: "numeric",
    day: "numeric",
  }).format(now);
  const weekday = new Intl.DateTimeFormat("zh-TW", {
    timeZone: tz,
    weekday: "short",
  }).format(now);
  const dateLabel = `${monthDay} ${weekday}`;

  if (events.length === 0) {
    return `📅 今天(${dateLabel})沒有任何行程,好好休息吧!`;
  }

  const lines = events.map((ev) => {
    const title = ev.summary || "(未命名行程)";
    if (ev.start?.date) {
      // 全天行程只有 date 沒有 dateTime
      return `・整天|${title}`;
    }
    const start = formatTime(ev.start.dateTime, tz);
    const end = ev.end?.dateTime ? formatTime(ev.end.dateTime, tz) : null;
    const location = ev.location ? ` @ ${ev.location}` : "";
    return `・${start}${end ? `–${end}` : ""}|${title}${location}`;
  });

  return `📅 今日行程(${dateLabel})\n${lines.join("\n")}`;
}

// 查詢 + 排版一次做完,給指令與每日推播共用
export async function buildTodayAgenda(now = new Date(), tz = DEFAULT_TZ) {
  const events = await getTodayEvents(now, tz);
  return formatAgenda(events, now, tz);
}
