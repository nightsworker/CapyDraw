"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  buildScheduleRequest,
  normalizeRecurrenceForEditor,
  previewTemplate,
  recurrenceLabel,
  runStatusLabel,
} = require("../../line-schedules-ui");

test("frontend preview renders member, @ALL, and date tokens without OpenAI", () => {
  const preview = previewTemplate([
    {type: "all"}, {type: "text", text: " 明天 "},
    {type: "date", offsetDays: 1, format: "M/D"},
    {type: "text", text: " 找 "},
    {type: "member", bindingId: "binding-secret-reference", display: "@Rain"},
  ], "2026-08-15");
  assert.equal(preview, "@ALL 明天 8/16 找 @Rain");
  assert.equal(preview.includes("binding-secret-reference"), false);
});

test("frontend schedule request remains structured and has no LINE userId", () => {
  const request = buildScheduleRequest({
    name: "每週提醒", enabled: true,
    messageTemplate: [{type: "member", bindingId: "binding_a", display: "@A"}],
    startDate: "2026-08-14", endDate: "", recurrenceType: "every_n_weeks",
    weekInterval: "3", weekdays: [2, 5], time: "20:30",
  });
  assert.equal(request.recurrence.type, "every_n_weeks");
  assert.equal(request.recurrence.weekInterval, 3);
  assert.deepEqual(request.recurrence.weekdays, [2, 5]);
  assert.equal(JSON.stringify(request).includes("lineUserId"), false);
});

test("frontend daily request omits weekly-only fields", () => {
  const request = buildScheduleRequest({
    name: "每天", messageTemplate: [{type: "text", text: "提醒"}],
    startDate: "2026-08-14", recurrenceType: "daily",
    weekInterval: "garbage", weekdays: [99], time: "20:30",
  });
  assert.deepEqual(request.recurrence, {type: "daily"});
});

test("frontend recurrence and run status labels cover generalized weeks", () => {
  assert.equal(recurrenceLabel({recurrence: {
    type: "every_n_weeks", weekInterval: 1, weekdays: [2, 5],
  }}), "每週・週二、週五");
  assert.equal(recurrenceLabel({recurrence: {
    type: "every_n_weeks", weekInterval: 2, weekdays: [2, 5],
  }}), "每 2 週・週二、週五");
  assert.equal(recurrenceLabel({recurrence: {type: "monthly", dayOfMonth: 31}}),
    "舊版每月排程，請重新設定循環");
  assert.equal(runStatusLabel("waiting-for-draw"), "⏳ 等待抽籤");
  assert.equal(runStatusLabel("queued-for-reply"), "⏳ 等待群組訊息後免費回覆");
  assert.equal(runStatusLabel("sent-via-reply"), "✅ 已透過 Reply 發布");
});

test("legacy weekly and biweekly edit into the new formal schema", () => {
  assert.deepEqual(normalizeRecurrenceForEditor({recurrence: {
    type: "weekly", weekdays: [2, 5],
  }}), {type: "every_n_weeks", weekInterval: 1, weekdays: [2, 5], needsReview: false});
  assert.deepEqual(normalizeRecurrenceForEditor({recurrence: {
    type: "biweekly", weekdays: [2, 5],
  }}), {type: "every_n_weeks", weekInterval: 2, weekdays: [2, 5], needsReview: false});
});

test("legacy monthly opens as an explicit recurrence reset", () => {
  assert.deepEqual(normalizeRecurrenceForEditor({recurrence: {
    type: "monthly", dayOfMonth: 31,
  }}), {type: "every_n_weeks", weekInterval: 1, weekdays: [], needsReview: true});
});

test("automation editor exposes only daily and every-n-weeks creation options", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../../index.html"), "utf8");
  const select = source.match(/<select id="scheduleRecurrence">[\s\S]*?<\/select>/u);
  assert.ok(select);
  assert.match(select[0], /value="daily"/u);
  assert.match(select[0], /value="every_n_weeks"/u);
  assert.doesNotMatch(select[0], /value="(?:weekly|biweekly|monthly)"/u);
  assert.match(source, /id="scheduleWeekInterval"[^>]*min="1"[^>]*max="52"/u);
  assert.doesNotMatch(source, /id="scheduleMonthDay"/u);
});

test("automation UI uses existing admin helper and never writes schedule RTDB directly", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../../index.html"), "utf8");
  assert.match(source, /data-tab="automationPanel"/u);
  assert.match(source, /"createLineSchedule"/u);
  assert.match(source, /callLineAdminFunction\(endpoint/u);
  assert.match(source, /callLineAdminFunction\("updateTomorrowDrawAutomation"/u);
  const section = source.match(/async function loadLineSchedules[\s\S]*?(?=\n    function poolDiff)/u);
  assert.ok(section);
  assert.doesNotMatch(section[0], /firebase\.database|\.ref\(|lineSentAt\s*=|lineSendCount\s*=/u);
  assert.doesNotMatch(section[0], /OPENAI_API_KEY|LINE_CHANNEL_ACCESS_TOKEN/u);
});

test("schedule page is hidden until existing Firebase admin authorization succeeds", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../../index.html"), "utf8");
  assert.match(source, /automationTabBtn[\s\S]*style="display:none"/u);
  assert.match(source, /automationTabBtn"\)\.style\.display = lineAdminAuthorized/u);
});

test("manual push UI explicitly warns quota use and automation explains Reply delay", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../../index.html"), "utf8");
  assert.match(source, />強制立即推播到 LINE</u);
  assert.match(source, /會消耗 LINE 主動訊息額度/u);
  assert.match(source, /自動公告預設使用 LINE Reply 模式/u);
  assert.match(source, /實際送達時間可能晚於設定時間/u);
  assert.match(source, /confirm\(confirmText\)/u);
});
