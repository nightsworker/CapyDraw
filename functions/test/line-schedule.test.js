"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  addCalendarDays,
  buildScheduledLineMessage,
  calendarDayDifference,
  findNextOccurrence,
  fixedRunKey,
  formatDateToken,
  latestTomorrowOccurrence,
  occurrenceTimestamp,
  normalizeLineScheduleRecurrence,
  pruneRunHistory,
  recurrenceMatchesDate,
  renderScheduleCore,
  reuseExistingOccurrenceRun,
  stableRetryKey,
  taipeiDateKey,
  tomorrowRunKey,
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

function occurrenceDates(value, count, after = "2026-08-09T16:00:00.000Z") {
  const dates = [];
  let cursor = new Date(after);
  while (dates.length < count) {
    const next = findNextOccurrence(value, {after: cursor, inclusive: true});
    if (!next) break;
    dates.push(next.occurrenceDate);
    cursor = new Date(next.timestamp + 1);
  }
  return dates;
}

test("daily recurrence honors inclusive start and end dates", () => {
  const value = schedule({startDate: "2026-08-14", endDate: "2026-08-15"});
  assert.equal(recurrenceMatchesDate(value, "2026-08-13"), false);
  assert.equal(recurrenceMatchesDate(value, "2026-08-14"), true);
  assert.equal(recurrenceMatchesDate(value, "2026-08-15"), true);
  assert.equal(recurrenceMatchesDate(value, "2026-08-16"), false);
});

test("every one week recurrence supports one or multiple weekdays", () => {
  const value = schedule({
    recurrence: {type: "every_n_weeks", weekInterval: 1, weekdays: [2, 5]},
  });
  assert.equal(recurrenceMatchesDate(value, "2026-08-18"), true);
  assert.equal(recurrenceMatchesDate(value, "2026-08-21"), true);
  assert.equal(recurrenceMatchesDate(value, "2026-08-19"), false);
});

test("every two weeks anchors week zero to the startDate calendar week", () => {
  const value = schedule({
    startDate: "2026-08-12",
    recurrence: {type: "every_n_weeks", weekInterval: 2, weekdays: [2, 5]},
  });
  assert.equal(recurrenceMatchesDate(value, "2026-08-14"), true);
  assert.equal(recurrenceMatchesDate(value, "2026-08-18"), false);
  assert.equal(recurrenceMatchesDate(value, "2026-08-25"), true);
  assert.equal(recurrenceMatchesDate(value, "2026-08-28"), true);
});

test("every three weeks activates only calendar weeks 0, 3, 6", () => {
  const value = schedule({
    startDate: "2026-08-10",
    recurrence: {type: "every_n_weeks", weekInterval: 3, weekdays: [2]},
  });
  assert.equal(recurrenceMatchesDate(value, "2026-08-11"), true);
  assert.equal(recurrenceMatchesDate(value, "2026-08-18"), false);
  assert.equal(recurrenceMatchesDate(value, "2026-08-25"), false);
  assert.equal(recurrenceMatchesDate(value, "2026-09-01"), true);
});

test("every four weeks supports multiple weekdays", () => {
  const value = schedule({
    startDate: "2026-08-10",
    recurrence: {type: "every_n_weeks", weekInterval: 4, weekdays: [1, 7]},
  });
  assert.equal(recurrenceMatchesDate(value, "2026-08-10"), true);
  assert.equal(recurrenceMatchesDate(value, "2026-08-16"), true);
  assert.equal(recurrenceMatchesDate(value, "2026-08-17"), false);
  assert.equal(recurrenceMatchesDate(value, "2026-09-07"), true);
});

test("disabled schedules never match an otherwise active week", () => {
  const value = schedule({
    enabled: false,
    startDate: "2026-08-10",
    recurrence: {type: "every_n_weeks", weekInterval: 1, weekdays: [1]},
  });
  assert.equal(recurrenceMatchesDate(value, "2026-08-10"), false);
});

