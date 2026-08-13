"use strict";

const {
  isDrawPublishedToLine,
} = require("./drawKnowledge");

const FUTURE_CLOCK_TOLERANCE_MS = 5 * 60 * 1000;
const ISO_DATETIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/u;
const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;

function isValidDateParts(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
}

function validateBackfillRecordId(value) {
  const recordId = typeof value === "string" ? value.trim() : "";
  return recordId && recordId.length <= 200 ? recordId : null;
}

function normalizePublishedAt(value, {
  now = new Date(),
  toleranceMs = FUTURE_CLOCK_TOLERANCE_MS,
} = {}) {
  if (value === undefined) {
    return {ok: true, publishedAt: now.toISOString()};
  }
  if (typeof value !== "string") return {ok: false, reason: "invalid-published-at"};
  const publishedAt = value.trim();
  const match = publishedAt.match(ISO_DATETIME_PATTERN);
  if (!match) return {ok: false, reason: "invalid-published-at"};
  const [, year, month, day, hour, minute, second, , zone] = match;
  const validCalendar = isValidDateParts(Number(year), Number(month), Number(day));
  const validTime = Number(hour) <= 23 && Number(minute) <= 59 && Number(second) <= 59;
  const zoneParts = zone === "Z" ? null : zone.slice(1).split(":").map(Number);
  const validZone = !zoneParts || (zoneParts[0] <= 14 && zoneParts[1] <= 59 &&
    (zoneParts[0] < 14 || zoneParts[1] === 0));
  const timestamp = Date.parse(publishedAt);
  if (!validCalendar || !validTime || !validZone || !Number.isFinite(timestamp)) {
    return {ok: false, reason: "invalid-published-at"};
  }
  if (timestamp > now.getTime() + toleranceMs) {
    return {ok: false, reason: "future-published-at"};
  }
  return {ok: true, publishedAt};
}

function findHistoryEntry(rawHistory, recordId) {
  if (Array.isArray(rawHistory)) {
    const key = rawHistory.findIndex((record) => record && record.id === recordId);
    return key === -1 ? null : {key, record: rawHistory[key]};
  }
  if (!rawHistory || typeof rawHistory !== "object") return null;
  const key = Object.keys(rawHistory)
    .find((entryKey) => rawHistory[entryKey] && rawHistory[entryKey].id === recordId);
  return key === undefined ? null : {key, record: rawHistory[key]};
}

function validateRecordDate(record) {
  const match = String(record && record.date || "").match(DATE_KEY_PATTERN);
  if (!match || !isValidDateParts(Number(match[1]), Number(match[2]), Number(match[3]))) {
    return {ok: false, reason: "invalid-record-date"};
  }
  return {ok: true, recordDate: record.date};
}

function planDrawPublicationRecordBackfill(record, {
  recordId,
  publishedAt,
} = {}) {
  if (!record || record.id !== recordId) return {status: "not-found"};
  if (isDrawPublishedToLine(record)) {
    return {
      status: "already-published",
      recordDate: record.date,
      publishedAt: record.lineSentAt,
      alreadyPublished: true,
    };
  }
  const dateValidation = validateRecordDate(record);
  if (!dateValidation.ok) {
    return {status: dateValidation.reason, recordDate: record.date || null};
  }
  return {
    status: "updated",
    nextRecord: {
      ...record,
      lineSentAt: publishedAt,
      lineSendCount: Math.max(Number(record.lineSendCount) || 0, 1),
      lastLineSendStatus: "sent",
    },
    recordDate: dateValidation.recordDate,
    publishedAt,
    alreadyPublished: false,
  };
}

function planDrawPublicationBackfill(rawHistory, {recordId, publishedAt} = {}) {
  const found = findHistoryEntry(rawHistory, recordId);
  if (!found) return {status: "not-found"};
  const recordPlan = planDrawPublicationRecordBackfill(found.record, {
    recordId,
    publishedAt,
  });
  if (recordPlan.status !== "updated") return recordPlan;

  const nextHistory = Array.isArray(rawHistory) ? [...rawHistory] : {...rawHistory};
  nextHistory[found.key] = recordPlan.nextRecord;
  return {
    ...recordPlan,
    nextHistory,
  };
}

function observeCurrentValue(ref) {
  let valueHandler;
  return new Promise((resolve, reject) => {
    valueHandler = (snapshot) => resolve({
      snapshot,
      release: () => ref.off("value", valueHandler),
    });
    const cancelHandler = (error) => {
      ref.off("value", valueHandler);
      reject(error);
    };
    ref.on("value", valueHandler, cancelHandler);
  });
}

async function backfillDrawLinePublication(historyRef, options) {
  const historySnapshot = await historyRef.get();
  const found = findHistoryEntry(historySnapshot.val(), options.recordId);
  if (!found) return {status: "not-found"};

  const recordRef = historyRef.child(String(found.key));
  const observed = await observeCurrentValue(recordRef);
  let outcome = {status: "not-found"};
  try {
    outcome = planDrawPublicationRecordBackfill(observed.snapshot.val(), options);
    if (outcome.status === "updated") {
      await recordRef.transaction((currentRecord) => {
        outcome = planDrawPublicationRecordBackfill(currentRecord, options);
        return outcome.status === "updated" ? outcome.nextRecord : undefined;
      });
    }
  } finally {
    observed.release();
  }
  return Object.fromEntries(Object.entries(outcome)
    .filter(([key]) => key !== "nextRecord"));
}

module.exports = {
  FUTURE_CLOCK_TOLERANCE_MS,
  backfillDrawLinePublication,
  findHistoryEntry,
  normalizePublishedAt,
  planDrawPublicationBackfill,
  planDrawPublicationRecordBackfill,
  validateBackfillRecordId,
};
