import crypto from "node:crypto";
import fs from "node:fs";

const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REQUEST_TIMEOUT_MS = 20_000;

let tokenCache = { token: null, expiresAtMs: 0, key: "" };

export function clearCalendarTokenCache() {
  tokenCache = { token: null, expiresAtMs: 0, key: "" };
}

export function calendarConfigured() {
  return Boolean(
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON_PATH ||
      process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 ||
      process.env.GOOGLE_SERVICE_ACCOUNT_JSON ||
      (process.env.GOOGLE_CLIENT_ID &&
        process.env.GOOGLE_CLIENT_SECRET &&
        process.env.GOOGLE_REFRESH_TOKEN)
  );
}

export function calendarIds() {
  return (process.env.GOOGLE_CALENDAR_ID || "primary")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

function credentialKey() {
  return [
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON_PATH || "",
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 || "",
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "",
    process.env.GOOGLE_CLIENT_ID || "",
    process.env.GOOGLE_CLIENT_SECRET || "",
    process.env.GOOGLE_REFRESH_TOKEN || "",
  ].join("\n");
}

function loadServiceAccount() {
  let raw = null;
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON_PATH) {
    raw = fs.readFileSync(process.env.GOOGLE_SERVICE_ACCOUNT_JSON_PATH, "utf8");
  } else if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64) {
    raw = Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64, "base64").toString("utf8");
  } else if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  }
  if (!raw) return null;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Google service account JSON could not be parsed");
  }
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error("Google service account JSON is missing client_email or private_key");
  }
  return parsed;
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

export function createServiceAccountAssertion(serviceAccount, nowSeconds) {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      iss: serviceAccount.client_email,
      scope: CALENDAR_SCOPE,
      aud: TOKEN_URL,
      iat: nowSeconds,
      exp: nowSeconds + 3600,
    })
  );
  const unsigned = `${header}.${payload}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(serviceAccount.private_key).toString("base64url");
  return `${unsigned}.${signature}`;
}

async function requestToken(body, fetchImpl) {
  const response = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Google token request failed: ${response.status} ${text.slice(0, 300)}`);
  }
  const parsed = JSON.parse(text);
  if (!parsed.access_token) throw new Error("Google token response did not include access_token");
  return parsed;
}

async function getAccessToken({ fetchImpl, now }) {
  const key = credentialKey();
  if (tokenCache.token && tokenCache.key === key && tokenCache.expiresAtMs > now.getTime() + 60_000) {
    return tokenCache.token;
  }

  const serviceAccount = loadServiceAccount();
  let body;
  if (serviceAccount) {
    const assertion = createServiceAccountAssertion(
      serviceAccount,
      Math.floor(now.getTime() / 1000)
    );
    body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    });
  } else if (
    process.env.GOOGLE_CLIENT_ID &&
    process.env.GOOGLE_CLIENT_SECRET &&
    process.env.GOOGLE_REFRESH_TOKEN
  ) {
    body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
    });
  } else {
    const err = new Error("Google Calendar credentials are not configured");
    err.code = "CALENDAR_NOT_CONFIGURED";
    throw err;
  }

  const parsed = await requestToken(body, fetchImpl);
  const expiresIn = Number(parsed.expires_in) || 3600;
  tokenCache = {
    token: parsed.access_token,
    expiresAtMs: now.getTime() + expiresIn * 1000,
    key,
  };
  return parsed.access_token;
}

async function listEvents(calendarId, { timeMin, timeMax, token, fetchImpl }) {
  const items = [];
  let pageToken = "";
  do {
    const url = new URL(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`
    );
    url.searchParams.set("timeMin", timeMin);
    url.searchParams.set("timeMax", timeMax);
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("orderBy", "startTime");
    url.searchParams.set("maxResults", "250");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `Calendar API ${response.status} for ${calendarId}: ${text.slice(0, 300)}`
      );
    }
    const data = text ? JSON.parse(text) : {};
    items.push(...(data.items || []));
    pageToken = data.nextPageToken || "";
  } while (pageToken);
  return items;
}

export async function fetchCalendarEvents({
  timeMin,
  timeMax,
  fetchImpl = globalThis.fetch,
  now = new Date(),
} = {}) {
  const token = await getAccessToken({ fetchImpl, now });
  const ids = calendarIds();
  const batches = [];
  for (const calendarId of ids) {
    batches.push(await listEvents(calendarId, { timeMin, timeMax, token, fetchImpl }));
  }
  return batches.flat();
}
