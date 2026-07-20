import fs from "fs";
import path from "path";

// Railway 的檔案系統重新部署後會清空,若要永久保存請掛 Volume 並設定 DATA_DIR
const dataDir = process.env.DATA_DIR || "./data";
const dataFile = path.join(dataDir, "shopping-lists.json");

// ownerId(使用者或群組) -> [{ name, store, createdAt }]
let lists = {};

export function loadLists() {
  try {
    lists = JSON.parse(fs.readFileSync(dataFile, "utf8"));
  } catch {
    lists = {};
  }
}

function saveLists() {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(dataFile, JSON.stringify(lists, null, 2));
}

const UNCATEGORIZED = "未分類";

// 依地點分組後攤平成有序陣列(保留原物件參照),
// 清單顯示的編號與「買到 N」的編號都以此為準
function orderedItems(ownerId) {
  const items = lists[ownerId] || [];
  const byStore = new Map();
  for (const item of items) {
    const store = item.store || UNCATEGORIZED;
    if (!byStore.has(store)) byStore.set(store, []);
    byStore.get(store).push(item);
  }
  return [...byStore.values()].flat();
}

function addItem(ownerId, name, store) {
  if (!lists[ownerId]) lists[ownerId] = [];
  lists[ownerId].push({ name, store: store || null, createdAt: Date.now() });
  saveLists();
}

function removeByNumbers(ownerId, numbers) {
  const ordered = orderedItems(ownerId);
  const removed = [];
  const invalid = [];
  for (const n of numbers) {
    if (n >= 1 && n <= ordered.length) removed.push(ordered[n - 1]);
    else invalid.push(n);
  }
  const toRemove = new Set(removed);
  lists[ownerId] = (lists[ownerId] || []).filter((item) => !toRemove.has(item));
  saveLists();
  return { removed, invalid };
}

function formatList(ownerId) {
  const ordered = orderedItems(ownerId);
  if (ordered.length === 0) {
    return "購物清單是空的 🎉\n輸入「買 牛奶 @家樂福」來新增項目";
  }
  const linesByStore = new Map();
  ordered.forEach((item, i) => {
    const store = item.store || UNCATEGORIZED;
    if (!linesByStore.has(store)) linesByStore.set(store, []);
    linesByStore.get(store).push(`${i + 1}. ${item.name}`);
  });
  const sections = [...linesByStore.entries()].map(
    ([store, lines]) => `【${store}】\n${lines.join("\n")}`
  );
  return `🛒 購物清單\n${sections.join("\n")}\n\n買到了就輸入「買到 編號」`;
}

// 目前清單快照,給 LLM 解析器當上下文用
export function getItems(ownerId) {
  return orderedItems(ownerId).map((item) => ({
    name: item.name,
    store: item.store || null,
  }));
}

// 依名稱刪除(LLM 解析出的名稱可能是簡稱,做寬鬆比對)
function removeByNames(ownerId, names) {
  const items = lists[ownerId] || [];
  const toRemove = new Set();
  const removed = [];
  const notFound = [];
  for (const name of names) {
    const match = items.find(
      (item) =>
        !toRemove.has(item) &&
        (item.name === name || item.name.includes(name) || name.includes(item.name))
    );
    if (match) {
      toRemove.add(match);
      removed.push(match);
    } else {
      notFound.push(name);
    }
  }
  lists[ownerId] = items.filter((item) => !toRemove.has(item));
  saveLists();
  return { removed, notFound };
}

// 套用 LLM 解析出的意圖;無法處理時回傳 null,讓呼叫端 fallback
export function applyParsedIntent(ownerId, parsed) {
  if (!parsed || typeof parsed.intent !== "string") return null;

  switch (parsed.intent) {
    case "add": {
      const items = (parsed.items || []).filter(
        (it) => it && typeof it.name === "string" && it.name.trim()
      );
      if (items.length === 0) return null;
      for (const it of items) {
        addItem(ownerId, it.name.trim(), it.store || null);
      }
      const added = items
        .map((it) => `${it.name.trim()}${it.store ? `(${it.store})` : ""}`)
        .join("、");
      return `已加入:${added}\n\n${formatList(ownerId)}`;
    }
    case "list":
      return formatList(ownerId);
    case "remove": {
      const names = (parsed.items || [])
        .map((it) => it && typeof it.name === "string" && it.name.trim())
        .filter(Boolean);
      if (names.length === 0) return null;
      const { removed, notFound } = removeByNames(ownerId, names);
      const parts = [];
      if (removed.length > 0) {
        parts.push(`已刪除:${removed.map((r) => r.name).join("、")}`);
      }
      if (notFound.length > 0) {
        parts.push(`清單裡找不到:${notFound.join("、")}`);
      }
      parts.push("", formatList(ownerId));
      return parts.join("\n");
    }
    case "clear":
      delete lists[ownerId];
      saveLists();
      return "購物清單已清空 🧹";
    default:
      return null;
  }
}

export const SHOPPING_HELP = [
  "🛒 購物清單指令:",
  "- 買 牛奶 @家樂福:新增待買項目(@後面是要去買的地方,可省略)",
  "- 清單:查看購物清單",
  "- 買到 2:刪除第 2 項(可一次多個,如「買到 1 3」)",
  "- 清空清單:刪除全部項目",
].join("\n");

// 回傳回覆文字;不是購物清單指令時回傳 null,讓呼叫端 fallback
export function handleShoppingCommand(ownerId, text) {
  const addMatch = text.match(/^(?:買|加)\s+(.+)$/);
  if (addMatch && addMatch[1].trim()) {
    let rest = addMatch[1].trim();
    let store = null;
    const storeMatch = rest.match(/^(.*?)\s*@(\S+)$/);
    if (storeMatch && storeMatch[1].trim()) {
      rest = storeMatch[1].trim();
      store = storeMatch[2];
    }
    addItem(ownerId, rest, store);
    return `已加入:${rest}${store ? `(${store})` : ""}\n\n${formatList(ownerId)}`;
  }

  if (/^(?:清單|購物清單|list)$/i.test(text)) {
    return formatList(ownerId);
  }

  const doneMatch = text.match(/^(?:買到|買到了|刪|刪除)\s+([\d\s,、]+)$/);
  if (doneMatch) {
    const numbers = doneMatch[1]
      .split(/[\s,、]+/)
      .filter(Boolean)
      .map(Number);
    const { removed, invalid } = removeByNumbers(ownerId, numbers);
    const parts = [];
    if (removed.length > 0) {
      parts.push(`已刪除:${removed.map((r) => r.name).join("、")}`);
    }
    if (invalid.length > 0) {
      parts.push(`找不到編號:${invalid.join("、")}`);
    }
    parts.push("", formatList(ownerId));
    return parts.join("\n");
  }

  if (/^(?:清空清單|清空)$/.test(text)) {
    delete lists[ownerId];
    saveLists();
    return "購物清單已清空 🧹";
  }

  return null;
}
