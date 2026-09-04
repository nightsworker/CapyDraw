"use strict";

const crypto = require("node:crypto");

const SCHEDULE_TIMEZONE = "Asia/Taipei";
const SCHEDULE_TYPES = Object.freeze(["daily", "every_n_weeks"]);
const FIXED_RETRY_LIMIT = 3;
const RUN_HISTORY_LIMIT = 20;
const RUN_LEASE_MS = 2 * 60 * 1000;
const TOMORROW_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const MAX_TEMPLATE_TOKENS = 100;
const MAX_TEMPLATE_TEXT_CHARS = 4000;
const MAX_DATE_OFFSET_DAYS = 3660;

function scheduleError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function parseDateKey(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/u);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day) return null;
  return {year, month, day};
}

function dateKey(parts) {
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

function addCalendarDays(value, offsetDays) {
  const parts = typeof value === "string" ? parseDateKey(value) : value;
  if (!parts) return null;
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + Number(offsetDays || 0)));
  return dateKey({year: date.getUTCFullYear(), month: date.getUTCMonth() + 1,
    day: date.getUTCDate()});
}

function taipeiDateKey(value = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: SCHEDULE_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function normalizeTime(value) {
  const match = String(value || "").match(/^([01]\d|2[0-3]):([0-5]\d)$/u);
  return match ? `${match[1]}:${match[2]}` : null;
}

function occurrenceTimestamp(date, time) {
  if (!parseDateKey(date) || !normalizeTime(time)) return null;
  return Date.parse(`${date}T${time}:00+08:00`);
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function weekdayForDate(date) {
  const parts = parseDateKey(date);
  if (!parts) return null;
  const day = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
  return day === 0 ? 7 : day;
}

function mondayForDate(date) {
  const weekday = weekdayForDate(date);
  return weekday ? addCalendarDays(date, 1 - weekday) : null;
}

function calendarDayDifference(left, right) {
  const a = parseDateKey(left);
  const b = parseDateKey(right);
  if (!a || !b) return null;
  const civilDayNumber = ({year, month, day}) => {
    const adjustedYear = year - (month <= 2 ? 1 : 0);
    const era = Math.floor(adjustedYear / 400);
    const yearOfEra = adjustedYear - era * 400;
    const shiftedMonth = month + (month > 2 ? -3 : 9);
    const dayOfYear = Math.floor((153 * shiftedMonth + 2) / 5) + day - 1;
    const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) -
      Math.floor(yearOfEra / 100) + dayOfYear;
    return era * 146097 + dayOfEra;
  };
  return civilDayNumber(a) - civilDayNumber(b);
}

function normalizeWeekdays(value) {
  return [...new Set((Array.isArray(value) ? value : []).map(Number)
    .filter((day) => Number.isInteger(day) && day >= 1 && day <= 7))]
    .sort((a, b) => a - b);
}

function normalizeLineScheduleRecurrence(schedule) {
  if (!schedule || typeof schedule !== "object") return schedule;
  const recurrence = schedule.recurrence && typeof schedule.recurrence === "object" ?
    schedule.recurrence : {};
  if (recurrence.type === "weekly" || recurrence.type === "biweekly") {
    return {
      ...schedule,
      recurrence: {
        type: "every_n_weeks",
        weekInterval: recurrence.type === "weekly" ? 1 : 2,
        weekdays: normalizeWeekdays(recurrence.weekdays),
      },
      legacyRecurrenceType: recurrence.type,
    };
  }
  if (recurrence.type === "monthly") {
    return {...schedule, legacyRecurrenceType: "monthly", legacyRecurrenceNeedsReview: true};
  }
  return {...schedule};
}

function recurrenceMatchesDate(schedule, occurrenceDate) {
  schedule = normalizeLineScheduleRecurrence(schedule);
  const date = parseDateKey(occurrenceDate);
  if (!date || !schedule || schedule.enabled === false) return false;
  if (occurrenceDate < schedule.startDate ||
      (schedule.endDate && occurrenceDate > schedule.endDate)) return false;
  const recurrence = schedule.recurrence || {};
  if (recurrence.type === "daily") return true;
  if (recurrence.type === "every_n_weeks") {
    const difference = calendarDayDifference(
      mondayForDate(occurrenceDate), mondayForDate(schedule.startDate));
    const calendarWeekDifference = difference === null ? null : difference / 7;
    return Number.isInteger(calendarWeekDifference) && calendarWeekDifference >= 0 &&
      calendarWeekDifference % recurrence.weekInterval === 0 &&
      normalizeWeekdays(recurrence.weekdays).includes(weekdayForDate(occurrenceDate));
  }
  if (recurrence.type === "weekly") {
    return normalizeWeekdays(recurrence.weekdays).includes(weekdayForDate(occurrenceDate));
  }
  if (recurrence.type === "biweekly") {
    const difference = calendarDayDifference(
      mondayForDate(occurrenceDate), mondayForDate(schedule.startDate));
    return difference >= 0 && Math.floor(difference / 7) % 2 === 0 &&
      normalizeWeekdays(recurrence.weekdays).includes(weekdayForDate(occurrenceDate));
  }
  if (recurrence.type === "monthly") {
    const requested = Math.max(1, Math.min(31, Number(recurrence.dayOfMonth) || 1));
    return date.day === Math.min(requested, daysInMonth(date.year, date.month));
  }
  return false;
}

function fixedRunKey(scheduleId, date) {
  const safeId = String(scheduleId || "schedule")
    .replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, 80);
  return `${safeId}_${date}`;
}

