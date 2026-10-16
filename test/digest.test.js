import assert from "node:assert/strict";
import test from "node:test";
import { createCalendarDigestJob } from "../jobs/calendarDigest.js";
import {
  digestWindow,
  formatCalendarDigest,
  normalizeGoogleEvents,
} from "../digest.js";
import { zonedMidnightUtc, zonedParts } from "../time.js";

const ZONE = "Asia/Taipei";
const NOW = new Date("2026-10-16T01:00:00.000Z"); // 10/16 09:00 台北

function timed(summary, start, end, extra = {}) {
  return {
    summary,
    status: "confirmed",
    start: { dateTime: start },
    end: { dateTime: end },
    ...extra,
  };
}

function render(items, options = {}) {
  const events = normalizeGoogleEvents(items, { timeZone: ZONE, ...options });
  return formatCalendarDigest(events, { now: NOW, timeZone: ZONE });
}

test("Taipei midnight and weekday", () => {
  const midnight = new Date("2026-10-15T16:00:00.000Z");
  const parts = zonedParts(midnight, ZONE);
  assert.equal(parts.hour, 0);
  assert.equal(parts.minute, 0);
  assert.equal(parts.dateKey, "2026-10-16");
  assert.equal(parts.weekday, "五");
  assert.equal(zonedMidnightUtc("2026-10-16", ZONE).toISOString(), "2026-10-15T16:00:00.000Z");
});

test("digest window covers today and tomorrow in Taipei", () => {
  const window = digestWindow(NOW, ZONE);
  assert.equal(window.today, "2026-10-16");
  assert.equal(window.tomorrow, "2026-10-17");
  assert.equal(window.timeMin, "2026-10-15T16:00:00.000Z");
  assert.equal(window.timeMax, "2026-10-17T16:00:00.000Z");
});

test("formats time, place, meeting link, conflict, and back-to-back", () => {
  const text = render([
    {
      summary: "家族聚餐",
      status: "confirmed",
      start: { date: "2026-10-16" },
      end: { date: "2026-10-17" },
    },
    timed("週會", "2026-10-16T09:00:00+08:00", "2026-10-16T10:00:00+08:00", {
      location: "3F 會議室",
    }),
    timed("客戶會議", "2026-10-16T10:00:00+08:00", "2026-10-16T10:45:00+08:00", {
      hangoutLink: "https://meet.google.com/abc-defg-hij",
    }),
    timed("設計討論", "2026-10-16T10:30:00+08:00", "2026-10-16T11:00:00+08:00", {
      location: "https://zoom.us/j/123456789",
    }),
    timed("出遊：墾丁", "2026-10-16T13:00:00+08:00", "2026-10-16T18:00:00+08:00"),
    timed("已拒絕的會", "2026-10-16T15:00:00+08:00", "2026-10-16T16:00:00+08:00", {
      attendees: [{ self: true, responseStatus: "declined" }],
    }),
    timed("別人拒絕但我要去", "2026-10-16T16:00:00+08:00", "2026-10-16T16:30:00+08:00", {
      attendees: [
        { self: true, responseStatus: "accepted" },
        { self: false, responseStatus: "declined" },
      ],
      description: "連結 https://zoom.us/j/999",
    }),
    {
      summary: "已取消",
      status: "cancelled",
      start: { dateTime: "2026-10-16T17:00:00+08:00" },
      end: { dateTime: "2026-10-16T18:00:00+08:00" },
    },
    timed("牙醫", "2026-10-17T15:00:00+08:00", "2026-10-17T16:00:00+08:00", {
      location: "大安診所",
    }),
    timed("週會", "2026-10-16T09:00:00+08:00", "2026-10-16T10:00:00+08:00", {
      location: "3F 會議室",
    }),
    timed("跨日", "2026-10-16T23:00:00+08:00", "2026-10-17T01:00:00+08:00"),
    timed("午夜後", "2026-10-16T16:30:00Z", "2026-10-16T17:00:00Z"),
  ]);

  assert.match(text, /【今天 10\/16（五）】/);
  assert.match(text, /【明天 10\/17（六）】/);
  assert.match(text, /全天 家族聚餐/);
  assert.match(text, /09:00–10:00 週會\n {2}📍 3F 會議室/);
  assert.equal(text.split("09:00–10:00 週會").length - 1, 1);
  assert.match(text, /10:00–10:45 客戶會議\n {2}🔗 https:\/\/meet\.google\.com\/abc-defg-hij\n {2}⚡ 緊接「週會」/);
  assert.match(text, /10:30–11:00 設計討論\n {2}🔗 https:\/\/zoom\.us\/j\/123456789\n {2}⚠️ 與「客戶會議」時間重疊/);
  assert.match(text, /16:00–16:30 別人拒絕但我要去/);
  assert.match(text, /https:\/\/zoom\.us\/j\/999/);
  assert.match(text, /15:00–16:00 牙醫\n {2}📍 大安診所/);
  assert.doesNotMatch(text, /出遊：墾丁/);
  assert.doesNotMatch(text, /已拒絕的會/);
  assert.doesNotMatch(text, /已取消/);
});

