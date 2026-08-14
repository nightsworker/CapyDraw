"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  addCalendarDays,
  buildScheduledLineMessage,
  findNextOccurrence,
  formatDateToken,
  occurrenceTimestamp,
  pruneRunHistory,
  recurrenceMatchesDate,
  renderScheduleCore,
  stableRetryKey,
  taipeiDateKey,
  validateLineSchedule,
  validateTomorrowAutomation,
} = require("../lib/lineSchedule");

function schedule(overrides = {}) {
  return {
    id: "s_test1234",
    name: "測試公告",
    enabled: true,
    messageTemplate: [{type: "text", text: "核心公告"}],
    startDate: "2026-08-01",
    endDate: null,
    recurrence: {type: "daily", weekdays: [], dayOfMonth: null},
    time: "20:30",
    timezone: "Asia/Taipei",
    ...overrides,
  };
}

test("daily recurrence honors inclusive start and end dates", () => {
  const value = schedule({startDate: "2026-08-14", endDate: "2026-08-15"});
  assert.equal(recurrenceMatchesDate(value, "2026-08-13"), false);
  assert.equal(recurrenceMatchesDate(value, "2026-08-14"), true);
  assert.equal(recurrenceMatchesDate(value, "2026-08-15"), true);
  assert.equal(recurrenceMatchesDate(value, "2026-08-16"), false);
});

test("weekly recurrence supports one or multiple weekdays", () => {
  const value = schedule({recurrence: {type: "weekly", weekdays: [2, 5]}});
  assert.equal(recurrenceMatchesDate(value, "2026-08-18"), true);
  assert.equal(recurrenceMatchesDate(value, "2026-08-21"), true);
  assert.equal(recurrenceMatchesDate(value, "2026-08-19"), false);
});

test("biweekly recurrence anchors week zero to the startDate calendar week", () => {
  const value = schedule({
    startDate: "2026-08-12",
    recurrence: {type: "biweekly", weekdays: [2, 5]},
  });
  assert.equal(recurrenceMatchesDate(value, "2026-08-14"), true);
  assert.equal(recurrenceMatchesDate(value, "2026-08-18"), false);
  assert.equal(recurrenceMatchesDate(value, "2026-08-25"), true);
  assert.equal(recurrenceMatchesDate(value, "2026-08-28"), true);
});

test("monthly day 15 runs on the 15th", () => {
  const value = schedule({recurrence: {type: "monthly", dayOfMonth: 15}});
  assert.equal(recurrenceMatchesDate(value, "2026-08-15"), true);
  assert.equal(recurrenceMatchesDate(value, "2026-08-16"), false);
});

test("monthly day 31 clamps to month end including leap February", () => {
  const value = schedule({startDate: "2025-01-01", recurrence: {type: "monthly", dayOfMonth: 31}});
  assert.equal(recurrenceMatchesDate(value, "2025-02-28"), true);
  assert.equal(recurrenceMatchesDate(value, "2026-04-30"), true);
  assert.equal(recurrenceMatchesDate(value, "2026-05-31"), true);
  assert.equal(recurrenceMatchesDate(value, "2028-02-29"), true);
});

test("next occurrence is backend-calculated and catches a one-minute late dispatcher", () => {
  const value = schedule({startDate: "2026-08-14", time: "20:30"});
  const next = findNextOccurrence(value, {
    after: new Date("2026-08-14T12:29:00.000Z"), inclusive: true,
  });
  assert.equal(next.scheduledFor, "2026-08-14T12:30:00.000Z");
  assert.ok(next.timestamp <= Date.parse("2026-08-14T12:31:00.000Z"));
});

test("no end date continues while after endDate has no occurrence", () => {
  assert.equal(findNextOccurrence(schedule({startDate: "2026-08-01"}), {
    after: new Date("2029-01-01T00:00:00.000Z"), inclusive: true,
  }).occurrenceDate, "2029-01-01");
  assert.equal(findNextOccurrence(schedule({startDate: "2026-08-01", endDate: "2026-08-02"}), {
    after: new Date("2026-08-03T00:00:00.000Z"), inclusive: true,
  }), null);
});

test("Asia/Taipei calendar date is independent of server UTC date", () => {
  assert.equal(taipeiDateKey(new Date("2026-08-13T16:30:00.000Z")), "2026-08-14");
  assert.equal(occurrenceTimestamp("2026-08-14", "00:30"), Date.parse("2026-08-13T16:30:00.000Z"));
});

test("date tokens support X, offsets, formats, and calendar rollover", () => {
  assert.equal(formatDateToken("2026-08-15", 0, "M/D"), "8/15");
  assert.equal(formatDateToken("2026-08-15", 1, "M/D"), "8/16");
  assert.equal(formatDateToken("2026-08-01", -1, "YYYY/MM/DD"), "2026/07/31");
  assert.equal(addCalendarDays("2026-12-31", 1), "2027-01-01");
});

