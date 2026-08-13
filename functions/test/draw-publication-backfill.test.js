"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {assertAdminUid} = require("../lib/admin");
const {
  FUTURE_CLOCK_TOLERANCE_MS,
  backfillDrawLinePublication,
  normalizePublishedAt,
  planDrawPublicationBackfill,
  validateBackfillRecordId,
} = require("../lib/drawPublicationBackfill");
const {
  isDrawPublishedToLine,
  planPublishedDrawQuery,
  resolvePublishedDrawKnowledge,
} = require("../lib/drawKnowledge");

const NOW = new Date("2026-08-13T12:00:00.000Z");
const PUBLISHED_AT = "2026-08-13T10:00:00.000Z";

function drawRecord(id, date = "2026-08-13", overrides = {}) {
  return {
    id,
    date,
    captain: "Chia - 嘻嘻不嘻嘻",
    guardian: "kenji - ちゃらう",
    cabin4: ["Rain - 流鬼", "@Hank - 挖系小嗨"],
    specialDay: false,
    poolSnapshots: {before: {captainPool: ["private candidate"]}},
    consumed: {captain: ["private consumed member"]},
    customLegacyField: {keep: true},
    ...overrides,
  };
}

function createHistoryRef(initialValue, {beforeObserve} = {}) {
  let value = structuredClone(initialValue);
  let gets = 0;
  let rootTransactions = 0;
  let childTransactions = 0;
  let activeListeners = 0;
  const childKeys = [];
  return {
    get transactions() {
      return childTransactions;
    },
    get gets() {
      return gets;
    },
    get rootTransactions() {
      return rootTransactions;
    },
    get activeListeners() {
      return activeListeners;
    },
    get childKeys() {
      return childKeys;
    },
    get value() {
      return value;
    },
    async get() {
      gets += 1;
      return {val: () => structuredClone(value)};
    },
    async transaction(update) {
      rootTransactions += 1;
      const nextValue = update(null);
      return {
        committed: false,
        snapshot: {val: () => nextValue},
      };
    },
    child(key) {
      childKeys.push(key);
      let observing = false;
      return {
        on(event, valueHandler) {
          assert.equal(event, "value");
          observing = true;
          activeListeners += 1;
          if (beforeObserve) value = beforeObserve(value, key);
          valueHandler({val: () => structuredClone(value[key] ?? null)});
        },
        off(event) {
          assert.equal(event, "value");
          if (observing) {
            observing = false;
            activeListeners -= 1;
          }
        },
        async transaction(update) {
          childTransactions += 1;
          // The installed RTDB SDK starts an uncached transaction with null.
          // An active value listener makes the actual server child available.
          const currentValue = observing ? structuredClone(value[key] ?? null) : null;
          const nextValue = update(currentValue);
          if (nextValue !== undefined) value[key] = nextValue;
          return {
            committed: nextValue !== undefined,
            snapshot: {val: () => structuredClone(value[key] ?? null)},
          };
        },
      };
    },
  };
}

function withoutPublicationMetadata(record) {
  const copy = structuredClone(record);
  delete copy.lineSentAt;
  delete copy.lineSendCount;
  delete copy.lastLineSendStatus;
  return copy;
}

test("backfill endpoint authorization uses the existing Firebase admin allowlist", () => {
  assert.throws(
    () => assertAdminUid("UID_MEMBER", "UID_ADMIN_A,UID_ADMIN_B"),
    (error) => error.status === 403,
  );
  assert.doesNotThrow(() => assertAdminUid("UID_ADMIN_B", "UID_ADMIN_A,UID_ADMIN_B"));
});

test("recordId is required and bounded", () => {
  assert.equal(validateBackfillRecordId(), null);
  assert.equal(validateBackfillRecordId("  "), null);
  assert.equal(validateBackfillRecordId("x".repeat(201)), null);
  assert.equal(validateBackfillRecordId("  legacy-record  "), "legacy-record");
});

test("publishedAt requires a strict valid ISO datetime and defaults to server time", () => {
  assert.deepEqual(normalizePublishedAt(undefined, {now: NOW}), {
    ok: true,
    publishedAt: NOW.toISOString(),
  });
  for (const invalid of [
    null,
    "",
    "2026-08-13",
    "August 13, 2026",
    "2026-02-30T10:00:00.000Z",
    "2026-08-13T25:00:00.000Z",
    "2026-08-13T10:00:00",
  ]) {
    assert.deepEqual(normalizePublishedAt(invalid, {now: NOW}), {
      ok: false,
      reason: "invalid-published-at",
    });
  }
});

