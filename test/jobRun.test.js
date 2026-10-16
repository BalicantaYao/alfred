import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alfred-job-runs-"));
let claimJobRun;
let finishJobRun;

test.before(async () => {
  delete process.env.DATABASE_URL;
  process.env.DATA_DIR = dir;
  process.env.REMINDER_TIMEZONE = "Asia/Taipei";
  ({ claimJobRun, finishJobRun } = await import("../storage.js"));
});

test.after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test("only one claim wins, done sticks, and a failure keeps the retry key", async () => {
  const key = "calendar-digest|U1|2026-10-16";
  const [first, second, third] = await Promise.all([
    claimJobRun(key),
    claimJobRun(key),
    claimJobRun(key),
  ]);
  const won = [first, second, third].filter((result) => result.ok);
  assert.equal(won.length, 1);
  assert.match(won[0].retryKey, /^[0-9a-f-]{36}$/i);

  assert.equal((await claimJobRun(key)).ok, false);
  await finishJobRun(key, "failed");

  const retry = await claimJobRun(key);
  assert.equal(retry.ok, true);
  assert.equal(retry.retryKey, won[0].retryKey);
  await finishJobRun(key, "done");
  assert.equal((await claimJobRun(key)).ok, false);
});

test("an expired running claim can be taken over with the same retry key", async () => {
  const key = "ping|U2|2026-10-16";
  const first = await claimJobRun(key, 1);
  assert.equal(first.ok, true);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const again = await claimJobRun(key, 60_000);
  assert.equal(again.ok, true);
  assert.equal(again.retryKey, first.retryKey);
});
