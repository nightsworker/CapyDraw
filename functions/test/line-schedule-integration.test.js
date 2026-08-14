"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const indexSource = fs.readFileSync(path.resolve(__dirname, "../index.js"), "utf8");

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

test("scheduler is one v2 onSchedule dispatcher with Taipei timezone and bound secrets", () => {
  const handler = indexSource.match(/exports\.scheduleDispatcher = onSchedule\([\s\S]*?(?=\nexports\.|$)/u);
  assert.ok(handler);
  assert.match(handler[0], /schedule: "every 1 minutes"/u);
  assert.match(handler[0], /timeZone: SCHEDULE_TIMEZONE/u);
  assert.match(handler[0], /secrets: \[LINE_CHANNEL_ACCESS_TOKEN, OPENAI_API_KEY\]/u);
});

test("scheduled push sends stable X-Line-Retry-Key and accepts LINE duplicate acknowledgement", () => {
  const callLine = indexSource.match(/async function callLine[\s\S]*?(?=\nasync function pushLineMessages)/u);
  assert.ok(callLine);
  assert.match(callLine[0], /"X-Line-Retry-Key": retryKey/u);
  assert.match(callLine[0], /response\.status === 409/u);
  assert.match(callLine[0], /x-line-accepted-request-id/u);
});

test("manual and scheduled draw publication share sendDrawLineRecord", () => {
  const manual = indexSource.match(/exports\.sendDrawToLine[\s\S]*?(?=exports\.backfillDrawLinePublished)/u);
  const scheduler = indexSource.match(/exports\.scheduleDispatcher[\s\S]*$/u);
  assert.ok(manual);
  assert.ok(scheduler);
  assert.match(manual[0], /sendDrawLineRecord/u);
  assert.match(scheduler[0], /dispatchTomorrowDraw/u);
  const runtime = fs.readFileSync(path.resolve(__dirname, "../lib/lineScheduleRuntime.js"), "utf8");
  assert.match(runtime, /sendDrawLineRecord/u);
});

test("lineSchedules remains server-only under RTDB root default deny", () => {
  const rules = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../database.rules.json"), "utf8"));
  assert.equal(rules.rules[".read"], false);
  assert.equal(rules.rules[".write"], false);
  assert.equal(rules.rules.guildDraw.lineSchedules, undefined);
});

test("dispatcher never accepts a schedule-provided groupId", () => {
  const scheduleModule = fs.readFileSync(path.resolve(__dirname, "../lib/lineSchedule.js"), "utf8");
  assert.doesNotMatch(scheduleModule, /targetGroupId|schedule\.groupId/u);
  assert.match(indexSource, /settingsSnapshot\.child\("defaultGroupId"\)\.val\(\)/u);
});

test("tomorrow diagnostics log only safe lookup and delivery metadata", () => {
  const handler = indexSource.match(/exports\.scheduleDispatcher = onSchedule\([\s\S]*?(?=\nexports\.|$)/u);
  assert.ok(handler);
  for (const field of ["historyType", "historyCount", "matchedRecordCount", "matchedRecordId",
    "matchedRecordDate", "published", "occurrenceStatusBefore", "occurrenceStatusAfter",
    "nextCheckAt", "sendClaimResult", "errorType"]) {
    assert.match(handler[0], new RegExp(`\\b${field}\\b`, "u"));
  }
  assert.doesNotMatch(handler[0], /logger\.(?:info|warn|error)\([^\n]*historySnapshot/u);
});
