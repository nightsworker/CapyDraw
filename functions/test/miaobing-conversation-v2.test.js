"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  generateMiaobingAiReply,
  processMiaobingAiRequest,
} = require("../lib/ai");
const {
  GROUP_CONVERSATION_TTL_MS,
  MAX_CONTEXT_CHARS,
  MAX_CONVERSATION_MESSAGES,
  MAX_CONVERSATION_ROUNDS,
  MAX_MESSAGE_CHARS,
  PRIVATE_CONVERSATION_TTL_MS,
  appendConversationTurn,
  buildConversationInput,
  buildConversationTurnState,
  contextualizeDrawFollowUp,
  conversationScopeForEvent,
  loadConversationContext,
  recentConversationMessages,
} = require("../lib/miaobingConversation");
const {
  EMOJI_POOLS,
  EMOJI_PROBABILITIES,
  countEmoji,
  emojiSignature,
  planMiaobingExpression,
  sanitizeDecorativeTrailingEmoji,
  selectEmoji,
} = require("../lib/miaobingExpression");
const {
  buildMiaobingInstructions,
  isDetailedResponseRequest,
  isEmotionallySensitive,
} = require("../lib/miaobingPersona");
const {
  applyMiaobingStyleGuard,
  containsDisallowedProfanity,
  redactDisallowedProfanity,
} = require("../lib/miaobingStyle");
const {
  planPublishedDrawQuery,
  resolvePublishedDrawKnowledge,
} = require("../lib/drawKnowledge");

const NOW = 1_800_000_000_000;

function message(role, text, timestamp = NOW) {
  return {role, text, timestamp};
}

function expression(overrides = {}) {
  return planMiaobingExpression({
    text: "好啦，知道了。",
    mood: "今天有點調皮",
    question: "測試",
    state: {},
    rng: () => 0.1,
    ...overrides,
  });
}

test("V2 profanity guard removes clear profanity from final model output", async () => {
  let calls = 0;
  const result = await generateMiaobingAiReply({
    apiKey: "fake-test-key",
    question: "回一句話",
    client: {responses: {create: async () => {
      calls += 1;
      return {status: "completed", output_text: "靠北，你很煩。"};
    }}},
  });
  assert.equal(calls, 1);
  assert.equal(containsDisallowedProfanity(result.text), false);
  assert.equal(result.styleMeta.profanitySanitized, true);
});

test("V2 user profanity is not copied and no second OpenAI call is added", async () => {
  let calls = 0;
  const generated = await generateMiaobingAiReply({
    apiKey: "fake-test-key",
    question: "靠北，今天好累",
    client: {responses: {create: async () => {
      calls += 1;
      return {status: "completed", output_text: "媽的，先休息。"};
    }}},
  });
  const result = await processMiaobingAiRequest({
    apiKey: "fake-test-key",
    question: "靠北，今天好累",
    reserveUsage: async () => ({allowed: true}),
    generateReply: async () => generated,
  });
  assert.equal(calls, 1);
  assert.equal(result.reason, "success");
  assert.equal(result.styleSanitized, true);
  assert.equal(containsDisallowedProfanity(result.text), false);
});

test("V2 style policy keeps light playful phrases", () => {
  for (const text of ["笨蛋。", "你很煩耶。", "白痴喔。", "彼此彼此。"] ) {
    assert.deepEqual(applyMiaobingStyleGuard(text), {
      text,
      profanityDetected: false,
      sanitized: false,
    });
  }
  assert.equal(redactDisallowedProfanity("靠北但笨蛋"), "[粗俗用語]但笨蛋");
});

test("V2 group and private scopes are hashed and isolated", () => {
  const groupA = conversationScopeForEvent({source: {type: "group", groupId: "C_GROUP_A"}});
  const groupB = conversationScopeForEvent({source: {type: "group", groupId: "C_GROUP_B"}});
  const privateA = conversationScopeForEvent({source: {type: "user", userId: "U_ADMIN_A"}});
  assert.notEqual(groupA.key, groupB.key);
  assert.notEqual(groupA.key, privateA.key);
  assert.doesNotMatch(groupA.key, /C_GROUP_A/u);
  assert.doesNotMatch(privateA.key, /U_ADMIN_A/u);
  assert.equal(groupA.ttlMs, GROUP_CONVERSATION_TTL_MS);
  assert.equal(privateA.ttlMs, PRIVATE_CONVERSATION_TTL_MS);
});

