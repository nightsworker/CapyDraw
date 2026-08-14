"use strict";

const {
  FIXED_RETRY_LIMIT,
  RUN_LEASE_MS,
  TOMORROW_CHECK_INTERVAL_MS,
  buildScheduledLineMessage,
  findNextOccurrence,
  latestTomorrowOccurrence,
  occurrenceDayExpired,
  pruneRunHistory,
  renderScheduleCore,
  stableRetryKey,
  taipeiDateKey,
} = require("./lineSchedule");
const {isDrawPublishedToLine} = require("./drawKnowledge");
const {
  listHistoryEntries,
  selectDrawRecordByDate,
  sendDrawLineRecord,
} = require("./drawLineDelivery");

const TERMINAL_RUN_STATUSES = new Set([
  "sent", "failed", "expired", "expired-no-draw", "ambiguous-draw-records",
  "skipped-already-published",
]);

function safeRunError(error) {
  return String(error && (error.code || error.lineStatus || error.name) || "unknown-error")
    .slice(0, 80);
}

function buildDrawLookupDiagnostics(rawHistory, selection) {
  const historyType = rawHistory === null || rawHistory === undefined ? "null" :
    (Array.isArray(rawHistory) ? "array" : typeof rawHistory === "object" ? "object" : "invalid");
  const entries = listHistoryEntries(rawHistory)
    .filter(({record}) => record && typeof record === "object");
  const matched = selection && Array.isArray(selection.matches) ? selection.matches : [];
  const record = matched.length === 1 ? matched[0].record : null;
  return {
    historyType,
    historyCount: entries.length,
    matchedRecordCount: matched.length,
    matchedRecordId: record && String(record.id || "").slice(0, 200) || null,
    matchedRecordDate: record && String(record.date || "").slice(0, 20) || null,
    published: record ? isDrawPublishedToLine(record) : null,
  };
}

async function claimScheduleRun(runRef, {
  runKey,
  scheduleId,
  scheduledFor,
  occurrenceDate,
  now = new Date(),
  retryLimit = FIXED_RETRY_LIMIT,
} = {}) {
  const nowMs = now.getTime();
  let decision = {claimed: false, reason: "busy"};
  const transaction = await runRef.transaction((current) => {
    const state = current && typeof current === "object" ? current : {};
    if (TERMINAL_RUN_STATUSES.has(state.status)) {
      decision = {claimed: false, reason: state.status, state};
      return;
    }
    if (state.status === "sending" && Number(state.leaseUntil) > nowMs) {
      decision = {claimed: false, reason: "busy", state};
      return;
    }
    if (state.nextAttemptAt && Date.parse(state.nextAttemptAt) > nowMs) {
      decision = {claimed: false, reason: "not-due", state};
      return;
    }
    const attempt = Math.max(0, Number(state.retryCount) || 0) + 1;
    if (attempt > retryLimit) {
      decision = {claimed: false, reason: "failed", state: {...state, status: "failed"}};
      return {...state, status: "failed", leaseUntil: 0, deliveryPayload: null,
        updatedAt: now.toISOString()};
    }
    const next = {
      ...state,
      runKey,
      scheduleId,
      scheduledFor,
      occurrenceDate,
      status: "sending",
      retryCount: attempt,
      retryKey: state.retryKey || stableRetryKey(`fixed:${runKey}`),
      leaseUntil: nowMs + RUN_LEASE_MS,
      startedAt: state.startedAt || now.toISOString(),
      updatedAt: now.toISOString(),
    };
    decision = {claimed: true, reason: null, state: next};
    return next;
  });
  return transaction.committed ? decision : {...decision, claimed: false};
}

async function finishScheduleRun(runRef, claim, status, {
  now = new Date(), warnings = [], errorType = null, nextAttemptAt = null,
  wrapperReason = null,
} = {}) {
  const terminal = status !== "failed-retryable";
  const next = {
    ...claim.state,
    status,
    leaseUntil: 0,
    updatedAt: now.toISOString(),
    ...(status === "sent" ? {sentAt: now.toISOString()} : {}),
    ...(warnings.length ? {warning: warnings.slice(0, 10).join(",").slice(0, 500)} : {}),
    ...(errorType ? {errorType: String(errorType).slice(0, 80)} : {}),
    ...(nextAttemptAt ? {nextAttemptAt} : {}),
    ...(wrapperReason ? {wrapperReason: String(wrapperReason).slice(0, 80)} : {}),
  };
  if (terminal) {
    delete next.deliveryPayload;
    delete next.nextAttemptAt;
  }
  await runRef.set(next);
  return next;
}

function retryDelayMs(retryCount) {
  return retryCount <= 1 ? 60_000 : 5 * 60_000;
}

