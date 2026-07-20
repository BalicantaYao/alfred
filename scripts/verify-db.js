// 手動驗證腳本:走一遍新增/查看/刪除/清空,確認儲存層正常
//   node scripts/verify-db.js                     — 完整流程(結束時清單為空)
//   node scripts/verify-db.js --check-persisted X — 只載入後印出 owner X 的清單,
//                                                   用來驗證跨 process 的持久化
import assert from "node:assert";
import { getItems, handleShoppingCommand, loadLists } from "../shoppingList.js";
import { closeStorage, flushWrites } from "../storage.js";

await loadLists();

const checkIdx = process.argv.indexOf("--check-persisted");
if (checkIdx !== -1) {
  const owner = process.argv[checkIdx + 1];
  if (!owner) {
    console.error("Usage: node scripts/verify-db.js --check-persisted <ownerId>");
    process.exit(1);
  }
  console.log(JSON.stringify(getItems(owner), null, 2));
  await closeStorage();
  process.exit(0);
}

const owner = process.env.VERIFY_OWNER || `verify-${Date.now()}`;

handleShoppingCommand(owner, "買 牛奶 @家樂福");
handleShoppingCommand(owner, "買 電池");
assert.equal(getItems(owner).length, 2);

console.log(handleShoppingCommand(owner, "清單"));

handleShoppingCommand(owner, "買到 1");
assert.equal(getItems(owner).length, 1);

handleShoppingCommand(owner, "清空清單");
assert.equal(getItems(owner).length, 0);

await flushWrites();
await closeStorage();
console.log("OK");
