import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { addDays, getTimeZone, zonedParts } from "./time.js";

// 有設 DATABASE_URL 時用 PostgreSQL(Railway 附加服務),
// 否則 fallback 到本機 JSON 檔(適合本機開發;Railway 上 redeploy 會清空)
const usePg = Boolean(process.env.DATABASE_URL);

let pool = null;

function getDataDir() {
  return process.env.DATA_DIR || "./data";
}

function shoppingFile() {
  return path.join(getDataDir(), "shopping-lists.json");
}

function remindersFile() {
  return path.join(getDataDir(), "reminders.json");
}

function jobRunsFile() {
  return path.join(getDataDir(), "job-runs.json");
}

function loadListsFromFile() {
  try {
    return JSON.parse(fs.readFileSync(shoppingFile(), "utf8"));
  } catch {
    return {};
  }
}

async function ensureReminderTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reminder_subscriptions (
      owner_id   TEXT NOT NULL,
      job_id     TEXT NOT NULL,
      time_hhmm  TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (owner_id, job_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS job_runs (
      run_key    TEXT PRIMARY KEY,
      status     TEXT NOT NULL,
      retry_key  TEXT,
      claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query("DELETE FROM job_runs WHERE updated_at < now() - interval '14 days'");
}

// 全量載入所有清單;pg 模式下順便建表,並在 DB 是空的時
// 一次性匯入舊的 shopping-lists.json
export async function initStorage() {
  if (!usePg) {
    return loadListsFromFile();
  }

  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS shopping_lists (
      owner_id   TEXT PRIMARY KEY,
      items      JSONB NOT NULL DEFAULT '[]'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await ensureReminderTables();

  const { rows: countRows } = await pool.query(
    "SELECT COUNT(*)::int AS count FROM shopping_lists"
  );
  if (countRows[0].count === 0 && fs.existsSync(shoppingFile())) {
    const old = loadListsFromFile();
    const owners = Object.keys(old);
    for (const ownerId of owners) {
      await pool.query(
        "INSERT INTO shopping_lists (owner_id, items) VALUES ($1, $2::jsonb)",
        [ownerId, JSON.stringify(old[ownerId])]
      );
    }
    if (owners.length > 0) {
      console.log(`Migrated ${owners.length} lists from ${shoppingFile()}`);
    }
  }

  const { rows } = await pool.query("SELECT owner_id, items FROM shopping_lists");
  const lists = {};
  for (const row of rows) {
    lists[row.owner_id] = row.items;
  }
  return lists;
}

// 同一 owner 的寫入用 promise chain 序列化,避免先後順序顛倒
const writeChains = new Map();

function enqueueWrite(ownerId, task) {
  const prev = writeChains.get(ownerId) || Promise.resolve();
  const next = prev
    .then(task)
    .catch((err) => console.error("DB persist error:", err));
  writeChains.set(ownerId, next);
}

// fire-and-forget:在呼叫當下同步 snapshot 該 owner 的清單,
// 寫入失敗只記 log,不影響機器人回覆
export function persist(ownerId, lists) {
  if (!usePg) {
    fs.mkdirSync(getDataDir(), { recursive: true });
    fs.writeFileSync(shoppingFile(), JSON.stringify(lists, null, 2));
    return;
  }

  const snapshot = lists[ownerId] ? JSON.stringify(lists[ownerId]) : null;
  enqueueWrite(ownerId, () =>
    snapshot === null
      ? pool.query("DELETE FROM shopping_lists WHERE owner_id = $1", [ownerId])
      : pool.query(
          `INSERT INTO shopping_lists (owner_id, items, updated_at)
           VALUES ($1, $2::jsonb, now())
           ON CONFLICT (owner_id)
           DO UPDATE SET items = EXCLUDED.items, updated_at = now()`,
          [ownerId, snapshot]
        )
  );
}

function canonicalTime(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value || "");
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function normalizeSubscriptions(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const subscriptions = {};
  for (const [ownerId, jobs] of Object.entries(raw)) {
    if (!jobs || typeof jobs !== "object" || Array.isArray(jobs)) continue;
    const clean = {};
    for (const [jobId, sub] of Object.entries(jobs)) {
      const time = canonicalTime(sub?.time);
      if (!time) continue;
      clean[jobId] = { time };
    }
    if (Object.keys(clean).length > 0) subscriptions[ownerId] = clean;
  }
  return subscriptions;
}

export async function loadReminderSubscriptions() {
  if (!usePg) {
    try {
      return normalizeSubscriptions(JSON.parse(fs.readFileSync(remindersFile(), "utf8")));
    } catch {
      return {};
    }
  }
  if (!pool) throw new Error("storage is not initialized");

  const { rows } = await pool.query(
    "SELECT owner_id, job_id, time_hhmm FROM reminder_subscriptions"
  );
  const subscriptions = {};
  for (const row of rows) {
    if (!subscriptions[row.owner_id]) subscriptions[row.owner_id] = {};
    subscriptions[row.owner_id][row.job_id] = { time: row.time_hhmm };
  }
  return subscriptions;
}

const reminderWriteChains = new Map();

function enqueueReminder(ownerId, task) {
  const prev = reminderWriteChains.get(ownerId) || Promise.resolve();
  const next = prev
    .then(task)
    .catch((err) => console.error("Reminder persist error:", err));
  reminderWriteChains.set(ownerId, next);
}

// subscriptions 是全部聊天室的記憶體快照。JSON 模式整份覆寫;
// Postgres 只重寫這個 owner,避免並行更新互相蓋掉。
export function persistReminderOwner(ownerId, subscriptions) {
  if (!usePg) {
    fs.mkdirSync(getDataDir(), { recursive: true });
    fs.writeFileSync(remindersFile(), JSON.stringify(subscriptions, null, 2));
    return;
  }

  const snapshot = JSON.parse(JSON.stringify(subscriptions[ownerId] || {}));
  enqueueReminder(ownerId, async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM reminder_subscriptions WHERE owner_id = $1", [ownerId]);
      for (const [jobId, sub] of Object.entries(snapshot)) {
        await client.query(
          `INSERT INTO reminder_subscriptions (owner_id, job_id, time_hhmm, updated_at)
           VALUES ($1, $2, $3, now())`,
          [ownerId, jobId, sub.time]
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  });
}

const JOB_RUN_LEASE_MS = 2 * 60 * 1000;
let jobRunChain = Promise.resolve();

function enqueueJobRun(task) {
  const run = jobRunChain.then(task, task);
  jobRunChain = run.then(
    () => {},
    () => {}
  );
  return run;
}

function readJobRuns() {
  try {
    const parsed = JSON.parse(fs.readFileSync(jobRunsFile(), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeJobRuns(data) {
  fs.mkdirSync(getDataDir(), { recursive: true });
  fs.writeFileSync(jobRunsFile(), JSON.stringify(data, null, 2));
}

function pruneJobRuns(data) {
  const today = zonedParts(new Date(), getTimeZone()).dateKey;
  const cutoff = addDays(today, -14);
  for (const key of Object.keys(data)) {
    const date = key.split("|").pop();
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && date < cutoff) delete data[key];
  }
}

// 搶下某個 job 在某個聊天室、某一天的執行權。
// 回傳 { ok:false } 表示今天已經送過,或別的程序還在送。
// ok 時帶的 retryKey 要原樣傳給 LINE,這樣送出後崩潰重試也不會重複投遞。
export function claimJobRun(runKey, leaseMs = JOB_RUN_LEASE_MS) {
  if (!usePg) return claimJobRunJson(runKey, leaseMs);
  return claimJobRunPg(runKey, leaseMs);
}

function claimJobRunJson(runKey, leaseMs) {
  return enqueueJobRun(async () => {
    const now = Date.now();
    const data = readJobRuns();
    pruneJobRuns(data);
    const row = data[runKey];
    if (row?.status === "done") return { ok: false };
    if (row?.status === "running" && row.expiresAt > now) return { ok: false };

    const retryKey = row?.retryKey || crypto.randomUUID();
    data[runKey] = {
      status: "running",
      retryKey,
      claimedAt: new Date(now).toISOString(),
      expiresAt: now + leaseMs,
    };
    writeJobRuns(data);
    return { ok: true, retryKey };
  });
}

async function claimJobRunPg(runKey, leaseMs) {
  const retryKey = crypto.randomUUID();
  const { rows } = await pool.query(
    `INSERT INTO job_runs (run_key, status, retry_key, claimed_at, expires_at, updated_at)
     VALUES ($1, 'running', $2, now(), now() + ($3::int * interval '1 millisecond'), now())
     ON CONFLICT (run_key) DO UPDATE
       SET status = 'running',
           claimed_at = now(),
           expires_at = now() + ($3::int * interval '1 millisecond'),
           updated_at = now()
       WHERE job_runs.status = 'failed'
          OR (
            job_runs.status = 'running'
            AND job_runs.expires_at IS NOT NULL
            AND job_runs.expires_at < now()
          )
     RETURNING retry_key`,
    [runKey, retryKey, leaseMs]
  );
  if (rows.length === 0) return { ok: false };
  return { ok: true, retryKey: rows[0].retry_key };
}

export function finishJobRun(runKey, status) {
  if (status !== "done" && status !== "failed") {
    throw new Error(`invalid job run status: ${status}`);
  }
  if (!usePg) {
    return enqueueJobRun(async () => {
      const data = readJobRuns();
      if (!data[runKey]) return;
      data[runKey].status = status;
      data[runKey].updatedAt = new Date().toISOString();
      if (status === "done") data[runKey].expiresAt = null;
      writeJobRuns(data);
    });
  }
  return pool.query(
    `UPDATE job_runs
     SET status = $2,
         updated_at = now(),
         expires_at = CASE WHEN $2 = 'done' THEN NULL ELSE expires_at END
     WHERE run_key = $1`,
    [runKey, status]
  );
}

// 等待所有排隊中的寫入完成(驗證腳本用)
export async function flushWrites() {
  await Promise.all([...writeChains.values(), ...reminderWriteChains.values(), jobRunChain]);
}

export async function closeStorage() {
  if (pool) await pool.end();
}