test("publishedAt beyond the clock tolerance is rejected", () => {
  const future = new Date(NOW.getTime() + FUTURE_CLOCK_TOLERANCE_MS + 1).toISOString();
  assert.deepEqual(normalizePublishedAt(future, {now: NOW}), {
    ok: false,
    reason: "future-published-at",
  });
});

test("missing recordId returns a not-found plan without changing history", () => {
  const history = [drawRecord("legacy-a")];
  const outcome = planDrawPublicationBackfill(history, {
    recordId: "missing",
    publishedAt: PUBLISHED_AT,
    now: NOW,
  });
  assert.deepEqual(outcome, {status: "not-found"});
  assert.equal(isDrawPublishedToLine(history[0]), false);
});

test("recordId lookup requires an exact string match", () => {
  assert.equal(planDrawPublicationBackfill(
    [drawRecord(1786455181162)],
    {recordId: "1786455181162", publishedAt: PUBLISHED_AT, now: NOW},
  ).status, "not-found");
});

test("array history backfills only publication metadata and never calls LINE", async () => {
  const target = drawRecord("legacy-array", "2026-08-13", {lineSendCount: 0});
  const untouched = drawRecord("unpublished-other", "2026-08-12");
  const historyRef = createHistoryRef([target, untouched]);
  const originalFetch = global.fetch;
  let lineCalls = 0;
  global.fetch = async () => {
    lineCalls += 1;
    throw new Error("LINE must not be called");
  };
  try {
    const outcome = await backfillDrawLinePublication(historyRef, {
      recordId: "legacy-array",
      publishedAt: PUBLISHED_AT,
      now: NOW,
    });
    assert.deepEqual(outcome, {
      status: "updated",
      recordDate: "2026-08-13",
      publishedAt: PUBLISHED_AT,
      alreadyPublished: false,
    });
  } finally {
    global.fetch = originalFetch;
  }

  const updated = historyRef.value[0];
  assert.equal(historyRef.gets, 1);
  assert.equal(historyRef.transactions, 1);
  assert.equal(historyRef.rootTransactions, 0);
  assert.deepEqual(historyRef.childKeys, ["0"]);
  assert.equal(historyRef.activeListeners, 0);
  assert.equal(lineCalls, 0);
  assert.equal(updated.lineSentAt, PUBLISHED_AT);
  assert.equal(updated.lineSendCount, 1);
  assert.equal(updated.lastLineSendStatus, "sent");
  assert.deepEqual(withoutPublicationMetadata(updated), withoutPublicationMetadata(target));
  assert.deepEqual(historyRef.value[1], untouched);
  assert.equal(isDrawPublishedToLine(updated), true);
  assert.equal(isDrawPublishedToLine(historyRef.value[1]), false);
});

test("object history finds records by record.id rather than Firebase node key", async () => {
  const historyRef = createHistoryRef({
    unrelatedFirebaseKey: drawRecord("legacy-object", "2026-08-12"),
  });
  const outcome = await backfillDrawLinePublication(historyRef, {
    recordId: "legacy-object",
    publishedAt: PUBLISHED_AT,
    now: NOW,
  });
  assert.equal(outcome.status, "updated");
  assert.equal(historyRef.value.unrelatedFirebaseKey.lineSentAt, PUBLISHED_AT);
  assert.equal(historyRef.value.unrelatedFirebaseKey.lastLineSendStatus, "sent");
});

test("production null-cache regression reads history then transacts only the matched child", async () => {
  const historyRef = createHistoryRef([
    drawRecord("unrelated"),
    drawRecord("1786455181162-de73c1355d6eb"),
  ]);
  const outcome = await backfillDrawLinePublication(historyRef, {
    recordId: "1786455181162-de73c1355d6eb",
    publishedAt: PUBLISHED_AT,
    now: NOW,
  });
  assert.equal(outcome.status, "updated");
  assert.equal(historyRef.rootTransactions, 0);
  assert.deepEqual(historyRef.childKeys, ["1"]);
  assert.equal(historyRef.value[1].lineSentAt, PUBLISHED_AT);
  assert.equal(historyRef.value[0].lineSentAt, undefined);
});

