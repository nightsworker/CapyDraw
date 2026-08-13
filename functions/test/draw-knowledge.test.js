"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
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
} = require("../lib/drawKnowledge");
const {generateMiaobingAiReply} = require("../lib/ai");

const NOW = new Date("2026-08-12T16:30:00.000Z");
const HIDDEN_NAMES = [
  "Hidden Captain - 秘密船長",
  "Hidden Guardian - 秘密守護",
  "Hidden Cabin - 秘密船艙",
];

function drawRecord(date, overrides = {}) {
  return {
    id: `record-${date}`,
    date,
    createdAt: `${date}T01:00:00.000Z`,
    specialDay: false,
    captain: "Rain - 流鬼",
    guardian: "@Hank - 挖系小嗨",
    cabin4: ["Chia - 嘻嘻不嘻嘻", "KevenWz - 少冰養老"],
    consumed: {captain: ["private pool name"]},
    poolSnapshots: {before: {captainPool: ["private candidate"]}},
    ...overrides,
  };
}

function publishedRecord(date, overrides = {}) {
  return drawRecord(date, {
    lineSentAt: `${date}T02:00:00.000Z`,
    lineSendCount: 1,
    lastLineSendStatus: "sent",
    ...overrides,
  });
}

function hiddenRecord(date) {
  return drawRecord(date, {
    captain: HIDDEN_NAMES[0],
    guardian: HIDDEN_NAMES[1],
    cabin4: [HIDDEN_NAMES[2]],
  });
}

test("A/B/M: existing and legacy records without provable LINE publication fail closed", () => {
  assert.equal(isDrawPublishedToLine({date: "2026-08-13"}), false);
  assert.equal(isDrawPublishedToLine(drawRecord("2026-08-13")), false);
  assert.equal(isDrawPublishedToLine(drawRecord("2026-08-13", {
    lineSendCount: 1,
    lastLineSendStatus: "sent",
  })), false);
  assert.equal(isDrawPublishedToLine(drawRecord("2026-08-13", {
    lineSentAt: "2026-08-13T02:00:00.000Z",
    lastLineSendStatus: "sent",
  })), false);
  assert.equal(isDrawPublishedToLine(drawRecord("2026-08-13", {
    lineSentAt: "not-a-date",
    lineSendCount: 1,
  })), false);
});

test("C: a successful LINE publication is available with public fields only", () => {
  const raw = publishedRecord("2026-08-13");
  assert.equal(isDrawPublishedToLine(raw), true);
  const sanitized = sanitizePublishedDrawRecord(raw);
  assert.deepEqual(Object.keys(sanitized), ["date", "specialDay", "captain", "guardian", "cabin4"]);
  assert.equal(JSON.stringify(sanitized).includes("poolSnapshots"), false);
  assert.equal(JSON.stringify(sanitized).includes("consumed"), false);
  assert.equal(JSON.stringify(sanitized).includes("createdAt"), false);
});

test("publication evidence does not depend on the latest status after a failed resend", () => {
  const record = publishedRecord("2026-08-13", {lastLineSendStatus: "failed"});
  assert.equal(isDrawPublishedToLine(record), true);
});

test("draw query detection is on-demand and supports required query forms", () => {
  for (const question of [
    "今天誰是船長？",
    "今天守護天使是誰？",
    "今天第四船艙有誰？",
    "今天抽籤結果？",
    "今天抽了誰？",
    "昨天船長是誰？",
    "8/10 抽籤結果？",
    "2026-08-10 船長是誰？",
  ]) {
    assert.equal(planPublishedDrawQuery(question, NOW).shouldRetrieve, true, question);
  }
  for (const question of ["你好", "狗狗比較可愛", "你是誰", "今天要捐幾張船票？"]) {
    assert.deepEqual(planPublishedDrawQuery(question, NOW), {
      shouldRetrieve: false,
      reason: "not-draw-query",
    }, question);
  }
});

test("date resolution uses Asia/Taipei for today, yesterday, future and explicit dates", () => {
  assert.equal(taipeiDateKey(NOW), "2026-08-13");
  assert.equal(resolveRequestedDrawDate("今天船長", NOW), "2026-08-13");
  assert.equal(resolveRequestedDrawDate("昨天船長", NOW), "2026-08-12");
  assert.equal(resolveRequestedDrawDate("明天船長", NOW), "2026-08-14");
  assert.equal(resolveRequestedDrawDate("8/10 船長", NOW), "2026-08-10");
  assert.equal(resolveRequestedDrawDate("2025-12-31 船長", NOW), "2025-12-31");
});

test("unindexed retrieval uses only historyRef.get and resolves the requested published date", async () => {
  let reads = 0;
  const historyRef = {
    get: async () => {
      reads += 1;
      return {val: () => ({
        hidden: hiddenRecord("2026-08-13"),
        published: publishedRecord("2026-08-13", {
          captain: "Target Captain - 指定日期船長",
        }),
        other: publishedRecord("2026-08-12"),
      })};
    },
  };
  const knowledge = await loadPublishedDrawKnowledge(
    historyRef,
    planPublishedDrawQuery("今天船長是誰？", NOW),
  );
  assert.equal(reads, 1);
  assert.equal(knowledge.record.captain, "Target Captain - 指定日期船長");
  HIDDEN_NAMES.forEach((name) => assert.equal(knowledge.context.includes(name), false));
});

