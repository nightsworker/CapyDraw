"use strict";

const crypto = require("node:crypto");

const PENDING_CLAIM_LEASE_MS = 60 * 1000;
const EVENT_HISTORY_LIMIT = 100;
const PENDING_STATUSES = new Set(["pending", "claimed"]);

function digestKey(prefix, value, length = 40) {
  const digest = crypto.createHash("sha256").update(String(value || ""), "utf8")
    .digest("base64url").slice(0, length);
  return `${prefix}_${digest}`;
}

function pendingGroupKey(groupId) {
  return digestKey("g", groupId);
}

function pendingAnnouncementId(type, occurrenceKey) {
  return digestKey("a", `${type}:${occurrenceKey}`);
}

function pendingEventKey(eventId) {
  return digestKey("e", eventId);
}

function pendingGroupRef(db, groupId) {
  return db.ref(`guildDraw/linePendingAnnouncements/${pendingGroupKey(groupId)}`);
}

function validLineMessage(message) {
  return Boolean(message && typeof message === "object" && typeof message.type === "string");
}

function buildPendingAnnouncement({
  id,
  type,
  scheduledFor,
  occurrenceDate,
  createdAt = new Date().toISOString(),
  expiresAt = null,
  drawRecordId = null,
  scheduleId = null,
  runKey = null,
  runPath = null,
  message,
  renderedCore = null,
  aiIntro = null,
  aiOutro = null,
  wrapperReason = null,
  warning = null,
} = {}) {
  if (!id || !["draw", "fixed"].includes(type) || !validLineMessage(message)) {
    throw new Error("Pending announcement is invalid.");
  }
  return {
    id,
    type,
    status: "pending",
    scheduledFor: String(scheduledFor || createdAt),
    occurrenceDate: String(occurrenceDate || ""),
    createdAt,
    expiresAt,
    drawRecordId,
    scheduleId,
    runKey,
    runPath,
    message,
    renderedCore,
    aiIntro,
    aiOutro,
    wrapperReason,
    warning,
    claim: null,
    sentAt: null,
    sentVia: null,
    error: null,
  };
}

async function enqueuePendingAnnouncement(groupRef, announcement) {
  const itemRef = groupRef.child(`items/${announcement.id}`);
  let created = false;
  const transaction = await itemRef.transaction((current) => {
    if (current && typeof current === "object") return;
    created = true;
    return announcement;
  });
  return {
    created: transaction.committed && created,
    announcement: transaction.snapshot.val() || announcement,
  };
}

function isClaimExpired(item, nowMs) {
  return item && item.status === "claimed" &&
    Number(item.claim && item.claim.leaseUntil) <= nowMs;
}

function eligiblePendingItems(items, now = new Date()) {
  const nowMs = now.getTime();
  return Object.values(items && typeof items === "object" ? items : {})
    .filter((item) => item && (item.status === "pending" || isClaimExpired(item, nowMs)))
    .filter((item) => !item.expiresAt || Date.parse(item.expiresAt) > nowMs)
    .filter((item) => validLineMessage(item.message))
    .sort((left, right) => String(left.scheduledFor || "").localeCompare(
      String(right.scheduledFor || "")) ||
      String(left.createdAt || "").localeCompare(String(right.createdAt || "")) ||
      String(left.id || "").localeCompare(String(right.id || "")));
}

function trimEventHistory(events, limit = EVENT_HISTORY_LIMIT) {
  return Object.fromEntries(Object.entries(events && typeof events === "object" ? events : {})
    .sort((left, right) => String(right[1] && right[1].updatedAt || "")
      .localeCompare(String(left[1] && left[1].updatedAt || "")))
    .slice(0, limit));
}

