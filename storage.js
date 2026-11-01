import fs from "fs";
import path from "path";
import pg from "pg";

// 有設 DATABASE_URL 時用 PostgreSQL(Railway 附加服務),
// 否則 fallback 到本機 JSON 檔(適合本機開發;Railway 上 redeploy 會清空)
const usePg = Boolean(process.env.DATABASE_URL);

const dataDir = process.env.DATA_DIR || "./data";

let pool = null;

// 轉發對象:有 DATABASE_URL 時是 notify_targets 的單一列,否則是 data/notify-target.json。
const notifyFile = path.join(dataDir, "notify-target.json");
const NOTIFY_ROW_ID = "default";

let notifyTargetId = null;
let notifyWrite = Promise.resolve();

function readNotifyFile() {
  try {
    const data = JSON.parse(fs.readFileSync(notifyFile, "utf8"));
    return typeof data?.targetId === "string" && data.targetId ? data.targetId : null;
  } catch {
    return null;
  }
}

function enqueueNotifyWrite(task) {
  notifyWrite = notifyWrite
    .then(task)
    .catch((err) => console.error("DB persist error:", err));
}

function persistNotify() {
  const snapshot = notifyTargetId;
  if (!usePg) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(notifyFile, JSON.stringify({ targetId: snapshot }, null, 2));
    return;
  }

  enqueueNotifyWrite(() =>
    snapshot == null
      ? pool.query("DELETE FROM notify_targets WHERE id = $1", [NOTIFY_ROW_ID])
      : pool.query(
          `INSERT INTO notify_targets (id, target_id, updated_at)
           VALUES ($1, $2, now())
           ON CONFLICT (id)
           DO UPDATE SET target_id = EXCLUDED.target_id, updated_at = now()`,
          [NOTIFY_ROW_ID, snapshot]
        )
  );
}

// 檔案模式直接讀 JSON;Postgres 模式建表後載入那一列。
export async function initNotifyStorage() {
  if (!usePg) {
    notifyTargetId = readNotifyFile();
    return notifyTargetId;
  }

  if (!pool) {
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS notify_targets (
      id         TEXT PRIMARY KEY,
      target_id  TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const { rows } = await pool.query(
    "SELECT target_id FROM notify_targets WHERE id = $1",
    [NOTIFY_ROW_ID]
  );
  const value = rows[0]?.target_id;
  notifyTargetId = typeof value === "string" && value ? value : null;
  return notifyTargetId;
}

export function getNotifyTarget() {
  return notifyTargetId;
}

export function setNotifyTarget(targetId) {
  if (typeof targetId !== "string" || targetId.length === 0) {
    throw new Error("invalid notify target");
  }
  notifyTargetId = targetId;
  persistNotify();
}

export function clearNotifyTarget() {
  notifyTargetId = null;
  persistNotify();
}

// 等待所有排隊中的寫入完成(驗證腳本用)
export async function flushWrites() {
  await notifyWrite;
}

export async function closeStorage() {
  if (!pool) return;
  const current = pool;
  pool = null;
  await current.end();
}