test("startDate calendar week is week zero", () => {
  const value = schedule({
    startDate: "2026-08-12",
    recurrence: {type: "every_n_weeks", weekInterval: 5, weekdays: [3]},
  });
  assert.equal(recurrenceMatchesDate(value, "2026-08-12"), true);
});

test("week zero never runs a selected weekday before startDate", () => {
  const value = schedule({
    startDate: "2026-08-13",
    recurrence: {type: "every_n_weeks", weekInterval: 2, weekdays: [1, 5]},
  });
  assert.equal(recurrenceMatchesDate(value, "2026-08-10"), false);
  assert.equal(recurrenceMatchesDate(value, "2026-08-14"), true);
});

test("endDate is inclusive for an every-n-weeks occurrence", () => {
  const value = schedule({
    startDate: "2026-08-10", endDate: "2026-08-25",
    recurrence: {type: "every_n_weeks", weekInterval: 2, weekdays: [2]},
  });
  assert.equal(recurrenceMatchesDate(value, "2026-08-25"), true);
  assert.equal(recurrenceMatchesDate(value, "2026-09-08"), false);
});

test("an absent endDate keeps every-n-weeks recurrence permanent", () => {
  const value = schedule({
    startDate: "2026-08-10",
    recurrence: {type: "every_n_weeks", weekInterval: 52, weekdays: [1]},
  });
  assert.ok(findNextOccurrence(value, {
    after: new Date("2031-01-01T00:00:00.000Z"), inclusive: true,
  }));
});

test("calendar-week recurrence crosses month boundaries", () => {
  const value = schedule({
    startDate: "2026-08-24",
    recurrence: {type: "every_n_weeks", weekInterval: 2, weekdays: [1]},
  });
  assert.equal(recurrenceMatchesDate(value, "2026-08-24"), true);
  assert.equal(recurrenceMatchesDate(value, "2026-09-07"), true);
});

test("calendar-week recurrence crosses year boundaries", () => {
  const value = schedule({
    startDate: "2026-12-28",
    recurrence: {type: "every_n_weeks", weekInterval: 2, weekdays: [1]},
  });
  assert.equal(recurrenceMatchesDate(value, "2026-12-28"), true);
  assert.equal(recurrenceMatchesDate(value, "2027-01-04"), false);
  assert.equal(recurrenceMatchesDate(value, "2027-01-11"), true);
});

test("calendar week arithmetic uses civil dates across leap years", () => {
  assert.equal(calendarDayDifference("2028-03-06", "2028-02-28"), 7);
  assert.equal(calendarDayDifference("2027-01-04", "2026-12-28"), 7);
});

test("deterministic A: every week Tuesday and Friday next six dates", () => {
  const value = schedule({
    startDate: "2026-08-10",
    recurrence: {type: "every_n_weeks", weekInterval: 1, weekdays: [2, 5]},
  });
  assert.deepEqual(occurrenceDates(value, 6), [
    "2026-08-11", "2026-08-14", "2026-08-18",
    "2026-08-21", "2026-08-25", "2026-08-28",
  ]);
});

test("deterministic B: every two weeks Tuesday and Friday next six dates", () => {
  const value = schedule({
    startDate: "2026-08-10",
    recurrence: {type: "every_n_weeks", weekInterval: 2, weekdays: [2, 5]},
  });
  assert.deepEqual(occurrenceDates(value, 6), [
    "2026-08-11", "2026-08-14", "2026-08-25",
    "2026-08-28", "2026-09-08", "2026-09-11",
  ]);
});

test("deterministic C: every three weeks Tuesday and Friday next six dates", () => {
  const value = schedule({
    startDate: "2026-08-10",
    recurrence: {type: "every_n_weeks", weekInterval: 3, weekdays: [2, 5]},
  });
  assert.deepEqual(occurrenceDates(value, 6), [
    "2026-08-11", "2026-08-14", "2026-09-01",
    "2026-09-04", "2026-09-22", "2026-09-25",
  ]);
});