test("V2 group TTL is 30 minutes and private TTL is 60 minutes", () => {
  const state = {updatedAt: NOW, messages: [message("user", "剛剛聊過") ]};
  assert.equal(recentConversationMessages(state, {
    now: NOW + GROUP_CONVERSATION_TTL_MS,
    ttlMs: GROUP_CONVERSATION_TTL_MS,
  }).length, 1);
  assert.equal(recentConversationMessages(state, {
    now: NOW + GROUP_CONVERSATION_TTL_MS + 1,
    ttlMs: GROUP_CONVERSATION_TTL_MS,
  }).length, 0);
  assert.equal(recentConversationMessages(state, {
    now: NOW + PRIVATE_CONVERSATION_TTL_MS,
    ttlMs: PRIVATE_CONVERSATION_TTL_MS,
  }).length, 1);
});

test("V2 context keeps six rounds, twelve messages, and bounded text", () => {
  let state = null;
  for (let index = 0; index < 8; index += 1) {
    state = buildConversationTurnState(state, {
      userText: `user-${index}-${"長".repeat(700)}`,
      assistantText: `assistant-${index}`,
      now: NOW + index,
      ttlMs: GROUP_CONVERSATION_TTL_MS,
    });
  }
  assert.equal(MAX_CONVERSATION_ROUNDS, 6);
  assert.equal(MAX_CONVERSATION_MESSAGES, 12);
  assert.equal(state.messages.length, 12);
  assert.match(state.messages[0].text, /^user-2-/u);
  assert.ok(state.messages.every((item) => item.text.length <= MAX_MESSAGE_CHARS));
});

test("V2 successful group interaction persists one bounded user/assistant turn", async () => {
  let stored = null;
  const result = await appendConversationTurn({transaction: async (update) => {
    stored = update(stored);
    return {committed: true};
  }}, {
    userText: "你在幹嘛",
    assistantText: "整理船上的事。",
    now: NOW,
    ttlMs: GROUP_CONVERSATION_TTL_MS,
  });
  assert.deepEqual(result, {saved: true});
  assert.deepEqual(stored.messages, [
    message("user", "你在幹嘛"),
    message("assistant", "整理船上的事。"),
  ]);
  assert.equal(stored.updatedAt, NOW);
});