async function dispatchFixedOccurrence({
  schedule,
  occurrence,
  runRef,
  bindings,
  defaultGroupId,
  pushMessage,
  createWrapper,
  now = new Date(),
} = {}) {
  if (!schedule || schedule.enabled === false) return {status: "disabled"};
  if (occurrenceDayExpired(occurrence.scheduledFor, now)) {
    const claim = await claimScheduleRun(runRef, {...occurrence, scheduleId: schedule.id, now});
    if (claim.claimed) await finishScheduleRun(runRef, claim, "expired", {now});
    return {status: "expired"};
  }
  const claim = await claimScheduleRun(runRef, {...occurrence, scheduleId: schedule.id, now});
  if (!claim.claimed) return {status: claim.reason, claim};

  let payload = claim.state.deliveryPayload;
  let wrapperReason = claim.state.wrapperReason || null;
  let warnings = [];
  if (!payload) {
    const core = renderScheduleCore(schedule.messageTemplate, {
      occurrenceDate: occurrence.occurrenceDate,
      bindings,
      defaultGroupId,
    });
    const wrapper = await createWrapper(core.plainText);
    wrapperReason = wrapper.reason;
    warnings = core.warnings;
    payload = {
      message: buildScheduledLineMessage(core, wrapper),
      warning: warnings,
      wrapperReason,
    };
    await runRef.update({deliveryPayload: payload, wrapperReason, updatedAt: new Date().toISOString()});
    claim.state.deliveryPayload = payload;
    claim.state.wrapperReason = wrapperReason;
  } else {
    warnings = Array.isArray(payload.warning) ? payload.warning : [];
  }

  try {
    await pushMessage({
      to: defaultGroupId,
      messages: [payload.message],
      retryKey: claim.state.retryKey,
    });
    const finished = await finishScheduleRun(runRef, claim, "sent", {
      now: new Date(), warnings, wrapperReason,
    });
    return {status: "sent", run: finished, warnings, wrapperReason};
  } catch (error) {
    const nextAttempt = new Date(now.getTime() + retryDelayMs(claim.state.retryCount));
    const retryable = claim.state.retryCount < FIXED_RETRY_LIMIT &&
      taipeiDateKey(nextAttempt) === occurrence.occurrenceDate;
    const status = retryable ? "failed-retryable" : "failed";
    const finished = await finishScheduleRun(runRef, claim, status, {
      now: new Date(), warnings, errorType: safeRunError(error), wrapperReason,
      nextAttemptAt: retryable ? nextAttempt.toISOString() : null,
    });
    return {status, run: finished, error};
  }
}

async function claimTomorrowCheck(runRef, occurrence, now = new Date(), {force = false} = {}) {
  const nowMs = now.getTime();
  let decision = {claimed: false, reason: "busy"};
  const transaction = await runRef.transaction((current) => {
    const state = current && typeof current === "object" ? current : {};
    const previousStatus = state.status || null;
    if (TERMINAL_RUN_STATUSES.has(state.status)) {
      decision = {claimed: false, reason: state.status, state, previousStatus};
      return;
    }
    if (state.status === "checking" && Number(state.leaseUntil) > nowMs) {
      decision = {claimed: false, reason: "busy", state, previousStatus};
      return;
    }
    if (!force && state.nextCheckAt && Date.parse(state.nextCheckAt) > nowMs) {
      decision = {claimed: false, reason: "not-due", state, previousStatus};
      return;
    }
    const next = {
      ...state,
      ...occurrence,
      status: "checking",
      checkCount: Math.max(0, Number(state.checkCount) || 0) + 1,
      leaseUntil: nowMs + RUN_LEASE_MS,
      startedAt: state.startedAt || now.toISOString(),
      updatedAt: now.toISOString(),
    };
    decision = {claimed: true, state: next, previousStatus};
    return next;
  });
  return transaction.committed ? decision : {...decision, claimed: false};
}

async function setTomorrowRunStatus(runRef, claim, status, {
  now = new Date(), nextCheckAt = null, errorType = null,
} = {}) {
  const next = {...claim.state, status, leaseUntil: 0, updatedAt: now.toISOString(),
    ...(nextCheckAt ? {nextCheckAt} : {}),
    ...(errorType ? {errorType: String(errorType).slice(0, 80)} : {})};
  if (!errorType) delete next.errorType;
  if (TERMINAL_RUN_STATUSES.has(status)) delete next.nextCheckAt;
  if (status === "sent") next.sentAt = now.toISOString();
  await runRef.set(next);
  return next;
}