test("a conference link is kept alongside a physical location", () => {
  const text = render([
    timed("遠端", "2026-10-16T09:00:00+08:00", "2026-10-16T09:30:00+08:00", {
      location: "家裡",
      conferenceData: {
        entryPoints: [{ entryPointType: "video", uri: "https://meet.google.com/from-conf" }],
      },
    }),
  ]);
  assert.match(text, /09:00–09:30 遠端\n {2}📍 家裡\n {2}🔗 https:\/\/meet\.google\.com\/from-conf/);
});

test("flags a 10 minute gap and ignores an 11 minute gap", () => {
  const text = render([
    timed("第一場", "2026-10-16T09:00:00+08:00", "2026-10-16T10:00:00+08:00"),
    timed("十分鐘", "2026-10-16T10:10:00+08:00", "2026-10-16T10:30:00+08:00"),
    timed("十一分鐘", "2026-10-16T10:41:00+08:00", "2026-10-16T11:00:00+08:00"),
  ]);
  assert.match(text, /10:10–10:30 十分鐘\n {2}⚡ 距「第一場」結束僅 10 分鐘/);
  assert.match(text, /10:41–11:00 十一分鐘/);
  assert.doesNotMatch(text, /十一分鐘\n {2}⚡/);
});

test("back-to-back with no gap is called out, overlap is not also back-to-back", () => {
  const text = render([
    timed("週會", "2026-10-16T09:00:00+08:00", "2026-10-16T10:00:00+08:00"),
    timed("下一場", "2026-10-16T10:00:00+08:00", "2026-10-16T11:00:00+08:00"),
    timed("重疊場", "2026-10-16T10:30:00+08:00", "2026-10-16T11:30:00+08:00"),
  ]);
  assert.match(text, /10:00–11:00 下一場\n {2}⚡ 緊接「週會」/);
  assert.match(text, /10:30–11:30 重疊場\n {2}⚠️ 與「下一場」時間重疊/);
  assert.doesNotMatch(text, /重疊場[\s\S]{0,40}⚡/);
});

test("an event that overlaps two earlier ones names both", () => {
  const text = render([
    timed("甲", "2026-10-16T09:00:00+08:00", "2026-10-16T11:00:00+08:00"),
    timed("乙", "2026-10-16T09:30:00+08:00", "2026-10-16T10:30:00+08:00"),
    timed("丙", "2026-10-16T09:45:00+08:00", "2026-10-16T11:30:00+08:00"),
  ]);
  assert.match(text, /09:45–11:30 丙\n {2}⚠️ 與「甲」、「乙」時間重疊/);
});