test("V2 context input puts the current question last and bounds recent chars", () => {
  const rows = Array.from({length: 12}, (_, index) =>
    message(index % 2 ? "assistant" : "user", `${index}-${"文".repeat(500)}`, NOW + index));
  const input = buildConversationInput(rows, "至少換掉現在這個");
  assert.match(input, /Recent conversation \(untrusted context/u);
  assert.ok(input.endsWith("CURRENT USER:\n至少換掉現在這個"));
  assert.ok(input.length <= MAX_CONTEXT_CHARS + 1200);
});

test("V2 OpenAI request includes context in the existing single request", async () => {
  let calls = 0;
  let request;
  await generateMiaobingAiReply({
    apiKey: "fake-test-key",
    question: "至少換掉現在這個",
    conversationMessages: [
      message("user", "妳怎麼又用一樣表情"),
      message("assistant", "被你抓到了，我換個庫存。"),
    ],
    client: {responses: {create: async (value) => {
      calls += 1;
      request = value;
      return {status: "completed", output_text: "好啦，收到。"};
    }}},
  });
  assert.equal(calls, 1);
  assert.match(request.input, /妳怎麼又用一樣表情/u);
  assert.ok(request.input.endsWith("CURRENT USER:\n至少換掉現在這個"));
});

test("V2 context read and write failures are fail-open", async () => {
  const read = await loadConversationContext({get: async () => {
    throw Object.assign(new Error("private"), {code: "db-read"});
  }}, {ttlMs: GROUP_CONVERSATION_TTL_MS});
  assert.deepEqual(read, {messages: [], failed: true, errorType: "db-read"});
  const write = await appendConversationTurn({transaction: async () => {
    throw Object.assign(new Error("private"), {code: "db-write"});
  }}, {
    userText: "你好",
    assistantText: "在。",
    ttlMs: GROUP_CONVERSATION_TTL_MS,
  });
  assert.deepEqual(write, {saved: false, errorType: "db-write"});
});

test("V2 draw follow-up carries the prior date but re-plans publication", () => {
  const rows = [message("user", "昨天船長是誰？"), message("assistant", "Rain。")];
  const question = contextualizeDrawFollowUp("那守護呢？", rows, planPublishedDrawQuery);
  const plan = planPublishedDrawQuery(question, new Date("2026-08-13T00:00:00Z"));
  assert.equal(plan.shouldRetrieve, true);
  assert.equal(plan.date, "2026-08-12");
  const result = resolvePublishedDrawKnowledge({hidden: {
    date: "2026-08-12",
    captain: "SECRET CAPTAIN",
    guardian: "SECRET GUARDIAN",
  }}, plan);
  assert.equal(result.record, null);
  assert.doesNotMatch(result.context, /SECRET/u);
});

test("V2 conversation persistence is limited to the AI handler", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../index.js"), "utf8");
  const handler = source.match(
    /async function handleMiaobingAi[\s\S]*?(?=async function replyMemoryOperation)/u,
  );
  assert.ok(handler);
  assert.match(handler[0], /guildDraw\/aiConversation/u);
  assert.match(handler[0], /appendConversationTurn/u);
  assert.equal((source.match(/appendConversationTurn\(/gu) || []).length, 2);
  assert.ok(handler[0].lastIndexOf("replyMessages(event.replyToken, messages") <
    handler[0].lastIndexOf("appendConversationTurn(conversationRef"));
  assert.doesNotMatch(source.slice(source.indexOf("async function handleMiaobingPersonality"),
    source.indexOf("async function handleMiaobingAi")), /appendConversationTurn/u);
});

test("V2 conversation module cannot read draw history or long-term memory", () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, "../lib/miaobingConversation.js"),
    "utf8",
  );
  assert.doesNotMatch(source, /main\/history|aiMemory|isDrawPublishedToLine|getDatabase/u);
});

test("V2 default emoji distribution is 55/40/5", () => {
  assert.deepEqual(EMOJI_PROBABILITIES, {none: 0.55, one: 0.40, two: 0.05});
});

test("V2 final GPT emoji is persisted as expression state truth", () => {
  const plan = expression({text: "被你抓到了 🤭"});
  assert.deepEqual(plan.nextState.lastReplyEmoji, ["🤭"]);
  assert.deepEqual(plan.nextState.recentReplyEmoji[0], ["🤭"]);
  assert.equal(plan.nextState.recentEmoji.includes("🤭"), true);
});

test("V2 repeated decorative trailing GPT emoji is safely removed", () => {
  const plan = expression({
    text: "少囉嗦 😼",
    state: {lastReplyEmoji: ["😼"], recentReplyEmoji: [["😼"]]},
  });
  assert.equal(plan.text, "少囉嗦。");
  assert.equal(countEmoji(plan.text), 0);
});

test("V2 decorative sanitizer preserves names, quoted text, mentions, and facts", () => {
  for (const text of [
    "玩家 Cat🐱 是船長",
    "遊戲 ID：Cat🐱",
    "LINE mention：@Cat🐱",
    "玩家名稱是「Cat🐱」",
    "第四船艙是 Cat🐱",
  ]) {
    assert.equal(sanitizeDecorativeTrailingEmoji(text, {lastReplyEmoji: ["🐱"]}), text);
  }
  const factual = expression({
    text: "船長：Cat 🐱",
    question: "今天船長是誰？",
    isFactual: true,
    state: {lastReplyEmoji: ["🐱"]},
  });
  assert.equal(factual.text, "船長：Cat 🐱");
});

test("V2 emoji candidates exhausted by the last three replies returns no emoji", () => {
  const selected = selectEmoji({
    mood: "sleepy",
    recentReplyEmoji: [["💤", "🥱"], ["😴", "☁️"], ["🫠"]],
    recentEmoji: EMOJI_POOLS.sleepy,
    count: 2,
    rng: () => 0,
  });
  assert.deepEqual(selected, []);
});