function isTaipeiLastMinute(now) {
  const parts = new Intl.DateTimeFormat("en-GB", {timeZone: "Asia/Taipei",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"}).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return Number(values.hour) === 23 && Number(values.minute) >= 59;
}

async function dispatchTomorrowDraw({
  settings,
  runRef,
  historyRef,
  bindings,
  defaultGroupId,
  drawClaimsRef,
  pushMessage,
  now = new Date(),
} = {}) {
  const occurrence = latestTomorrowOccurrence(settings, now);
  if (!occurrence) return {status: settings && settings.enabled ? "not-due" : "disabled"};
  const lastMinute = isTaipeiLastMinute(now);
  const claim = await claimTomorrowCheck(runRef, occurrence, now, {force: lastMinute});
  if (!claim.claimed) {
    return {status: claim.reason, occurrence, previousStatus: claim.previousStatus || null};
  }
  const historySnapshot = await historyRef.get();
  const rawHistory = historySnapshot.val();
  const selection = selectDrawRecordByDate(rawHistory, occurrence.targetDrawDate);
  const lookup = buildDrawLookupDiagnostics(rawHistory, selection);
  if (selection.status === "missing") {
    if (lastMinute) {
      await setTomorrowRunStatus(runRef, claim, "expired-no-draw", {now});
      return {status: "expired-no-draw", occurrence, lookup,
        previousStatus: claim.previousStatus || null};
    }
    const nextCheckAt = new Date(now.getTime() + TOMORROW_CHECK_INTERVAL_MS).toISOString();
    await setTomorrowRunStatus(runRef, claim, "waiting-for-draw", {now, nextCheckAt});
    return {status: "waiting-for-draw", occurrence, nextCheckAt, lookup,
      previousStatus: claim.previousStatus || null};
  }
  if (selection.status === "ambiguous-draw-records") {
    await setTomorrowRunStatus(runRef, claim, "ambiguous-draw-records", {now});
    return {status: "ambiguous-draw-records", occurrence, lookup,
      previousStatus: claim.previousStatus || null};
  }
  if (isDrawPublishedToLine(selection.record)) {
    await setTomorrowRunStatus(runRef, claim, "skipped-already-published", {now});
    return {status: "skipped-already-published", occurrence, lookup,
      previousStatus: claim.previousStatus || null};
  }
  try {
    const sent = await sendDrawLineRecord({
      historyRef, bindings, groupId: defaultGroupId, claimsRef: drawClaimsRef,
      recordId: selection.record.id, owner: "scheduler",
      retryNamespace: `tomorrow:${occurrence.runKey}`, skipPublished: true,
      allowRepublish: false, pushMessage, now,
    });
    const terminalStatus = sent.status === "sent" ? "sent" : sent.status;
    if (terminalStatus === "not-found") {
      const nextCheckAt = new Date(now.getTime() + TOMORROW_CHECK_INTERVAL_MS).toISOString();
      await setTomorrowRunStatus(runRef, claim, "waiting-for-draw", {now, nextCheckAt});
      return {status: "waiting-for-draw", occurrence, nextCheckAt, lookup,
        previousStatus: claim.previousStatus || null, sendClaimResult: terminalStatus};
    }
    if (["busy", "failed"].includes(terminalStatus)) {
      const nextCheckAt = new Date(now.getTime() + TOMORROW_CHECK_INTERVAL_MS).toISOString();
      await setTomorrowRunStatus(runRef, claim, "failed-retryable", {now, nextCheckAt,
        errorType: terminalStatus});
      return {status: "failed-retryable", occurrence, nextCheckAt, lookup,
        previousStatus: claim.previousStatus || null, sendClaimResult: terminalStatus};
    }
    await setTomorrowRunStatus(runRef, claim, terminalStatus, {now: new Date()});
    return {...sent, occurrence, lookup, previousStatus: claim.previousStatus || null,
      sendClaimResult: sent.status};
  } catch (error) {
    if (lastMinute) {
      await setTomorrowRunStatus(runRef, claim, "failed", {now, errorType: safeRunError(error)});
      return {status: "failed", occurrence, error, lookup,
        previousStatus: claim.previousStatus || null, sendClaimResult: "line-error"};
    }
    const nextCheckAt = new Date(now.getTime() + TOMORROW_CHECK_INTERVAL_MS).toISOString();
    await setTomorrowRunStatus(runRef, claim, "failed-retryable", {
      now, nextCheckAt, errorType: safeRunError(error),
    });
    return {status: "failed-retryable", occurrence, nextCheckAt, error, lookup,
      previousStatus: claim.previousStatus || null, sendClaimResult: "line-error"};
  }
}

async function pruneRunsRef(ref) {
  await ref.transaction((current) => pruneRunHistory(current));
}

function nextOccurrenceAfter(schedule, occurrence) {
  return findNextOccurrence(schedule, {after: occurrence.timestamp + 1, inclusive: true});
}

module.exports = {
  TERMINAL_RUN_STATUSES,
  buildDrawLookupDiagnostics,
  claimScheduleRun,
  claimTomorrowCheck,
  dispatchFixedOccurrence,
  dispatchTomorrowDraw,
  finishScheduleRun,
  isTaipeiLastMinute,
  nextOccurrenceAfter,
  pruneRunsRef,
  retryDelayMs,
  safeRunError,
  setTomorrowRunStatus,
};
