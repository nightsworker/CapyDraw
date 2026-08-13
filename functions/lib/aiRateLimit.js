"use strict";

const crypto = require("node:crypto");

const AI_COOLDOWN_MS = 10_000;
const AI_MINUTE_WINDOW_MS = 60_000;
const AI_MINUTE_LIMIT = 5;
const AI_DAILY_LIMIT = 500;

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

function aiUserKey(userId) {
  const value = String(userId || "").trim();
  if (!value) return "";
  const digest = crypto.createHash("sha256").update(value, "utf8").digest("base64url").slice(0, 24);
  return `u_${digest}`;
}

function finiteTimestamp(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function buildAiUsageUpdate(current, {dateKey, userKey, now}) {
  const usage = current && typeof current === "object" ? current : {};
  const users = usage.users && typeof usage.users === "object" ? usage.users : {};
  const existingUser = users[userKey] && typeof users[userKey] === "object" ? users[userKey] : {};
  const lastRequestAt = finiteTimestamp(existingUser.lastRequestAt);
  const requestTimestamps = (Array.isArray(existingUser.requestTimestamps) ?
    existingUser.requestTimestamps : Object.values(existingUser.requestTimestamps || {}))
    .map(finiteTimestamp)
    .filter((timestamp) => timestamp > now - AI_MINUTE_WINDOW_MS && timestamp <= now)
    .sort((a, b) => a - b);

  if (lastRequestAt && now - lastRequestAt < AI_COOLDOWN_MS) {
    return {allowed: false, reason: "cooldown"};
  }
  if (requestTimestamps.length >= AI_MINUTE_LIMIT) {
    return {allowed: false, reason: "minute-limit"};
  }

  const daily = usage.daily && typeof usage.daily === "object" ? usage.daily : {};
  const dailyEntry = daily[dateKey] && typeof daily[dateKey] === "object" ? daily[dateKey] : {};
  const dailyCount = Math.max(0, Math.floor(Number(dailyEntry.count) || 0));
  if (dailyCount >= AI_DAILY_LIMIT) return {allowed: false, reason: "daily-limit"};

  const activeUsers = {};
  Object.entries(users).forEach(([key, value]) => {
    if (!value || typeof value !== "object") return;
    const last = finiteTimestamp(value.lastRequestAt);
    if (key === userKey || last > now - AI_MINUTE_WINDOW_MS) activeUsers[key] = value;
  });
  activeUsers[userKey] = {
    lastRequestAt: now,
    requestTimestamps: [...requestTimestamps, now],
  };

  return {
    allowed: true,
    reason: null,
    value: {
      daily: {[dateKey]: {count: dailyCount + 1, updatedAt: now}},
      users: activeUsers,
    },
  };
}

async function reserveAiUsage(usageRef, userId, date = new Date()) {
  const userKey = aiUserKey(userId);
  if (!usageRef || !userKey) return {allowed: false, reason: "invalid-user"};
  const now = date.getTime();
  const dateKey = taipeiDateKey(date);
  let decision = {allowed: false, reason: "rate-limit-error"};
  const transaction = await usageRef.transaction((current) => {
    decision = buildAiUsageUpdate(current, {dateKey, userKey, now});
    return decision.allowed ? decision.value : undefined;
  });
  return transaction.committed ? {allowed: true, reason: null, dateKey} : decision;
}

module.exports = {
  AI_COOLDOWN_MS,
  AI_DAILY_LIMIT,
  AI_MINUTE_LIMIT,
  AI_MINUTE_WINDOW_MS,
  aiUserKey,
  buildAiUsageUpdate,
  reserveAiUsage,
  taipeiDateKey,
};
