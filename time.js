// 提醒一律用使用者的時區計算「今天」與是否到點。預設台北,沒有日光節約時間。

export function getTimeZone() {
  return process.env.REMINDER_TIMEZONE || "Asia/Taipei";
}

export function timeZoneLabel(timeZone = getTimeZone()) {
  return timeZone === "Asia/Taipei" ? "台北時間" : timeZone;
}

const WEEKDAY_ZH = {
  Sun: "日",
  Mon: "一",
  Tue: "二",
  Wed: "三",
  Thu: "四",
  Fri: "五",
  Sat: "六",
};

export function zonedParts(date, timeZone = getTimeZone()) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  });
  const parts = {};
  for (const part of fmt.formatToParts(date)) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }
  // 少數 ICU 版本在午夜會回 hour=24,當成 00 處理
  let hour = Number(parts.hour);
  if (hour === 24) hour = 0;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAY_ZH[parts.weekday] || parts.weekday,
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

// 把 YYYY-MM-DD 的當地午夜換算成 UTC。用本地時間與目標午夜的差值修正,
// 台北這種固定偏移一次就會對上。
export function zonedMidnightUtc(dateKey, timeZone = getTimeZone()) {
  const [year, month, day] = dateKey.split("-").map(Number);
  let utc = Date.UTC(year, month - 1, day, 0, 0, 0);
  for (let i = 0; i < 4; i++) {
    const parts = zonedParts(new Date(utc), timeZone);
    const got = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    const want = Date.UTC(year, month - 1, day, 0, 0, 0);
    const diff = want - got;
    if (diff === 0) return new Date(utc);
    utc += diff;
  }
  return new Date(utc);
}

export function addDays(dateKey, days) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  const yyyy = shifted.getUTCFullYear();
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(shifted.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export function pad2(value) {
  return String(value).padStart(2, "0");
}
