// 驗證轉發對象儲存(JSON 模式):寫入、重載、清除。不連資料庫。
//   node scripts/verify-db.js
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alfred-db-"));
process.env.DATA_DIR = tmp;
delete process.env.DATABASE_URL;

const storage = await import("../storage.js");

const USER = "U" + "ab".repeat(16);
const OTHER = "U" + "12".repeat(16);
const notifyFile = path.join(tmp, "notify-target.json");

try {
  assert.equal(await storage.initNotifyStorage(), null);
  assert.equal(storage.getNotifyTarget(), null);
  assert.equal(fs.existsSync(notifyFile), false);

  storage.setNotifyTarget(USER);
  await storage.flushWrites();
  assert.equal(storage.getNotifyTarget(), USER);
  assert.equal(JSON.parse(fs.readFileSync(notifyFile, "utf8")).targetId, USER);
  assert.deepEqual(fs.readdirSync(tmp).sort(), ["notify-target.json"]);

  fs.writeFileSync(notifyFile, JSON.stringify({ targetId: OTHER }));
  assert.equal(await storage.initNotifyStorage(), OTHER);
  assert.equal(storage.getNotifyTarget(), OTHER);

  fs.writeFileSync(notifyFile, JSON.stringify({ targetId: "" }));
  assert.equal(await storage.initNotifyStorage(), null);

  fs.writeFileSync(notifyFile, "{");
  assert.equal(await storage.initNotifyStorage(), null);

  storage.setNotifyTarget(USER);
  storage.clearNotifyTarget();
  await storage.flushWrites();
  assert.equal(storage.getNotifyTarget(), null);
  assert.equal(JSON.parse(fs.readFileSync(notifyFile, "utf8")).targetId, null);

  assert.throws(() => storage.setNotifyTarget(""), /invalid notify target/);
  assert.throws(() => storage.setNotifyTarget(123), /invalid notify target/);
  assert.equal(storage.getNotifyTarget(), null);

  await storage.closeStorage();
  console.log("OK");
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
