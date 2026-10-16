import assert from "node:assert/strict";
import test from "node:test";
import { isDue, runSchedulerTick } from "../scheduler.js";
import { zonedParts } from "../time.js";

const ZONE = "Asia/Taipei";
const AT_0820 = new Date("2026-10-16T00:20:00.000Z");
const log = { log() {}, error() {} };

function partsAt(date) {
  return zonedParts(date, ZONE);
}

test("a reminder is due from the scheduled minute through the catch-up window", () => {
  const at = (iso) => partsAt(new Date(iso));
  assert.equal(isDue("08:20", at("2026-10-16T00:19:00.000Z"), 180), false);
  assert.equal(isDue("08:20", at("2026-10-16T00:20:00.000Z"), 180), true);
  assert.equal(isDue("08:20", at("2026-10-16T03:20:00.000Z"), 180), true);
  assert.equal(isDue("08:20", at("2026-10-16T03:21:00.000Z"), 180), false);
  assert.equal(isDue("23:50", at("2026-10-16T16:10:00.000Z"), 180), false);
  assert.equal(isDue("bad", at("2026-10-16T00:20:00.000Z"), 180), false);
});

function memoryClaims() {
  const rows = new Map();
  return {
    rows,
    async claim(key) {
      const row = rows.get(key);
      if (row?.status === "done" || row?.status === "running") return { ok: false };
      const retryKey = row?.retryKey || `retry:${key}`;
      rows.set(key, { status: "running", retryKey });
      return { ok: true, retryKey };
    },
    async finish(key, status) {
      const row = rows.get(key) || {};
      rows.set(key, { ...row, status });
    },
  };
}

function harness(overrides = {}) {
  const claims = overrides.claims || memoryClaims();
  const pushes = [];
  const subscriptions = overrides.subscriptions || [
    { ownerId: "U1", jobId: "calendar-digest", time: "08:20" },
  ];
  const jobs = overrides.jobs || [
    {
      id: "calendar-digest",
      async run() {
        return "今天有會";
      },
    },
  ];
  const tick = (now = AT_0820) =>
    runSchedulerTick({
      jobs,
      push: async (to, text, meta) => {
        pushes.push({ to, text, retryKey: meta?.retryKey });
      },
      now,
      timeZone: ZONE,
      catchupMinutes: 180,
      listSubscriptions: () => subscriptions,
      claim: (key) => claims.claim(key),
      finish: (key, status) => claims.finish(key, status),
      log,
      ...overrides.tick,
    });
  return { claims, pushes, tick, subscriptions, jobs };
}

test("a due subscription is pushed once and a second tick stays quiet", async () => {
  const { pushes, tick, claims } = harness();
  await tick();
  await tick();
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].to, "U1");
  assert.equal(pushes[0].text, "今天有會");
  assert.equal(claims.rows.get("calendar-digest|U1|2026-10-16").status, "done");
});

test("nothing is due before the configured minute or after the catch-up window", async () => {
  const early = harness();
  await early.tick(new Date("2026-10-16T00:19:00.000Z"));
  assert.equal(early.pushes.length, 0);
  assert.equal(early.claims.rows.size, 0);

  const late = harness();
  await late.tick(new Date("2026-10-16T06:00:00.000Z"));
  assert.equal(late.pushes.length, 0);
  assert.equal(late.claims.rows.size, 0);
});

test("a quiet digest is recorded as sent and does not push", async () => {
  const { pushes, tick, claims } = harness({
    jobs: [{ id: "calendar-digest", async run() { return null; } }],
  });
  await tick();
  await tick();
  assert.equal(pushes.length, 0);
  assert.equal(claims.rows.get("calendar-digest|U1|2026-10-16").status, "done");
});

test("a failed push is retried with the same LINE retry key", async () => {
  let calls = 0;
  const { pushes, tick } = harness({
    tick: {
      push: async (to, text, meta) => {
        calls += 1;
        if (calls === 1) {
          const err = new Error("upstream");
          err.status = 500;
          throw err;
        }
        pushes.push({ to, text, retryKey: meta.retryKey });
      },
    },
  });
  await tick();
  await tick();
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].retryKey, "retry:calendar-digest|U1|2026-10-16");
});

test("a permanent LINE rejection is not retried", async () => {
  let calls = 0;
  const { tick, claims } = harness({
    tick: {
      push: async () => {
        calls += 1;
        const err = new Error("bad recipient");
        err.status = 400;
        throw err;
      },
    },
  });
  await tick();
  await tick();
  assert.equal(calls, 1);
  assert.equal(claims.rows.get("calendar-digest|U1|2026-10-16").status, "done");
});

test("a job that is not ready does not take the day's claim", async () => {
  const { tick, claims, pushes } = harness({
    jobs: [{ id: "calendar-digest", ready: () => false, async run() { return "x"; } }],
  });
  await tick();
  await tick();
  assert.equal(pushes.length, 0);
  assert.equal(claims.rows.size, 0);
});

test("unknown jobs are ignored and an extra job can run beside the digest", async () => {
  const { tick, pushes } = harness({
    subscriptions: [
      { ownerId: "U1", jobId: "calendar-digest", time: "08:20" },
      { ownerId: "U1", jobId: "missing", time: "08:20" },
      { ownerId: "U2", jobId: "ping", time: "08:20" },
    ],
    jobs: [
      { id: "calendar-digest", async run() { return "行程"; } },
      { id: "ping", async run({ ownerId }) { return `ping ${ownerId}`; } },
    ],
  });
  await tick();
  assert.deepEqual(
    pushes.map((push) => push.text),
    ["行程", "ping U2"]
  );
});

test("overlong text is truncated to LINE's limit", async () => {
  const { tick, pushes } = harness({
    jobs: [{ id: "calendar-digest", async run() { return "啊".repeat(6000); } }],
  });
  await tick();
  assert.equal(pushes[0].text.length, 5000);
  assert.ok(pushes[0].text.endsWith("…(內容過長已截斷)"));
});
