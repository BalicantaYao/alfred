import { addDays, pad2, zonedMidnightUtc, zonedParts } from "./time.js";

// 前一場結束後,間隔在這個分鐘數以內就標成緊接(0 分鐘)或間隔過短
export const BACK_TO_BACK_MINUTES = 10;

const MEETING_URL =
  /https?:\/\/(?:[\w.-]*zoom\.us|meet\.google\.com|teams\.microsoft\.com|[\w.-]*webex\.com|[\w.-]*whereby\.com)\/[^\s<>]+/i;

export function digestWindow(now, timeZone) {
  const today = zonedParts(now, timeZone).dateKey;
  const tomorrow = addDays(today, 1);
  const dayAfter = addDays(today, 2);
  return {
    today,
    tomorrow,
    timeMin: zonedMidnightUtc(today, timeZone).toISOString(),
    timeMax: zonedMidnightUtc(dayAfter, timeZone).toISOString(),
  };
}

function cleanTitle(summary) {
  const title = String(summary || "")
    .replace(/\s+/g, " ")
    .trim();
  return title || "(未命名行程)";
}

function isDeclined(event) {
  return (event.attendees || []).some(
    (attendee) => attendee && attendee.self && attendee.responseStatus === "declined"
  );
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(value);
}

function extractPlaceAndLink(event) {
  let link = typeof event.hangoutLink === "string" && event.hangoutLink ? event.hangoutLink : null;
  if (!link) {
    const video = (event.conferenceData?.entryPoints || []).find(
      (entry) => entry && entry.entryPointType === "video" && entry.uri
    );
    if (video) link = video.uri;
  }

  let location = typeof event.location === "string" ? event.location.trim() : "";
  if (location && isHttpUrl(location)) {
    if (!link) link = location;
    location = "";
  }

  if (!link && typeof event.description === "string") {
    const match = event.description.match(MEETING_URL);
    if (match) link = match[0].replace(/[),.;]+$/, "");
  }

  return { location: location || null, link };
}

