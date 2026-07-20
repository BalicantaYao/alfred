import Anthropic from "@anthropic-ai/sdk";

const MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-4-8";

let client = null;
function getClient() {
  if (!client) client = new Anthropic();
  return client;
}

export function llmEnabled() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

// structured outputs 的 json_schema:保證模型輸出可直接 JSON.parse
const INTENT_SCHEMA = {
  type: "object",
  properties: {
    intent: {
      type: "string",
      enum: ["add", "list", "remove", "clear", "none"],
    },
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          store: { anyOf: [{ type: "string" }, { type: "null" }] },
        },
        required: ["name", "store"],
        additionalProperties: false,
      },
    },
  },
  required: ["intent", "items"],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `你是 LINE 購物清單機器人的意圖解析器。使用者會用自由的中文(可能混雜英文)描述需求,你要解析成結構化 JSON。

intent 的定義:
- add:使用者想新增待買項目。items 填入每一個要買的項目;store 是要去買的地方(例如蝦皮、家樂福、全聯、好市多、momo),使用者沒提到地點就填 null。一句話裡提到多個項目要拆成多筆。
- remove:使用者表示某些東西買到了、不用買了、或想刪除。items 填入要刪除的項目,name 盡量使用「目前清單」中出現的名稱(使用者的說法可能是簡稱或同義詞);store 一律填 null。
- list:使用者想查看購物清單(例如「我要買什麼」「清單裡有啥」)。items 填空陣列。
- clear:使用者明確想清空整份清單。items 填空陣列。
- none:與購物清單無關的訊息(閒聊、問天氣等)。items 填空陣列。

注意:
- 只解析,不要自行發揮或添加使用者沒提到的項目。
- 語意不確定時寧可回 none,不要猜測成 add 或 remove。`;

/**
 * 把自由格式的訊息解析成購物清單意圖。
 * currentItems: [{name, store}] 目前清單快照,用來幫助 remove 對應名稱。
 * 回傳 {intent, items} 或 null(解析失敗/被拒絕時,由呼叫端 fallback)。
 */
export async function parseShoppingIntent(text, currentItems) {
  const listText =
    currentItems.length > 0
      ? currentItems
          .map((it, i) => `${i + 1}. ${it.name}${it.store ? `(${it.store})` : ""}`)
          .join("\n")
      : "(清單目前是空的)";

  const response = await getClient().messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    output_config: {
      effort: "low",
      format: { type: "json_schema", schema: INTENT_SCHEMA },
    },
    messages: [
      {
        role: "user",
        content: `目前清單:\n${listText}\n\n使用者訊息:「${text}」`,
      },
    ],
  });

  if (response.stop_reason === "refusal") {
    return null;
  }
  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock) {
    return null;
  }
  try {
    return JSON.parse(textBlock.text);
  } catch {
    return null;
  }
}