test("unindexed retrieval resolves latest from published records only", async () => {
  const historyRef = {get: async () => ({val: () => ({
    old: publishedRecord("2026-08-10"),
    latest: publishedRecord("2026-08-12", {captain: "Latest Captain - 最新船長"}),
    newerHidden: hiddenRecord("2026-08-14"),
  })})};
  const knowledge = await loadPublishedDrawKnowledge(
    historyRef,
    planPublishedDrawQuery("最近一次抽籤結果？", NOW),
  );
  assert.equal(knowledge.record.captain, "Latest Captain - 最新船長");
  HIDDEN_NAMES.forEach((name) => assert.equal(knowledge.context.includes(name), false));
});

test("ordinary AI questions never read draw history", async () => {
  let reads = 0;
  const historyRef = {get: async () => {
    reads += 1;
    return {val: () => ({})};
  }};
  const knowledge = await loadPublishedDrawKnowledge(
    historyRef,
    planPublishedDrawQuery("你好", NOW),
  );
  assert.equal(reads, 0);
  assert.deepEqual(knowledge, {record: null, context: ""});
});

test("D/E/F: group and admin private queries cannot retrieve today's hidden names", () => {
  const history = [hiddenRecord("2026-08-13")];
  for (const sourceType of ["group", "user"]) {
    const plan = planPublishedDrawQuery("今天第四船艙有誰？", NOW);
    const knowledge = resolvePublishedDrawKnowledge(history, plan);
    assert.equal(knowledge.record, null, sourceType);
    assert.match(knowledge.context, /沒有可公開的/u);
    HIDDEN_NAMES.forEach((name) => assert.equal(knowledge.context.includes(name), false, sourceType));
  }
});

test("G/H: today never falls back to yesterday, while an explicit yesterday query works", () => {
  const history = [publishedRecord("2026-08-12"), hiddenRecord("2026-08-13")];
  const today = resolvePublishedDrawKnowledge(
    history,
    planPublishedDrawQuery("今天船長是誰？", NOW),
  );
  assert.equal(today.record, null);
  assert.equal(today.context.includes("Rain - 流鬼"), false);
  const yesterday = resolvePublishedDrawKnowledge(
    history,
    planPublishedDrawQuery("昨天船長是誰？", NOW),
  );
  assert.equal(yesterday.record.date, "2026-08-12");
  assert.match(yesterday.context, /船長：Rain - 流鬼/u);
});

test("I: a future hidden result remains unavailable and cannot be predicted", () => {
  const knowledge = resolvePublishedDrawKnowledge(
    [hiddenRecord("2026-08-14")],
    planPublishedDrawQuery("明天船長是誰？", NOW),
  );
  assert.equal(knowledge.record, null);
  assert.match(knowledge.context, /不得推測/u);
  HIDDEN_NAMES.forEach((name) => assert.equal(knowledge.context.includes(name), false));
});

test("J: latest lookup ignores newer unpublished records", () => {
  const history = [
    publishedRecord("2026-08-10"),
    publishedRecord("2026-08-12", {captain: "Latest Public - 最新公開"}),
    hiddenRecord("2026-08-13"),
    hiddenRecord("2026-08-14"),
  ];
  assert.equal(findLatestPublishedDraw(history).captain, "Latest Public - 最新公開");
  const knowledge = resolvePublishedDrawKnowledge(
    history,
    planPublishedDrawQuery("最近一次抽籤結果？", NOW),
  );
  assert.match(knowledge.context, /Latest Public - 最新公開/u);
  HIDDEN_NAMES.forEach((name) => assert.equal(knowledge.context.includes(name), false));
});

test("K: unpublished names are completely absent from the mocked OpenAI request", async () => {
  const history = [
    hiddenRecord("2026-08-13"),
    publishedRecord("2026-08-13", {captain: "Public Captain - 公開船長"}),
  ];
  const plan = planPublishedDrawQuery("今天抽籤結果？", NOW);
  const {context} = resolvePublishedDrawKnowledge(history, plan);
  let request;
  const client = {responses: {create: async (value) => {
    request = value;
    return {status: "completed", output_text: "今天目前沒有公開結果。"};
  }}};
  await generateMiaobingAiReply({
    apiKey: "test-key-not-real",
    question: "今天抽籤結果？",
    authoritativeContext: context,
    rng: () => 0,
    client,
  });
  const payload = JSON.stringify(request);
  HIDDEN_NAMES.forEach((name) => assert.equal(payload.includes(name), false));
  assert.equal(payload.includes("Public Captain - 公開船長"), true);
  assert.match(request.instructions, /PUBLISHED DRAW DATA — AUTHORITATIVE/u);
  assert.match(request.instructions, /船長：Public Captain - 公開船長/u);
});

test("published lookup normalizes arrays and objects without exposing internal fields", () => {
  const objectHistory = {
    hidden: hiddenRecord("2026-08-13"),
    public: publishedRecord("2026-08-12"),
  };
  assert.equal(listPublishedDrawRecords(objectHistory).length, 1);
  assert.equal(findPublishedDrawByDate(objectHistory, "2026-08-12").date, "2026-08-12");
  assert.equal(findPublishedDrawByDate(objectHistory, "2026-08-13"), null);
  assert.equal(buildPublishedDrawContext(hiddenRecord("2026-08-13"), {
    date: "2026-08-13",
  }).includes(HIDDEN_NAMES[0]), false);
});
