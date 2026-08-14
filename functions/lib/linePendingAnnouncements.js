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

function isEligiblePendingItem(item, now = new Date()) {
  const nowMs = now.getTime();
  return Boolean(item && (item.status === "pending" || isClaimExpired(item, nowMs)) &&
    (!item.expiresAt || Date.parse(item.expiresAt) > nowMs) &&
    validLineMessage(item.message));
}

function eligiblePendingItems(items, now = new Date()) {
  return Object.values(items && typeof items === "object" ? items : {})
    .filter((item) => isEligiblePendingItem(item, now))
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

async function reservePendingEvent(eventsRef, eventKey, {claimedAt, leaseUntil} = {}) {
  let reserved = false;
  const transaction = await eventsRef.transaction((current) => {
    const events = current && typeof current === "object" ? {...current} : {};
    if (events[eventKey]) {
      reserved = false;
      return;
    }
    reserved = true;
    events[eventKey] = {
      status: "claiming",
      claimedAt,
      updatedAt: claimedAt,
      leaseUntil,
      pendingIds: [],
    };
    return trimEventHistory(events);
  });
  return transaction.committed && reserved;
}

function claimRaceReason(item, now) {
  if (!item || typeof item !== "object") return "missing";
  if (item.status === "sent" || item.status === "cancelled") return item.status;
  if (item.status === "claimed" && !isClaimExpired(item, now.getTime())) {
    return "active-claim";
  }
  if (item.expiresAt && Date.parse(item.expiresAt) <= now.getTime()) return "expired";
  return "ineligible";
}

async function claimPendingItem(itemRef, {eventKey, now, leaseMs} = {}) {
  let claimedItem = null;
  let reason = "lost-race";
  const claimedAt = now.toISOString();
  const leaseUntil = now.getTime() + leaseMs;
  const transaction = await itemRef.transaction((current) => {
    if (current === null) {
      claimedItem = null;
      reason = "server-sync";
      // Returning null, rather than undefined, keeps the transaction alive. If
      // the server has this candidate it responds datastale and reruns this
      // callback with authoritative state; if it is truly absent this is a
      // committed no-op and the candidate remains lost.
      return null;
    }
    if (!isEligiblePendingItem(current, now)) {
      claimedItem = null;
      reason = claimRaceReason(current, now);
      return;
    }
    claimedItem = {
      ...current,
      status: "claimed",
      claim: {eventKey, claimedAt, leaseUntil},
      error: null,
    };
    reason = null;
    return claimedItem;
  });
  return {
    claimed: transaction.committed && Boolean(claimedItem),
    item: transaction.committed ? claimedItem : null,
    reason: transaction.committed && claimedItem ? null : reason || "lost-race",
  };
}

async function claimPendingBatch(groupRef, {
  eventId,
  maxItems,
  now = new Date(),
  leaseMs = PENDING_CLAIM_LEASE_MS,
} = {}) {
  const eventKey = pendingEventKey(eventId);
  const limit = Math.max(0, Math.min(5, Number(maxItems) || 0));
  const base = {eventKey, items: [], serverCandidateCount: 0,
    attemptedClaimCount: 0, claimedCount: 0, raceLostCount: 0};
  if (!eventId || !limit) {
    return {...base, claimed: false, reason: "ineligible", resultStatus: "ineligible"};
  }

  // The server snapshot is discovery only. Every mutation below revalidates
  // the exact event or item path in a transaction before it can be committed.
  const serverSnapshot = await groupRef.get();
  const serverValue = serverSnapshot.val();
  const serverState = serverValue && typeof serverValue === "object" ? serverValue : {};
  const candidates = eligiblePendingItems(serverState.items, now);
  base.serverCandidateCount = candidates.length;
  if (serverState.events && serverState.events[eventKey]) {
    return {...base, claimed: false, reason: "duplicate-event",
      resultStatus: "duplicate-event"};
  }
  if (!candidates.length) {
    return {...base, claimed: false, reason: "empty", resultStatus: "empty"};
  }

  const claimedAt = now.toISOString();
  const leaseUntil = now.getTime() + leaseMs;
  const eventsRef = groupRef.child("events");
  const eventRef = eventsRef.child(eventKey);
  const reserved = await reservePendingEvent(eventsRef, eventKey, {claimedAt, leaseUntil});
  if (!reserved) {
    return {...base, claimed: false, reason: "duplicate-event",
      resultStatus: "duplicate-event"};
  }

  const items = [];
  let attemptedClaimCount = 0;
  let raceLostCount = 0;
  try {
    for (const candidate of candidates) {
      if (items.length >= limit) break;
      attemptedClaimCount += 1;
      const result = await claimPendingItem(groupRef.child(`items/${candidate.id}`), {
        eventKey,
        now,
        leaseMs,
      });
      if (result.claimed) items.push(result.item);
      else raceLostCount += 1;
    }
  } catch (error) {
    await Promise.allSettled(items.map((item) => settlePendingItem(
      groupRef.child(`items/${item.id}`), eventKey, {released: true, error: "claim-failed"})));
    await eventRef.update({status: "failed", updatedAt: new Date().toISOString(),
      leaseUntil: 0, error: "claim-failed"});
    throw error;
  }

  const resultStatus = items.length ? "claimed" : "lost-race";
  await eventRef.update({
    status: resultStatus,
    updatedAt: claimedAt,
    leaseUntil: items.length ? leaseUntil : 0,
    pendingIds: items.map((item) => item.id),
    serverCandidateCount: candidates.length,
    attemptedClaimCount,
    claimedCount: items.length,
    raceLostCount,
  });
  return {
    ...base,
    claimed: items.length > 0,
    reason: items.length ? null : "lost-race",
    resultStatus,
    items,
    attemptedClaimCount,
    claimedCount: items.length,
    raceLostCount,
  };
}

async function settlePendingItem(itemRef, eventKey, {
  sent = false,
  cancelled = false,
  released = false,
  sentAt = new Date().toISOString(),
  error = null,
} = {}) {
  let settledItem = null;
  const transaction = await itemRef.transaction((current) => {
    if (current === null) {
      settledItem = null;
      return null;
    }
    if (!current || current.status !== "claimed" ||
        !current.claim || current.claim.eventKey !== eventKey) {
      settledItem = null;
      return;
    }
    if (sent) {
      settledItem = {...current, status: "sent", claim: null, sentAt,
        sentVia: "reply", error: null};
    } else if (cancelled) {
      settledItem = {...current, status: "cancelled", claim: null,
        cancelledAt: sentAt, error: null};
    } else if (released || (!sent && !cancelled)) {
      settledItem = {...current, status: "pending", claim: null,
        error: error ? String(error).slice(0, 160) : null};
    }
    return settledItem;
  });
  return transaction.committed ? settledItem : null;
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
  const settledItems = (await Promise.all(claim.items.map((item) =>
    settlePendingItem(groupRef.child(`items/${item.id}`), claim.eventKey, {
      sent: sent.has(item.id),
      cancelled: cancelled.has(item.id),
      released: released.has(item.id),
      sentAt,
      error,
    })))).filter(Boolean);
  await groupRef.child(`events/${claim.eventKey}`).update({
    status: error ? "failed" : "sent",
    updatedAt: sentAt,
    sentAt: error ? null : sentAt,
    sentIds: [...sent],
    cancelledIds: [...cancelled],
    error: error ? String(error).slice(0, 160) : null,
    leaseUntil: 0,
  });
  return {settledItems};
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