// 把 Calendar API 的 event 收成摘要用的形狀。已取消、自己已拒絕、
// 以及標題以前綴(預設「出遊：」)開頭的活動都略過。
export function normalizeGoogleEvents(items, { skipPrefix = "出遊：", timeZone } = {}) {
  const seen = new Set();
  const events = [];
  for (const event of items || []) {
    if (!event || event.status === "cancelled") continue;
    if (isDeclined(event)) continue;

    const title = cleanTitle(event.summary);
    if (skipPrefix && title.startsWith(skipPrefix)) continue;

    const allDay = Boolean(event.start?.date && !event.start?.dateTime);
    let start;
    let end;
    if (allDay) {
      if (!event.end?.date) continue;
      start = zonedMidnightUtc(event.start.date, timeZone);
      end = zonedMidnightUtc(event.end.date, timeZone);
    } else {
      if (!event.start?.dateTime || !event.end?.dateTime) continue;
      start = new Date(event.start.dateTime);
      end = new Date(event.end.dateTime);
    }
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) continue;

    const key = `${title}|${start.toISOString()}|${end.toISOString()}|${allDay}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const { location, link } = extractPlaceAndLink(event);
    events.push({ title, start, end, allDay, location, link });
  }
  return events;
}

function overlapsDay(event, dateKey, timeZone) {
  const start = zonedMidnightUtc(dateKey, timeZone);
  const end = zonedMidnightUtc(addDays(dateKey, 1), timeZone);
  return event.start < end && event.end > start;
}

function formatHeading(dateKey, today, timeZone) {
  const parts = zonedParts(zonedMidnightUtc(dateKey, timeZone), timeZone);
  const label = dateKey === today ? "今天" : "明天";
  return `【${label} ${pad2(parts.month)}/${pad2(parts.day)}（${parts.weekday}）】`;
}

function formatClock(date, timeZone) {
  const parts = zonedParts(date, timeZone);
  return `${pad2(parts.hour)}:${pad2(parts.minute)}`;
}

function formatRange(event, sectionDateKey, timeZone) {
  const startKey = zonedParts(event.start, timeZone).dateKey;
  const endKey = zonedParts(new Date(event.end.getTime() - 1), timeZone).dateKey;
  const startText = formatClock(event.start, timeZone);
  const endText = formatClock(event.end, timeZone);
  if (startKey === sectionDateKey && endKey === sectionDateKey) {
    return `${startText}–${endText}`;
  }
  const startParts = zonedParts(event.start, timeZone);
  const endParts = zonedParts(event.end, timeZone);
  return `${pad2(startParts.month)}/${pad2(startParts.day)} ${startText}–${pad2(endParts.month)}/${pad2(endParts.day)} ${endText}`;
}

function annotateTimed(events, backToBackMinutes) {
  return events.map((event, index) => {
    const overlaps = [];
    for (let earlier = 0; earlier < index; earlier++) {
      const previous = events[earlier];
      if (event.start < previous.end && previous.start < event.end) {
        overlaps.push(previous.title);
      }
    }
    if (overlaps.length > 0) {
      const names = overlaps.map((title) => `「${title}」`).join("、");
      return [`⚠️ 與${names}時間重疊`];
    }

    let nearest = null;
    for (let earlier = 0; earlier < index; earlier++) {
      const previous = events[earlier];
      const gapMin = (event.start.getTime() - previous.end.getTime()) / 60000;
      if (gapMin < 0) continue;
      if (!nearest || gapMin < nearest.gapMin) {
        nearest = { title: previous.title, gapMin };
      }
    }
    if (!nearest || nearest.gapMin > backToBackMinutes) return [];
    if (nearest.gapMin < 1) return [`⚡ 緊接「${nearest.title}」`];
    return [`⚡ 距「${nearest.title}」結束僅 ${Math.round(nearest.gapMin)} 分鐘`];
  });
}

function formatDay(dateKey, events, { today, timeZone, backToBackMinutes }) {
  const heading = formatHeading(dateKey, today, timeZone);
  const dayEvents = events.filter((event) => overlapsDay(event, dateKey, timeZone));
  if (dayEvents.length === 0) return `${heading}\n（沒有行程）`;

  const allDay = dayEvents
    .filter((event) => event.allDay)
    .sort((a, b) => a.title.localeCompare(b.title, "zh-Hant"));
  const timed = dayEvents
    .filter((event) => !event.allDay)
    .sort((a, b) => a.start - b.start || a.end - b.end || a.title.localeCompare(b.title, "zh-Hant"));
  const notes = annotateTimed(timed, backToBackMinutes);

  const lines = allDay.map((event) => `全天 ${event.title}`);
  timed.forEach((event, index) => {
    lines.push(`${formatRange(event, dateKey, timeZone)} ${event.title}`);
    if (event.location) lines.push(`  📍 ${event.location}`);
    if (event.link) lines.push(`  🔗 ${event.link}`);
    for (const note of notes[index]) lines.push(`  ${note}`);
  });
  return `${heading}\n${lines.join("\n")}`;
}

// 今天與明天都沒有可報告的行程時回傳 null,呼叫端就不推播。
export function formatCalendarDigest(events, { now, timeZone, backToBackMinutes = BACK_TO_BACK_MINUTES }) {
  const today = zonedParts(now, timeZone).dateKey;
  const tomorrow = addDays(today, 1);
  const visible = events.filter(
    (event) => overlapsDay(event, today, timeZone) || overlapsDay(event, tomorrow, timeZone)
  );
  if (visible.length === 0) return null;

  const sections = [today, tomorrow].map((dateKey) =>
    formatDay(dateKey, visible, { today, timeZone, backToBackMinutes })
  );
  return ["📅 今天與明天的行程", "", sections.join("\n\n")].join("\n");
}