test("template creates true member and @ALL textV2 mentions", () => {
  const core = renderScheduleCore([
    {type: "all"}, {type: "text", text: " 明天 "},
    {type: "date", offsetDays: 1, format: "M/D"}, {type: "text", text: " 請找 "},
    {type: "member", bindingId: "binding_rain", display: "@Rain"},
  ], {
    occurrenceDate: "2026-08-15",
    defaultGroupId: "C_GROUP",
    bindings: {binding_rain: {lineUserId: "U_RAIN", lineGroupId: "C_GROUP"}},
  });
  assert.equal(core.plainText, "@ALL 明天 8/16 請找 @Rain");
  assert.deepEqual(core.substitutions.mention0, {type: "mention", mentionee: {type: "all"}});
  assert.deepEqual(core.substitutions.mention1, {
    type: "mention", mentionee: {type: "user", userId: "U_RAIN"},
  });
  const message = buildScheduledLineMessage(core, {intro: "先提醒一下。", outro: "記得喔。"});
  assert.equal(message.type, "textV2");
  assert.match(message.text, /^先提醒一下。\n\{mention0\} 明天 8\/16 請找 \{mention1\}\n記得喔。$/u);
});

test("multiple member mentions are resolved independently", () => {
  const core = renderScheduleCore([
    {type: "member", bindingId: "a", display: "@A"},
    {type: "text", text: " / "},
    {type: "member", bindingId: "b", display: "@B"},
  ], {occurrenceDate: "2026-08-15", defaultGroupId: "G", bindings: {
    a: {lineUserId: "UA", lineGroupId: "G"}, b: {lineUserId: "UB", lineGroupId: "G"},
  }});
  assert.equal(Object.keys(core.substitutions).length, 2);
  assert.equal(core.warnings.length, 0);
});

test("missing or moved binding becomes safe plain text and never mentions the wrong user", () => {
  const core = renderScheduleCore([
    {type: "member", bindingId: "old", display: "@Rain"},
  ], {occurrenceDate: "2026-08-15", defaultGroupId: "G", bindings: {
    old: {lineUserId: "WRONG_GROUP_USER", lineGroupId: "OTHER"},
  }});
  assert.equal(core.text, "@Rain");
  assert.deepEqual(core.substitutions, {});
  assert.deepEqual(core.warnings, ["missing-binding:old"]);
  assert.equal(JSON.stringify(core).includes("WRONG_GROUP_USER"), false);
});

test("AI wrapper surrounds but cannot mutate core text, numbers, dates, or mentions", () => {
  const core = renderScheduleCore([
    {type: "all"}, {type: "text", text: " 第四船艙捐滿三張，日期 "},
    {type: "date", offsetDays: 1, format: "M/D"},
  ], {occurrenceDate: "2026-08-15", defaultGroupId: "G", bindings: {}});
  const message = buildScheduledLineMessage(core, {
    intro: "別裝沒看到。", outro: "交作業。",
  });
  assert.ok(message.text.includes(core.text));
  assert.ok(message.text.includes("三張"));
  assert.ok(message.text.includes("8/16"));
  assert.deepEqual(message.substitution, core.substitutions);
});

test("schedule validation preserves structured tokens and rejects invalid recurrence", () => {
  const created = validateLineSchedule({
    name: "每週提醒", enabled: true,
    messageTemplate: [{type: "text", text: "請集合"}],
    startDate: "2026-08-14", endDate: "", time: "20:30",
    recurrence: {type: "weekly", weekdays: [2, 5]},
  }, {id: "s_test1234", uid: "UID_A", now: new Date("2026-08-14T00:00:00.000Z")});
  assert.deepEqual(created.messageTemplate, [{type: "text", text: "請集合"}]);
  assert.equal(created.timezone, "Asia/Taipei");
  assert.throws(() => validateLineSchedule({...created,
    recurrence: {type: "weekly", weekdays: []}}, {id: created.id}), /至少要選/u);
});

test("tomorrow automation validation is backwards-safe and timezone-fixed", () => {
  assert.deepEqual(validateTomorrowAutomation({enabled: true, time: "21:00"}, {
    uid: "UID_A", now: new Date("2026-08-14T00:00:00.000Z"),
  }), {
    enabled: true, time: "21:00", timezone: "Asia/Taipei",
    updatedAt: "2026-08-14T00:00:00.000Z", updatedByUid: "UID_A",
    lastRunAt: null, lastRunStatus: null,
  });
});

test("stable LINE retry key is a deterministic UUID for one occurrence", () => {
  const first = stableRetryKey("schedule:occurrence");
  assert.equal(first, stableRetryKey("schedule:occurrence"));
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  assert.notEqual(first, stableRetryKey("schedule:other"));
});

test("run history is capped at the newest twenty records", () => {
  const runs = Object.fromEntries(Array.from({length: 25}, (_, index) => [
    `run${index}`, {scheduledFor: new Date(1_700_000_000_000 + index * 60_000).toISOString()},
  ]));
  const pruned = pruneRunHistory(runs);
  assert.equal(Object.keys(pruned).length, 20);
  assert.equal(Object.hasOwn(pruned, "run24"), true);
  assert.equal(Object.hasOwn(pruned, "run0"), false);
});
