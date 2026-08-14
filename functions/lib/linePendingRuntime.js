"use strict";

const {isDrawPublishedToLine} = require("./drawKnowledge");
const {
  claimDrawSend,
  drawClaimKey,
  findHistoryRecord,
  finishDrawClaim,
  markDrawPublished,
} = require("./drawLineDelivery");
const {
  claimPendingBatch,
  isPendingCarrierEvent,
  pendingGroupRef,
  settlePendingBatch,
  webhookEventId,
} = require("./linePendingAnnouncements");

function normalReplyMessages(value) {
  return (Array.isArray(value) ? value : [])
    .filter((message) => message && typeof message === "object" && message.type)
    .slice(0, 5);
}

function pendingClaimCapacity(normalCount) {
  return normalCount >= 5 ? 1 : Math.max(1, 5 - normalCount);
}

function replyPayload(normalMessages, pendingMessages) {
  const pending = (Array.isArray(pendingMessages) ? pendingMessages : []).slice(0, 5);
  const normal = normalReplyMessages(normalMessages).slice(0, Math.max(0, 5 - pending.length));
  return [...normal, ...pending].slice(0, 5);
}

async function prepareClaimedPending({claim, historyRef, drawClaimsRef, now}) {
  const ready = [];
  const cancelledIds = [];
  const releasedIds = [];
  const drawClaims = new Map();
  let historyValue = null;
  let historyLoaded = false;

  for (const item of claim.items) {
    if (item.type !== "draw") {
      ready.push(item);
      continue;
    }
    if (!historyLoaded) {
      historyValue = (await historyRef.get()).val();
      historyLoaded = true;
    }
    const found = findHistoryRecord(historyValue, item.drawRecordId);
    if (!found || isDrawPublishedToLine(found.record)) {
      cancelledIds.push(item.id);
      continue;
    }
    const drawClaim = await claimDrawSend(drawClaimsRef.child(drawClaimKey(item.drawRecordId)), {
      recordId: item.drawRecordId,
      owner: "reply",
      retryNamespace: `reply:${item.id}`,
      allowRepublish: false,
      now,
    });
    if (!drawClaim.claimed) {
      if (drawClaim.reason === "already-sent") cancelledIds.push(item.id);
      else releasedIds.push(item.id);
      continue;
    }
    drawClaims.set(item.id, {claim: drawClaim, recordRef: historyRef.child(found.key)});
    ready.push(item);
  }
  return {ready, cancelledIds, releasedIds, drawClaims};
}

async function finishDownstreamState({db, item, drawState, sentAt}) {
  const warnings = [];
  if (item.type === "draw" && drawState) {
    try {
      await markDrawPublished(drawState.recordRef, {sentAt, deliveryMode: "reply"});
      await finishDrawClaim(drawState.claimRef, drawState.claim, "sent", {
        now: new Date(sentAt),
      });
    } catch (error) {
      warnings.push(String(error && (error.code || error.name) || "publication-failed").slice(0, 80));
    }
  }
  if (item.runPath) {
    const scheduledMs = Date.parse(item.scheduledFor);
    await db.ref(item.runPath).update({
      status: "sent-via-reply",
      sentAt,
      updatedAt: sentAt,
      replyDelayMs: Number.isFinite(scheduledMs) ? Math.max(0, Date.parse(sentAt) - scheduledMs) : null,
    });
  }
  if (item.type === "fixed" && item.scheduleId) {
    await db.ref(`guildDraw/lineSchedules/items/${item.scheduleId}`).update({
      lastRunAt: sentAt,
      lastRunStatus: "sent-via-reply",
    });
  } else if (item.type === "draw") {
    await db.ref("guildDraw/lineSchedules/tomorrowDraw").update({
      lastRunAt: sentAt,
      lastRunStatus: "sent-via-reply",
    });
  }
  return warnings;
}

async function failDrawClaims(drawClaims, error, now = new Date()) {
  await Promise.all([...drawClaims.values()].map(({claim, claimRef}) =>
    finishDrawClaim(claimRef, claim, "failed", {
      now,
      errorType: error && (error.code || error.lineStatus || error.name),
    })));
}

async function consumePendingAnnouncements({
  db,
  event,
  defaultGroupId,
  normalMessages = [],
  sendReply,
  now = new Date(),
} = {}) {
  const normal = normalReplyMessages(normalMessages);
  if (!isPendingCarrierEvent(event, defaultGroupId)) {
    if (normal.length && event && event.replyToken) {
      await sendReply(normal, {pendingIds: []});
    }
    return {status: normal.length ? "normal-only" : "ineligible", messages: normal,
      sentPending: []};
  }

  const groupRef = pendingGroupRef(db, defaultGroupId);
  const claim = await claimPendingBatch(groupRef, {
    eventId: webhookEventId(event),
    maxItems: pendingClaimCapacity(normal.length),
    now,
  });
  if (!claim.claimed) {
    if (normal.length) await sendReply(normal, {pendingIds: []});
    return {status: normal.length ? "normal-only" : claim.reason, claim, messages: normal,
      sentPending: []};
  }

  const historyRef = db.ref("guildDraw/main/history");
  const drawClaimsRef = db.ref("guildDraw/lineSchedules/drawClaims");
  const prepared = await prepareClaimedPending({claim, historyRef, drawClaimsRef, now});
  for (const [itemId, value] of prepared.drawClaims.entries()) {
    value.claimRef = drawClaimsRef.child(drawClaimKey(
      prepared.ready.find((item) => item.id === itemId).drawRecordId));
  }
  const messages = replyPayload(normal, prepared.ready.map((item) => item.message));
  if (!messages.length) {
    await settlePendingBatch(groupRef, claim, {
      cancelledIds: prepared.cancelledIds,
      releasedIds: prepared.releasedIds,
      sentAt: now.toISOString(),
    });
    return {status: "nothing-to-send", claim, sentPending: []};
  }

  try {
    await sendReply(messages, {pendingIds: prepared.ready.map((item) => item.id)});
  } catch (error) {
    await failDrawClaims(prepared.drawClaims, error, new Date());
    await settlePendingBatch(groupRef, claim, {
      cancelledIds: prepared.cancelledIds,
      releasedIds: [...prepared.releasedIds, ...prepared.ready.map((item) => item.id)],
      sentAt: new Date().toISOString(),
      error: String(error && (error.code || error.lineStatus || error.name) || "reply-failed"),
    });
    throw error;
  }

  const sentAt = new Date().toISOString();
  const sentIds = prepared.ready.map((item) => item.id);
  await settlePendingBatch(groupRef, claim, {
    sentIds,
    cancelledIds: prepared.cancelledIds,
    releasedIds: prepared.releasedIds,
    sentAt,
  });
  const warnings = [];
  for (const item of prepared.ready) {
    warnings.push(...await finishDownstreamState({
      db,
      item,
      drawState: prepared.drawClaims.get(item.id),
      sentAt,
    }));
  }
  return {
    status: sentIds.length ? "sent-via-reply" : "normal-only",
    claim,
    messages,
    sentPending: prepared.ready,
    cancelledIds: prepared.cancelledIds,
    leftoverNormalCount: Math.max(0, normal.length - (messages.length - sentIds.length)),
    warnings,
  };
}

module.exports = {
  consumePendingAnnouncements,
  normalReplyMessages,
  pendingClaimCapacity,
  prepareClaimedPending,
  replyPayload,
};
