"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  AI_COOLDOWN_TEXT,
  AI_DAILY_LIMIT_TEXT,
  AI_FALLBACK_TEXT,
  AI_MAX_OUTPUT_TOKENS,
  AI_MINUTE_LIMIT_TEXT,
  AI_MODEL,
  generateMiaobingAiReply,
  normalizeAiQuestion,
  planMiaobingAiTrigger,
  processMiaobingAiRequest,
} = require("../lib/ai");
const {
  AI_DAILY_LIMIT,
  aiUserKey,
  buildAiUsageUpdate,
  reserveAiUsage,
  taipeiDateKey,
} = require("../lib/aiRateLimit");
const {MIAOBING_JOKES} = require("../lib/miaobingJokes");
const {MIAOBING_MOODS, buildMiaobingInstructions, pickMood} = require("../lib/miaobingPersona");
const {parseBotCommand} = require("../lib/line");

function textEvent(text, messageExtra = {}) {
  return {
    type: "message",
    replyToken: "reply-token",
    source: {type: "group", groupId: "C_GROUP_A", userId: "U_MEMBER_A"},
    message: {type: "text", text, ...messageExtra},
  };
}

test("1: ordinary group messages do not trigger AI", () => {
  assert.deepEqual(planMiaobingAiTrigger({event: textEvent("今晚九點有人嗎")}), {
    shouldCallAi: false,
    reason: "not-addressed",
  });
});

test("2-4: supported Miaobing name punctuation forms trigger AI", () => {
  const cases = [
    ["喵餅 你好", "你好"],
    ["喵餅，你好", "你好"],
    ["喵餅你好", "你好"],
  ];
  cases.forEach(([text, question]) => {
    const plan = planMiaobingAiTrigger({event: textEvent(text)});
    assert.equal(plan.shouldCallAi, true);
    assert.equal(plan.reason, "direct-name");
    assert.equal(plan.question, question);
  });
});

test("a true LINE bot mention triggers AI without changing mention detection semantics", () => {
  const event = textEvent("@喵餅 幫我一下", {
    mention: {mentionees: [{type: "user", userId: "U_BOT", isSelf: true}]},
  });
  const plan = planMiaobingAiTrigger({event, botUserId: "U_BOT"});
  assert.equal(plan.shouldCallAi, true);
  assert.equal(plan.reason, "true-mention");
});

test("5: existing commands always take priority over AI", () => {
  const command = parseBotCommand("!綁定 喵餅");
  assert.deepEqual(planMiaobingAiTrigger({event: textEvent("!綁定 喵餅"), command}), {
    shouldCallAi: false,
    reason: "command",
  });
});

async function assertBlockedRequest(reason, expectedText) {
  let calls = 0;
  const result = await processMiaobingAiRequest({
    apiKey: "test-key-not-real",
    question: "測試",
    reserveUsage: async () => ({allowed: false, reason}),
    generateReply: async () => { calls += 1; return {text: "不應出現"}; },
  });
  assert.equal(calls, 0);
  assert.equal(result.calledOpenAI, false);
  assert.equal(result.text, expectedText);
}

test("6: cooldown blocks without calling OpenAI", () =>
  assertBlockedRequest("cooldown", AI_COOLDOWN_TEXT));

test("7: per-user minute limit blocks without calling OpenAI", () =>
  assertBlockedRequest("minute-limit", AI_MINUTE_LIMIT_TEXT));

test("8: global daily cap of 150 blocks without calling OpenAI", async () => {
  assert.equal(AI_DAILY_LIMIT, 150);
  await assertBlockedRequest("daily-limit", AI_DAILY_LIMIT_TEXT);
});

test("rate-limit planner enforces cooldown, minute limit, and daily cap atomically", () => {
  const now = 100_000;
  const userKey = aiUserKey("U_MEMBER_A");
  const dateKey = "2026-08-13";
  const cooldown = buildAiUsageUpdate({
    daily: {[dateKey]: {count: 1}},
    users: {[userKey]: {lastRequestAt: now - 9_999, requestTimestamps: [now - 9_999]}},
  }, {dateKey, userKey, now});
  assert.equal(cooldown.reason, "cooldown");

  const minute = buildAiUsageUpdate({
    daily: {[dateKey]: {count: 1}},
    users: {[userKey]: {
      lastRequestAt: now - 10_000,
      requestTimestamps: [now - 50_000, now - 40_000, now - 30_000, now - 20_000, now - 10_000],
    }},
  }, {dateKey, userKey, now});
  assert.equal(minute.reason, "minute-limit");

  const daily = buildAiUsageUpdate({
    daily: {[dateKey]: {count: AI_DAILY_LIMIT}},
    users: {},
  }, {dateKey, userKey, now});
  assert.equal(daily.reason, "daily-limit");
});

