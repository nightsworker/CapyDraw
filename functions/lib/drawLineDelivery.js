"use strict";

const crypto = require("node:crypto");
const {isDrawPublishedToLine} = require("./drawKnowledge");
const {buildDrawLineMessage} = require("./line");
const {RUN_LEASE_MS, stableRetryKey} = require("./lineSchedule");

function listHistoryEntries(value) {
  if (Array.isArray(value)) return value.map((record, index) => ({key: String(index), record}));
  return Object.entries(value && typeof value === "object" ? value : {})
    .map(([key, record]) => ({key, record}));
}

function findHistoryRecord(value, recordId) {
  return listHistoryEntries(value)
    .find(({record}) => record && record.id === recordId) || null;
}

function selectDrawRecordByDate(value, targetDate) {
  const matches = listHistoryEntries(value)
    .filter(({record}) => record && record.date === targetDate);
  if (!matches.length) return {status: "missing", matches: []};
  if (matches.length > 1) return {status: "ambiguous-draw-records", matches};
  return {status: "found", ...matches[0], matches};
}

function drawClaimKey(recordId) {
  const digest = crypto.createHash("sha256").update(String(recordId || ""), "utf8")
    .digest("base64url").slice(0, 32);
  return `draw_${digest}`;
}

async function claimDrawSend(claimRef, {
  recordId,
  owner,
  retryNamespace,
  allowRepublish = false,
  now = new Date(),
  leaseMs = RUN_LEASE_MS,
} = {}) {
  const nowMs = now.getTime();
  let decision = {claimed: false, reason: "busy"};
  const transaction = await claimRef.transaction((current) => {
    const state = current && typeof current === "object" ? current : {};
    const leaseActive = state.status === "sending" && Number(state.leaseUntil) > nowMs;
    if (leaseActive) {
      decision = {claimed: false, reason: "busy", state};
      return;
    }
    if (state.status === "sent" && !allowRepublish) {
      decision = {claimed: false, reason: "already-sent", state};
      return;
    }
    const reuseRetryKey = ["failed", "publication-pending", "sending"].includes(state.status) &&
      state.retryKey;
    const next = {
      recordId,
      status: "sending",
      owner: String(owner || "unknown").slice(0, 30),
      retryKey: reuseRetryKey || stableRetryKey(retryNamespace || `${recordId}:${nowMs}`),
      attempt: Math.max(0, Number(state.attempt) || 0) + 1,
      claimedAt: now.toISOString(),
      leaseUntil: nowMs + leaseMs,
      updatedAt: now.toISOString(),
    };
    decision = {claimed: true, reason: null, state: next};
    return next;
  });
  return transaction.committed ? decision :
    {...decision, claimed: false, reason: decision.reason || "busy"};
}

async function finishDrawClaim(claimRef, claim, status, {now = new Date(), errorType = null} = {}) {
  const update = {
    ...claim.state,
    status,
    leaseUntil: 0,
    updatedAt: now.toISOString(),
    ...(status === "sent" ? {sentAt: now.toISOString()} : {}),
    ...(errorType ? {errorType: String(errorType).slice(0, 80)} : {}),
  };
  await claimRef.set(update);
  return update;
}

async function markDrawPublished(recordRef, {sentAt = new Date().toISOString()} = {}) {
  let updated = null;
  const transaction = await recordRef.transaction((current) => {
    if (!current || typeof current !== "object") return;
    updated = {
      ...current,
      lineSentAt: sentAt,
      lineSendCount: (Number(current.lineSendCount) || 0) + 1,
      lastLineSendStatus: "sent",
    };
    return updated;
  });
  if (!transaction.committed || !updated) {
    const error = new Error("抽籤紀錄在發送後已不存在，無法寫入發布狀態。");
    error.code = "draw_publication_not_committed";
    throw error;
  }
  return updated;
}

async function sendDrawLineRecord({
  historyRef,
  bindings,
  groupId,
  claimsRef,
  recordId,
  owner,
  retryNamespace,
  skipPublished = false,
  allowRepublish = false,
  pushMessage,
  now = new Date(),
} = {}) {
  const firstSnapshot = await historyRef.get();
  let found = findHistoryRecord(firstSnapshot.val(), recordId);
  if (!found) return {status: "not-found"};
  if (skipPublished && isDrawPublishedToLine(found.record)) {
    return {status: "skipped-already-published", record: found.record};
  }
  const claimRef = claimsRef.child(drawClaimKey(recordId));
  const claim = await claimDrawSend(claimRef, {
    recordId, owner, retryNamespace, allowRepublish, now,
  });
  if (!claim.claimed) return {status: claim.reason, claim};

  const latestSnapshot = await historyRef.get();
  found = findHistoryRecord(latestSnapshot.val(), recordId);
  if (!found) {
    await finishDrawClaim(claimRef, claim, "failed", {now, errorType: "draw-not-found"});
    return {status: "not-found"};
  }
  if (skipPublished && isDrawPublishedToLine(found.record)) {
    await finishDrawClaim(claimRef, claim, "skipped-already-published", {now});
    return {status: "skipped-already-published", record: found.record};
  }

  const rendered = buildDrawLineMessage(found.record, bindings || {}, groupId);
  try {
    await pushMessage({
      to: groupId,
      messages: [rendered.message],
      retryKey: claim.state.retryKey,
    });
  } catch (error) {
    await finishDrawClaim(claimRef, claim, "failed", {
      now: new Date(),
      errorType: error && (error.code || error.lineStatus || error.name),
    });
    throw error;
  }

  let updated;
  try {
    updated = await markDrawPublished(historyRef.child(found.key), {
      sentAt: new Date().toISOString(),
    });
  } catch (error) {
    await finishDrawClaim(claimRef, claim, "publication-pending", {
      now: new Date(),
      errorType: error && (error.code || error.name),
    });
    throw error;
  }
  await finishDrawClaim(claimRef, claim, "sent", {now: new Date()});
  return {
    status: "sent",
    record: updated,
    unboundMembers: rendered.unboundMembers,
    retryKey: claim.state.retryKey,
  };
}

module.exports = {
  claimDrawSend,
  drawClaimKey,
  findHistoryRecord,
  finishDrawClaim,
  listHistoryEntries,
  markDrawPublished,
  selectDrawRecordByDate,
  sendDrawLineRecord,
};
