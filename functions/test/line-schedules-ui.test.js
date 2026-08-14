"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  buildScheduleRequest,
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
    startDate: "2026-08-14", endDate: "", recurrenceType: "weekly",
    weekdays: [2, 5], dayOfMonth: null, time: "20:30",
  });
  assert.equal(request.recurrence.type, "weekly");
  assert.deepEqual(request.recurrence.weekdays, [2, 5]);
  assert.equal(JSON.stringify(request).includes("lineUserId"), false);
});

test("frontend recurrence and run status labels cover V1", () => {
  assert.equal(recurrenceLabel({recurrence: {type: "biweekly", weekdays: [2, 5]}}), "每雙週 二、五");
  assert.equal(recurrenceLabel({recurrence: {type: "monthly", dayOfMonth: 31}}), "每月 31 日（缺日取月底）");
  assert.equal(runStatusLabel("waiting-for-draw"), "⏳ 等待抽籤");
  assert.equal(runStatusLabel("queued-for-reply"), "⏳ 等待群組訊息後免費回覆");
  assert.equal(runStatusLabel("sent-via-reply"), "✅ 已透過 Reply 發布");
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