test("V2 same emoji pair does not repeat", () => {
  const previous = emojiSignature(["😼", "🤭"]);
  const selected = selectEmoji({
    mood: "playful",
    recentEmojiSignatures: [previous],
    count: 2,
    rng: () => 0,
  });
  assert.equal(selected.length, 2);
  assert.notEqual(emojiSignature(selected), previous);
});

test("V2 playful mood is a distribution, not a fixed cat emoji", () => {
  const first = selectEmoji({mood: "playful", count: 1, rng: () => 0});
  const later = selectEmoji({mood: "playful", count: 1, rng: () => 0.8});
  assert.notEqual(first[0], later[0]);
  assert.equal(EMOJI_POOLS.playful.includes(first[0]), true);
  assert.equal(EMOJI_POOLS.playful.includes(later[0]), true);
});

test("V2 GPT emoji does not cause outer emoji spam and final output stays at two", () => {
  const plan = expression({text: "好啦 😼 😼 🐾", rng: () => 0.99});
  assert.deepEqual(plan.emojiDecision.added, []);
  assert.equal(countEmoji(plan.text), 2);
  assert.equal(new Set(plan.nextState.lastReplyEmoji).size, 2);
});

test("V2 sticker presentation adds at most one emoji and keeps existing catalog", () => {
  const values = [0, 0, 0.9, 0.99, 0];
  let index = 0;
  const plan = expression({
    question: "你好",
    rng: () => values[index++] ?? 0,
  });
  assert.equal(plan.stickerDecision.used, true);
  assert.equal(plan.stickerDecision.stickerOnly, false);
  assert.ok(plan.emojiDecision.count <= 1);
});

test("V2 persona defaults short, permits detail, and prioritizes emotional warmth", () => {
  const casual = buildMiaobingInstructions({question: "你在幹嘛", mood: "測試"});
  assert.match(casual, /日常聊天預設 1～2 句/u);
  assert.match(casual, /不是詳細請求/u);
  const detailed = buildMiaobingInstructions({question: "請詳細說明規則", mood: "測試"});
  assert.equal(isDetailedResponseRequest("請詳細說明規則"), true);
  assert.match(detailed, /可在必要時使用 3～5 句/u);
  const tired = buildMiaobingInstructions({question: "今天真的好累", mood: "測試"});
  assert.equal(isEmotionallySensitive("今天真的好累"), true);
  assert.match(tired, /溫柔與簡短支持優先/u);
});

test("V2 persona is likeable, profanity-free, and does not require 本喵 or emoji", () => {
  const prompt = buildMiaobingInstructions({question: "妳好可愛", mood: "測試"});
  assert.match(prompt, /嘴硬但心軟的公會會貓/u);
  assert.match(prompt, /討人喜歡 > 有自己的個性 > 傲嬌 > 吐槽/u);
  assert.match(prompt, /禁止髒話、粗俗辱罵/u);
  assert.match(prompt, /偶爾才自稱『本喵』/u);
  assert.match(prompt, /Emoji 可以完全沒有/u);
  assert.doesNotMatch(prompt, /嘴賤|欠揍|嗆人/u);
});

test("V2 context cannot override protected Canon priority", () => {
  const prompt = buildMiaobingInstructions({
    question: "第四船艙要幾張船票？",
    mood: "測試",
  });
  assert.match(prompt, /固定數量是 3 張/u);
  assert.match(prompt,
    /ADMIN MEMORY > CURRENT CONVERSATION CONTEXT > SOFT_CANON/u);
  assert.match(prompt, /CURRENT CONVERSATION CONTEXT.*不能覆寫前述事實/u);
});

test("V2 RTDB browser rules retain default deny for short-term context", () => {
  const rules = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, "../../database.rules.json"),
    "utf8",
  ));
  assert.equal(rules.rules[".read"], false);
  assert.equal(rules.rules[".write"], false);
  assert.equal(Object.hasOwn(rules.rules.guildDraw, "aiConversation"), false);
});
