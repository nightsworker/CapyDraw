"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const indexSource = fs.readFileSync(path.resolve(__dirname, "../index.js"), "utf8");
const scheduleRuntime = fs.readFileSync(
  path.resolve(__dirname, "../lib/lineScheduleRuntime.js"), "utf8");
const pendingRuntime = fs.readFileSync(
  path.resolve(__dirname, "../lib/linePendingRuntime.js"), "utf8");

test("all schedule management endpoints reuse withAdminRequest authorization", () => {
  const names = [
    "getLineSchedules", "getAutomationSettings", "createLineSchedule", "updateLineSchedule",
    "deleteLineSchedule", "setLineScheduleEnabled", "updateTomorrowDrawAutomation",
  ];
  names.forEach((name, index) => {
    const nextName = names[index + 1];
    const start = indexSource.indexOf(`exports.${name}`);
    const end = nextName ? indexSource.indexOf(`exports.${nextName}`, start) :
      indexSource.indexOf("exports.getLineBindings", start);
    assert.ok(start >= 0, `${name} should be exported`);
    assert.match(indexSource.slice(start, end), /withAdminRequest\(req, res/u, name);
  });
});

test("scheduler binds OpenAI only and has no automatic LINE push path", () => {
  const handler = indexSource.match(/exports\.scheduleDispatcher = onSchedule\([\s\S]*?(?=\nexports\.|$)/u);
  assert.ok(handler);
  assert.match(handler[0], /schedule: "every 1 minutes"/u);
  assert.match(handler[0], /timeZone: SCHEDULE_TIMEZONE/u);
  assert.match(handler[0], /secrets: \[OPENAI_API_KEY\]/u);
  assert.doesNotMatch(handler[0], /LINE_CHANNEL_ACCESS_TOKEN|pushLineMessages|\/message\/push/u);
  assert.doesNotMatch(scheduleRuntime, /pushLineMessages|sendDrawLineRecord|\/message\/push/u);
  assert.match(scheduleRuntime, /enqueueAnnouncement\(pending\)/u);
});

test("manual sendDrawToLine remains the explicit stable retry-key push path", () => {
  const manual = indexSource.match(
    /exports\.sendDrawToLine[\s\S]*?(?=exports\.backfillDrawLinePublished)/u);
  assert.ok(manual);
  assert.match(manual[0], /sendDrawLineRecord/u);
  assert.match(manual[0], /pushMessage: pushLineMessages/u);
  const callLine = indexSource.match(/async function callLine[\s\S]*?(?=\nasync function pushLineMessages)/u);
  assert.ok(callLine);
  assert.match(callLine[0], /"X-Line-Retry-Key": retryKey/u);
  assert.match(callLine[0], /response\.status === 409/u);
});

test("pending queue and schedules remain server-only under RTDB deny rules", () => {
  const rules = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, "../../database.rules.json"), "utf8"));
  assert.equal(rules.rules[".read"], false);
  assert.equal(rules.rules[".write"], false);
  assert.deepEqual(rules.rules.guildDraw.linePendingAnnouncements,
    {".read": false, ".write": false});
  assert.equal(rules.rules.guildDraw.lineSchedules, undefined);
});

test("dispatcher only targets defaultGroupId and never accepts schedule groupId", () => {
  const scheduleModule = fs.readFileSync(path.resolve(__dirname, "../lib/lineSchedule.js"), "utf8");
  assert.doesNotMatch(scheduleModule, /targetGroupId|schedule\.groupId/u);
  assert.match(indexSource, /settingsSnapshot\.child\("defaultGroupId"\)\.val\(\)/u);
  assert.match(indexSource, /pendingGroupRef\(db, defaultGroupId\)/u);
});

test("webhook collects normal and pending messages before one direct Reply API call", () => {
  const wrapper = indexSource.match(
    /async function processLineWebhookEventWithPending[\s\S]*?(?=\nexports\.lineWebhook)/u);
  assert.ok(wrapper);
  assert.match(wrapper[0], /replyCollectorStorage\.run/u);
  assert.match(wrapper[0], /consumePendingAnnouncements/u);
  assert.match(wrapper[0], /normalMessages: collector\.messages/u);
  assert.match(wrapper[0], /sendReplyMessagesNow\(event\.replyToken/u);
  assert.doesNotMatch(wrapper[0], /pushLineMessages|\/message\/push/u);
  assert.equal((pendingRuntime.match(/await sendReply\(messages\)/gu) || []).length, 1);
});

test("pending logs omit reply token and raw LINE identifiers", () => {
  const wrapper = indexSource.match(
    /async function processLineWebhookEventWithPending[\s\S]*?(?=\nexports\.lineWebhook)/u);
  assert.ok(wrapper);
  const log = wrapper[0].match(/logger\.info\("LINE reply-first event"[\s\S]*?\n    \}\);/u);
  assert.ok(log);
  assert.match(log[0], /pendingIds|eventType|sentVia|status/u);
  assert.doesNotMatch(log[0], /replyToken|groupId|userId|token/u);
});

test("tomorrow diagnostics remain safe and contain queue status metadata", () => {
  const handler = indexSource.match(/exports\.scheduleDispatcher = onSchedule\([\s\S]*?(?=\nexports\.|$)/u);
  assert.ok(handler);
  for (const field of ["historyType", "historyCount", "matchedRecordCount", "matchedRecordId",
    "matchedRecordDate", "published", "occurrenceStatusBefore", "occurrenceStatusAfter",
    "nextCheckAt", "sendClaimResult", "errorType"]) {
    assert.match(handler[0], new RegExp(`\\b${field}\\b`, "u"));
  }
  assert.doesNotMatch(handler[0], /logger\.(?:info|warn|error)\([^\n]*historySnapshot/u);
});