async function claimPendingBatch(groupRef, {
  eventId,
  maxItems,
  now = new Date(),
  leaseMs = PENDING_CLAIM_LEASE_MS,
} = {}) {
  const eventKey = pendingEventKey(eventId);
  const limit = Math.max(0, Math.min(5, Number(maxItems) || 0));
  if (!eventId || !limit) return {claimed: false, reason: "ineligible", eventKey, items: []};
  // A new Cloud Run instance has an empty RTDB client cache. Prime it from the
  // server before starting the transaction; the transaction still re-reads and
  // atomically decides the claim from its own current state.
  await groupRef.get();
  let decision = {claimed: false, reason: "empty", eventKey, items: []};
  const transaction = await groupRef.transaction((current) => {
    const state = current && typeof current === "object" ? current : {};
    const events = trimEventHistory(state.events);
    if (events[eventKey]) {
      decision = {claimed: false, reason: "duplicate-event", eventKey, items: []};
      return;
    }
    const candidates = eligiblePendingItems(state.items, now).slice(0, limit);
    if (!candidates.length) {
      decision = {claimed: false, reason: "empty", eventKey, items: []};
      return;
    }
    const claimedAt = now.toISOString();
    const leaseUntil = now.getTime() + leaseMs;
    const items = {...(state.items || {})};
    candidates.forEach((item) => {
      items[item.id] = {
        ...item,
        status: "claimed",
        claim: {eventKey, claimedAt, leaseUntil},
        error: null,
      };
    });
    events[eventKey] = {
      status: "claimed",
      claimedAt,
      updatedAt: claimedAt,
      leaseUntil,
      pendingIds: candidates.map((item) => item.id),
    };
    decision = {claimed: true, reason: null, eventKey,
      items: candidates.map((item) => items[item.id])};
    return {...state, items, events};
  });
  return transaction.committed ? decision : {...decision, claimed: false,
    reason: decision.reason || "busy"};
}

async function settlePendingBatch(groupRef, claim, {
  sentIds = [],
  cancelledIds = [],
  releasedIds = [],
  sentAt = new Date().toISOString(),
  error = null,
} = {}) {
  if (!claim || !claim.eventKey) return null;
  const sent = new Set(sentIds);
  const cancelled = new Set(cancelledIds);
  const released = new Set(releasedIds);
  const transaction = await groupRef.transaction((current) => {
    if (!current || typeof current !== "object") return;
    const items = {...(current.items || {})};
    for (const itemId of claim.items.map((item) => item.id)) {
      const item = items[itemId];
      if (!item || item.status !== "claimed" ||
          !item.claim || item.claim.eventKey !== claim.eventKey) continue;
      if (sent.has(itemId)) {
        items[itemId] = {...item, status: "sent", claim: null, sentAt,
          sentVia: "reply", error: null};
      } else if (cancelled.has(itemId)) {
        items[itemId] = {...item, status: "cancelled", claim: null,
          cancelledAt: sentAt, error: null};
      } else if (released.has(itemId) || (!sent.has(itemId) && !cancelled.has(itemId))) {
        items[itemId] = {...item, status: "pending", claim: null,
          error: error ? String(error).slice(0, 160) : null};
      }
    }
    const events = {...(current.events || {})};
    events[claim.eventKey] = {
      ...(events[claim.eventKey] || {}),
      status: error ? "failed" : "sent",
      updatedAt: sentAt,
      sentAt: error ? null : sentAt,
      sentIds: [...sent],
      cancelledIds: [...cancelled],
      error: error ? String(error).slice(0, 160) : null,
      leaseUntil: 0,
    };
    return {...current, items, events: trimEventHistory(events)};
  });
  return transaction.snapshot.val();
}

async function releasePendingBatch(groupRef, claim, error, now = new Date()) {
  return settlePendingBatch(groupRef, claim, {
    releasedIds: claim && claim.items ? claim.items.map((item) => item.id) : [],
    sentAt: now.toISOString(),
    error: String(error && (error.code || error.lineStatus || error.name) || "reply-failed"),
  });
}

function fallbackWebhookEventId(event) {
  return [event && event.timestamp, event && event.message && event.message.id,
    event && event.source && event.source.type,
    event && event.source && event.source.groupId,
    event && event.source && event.source.userId].map((value) => String(value || "")).join(":");
}

function webhookEventId(event) {
  return String(event && event.webhookEventId || fallbackWebhookEventId(event));
}

function isPendingCarrierEvent(event, defaultGroupId) {
  return Boolean(event && event.type === "message" && event.replyToken &&
    event.source && event.source.type === "group" && event.source.groupId &&
    event.source.groupId === defaultGroupId);
}

module.exports = {
  EVENT_HISTORY_LIMIT,
  PENDING_CLAIM_LEASE_MS,
  PENDING_STATUSES,
  buildPendingAnnouncement,
  claimPendingBatch,
  eligiblePendingItems,
  enqueuePendingAnnouncement,
  isPendingCarrierEvent,
  pendingAnnouncementId,
  pendingEventKey,
  pendingGroupKey,
  pendingGroupRef,
  releasePendingBatch,
  settlePendingBatch,
  trimEventHistory,
  webhookEventId,
};
