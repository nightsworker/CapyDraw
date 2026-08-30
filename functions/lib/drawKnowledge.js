"use strict";

const {normalizeLineMember} = require("./line");

const DRAW_QUERY_PATTERN = /(船長|守護天使|第四船艙|抽籤(?:結果)?|抽了誰|抽誰)/u;
const LATEST_DRAW_PATTERN = /(最近(?:一次|一筆)?|最新(?:一次|一筆)?|上一次)\s*(?:的)?抽籤/u;
const SANITIZED_RECORDS = new WeakSet();

function historyValues(rawHistory) {
  if (Array.isArray(rawHistory)) return rawHistory;
  return Object.values(rawHistory && typeof rawHistory === "object" ? rawHistory : {});
}

function validDateKey(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day) return null;
  return [year, month, day]
    .map((value, index) => index ? String(value).padStart(2, "0") : String(value))
    .join("-");
}

function taipeiDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function addDays(dateKey, days) {
  const match = String(dateKey || "").match(/^(\d{4})-(\d{2})-(\d{2})$/u);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function resolveRequestedDrawDate(text, now = new Date()) {
  const input = String(text || "").normalize("NFKC");
  const fullDate = input.match(/(?:^|\D)(\d{4})-(\d{1,2})-(\d{1,2})(?:\D|$)/u);
  if (fullDate) {
    return validDateKey(Number(fullDate[1]), Number(fullDate[2]), Number(fullDate[3]));
  }
  const shortDate = input.match(/(?:^|\D)(\d{1,2})\/(\d{1,2})(?:\D|$)/u);
  if (shortDate) {
    const year = Number(taipeiDateKey(now).slice(0, 4));
    return validDateKey(year, Number(shortDate[1]), Number(shortDate[2]));
  }
  const today = taipeiDateKey(now);
  if (/(明天|明日)/u.test(input)) return addDays(today, 1);
  if (/(昨天|昨日)/u.test(input)) return addDays(today, -1);
  return today;
}

function planPublishedDrawQuery(text, now = new Date()) {
  const input = String(text || "").trim();
  if (!DRAW_QUERY_PATTERN.test(input)) return {shouldRetrieve: false, reason: "not-draw-query"};
  if (LATEST_DRAW_PATTERN.test(input)) {
    return {shouldRetrieve: true, mode: "latest", date: null};
  }
  const date = resolveRequestedDrawDate(input, now);
  return date ? {shouldRetrieve: true, mode: "date", date} :
    {shouldRetrieve: false, reason: "invalid-date"};
}

function isDrawPublishedToLine(record) {
  if (!record || typeof record !== "object") return false;
  const sentAt = String(record.lineSentAt || "").trim();
  const sendCount = Number(record.lineSendCount);
  return Boolean(sentAt && Number.isFinite(Date.parse(sentAt)) &&
    Number.isFinite(sendCount) && sendCount > 0);
}

function safeMemberName(value) {
  const parsed = normalizeLineMember(value);
  return String(parsed.fullName || "").replace(/\s+/gu, " ").trim().slice(0, 200);
}

function sanitizePublishedDrawRecord(record) {
  if (!isDrawPublishedToLine(record)) return null;
  const dateMatch = String(record.date || "").match(/^(\d{4})-(\d{2})-(\d{2})$/u);
  const date = dateMatch && validDateKey(
    Number(dateMatch[1]), Number(dateMatch[2]), Number(dateMatch[3]),
  );
  if (!date) return null;
  const identity = record.memberIdentity && typeof record.memberIdentity === "object" ?
    record.memberIdentity : {};
  const captain = safeMemberName(identity.captain || record.captain);
  const guardian = safeMemberName(identity.guardian || record.guardian);
  const cabinSource = identity.cabin4 || record.cabin4;
  const cabin4 = (Array.isArray(cabinSource) ? cabinSource : Object.values(cabinSource || {}))
    .map(safeMemberName)
    .filter(Boolean);
  if (!captain || !guardian) return null;
  const sanitized = Object.freeze({
    date,
    specialDay: record.specialDay === true,
    captain,
    guardian,
    cabin4: Object.freeze(cabin4),
  });
  SANITIZED_RECORDS.add(sanitized);
  return sanitized;
}

function listPublishedDrawRecords(rawHistory) {
  return historyValues(rawHistory).map(sanitizePublishedDrawRecord).filter(Boolean);
}

function findPublishedDrawByDate(rawHistory, date) {
  const targetDate = String(date || "");
  return listPublishedDrawRecords(rawHistory).find((record) => record.date === targetDate) || null;
}

function findLatestPublishedDraw(rawHistory) {
  return listPublishedDrawRecords(rawHistory)
    .sort((left, right) => right.date.localeCompare(left.date))[0] || null;
}

function buildPublishedDrawContext(record, {date = null, mode = "date"} = {}) {
  const safeRecord = SANITIZED_RECORDS.has(record) ? record : sanitizePublishedDrawRecord(record);
  const header = "[PUBLISHED DRAW DATA — AUTHORITATIVE]";
  if (!safeRecord) {
    const target = mode === "latest" ? "目前" : `${date || "指定日期"} `;
    return [
      header,
      "",
      `${target}沒有可公開的抽籤結果。`,
      "不得推測未發布、hidden 或 draft result，也不得透露它們是否存在。",
      "不得依過去輪替、池子或歷史規律預測下一次抽籤。",
    ].join("\n");
  }
  return [
    header,
    "",
    `日期：${safeRecord.date}`,
    `類型：${safeRecord.specialDay ? "特別日" : "一般日"}`,
    `船長：${safeRecord.captain}`,
    `守護天使：${safeRecord.guardian}`,
    "第四船艙：",
    ...(safeRecord.cabin4.length ? safeRecord.cabin4.map((name) => `- ${name}`) : ["- 無公開名單"]),
    "",
    "以上資料已正式發布到 LINE，可以回答。",
    "此資料優先於一般 Canon；名字、日期與角色不得修改或自行補充。",
    "不得依此資料推測其他未發布的抽籤結果。",
  ].join("\n");
}

function resolvePublishedDrawKnowledge(rawHistory, queryPlan) {
  const plan = queryPlan && queryPlan.shouldRetrieve ? queryPlan : null;
  if (!plan) return {record: null, context: ""};
  const record = plan.mode === "latest" ? findLatestPublishedDraw(rawHistory) :
    findPublishedDrawByDate(rawHistory, plan.date);
  return {record, context: buildPublishedDrawContext(record, plan)};
}

async function loadPublishedDrawKnowledge(historyRef, queryPlan) {
  const plan = queryPlan && queryPlan.shouldRetrieve ? queryPlan : null;
  if (!plan) return {record: null, context: ""};
  const historySnapshot = await historyRef.get();
  return resolvePublishedDrawKnowledge(historySnapshot.val(), plan);
}

module.exports = {
  buildPublishedDrawContext,
  findLatestPublishedDraw,
  findPublishedDrawByDate,
  isDrawPublishedToLine,
  listPublishedDrawRecords,
  loadPublishedDrawKnowledge,
  planPublishedDrawQuery,
  resolvePublishedDrawKnowledge,
  resolveRequestedDrawDate,
  sanitizePublishedDrawRecord,
  taipeiDateKey,
};
