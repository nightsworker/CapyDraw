"use strict";

const MAX_LINE_ERROR_LENGTH = 500;
const MAX_LINE_ERROR_DETAILS = 10;
const MAX_PENDING_IDS = 5;

function safeText(value, maxLength = MAX_LINE_ERROR_LENGTH) {
  return typeof value === "string" ? value.slice(0, maxLength) : null;
}

function safeLineEndpoint(path) {
  if (path === "/message/reply") return "reply";
  if (path === "/message/push") return "push";
  return "other";
}

function safeLineErrorDetails(details) {
  if (!Array.isArray(details)) return [];
  return details.slice(0, MAX_LINE_ERROR_DETAILS).map((detail) => ({
    message: safeText(detail && detail.message),
    property: safeText(detail && detail.property, 200),
  }));
}

function safePendingIds(pendingIds) {
  return (Array.isArray(pendingIds) ? pendingIds : [])
    .map((id) => String(id || ""))
    .filter((id) => /^[A-Za-z0-9_-]{1,100}$/u.test(id))
    .slice(0, MAX_PENDING_IDS);
}

function buildLineErrorLog({path, status, errorBody, messageCount, elapsedMs,
  pendingIds} = {}) {
  const body = errorBody && typeof errorBody === "object" ? errorBody : {};
  return {
    endpoint: safeLineEndpoint(path),
    status: Number.isFinite(Number(status)) ? Number(status) : null,
    lineErrorMessage: safeText(body.message),
    details: safeLineErrorDetails(body.details),
    messageCount: Math.max(0, Math.min(5, Number(messageCount) || 0)),
    elapsedMs: Math.max(0, Number(elapsedMs) || 0),
    pendingIds: safePendingIds(pendingIds),
  };
}

module.exports = {
  buildLineErrorLog,
  safeLineEndpoint,
  safeLineErrorDetails,
  safePendingIds,
};
