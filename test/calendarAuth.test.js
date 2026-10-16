import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import {
  calendarConfigured,
  clearCalendarTokenCache,
  createServiceAccountAssertion,
  fetchCalendarEvents,
} from "../calendar.js";
import { calendarDigestJob } from "../jobs/calendarDigest.js";

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const serviceAccount = {
  client_email: "alfred@test.iam.gserviceaccount.com",
  private_key: privateKey,
};

function restoreEnv(snapshot) {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("GOOGLE_")) delete process.env[key];
  }
  for (const [key, value] of Object.entries(snapshot)) {
    if (typeof value === "string") process.env[key] = value;
  }
  clearCalendarTokenCache();
}

test("calendar access is unconfigured until credentials exist", () => {
  const previous = {
    GOOGLE_SERVICE_ACCOUNT_JSON: process.env.GOOGLE_SERVICE_ACCOUNT_JSON,
    GOOGLE_SERVICE_ACCOUNT_JSON_BASE64: process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64,
    GOOGLE_SERVICE_ACCOUNT_JSON_PATH: process.env.GOOGLE_SERVICE_ACCOUNT_JSON_PATH,
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
    GOOGLE_REFRESH_TOKEN: process.env.GOOGLE_REFRESH_TOKEN,
  };
  delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64;
  delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON_PATH;
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  delete process.env.GOOGLE_REFRESH_TOKEN;
  try {
    assert.equal(calendarConfigured(), false);
    assert.equal(calendarDigestJob.ready(), false);
  } finally {
    restoreEnv(previous);
  }
});

test("service-account auth signs a read-only JWT and follows calendar pages", async () => {
  const previous = {};
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("GOOGLE_")) previous[key] = process.env[key];
  }
  delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64;
  delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON_PATH;
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  delete process.env.GOOGLE_REFRESH_TOKEN;
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify(serviceAccount);
  process.env.GOOGLE_CALENDAR_ID = "primary, family@example.com";
  clearCalendarTokenCache();

  const calls = [];
  const fetchImpl = async (url, init) => {
    const href = String(url);
    calls.push({ href, init });
    if (href === "https://oauth2.googleapis.com/token") {
      const params = new URLSearchParams(init.body);
      assert.equal(params.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
      const assertion = params.get("assertion");
      const [header, payload, signature] = assertion.split(".");
      const verifier = crypto.createVerify("RSA-SHA256");
      verifier.update(`${header}.${payload}`);
      verifier.end();
      assert.equal(verifier.verify(publicKey, signature, "base64url"), true);
      const decoded = JSON.parse(Buffer.from(payload, "base64url").toString());
      assert.equal(decoded.iss, serviceAccount.client_email);
      assert.equal(decoded.scope, "https://www.googleapis.com/auth/calendar.readonly");
      assert.equal(decoded.aud, "https://oauth2.googleapis.com/token");
      return new Response(JSON.stringify({ access_token: "ya29.test", expires_in: 3600 }), {
        status: 200,
      });
    }
    assert.equal(init.headers.Authorization, "Bearer ya29.test");
    const parsed = new URL(href);
    if (parsed.searchParams.get("pageToken") === "next") {
      return new Response(JSON.stringify({ items: [{ id: "page-2" }] }), { status: 200 });
    }
    assert.equal(parsed.searchParams.get("singleEvents"), "true");
    assert.equal(parsed.searchParams.get("orderBy"), "startTime");
    if (parsed.pathname.includes("family%40example.com")) {
      return new Response(JSON.stringify({ items: [{ id: "family" }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ items: [{ id: "page-1" }], nextPageToken: "next" }), {
      status: 200,
    });
  };

  try {
    const now = new Date("2026-10-16T00:00:00.000Z");
    const first = await fetchCalendarEvents({
      timeMin: "2026-10-15T16:00:00.000Z",
      timeMax: "2026-10-17T16:00:00.000Z",
      fetchImpl,
      now,
    });
    const second = await fetchCalendarEvents({
      timeMin: "2026-10-15T16:00:00.000Z",
      timeMax: "2026-10-17T16:00:00.000Z",
      fetchImpl,
      now,
    });
    assert.deepEqual(
      first.map((event) => event.id),
      ["page-1", "page-2", "family"]
    );
    assert.deepEqual(second, first);
    assert.equal(calls.filter((call) => call.href === "https://oauth2.googleapis.com/token").length, 1);
    assert.equal(calendarDigestJob.ready(), true);
  } finally {
    restoreEnv(previous);
  }
});

test("oauth refresh tokens are exchanged without a service account", async () => {
  const previous = {};
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("GOOGLE_")) previous[key] = process.env[key];
  }
  delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64;
  delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON_PATH;
  process.env.GOOGLE_CLIENT_ID = "client";
  process.env.GOOGLE_CLIENT_SECRET = "secret";
  process.env.GOOGLE_REFRESH_TOKEN = "refresh";
  process.env.GOOGLE_CALENDAR_ID = "primary";
  clearCalendarTokenCache();

  const fetchImpl = async (url, init) => {
    if (String(url) === "https://oauth2.googleapis.com/token") {
      const params = new URLSearchParams(init.body);
      assert.equal(params.get("grant_type"), "refresh_token");
      assert.equal(params.get("refresh_token"), "refresh");
      return new Response(JSON.stringify({ access_token: "oauth-token", expires_in: 3600 }), {
        status: 200,
      });
    }
    assert.equal(init.headers.Authorization, "Bearer oauth-token");
    return new Response(JSON.stringify({ items: [] }), { status: 200 });
  };

  try {
    assert.equal(calendarConfigured(), true);
    const events = await fetchCalendarEvents({
      timeMin: "2026-10-15T16:00:00.000Z",
      timeMax: "2026-10-17T16:00:00.000Z",
      fetchImpl,
      now: new Date("2026-10-16T00:00:00.000Z"),
    });
    assert.deepEqual(events, []);
  } finally {
    restoreEnv(previous);
  }
});

test("the signed assertion verifies for a caller-supplied clock", () => {
  const assertion = createServiceAccountAssertion(serviceAccount, 1_700_000_000);
  const [, payload] = assertion.split(".");
  const decoded = JSON.parse(Buffer.from(payload, "base64url").toString());
  assert.equal(decoded.iat, 1_700_000_000);
  assert.equal(decoded.exp, 1_700_003_600);
});