test("deterministic D: Thursday start excludes Monday and first runs Friday", () => {
  const value = schedule({
    startDate: "2026-08-13",
    recurrence: {type: "every_n_weeks", weekInterval: 2, weekdays: [1, 5]},
  });
  assert.deepEqual(occurrenceDates(value, 4), [
    "2026-08-14", "2026-08-24", "2026-08-28", "2026-09-07",
  ]);
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

test("same-day occurrence keys do not change when an admin edits the time", () => {
  assert.equal(fixedRunKey("s_test1234", "2026-09-01", "13:00"),
    fixedRunKey("s_test1234", "2026-09-01", "15:19"));
  assert.equal(fixedRunKey("s_test1234", "2026-09-01"), "s_test1234_2026-09-01");
  assert.equal(tomorrowRunKey("2026-09-01", "13:00"),
    tomorrowRunKey("2026-09-01", "15:19"));
  assert.equal(tomorrowRunKey("2026-09-01"), "tomorrow_2026-09-01");
  assert.notEqual(tomorrowRunKey("2026-09-01"), tomorrowRunKey("2026-09-02"));
  assert.equal(
    latestTomorrowOccurrence({enabled: true, time: "13:00"},
      new Date("2026-09-01T07:20:00.000Z")).runKey,
    latestTomorrowOccurrence({enabled: true, time: "15:19"},
      new Date("2026-09-01T07:20:00.000Z")).runKey,
  );
});

test("same-date legacy time-based run is reused and terminal run wins", () => {
  const occurrence = {
    occurrenceDate: "2026-09-01",
    scheduledFor: "2026-09-01T07:19:00.000Z",
    runKey: tomorrowRunKey("2026-09-01"),
  };
  const resolved = reuseExistingOccurrenceRun(occurrence, {
    "tomorrow_2026-09-01_13-00": {
      occurrenceDate: "2026-09-01", status: "waiting-for-draw",
      scheduledFor: "2026-09-01T05:00:00.000Z",
    },
    "tomorrow_2026-09-01_15-15": {
      occurrenceDate: "2026-09-01", status: "sent-via-reply",
      scheduledFor: "2026-09-01T07:15:00.000Z",
    },
  });
  assert.equal(resolved.runKey, "tomorrow_2026-09-01_15-15");
  assert.equal(reuseExistingOccurrenceRun({...occurrence, occurrenceDate: "2026-09-02"}, {
    "tomorrow_2026-09-01_15-15": {
      occurrenceDate: "2026-09-01", status: "sent-via-reply",
    },
  }).runKey, occurrence.runKey);
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

test("schedule validation preserves structured tokens and the formal recurrence schema", () => {
  const created = validateLineSchedule({
    name: "每週提醒", enabled: true,
    messageTemplate: [{type: "text", text: "請集合"}],
    startDate: "2026-08-14", endDate: "", time: "20:30",
    recurrence: {type: "every_n_weeks", weekInterval: 2, weekdays: [2, 5]},
  }, {id: "s_test1234", uid: "UID_A", now: new Date("2026-08-14T00:00:00.000Z")});
  assert.deepEqual(created.messageTemplate, [{type: "text", text: "請集合"}]);
  assert.equal(created.timezone, "Asia/Taipei");
  assert.deepEqual(created.recurrence,
    {type: "every_n_weeks", weekInterval: 2, weekdays: [2, 5]});
});

function validScheduleInput(recurrence) {
  return {
    name: "循環測試", enabled: true,
    messageTemplate: [{type: "text", text: "請集合"}],
    startDate: "2026-08-10", endDate: null, time: "20:30", recurrence,
  };
}

test("weekInterval boundaries 1 and 52 are valid", () => {
  for (const weekInterval of [1, 52]) {
    const value = validateLineSchedule(validScheduleInput({
      type: "every_n_weeks", weekInterval, weekdays: [1],
    }), {id: "s_test1234", uid: "UID_A", now: new Date("2026-08-01T00:00:00.000Z")});
    assert.equal(value.recurrence.weekInterval, weekInterval);
  }
});

test("weekInterval rejects zero, negative, decimal, over 52, missing, and strings", () => {
  for (const weekInterval of [0, -1, 1.5, 53, undefined, "2", "garbage"]) {
    assert.throws(() => validateLineSchedule(validScheduleInput({
      type: "every_n_weeks", weekInterval, weekdays: [1],
    }), {id: "s_test1234"}), /1～52 的整數/u);
  }
});

test("every-n-weeks rejects an empty weekday selection", () => {
  assert.throws(() => validateLineSchedule(validScheduleInput({
    type: "every_n_weeks", weekInterval: 2, weekdays: [],
  }), {id: "s_test1234"}), /至少要選/u);
});

test("every-n-weeks rejects invalid weekday numbers and string values", () => {
  for (const weekdays of [[0], [8], [1.5], ["2"], "2"]) {
    assert.throws(() => validateLineSchedule(validScheduleInput({
      type: "every_n_weeks", weekInterval: 2, weekdays,
    }), {id: "s_test1234"}), /有效星期/u);
  }
});

test("valid weekdays are sorted and de-duplicated", () => {
  const value = validateLineSchedule(validScheduleInput({
    type: "every_n_weeks", weekInterval: 2, weekdays: [5, 2, 5],
  }), {id: "s_test1234", now: new Date("2026-08-01T00:00:00.000Z")});
  assert.deepEqual(value.recurrence.weekdays, [2, 5]);
});

test("daily ignores irrelevant week interval and weekdays", () => {
  const value = validateLineSchedule(validScheduleInput({
    type: "daily", weekInterval: "garbage", weekdays: [99],
  }), {id: "s_test1234", now: new Date("2026-08-01T00:00:00.000Z")});
  assert.equal(value.recurrence.type, "daily");
  assert.equal(Object.hasOwn(value.recurrence, "weekdays"), false);
  assert.equal(Object.hasOwn(value.recurrence, "weekInterval"), false);
});

test("legacy weekly normalizes to every one week without changing weekdays", () => {
  const normalized = normalizeLineScheduleRecurrence(schedule({
    recurrence: {type: "weekly", weekdays: [2, 5]},
  }));
  assert.deepEqual(normalized.recurrence,
    {type: "every_n_weeks", weekInterval: 1, weekdays: [2, 5]});
  assert.equal(normalized.legacyRecurrenceType, "weekly");
});

test("legacy biweekly normalizes to every two weeks without changing weekdays", () => {
  const normalized = normalizeLineScheduleRecurrence(schedule({
    recurrence: {type: "biweekly", weekdays: [2, 5]},
  }));
  assert.deepEqual(normalized.recurrence,
    {type: "every_n_weeks", weekInterval: 2, weekdays: [2, 5]});
  assert.equal(normalized.legacyRecurrenceType, "biweekly");
});

test("legacy monthly is never converted into a four-week recurrence", () => {
  const normalized = normalizeLineScheduleRecurrence(schedule({
    recurrence: {type: "monthly", dayOfMonth: 31},
  }));
  assert.equal(normalized.recurrence.type, "monthly");
  assert.equal(normalized.recurrence.weekInterval, undefined);
  assert.equal(normalized.legacyRecurrenceNeedsReview, true);
});

test("new validation rejects legacy weekly, biweekly, and monthly writes", () => {
  for (const type of ["weekly", "biweekly", "monthly"]) {
    assert.throws(() => validateLineSchedule(validScheduleInput({
      type, weekdays: [2], dayOfMonth: 15,
    }), {id: "s_test1234"}), /循環類型不支援/u);
  }
});

test("backend nextRunAt is calculated for every one through four weeks", () => {
  const expected = ["2026-08-18", "2026-08-25", "2026-09-01", "2026-09-08"];
  for (const weekInterval of [1, 2, 3, 4]) {
    const value = schedule({
      startDate: "2026-08-10",
      recurrence: {type: "every_n_weeks", weekInterval, weekdays: [2]},
    });
    const next = findNextOccurrence(value, {
      after: new Date("2026-08-14T13:00:00.000Z"), inclusive: true,
    });
    assert.equal(next.occurrenceDate, expected[weekInterval - 1]);
  }
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