test("a record removed after lookup is not recreated", async () => {
  const historyRef = createHistoryRef({targetKey: drawRecord("removed")}, {
    beforeObserve(history) {
      const nextHistory = {...history};
      delete nextHistory.targetKey;
      return nextHistory;
    },
  });
  const outcome = await backfillDrawLinePublication(historyRef, {
    recordId: "removed",
    publishedAt: PUBLISHED_AT,
    now: NOW,
  });
  assert.deepEqual(outcome, {status: "not-found"});
  assert.equal(historyRef.transactions, 0);
  assert.equal(historyRef.value.targetKey, undefined);
  assert.equal(historyRef.activeListeners, 0);
});

test("existing positive lineSendCount is never reduced during backfill", () => {
  const history = [drawRecord("legacy-count", "2026-08-12", {
    lineSentAt: "invalid-legacy-value",
    lineSendCount: 7,
    lastLineSendStatus: "unknown",
  })];
  const outcome = planDrawPublicationBackfill(history, {
    recordId: "legacy-count",
    publishedAt: PUBLISHED_AT,
    now: NOW,
  });
  assert.equal(outcome.nextHistory[0].lineSendCount, 7);
  assert.equal(outcome.nextHistory[0].lineSentAt, PUBLISHED_AT);
  assert.equal(outcome.nextHistory[0].lastLineSendStatus, "sent");
});

test("already published records are returned unchanged", async () => {
  const existing = drawRecord("already-published", "2026-08-12", {
    lineSentAt: "2026-08-12T08:00:00.000Z",
    lineSendCount: 4,
    lastLineSendStatus: "failed",
  });
  const historyRef = createHistoryRef({recordKey: existing});
  const before = structuredClone(historyRef.value);
  const outcome = await backfillDrawLinePublication(historyRef, {
    recordId: "already-published",
    publishedAt: PUBLISHED_AT,
    now: NOW,
  });
  assert.equal(outcome.status, "already-published");
  assert.equal(outcome.alreadyPublished, true);
  assert.equal(outcome.publishedAt, "2026-08-12T08:00:00.000Z");
  assert.deepEqual(historyRef.value, before);
  assert.equal(historyRef.transactions, 0);
});

test("a concurrently published record is not overwritten", async () => {
  const concurrentPublishedAt = "2026-08-13T09:00:00.000Z";
  const historyRef = createHistoryRef({targetKey: drawRecord("concurrent")}, {
    beforeObserve(history) {
      return {
        ...history,
        targetKey: {
          ...history.targetKey,
          lineSentAt: concurrentPublishedAt,
          lineSendCount: 2,
          lastLineSendStatus: "sent",
        },
      };
    },
  });
  const outcome = await backfillDrawLinePublication(historyRef, {
    recordId: "concurrent",
    publishedAt: PUBLISHED_AT,
    now: NOW,
  });
  assert.equal(outcome.status, "already-published");
  assert.equal(outcome.publishedAt, concurrentPublishedAt);
  assert.equal(historyRef.value.targetKey.lineSendCount, 2);
  assert.equal(historyRef.transactions, 0);
});

test("future and invalid record dates fail closed", () => {
  assert.equal(planDrawPublicationBackfill(
    [drawRecord("future", "2026-08-14")],
    {recordId: "future", publishedAt: PUBLISHED_AT, now: NOW},
  ).status, "future-record");
  assert.equal(planDrawPublicationBackfill(
    [drawRecord("invalid", "2026-02-30")],
    {recordId: "invalid", publishedAt: PUBLISHED_AT, now: NOW},
  ).status, "invalid-record-date");
});

test("AI sees the backfilled record but not another legacy unpublished record", async () => {
  const hiddenName = "Hidden Legacy - 絕對不可公開";
  const historyRef = createHistoryRef({
    publicLegacy: drawRecord("public-legacy", "2026-08-13"),
    hiddenLegacy: drawRecord("hidden-legacy", "2026-08-13", {captain: hiddenName}),
  });
  await backfillDrawLinePublication(historyRef, {
    recordId: "public-legacy",
    publishedAt: PUBLISHED_AT,
    now: NOW,
  });
  const knowledge = resolvePublishedDrawKnowledge(
    historyRef.value,
    planPublishedDrawQuery("今天抽籤結果？", NOW),
  );
  assert.equal(knowledge.record.captain, "Chia - 嘻嘻不嘻嘻");
  assert.equal(knowledge.context.includes(hiddenName), false);
  assert.equal(isDrawPublishedToLine(historyRef.value.hiddenLegacy), false);
});
