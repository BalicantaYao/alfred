import fs from "fs";
import path from "path";
import pg from "pg";

// 有設 DATABASE_URL 時用 PostgreSQL(Railway 附加服務),
// 否則 fallback 到本機 JSON 檔(適合本機開發;Railway 上 redeploy 會清空)
const usePg = Boolean(process.env.DATABASE_URL);

const dataDir = process.env.DATA_DIR || "./data";
const dataFile = path.join(dataDir, "shopping-lists.json");

let pool = null;

function loadListsFromFile() {
  try {
    return JSON.parse(fs.readFileSync(dataFile, "utf8"));
  } catch {
    return {};
  }
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

  const { rows: countRows } = await pool.query(
    "SELECT COUNT(*)::int AS count FROM shopping_lists"
  );
  if (countRows[0].count === 0 && fs.existsSync(dataFile)) {
    const old = loadListsFromFile();
    const owners = Object.keys(old);
    for (const ownerId of owners) {
      await pool.query(
        "INSERT INTO shopping_lists (owner_id, items) VALUES ($1, $2::jsonb)",
        [ownerId, JSON.stringify(old[ownerId])]
      );
    }
    if (owners.length > 0) {
      console.log(`Migrated ${owners.length} lists from ${dataFile}`);
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
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(dataFile, JSON.stringify(lists, null, 2));
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

// 等待所有排隊中的寫入完成(驗證腳本用)
export async function flushWrites() {
  await Promise.all([...writeChains.values()]);
}

export async function closeStorage() {
  if (pool) await pool.end();
}