test("stays quiet when the only events are skipped, cancelled, or declined", () => {
  assert.equal(
    render([
      timed("出遊：墾丁", "2026-10-16T13:00:00+08:00", "2026-10-16T18:00:00+08:00"),
      timed("已拒絕的會", "2026-10-16T15:00:00+08:00", "2026-10-16T16:00:00+08:00", {
        attendees: [{ self: true, responseStatus: "declined" }],
      }),
      {
        summary: "已取消",
        status: "cancelled",
        start: { dateTime: "2026-10-16T17:00:00+08:00" },
        end: { dateTime: "2026-10-16T18:00:00+08:00" },
      },
    ]),
    null
  );
  assert.equal(render([]), null);
});

test("skip prefix is exact and configurable", () => {
  const items = [
    timed("出遊：墾丁", "2026-10-16T13:00:00+08:00", "2026-10-16T18:00:00+08:00"),
    timed("休假：在家", "2026-10-16T09:00:00+08:00", "2026-10-16T10:00:00+08:00"),
  ];
  assert.match(render(items, { skipPrefix: "休假：" }), /出遊：墾丁/);
  assert.doesNotMatch(render(items, { skipPrefix: "休假：" }), /休假：在家/);
  assert.match(render(items, { skipPrefix: "" }), /出遊：墾丁/);
});

test("empty day is explicit when the other day has events", () => {
  const text = render([
    timed("牙醫", "2026-10-17T15:00:00+08:00", "2026-10-17T16:00:00+08:00", {
      location: "大安診所",
    }),
  ]);
  assert.match(text, /【今天 10\/16（五）】\n（沒有行程）/);
  assert.match(text, /15:00–16:00 牙醫\n {2}📍 大安診所/);
});

test("all-day events do not conflict with timed events, and multi-day all-day shows twice", () => {
  const text = render([
    {
      summary: "連假",
      status: "confirmed",
      start: { date: "2026-10-16" },
      end: { date: "2026-10-18" },
    },
    timed("週會", "2026-10-16T09:00:00+08:00", "2026-10-16T10:00:00+08:00"),
  ]);
  assert.match(text, /【今天 10\/16（五）】\n全天 連假\n09:00–10:00 週會/);
  assert.match(text, /【明天 10\/17（六）】\n全天 連假/);
  assert.doesNotMatch(text, /週會[\s\S]*⚠️/);
});

test("an event after Taipei midnight belongs to tomorrow", () => {
  const text = render([
    timed("跨夜", "2026-10-16T23:00:00+08:00", "2026-10-17T01:00:00+08:00"),
    timed("午夜後", "2026-10-16T16:30:00Z", "2026-10-16T17:00:00Z"),
  ]);
  const today = text.split("【明天")[0];
  const tomorrow = text.split("【明天")[1];
  assert.match(today, /跨夜/);
  assert.doesNotMatch(today, /午夜後/);
  assert.match(tomorrow, /午夜後/);
  assert.match(tomorrow, /00:30–01:00 午夜後/);
  assert.match(today, /10\/16 23:00–10\/17 01:00 跨夜/);
  assert.match(tomorrow, /跨夜/);
});

test("meeting link falls back to description, and a blank title is named", () => {
  const text = render([
    timed("  ", "2026-10-16T09:00:00+08:00", "2026-10-16T09:30:00+08:00", {
      description: "請走 https://zoom.us/j/555 進入",
      location: "線上",
    }),
  ]);
  assert.match(text, /09:00–09:30 \(未命名行程\)\n {2}📍 線上\n {2}🔗 https:\/\/zoom\.us\/j\/555/);
});

test("calendar job returns null when the mocked calendar is empty", async () => {
  let seen;
  const job = createCalendarDigestJob({
    fetchEvents: async (window) => {
      seen = window;
      return [];
    },
  });
  assert.equal(job.ready(), true);
  const text = await job.run({ now: NOW, timeZone: ZONE });
  assert.equal(text, null);
  assert.equal(seen.timeMin, "2026-10-15T16:00:00.000Z");
  assert.equal(seen.timeMax, "2026-10-17T16:00:00.000Z");
});