function tomorrowRunKey(date) {
  return `tomorrow_${date}`;
}

const OCCURRENCE_TERMINAL_STATUSES = new Set([
  "sent", "sent-via-reply", "queued-for-reply", "failed", "expired", "expired-no-draw",
  "ambiguous-draw-records", "skipped-already-published",
]);

function existingRunPriority(run) {
  if (OCCURRENCE_TERMINAL_STATUSES.has(run && run.status)) return 2;
  return run && run.status ? 1 : 0;
}

function existingRunTime(run) {
  for (const value of [run && run.updatedAt, run && run.sentAt, run && run.scheduledFor]) {
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return 0;
}

function runMatchesOccurrenceDate(run, occurrenceDate) {
  if (!run || typeof run !== "object") return false;
  if (run.occurrenceDate === occurrenceDate) return true;
  const scheduledTimestamp = Date.parse(run.scheduledFor);
  return Number.isFinite(scheduledTimestamp) &&
    taipeiDateKey(new Date(scheduledTimestamp)) === occurrenceDate;
}

function reuseExistingOccurrenceRun(occurrence, runs) {
  if (!occurrence || !occurrence.occurrenceDate) return occurrence;
  const candidates = Object.entries(runs && typeof runs === "object" ? runs : {})
    .filter(([, run]) => runMatchesOccurrenceDate(run, occurrence.occurrenceDate))
    .sort((left, right) => existingRunPriority(right[1]) - existingRunPriority(left[1]) ||
      existingRunTime(right[1]) - existingRunTime(left[1]) ||
      String(left[0]).localeCompare(String(right[0])));
  return candidates.length ? {...occurrence, runKey: candidates[0][0]} : occurrence;
}

function findNextOccurrence(schedule, {after = new Date(), inclusive = false} = {}) {
  schedule = normalizeLineScheduleRecurrence(schedule);
  const afterMs = after instanceof Date ? after.getTime() : Number(after);
  if (!Number.isFinite(afterMs) || !schedule || schedule.enabled === false) return null;
  let candidate = taipeiDateKey(new Date(afterMs));
  if (schedule.startDate && candidate < schedule.startDate) candidate = schedule.startDate;
  for (let count = 0; count < 3700; count += 1) {
    if (schedule.endDate && candidate > schedule.endDate) return null;
    if (recurrenceMatchesDate(schedule, candidate)) {
      const timestamp = occurrenceTimestamp(candidate, schedule.time);
      if (timestamp !== null && (inclusive ? timestamp >= afterMs : timestamp > afterMs)) {
        return {
          occurrenceDate: candidate,
          scheduledFor: new Date(timestamp).toISOString(),
          timestamp,
          runKey: fixedRunKey(schedule.id, candidate, schedule.time),
        };
      }
    }
    candidate = addCalendarDays(candidate, 1);
  }
  return null;
}

function stableRetryKey(value) {
  const bytes = crypto.createHash("sha256").update(String(value || ""), "utf8")
    .digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
    `${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function normalizeTemplateTokens(value) {
  if (!Array.isArray(value) || !value.length || value.length > MAX_TEMPLATE_TOKENS) {
    throw scheduleError("核心訊息必須包含 1～100 個內容區塊。");
  }
  let textCharacters = 0;
  const tokens = value.map((token) => {
    if (!token || typeof token !== "object") throw scheduleError("核心訊息格式不正確。");
    if (token.type === "text") {
      const text = String(token.text || "").replaceAll("\r\n", "\n").replaceAll("\r", "\n");
      if (!text) throw scheduleError("文字區塊不可為空。");
      textCharacters += text.length;
      return {type: "text", text};
    }
    if (token.type === "member") {
      const bindingId = String(token.bindingId || "").trim();
      const display = String(token.display || "@成員").trim().slice(0, 100);
      if (!/^[A-Za-z0-9_-]{1,200}$/u.test(bindingId)) {
        throw scheduleError("成員 bindingId 格式不正確。");
      }
      return {type: "member", bindingId, display};
    }
    if (token.type === "all") return {type: "all", display: "@ALL"};
    if (token.type === "date") {
      const offsetDays = Number(token.offsetDays);
      const format = String(token.format || "M/D");
      if (!Number.isInteger(offsetDays) || Math.abs(offsetDays) > MAX_DATE_OFFSET_DAYS) {
        throw scheduleError(`日期 offset 必須是 ±${MAX_DATE_OFFSET_DAYS} 以內的整數。`);
      }
      if (!["M/D", "YYYY/MM/DD"].includes(format)) throw scheduleError("日期格式不支援。");
      return {type: "date", offsetDays, format};
    }
    throw scheduleError("核心訊息包含不支援的 token。");
  });
  if (textCharacters > MAX_TEMPLATE_TEXT_CHARS) throw scheduleError("核心訊息文字過長。");
  return tokens;
}

function validateLineSchedule(input, {id, uid, now = new Date(), existing = null} = {}) {
  const source = input && typeof input === "object" ? input : {};
  const name = String(source.name || "").trim().slice(0, 80);
  const startDate = String(source.startDate || "");
  const endDate = String(source.endDate || "").trim() || null;
  const time = normalizeTime(source.time);
  const type = String(source.recurrence && source.recurrence.type || "");
  if (!name) throw scheduleError("請輸入排程名稱。");
  if (!parseDateKey(startDate) || (endDate && !parseDateKey(endDate))) {
    throw scheduleError("日期格式不正確。");
  }
  if (endDate && endDate < startDate) throw scheduleError("結束日期不可早於開始日期。");
  if (!time) throw scheduleError("時間必須是 HH:mm。");
  if (!SCHEDULE_TYPES.includes(type)) throw scheduleError("循環類型不支援。");
  const weekdays = normalizeWeekdays(source.recurrence && source.recurrence.weekdays);
  const rawWeekdays = source.recurrence && source.recurrence.weekdays;
  const weekInterval = source.recurrence && source.recurrence.weekInterval;
  if (type === "every_n_weeks" &&
      (!Number.isInteger(weekInterval) || weekInterval < 1 || weekInterval > 52)) {
    throw scheduleError("週期必須是 1～52 的整數。");
  }
  if (type === "every_n_weeks" &&
      (!Array.isArray(rawWeekdays) || !rawWeekdays.length ||
       rawWeekdays.some((day) => !Number.isInteger(day) || day < 1 || day > 7))) {
    throw scheduleError("每 X 週排程至少要選一個有效星期。");
  }
  if (["weekly", "biweekly"].includes(type) && !weekdays.length) {
    throw scheduleError("每週／雙週排程至少要選一個星期。");
  }
  const dayOfMonth = type === "monthly" ?
    Number(source.recurrence && source.recurrence.dayOfMonth) : null;
  if (type === "monthly" &&
      (!Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 31)) {
    throw scheduleError("每月日期必須是 1～31。");
  }
  const nowIso = now.toISOString();
  const schedule = {
    id: String(id || source.id || "").trim(),
    name,
    enabled: source.enabled !== false,
    messageTemplate: normalizeTemplateTokens(source.messageTemplate),
    startDate,
    endDate,
    recurrence: {
      type,
      ...(type === "every_n_weeks" ? {weekInterval, weekdays} : {}),
      ...(["weekly", "biweekly"].includes(type) ? {weekdays} : {}),
      ...(type === "monthly" ? {dayOfMonth} : {}),
    },
    time,
    timezone: SCHEDULE_TIMEZONE,
    createdAt: existing && existing.createdAt || nowIso,
    updatedAt: nowIso,
    createdByUid: existing && existing.createdByUid || String(uid || ""),
    lastRunAt: existing && existing.lastRunAt || null,
    lastRunStatus: existing && existing.lastRunStatus || null,
    nextRunAt: null,
  };
  if (!schedule.id) throw scheduleError("排程 ID 不正確。");
  const next = findNextOccurrence(schedule, {after: now, inclusive: true});
  schedule.nextRunAt = next && next.scheduledFor || null;
  return schedule;
}

function validateTomorrowAutomation(input, {uid, now = new Date(), existing = null} = {}) {
  const source = input && typeof input === "object" ? input : {};
  const time = normalizeTime(source.time);
  if (!time) throw scheduleError("明日抽籤發布時間必須是 HH:mm。");
  return {
    enabled: source.enabled === true,
    time,
    timezone: SCHEDULE_TIMEZONE,
    updatedAt: now.toISOString(),
    updatedByUid: String(uid || ""),
    lastRunAt: existing && existing.lastRunAt || null,
    lastRunStatus: existing && existing.lastRunStatus || null,
  };
}

function formatDateToken(occurrenceDate, offsetDays, format) {
  const parts = parseDateKey(addCalendarDays(occurrenceDate, offsetDays));
  if (!parts) throw scheduleError("排程日期格式不正確。");
  return format === "YYYY/MM/DD" ?
    `${parts.year}/${pad2(parts.month)}/${pad2(parts.day)}` : `${parts.month}/${parts.day}`;
}

function escapeTextV2Literal(value) {
  return String(value || "").replaceAll("{", "{{").replaceAll("}", "}}");
}

function renderScheduleCore(tokens, {occurrenceDate, bindings, defaultGroupId} = {}) {
  const substitutions = {};
  const warnings = [];
  let mentionIndex = 0;
  let plainText = "";
  let text = "";
  normalizeTemplateTokens(tokens).forEach((token) => {
    if (token.type === "text") {
      plainText += token.text;
      text += escapeTextV2Literal(token.text);
      return;
    }
    if (token.type === "date") {
      const formatted = formatDateToken(occurrenceDate, token.offsetDays, token.format);
      plainText += formatted;
      text += formatted;
      return;
    }
    if (token.type === "all") {
      const key = `mention${mentionIndex++}`;
      plainText += "@ALL";
      text += `{${key}}`;
      substitutions[key] = {type: "mention", mentionee: {type: "all"}};
      return;
    }
    const record = bindings && bindings[token.bindingId];
    if (record && record.lineUserId && record.lineGroupId === defaultGroupId) {
      const key = `mention${mentionIndex++}`;
      plainText += token.display;
      text += `{${key}}`;
      substitutions[key] = {
        type: "mention",
        mentionee: {type: "user", userId: record.lineUserId},
      };
    } else {
      const fallback = token.display || "@成員";
      plainText += fallback;
      text += escapeTextV2Literal(fallback);
      warnings.push(`missing-binding:${token.bindingId}`);
    }
  });
  if (!plainText.trim()) throw scheduleError("核心訊息不可為空。");
  if (plainText.length > 4500) throw scheduleError("解析後的核心訊息過長。");
  return {text, plainText, substitutions, warnings};
}

function buildScheduledLineMessage(core, {intro = "", outro = ""} = {}) {
  const pieces = [];
  if (String(intro || "").trim()) pieces.push(escapeTextV2Literal(String(intro).trim()));
  pieces.push(core.text);
  if (String(outro || "").trim()) pieces.push(escapeTextV2Literal(String(outro).trim()));
  const message = {type: "textV2", text: pieces.join("\n")};
  if (Object.keys(core.substitutions || {}).length) message.substitution = core.substitutions;
  return message;
}

function occurrenceDayExpired(scheduledFor, now = new Date()) {
  return taipeiDateKey(now) > taipeiDateKey(new Date(scheduledFor));
}

function latestTomorrowOccurrence(settings, now = new Date()) {
  if (!settings || settings.enabled !== true || !normalizeTime(settings.time)) return null;
  const date = taipeiDateKey(now);
  const timestamp = occurrenceTimestamp(date, settings.time);
  if (now.getTime() < timestamp) return null;
  return {
    occurrenceDate: date,
    targetDrawDate: addCalendarDays(date, 1),
    scheduledFor: new Date(timestamp).toISOString(),
    runKey: tomorrowRunKey(date, settings.time),
  };
}

function pruneRunHistory(value, limit = RUN_HISTORY_LIMIT) {
  return Object.fromEntries(Object.entries(value && typeof value === "object" ? value : {})
    .sort((a, b) => String(b[1] && b[1].scheduledFor || "")
      .localeCompare(String(a[1] && a[1].scheduledFor || "")))
    .slice(0, limit));
}

module.exports = {
  FIXED_RETRY_LIMIT,
  MAX_DATE_OFFSET_DAYS,
  RUN_HISTORY_LIMIT,
  RUN_LEASE_MS,
  SCHEDULE_TIMEZONE,
  SCHEDULE_TYPES,
  TOMORROW_CHECK_INTERVAL_MS,
  addCalendarDays,
  buildScheduledLineMessage,
  calendarDayDifference,
  dateKey,
  daysInMonth,
  findNextOccurrence,
  fixedRunKey,
  formatDateToken,
  latestTomorrowOccurrence,
  mondayForDate,
  normalizeLineScheduleRecurrence,
  normalizeTemplateTokens,
  normalizeTime,
  occurrenceDayExpired,
  occurrenceTimestamp,
  parseDateKey,
  pruneRunHistory,
  recurrenceMatchesDate,
  renderScheduleCore,
  reuseExistingOccurrenceRun,
  stableRetryKey,
  taipeiDateKey,
  tomorrowRunKey,
  validateLineSchedule,
  validateTomorrowAutomation,
  weekdayForDate,
};