test("9: daily counter switches by Asia/Taipei date and uses an RTDB transaction", async () => {
  assert.equal(taipeiDateKey(new Date("2026-08-12T15:59:59.999Z")), "2026-08-12");
  assert.equal(taipeiDateKey(new Date("2026-08-12T16:00:00.000Z")), "2026-08-13");
  let state = null;
  let transactions = 0;
  const ref = {transaction: async (update) => {
    transactions += 1;
    const next = update(state);
    if (next === undefined) return {committed: false};
    state = next;
    return {committed: true};
  }};
  const result = await reserveAiUsage(ref, "U_MEMBER_A", new Date("2026-08-12T16:00:00.000Z"));
  assert.equal(result.allowed, true);
  assert.equal(result.dateKey, "2026-08-13");
  assert.equal(transactions, 1);
  assert.equal(state.daily["2026-08-13"].count, 1);
  assert.equal(JSON.stringify(state).includes("U_MEMBER_A"), false);
});

test("10: OpenAI errors return the safe fixed fallback", async () => {
  const result = await processMiaobingAiRequest({
    apiKey: "test-key-not-real",
    question: "你好",
    reserveUsage: async () => ({allowed: true}),
    generateReply: async () => { throw Object.assign(new Error("sensitive detail"), {status: 429}); },
  });
  assert.equal(result.text, AI_FALLBACK_TEXT);
  assert.deepEqual(result.errorMeta, {status: 429, type: "Error"});
  assert.equal(JSON.stringify(result).includes("sensitive detail"), false);
});

test("11: a mocked Responses API response returns normal LINE text", async () => {
  let request;
  const client = {responses: {create: async (value) => {
    request = value;
    return {output_text: "先不要急，船還沒沉。"};
  }}};
  const result = await generateMiaobingAiReply({
    apiKey: "test-key-not-real",
    question: "怎麼辦",
    rng: () => 0,
    client,
  });
  assert.equal(result.text, "先不要急，船還沒沉。");
  assert.equal(request.model, AI_MODEL);
  assert.equal(request.max_output_tokens, AI_MAX_OUTPUT_TOKENS);
  assert.equal(request.store, false);
  assert.equal(request.input, "怎麼辦");
  assert.equal(normalizeAiQuestion("x".repeat(1500)).length, 1000);
});

test("a successful orchestrated AI response is ready for the LINE reply", async () => {
  let calls = 0;
  const result = await processMiaobingAiRequest({
    apiKey: "test-key-not-real",
    question: "你好",
    reserveUsage: async () => ({allowed: true}),
    generateReply: async () => { calls += 1; return {text: "在。怎麼了？"}; },
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, {text: "在。怎麼了？", calledOpenAI: true, reason: "success"});
});

test("12: mood selection varies and is injectable", () => {
  assert.equal(pickMood(() => 0), MIAOBING_MOODS[0]);
  assert.equal(pickMood(() => 0.999), MIAOBING_MOODS.at(-1));
  assert.notEqual(pickMood(() => 0), pickMood(() => 0.999));
});

test("13: relevant canonical joke and immutable meaning are included in instructions", () => {
  const instructions = buildMiaobingInstructions({question: "第四船艙要捐幾張船票？", mood: "測試 mood"});
  const joke = MIAOBING_JOKES.find((item) => item.id === "cabin-four-tickets");
  assert.match(instructions, new RegExp(joke.core));
  assert.match(instructions, new RegExp(joke.immutableMeaning));
  assert.match(instructions, /immutable meaning 絕對不可改/);
});

test("14: a missing API key fails safely without reserving usage or calling OpenAI", async () => {
  let reserveCalls = 0;
  let aiCalls = 0;
  const result = await processMiaobingAiRequest({
    apiKey: "",
    question: "你好",
    reserveUsage: async () => { reserveCalls += 1; return {allowed: true}; },
    generateReply: async () => { aiCalls += 1; return {text: "不應出現"}; },
  });
  assert.equal(result.text, AI_FALLBACK_TEXT);
  assert.equal(result.reason, "missing-api-key");
  assert.equal(reserveCalls, 0);
  assert.equal(aiCalls, 0);
});
