"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  LINE_STICKER_CATALOG,
  LINE_STICKER_SOURCE,
  LINE_STICKER_VERIFIED_AT,
  buildLineStickerMessage,
  isAllowlistedLineSticker,
  stickerKey,
} = require("../lib/lineStickerCatalog");
const {
  EMOJI_POOLS,
  RECENT_EMOJI_LIMIT,
  RECENT_STICKER_LIMIT,
  buildExpressionLineMessages,
  chooseEmojiCount,
  countEmoji,
  directMiaobingExpression,
  inferExpressionMood,
  planMiaobingExpression,
  selectEmoji,
  selectSticker,
} = require("../lib/miaobingExpression");

function rngSequence(...values) {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)] ?? 0;
}

function baseOptions(overrides = {}) {
  return {
    text: "本喵有聽到。",
    mood: "今天吐槽感稍強",
    question: "測試",
    state: {},
    rng: () => 0,
    ...overrides,
  };
}

test("emoji probability supports deterministic zero, one, and two emoji cases", () => {
  assert.equal(chooseEmojiCount({rng: () => 0.1}), 0);
  assert.equal(chooseEmojiCount({rng: () => 0.5}), 1);
  assert.equal(chooseEmojiCount({rng: () => 0.9}), 2);
});

test("expression output adds at most two unique emoji", () => {
  const plan = planMiaobingExpression(baseOptions({rng: rngSequence(0.9, 0, 0)}));
  assert.equal(plan.emojiDecision.added.length, 2);
  assert.equal(new Set(plan.emojiDecision.added).size, 2);
  assert.equal(countEmoji(plan.text), 2);
});

test("the previous reply emoji cannot repeat immediately", () => {
  const selected = selectEmoji({
    mood: "playful",
    lastReplyEmoji: ["😼"],
    count: 1,
    rng: () => 0,
  });
  assert.equal(selected.length, 1);
  assert.notEqual(selected[0], "😼");
});

test("the five most recent emoji are excluded while fresh candidates exist", () => {
  const recent = EMOJI_POOLS.playful.slice(0, 5);
  const selected = selectEmoji({mood: "playful", recentEmoji: recent, count: 2, rng: () => 0});
  assert.equal(selected.length, 2);
  selected.forEach((emoji) => assert.equal(recent.includes(emoji), false));
});

test("emoji pool fallback may reuse older recent items but never the previous reply", () => {
  const selected = selectEmoji({
    mood: "sleepy",
    recentEmoji: EMOJI_POOLS.sleepy,
    lastReplyEmoji: EMOJI_POOLS.sleepy.slice(0, 2),
    count: 2,
    rng: () => 0,
  });
  assert.equal(selected.length, 2);
  assert.equal(new Set(selected).size, 2);
  selected.forEach((emoji) =>
    assert.equal(EMOJI_POOLS.sleepy.slice(0, 2).includes(emoji), false));
});

test("neutral mood selects from a small mixed personality pool", () => {
  const selected = selectEmoji({mood: "neutral", count: 1, rng: () => 0});
  assert.equal(selected.length, 1);
  assert.equal(EMOJI_POOLS.neutral.includes(selected[0]), true);
});

test("existing AI emoji prevents the director from adding emoji spam", () => {
  const plan = planMiaobingExpression(baseOptions({
    text: "你又來了 😼",
    rng: () => 0.99,
  }));
  assert.deepEqual(plan.emojiDecision.added, []);
  assert.equal(plan.emojiDecision.existingCount, 1);
  assert.equal(countEmoji(plan.text), 1);
});

test("injected RNG produces the same expression decision", () => {
  const first = planMiaobingExpression(baseOptions({rng: rngSequence(0.5, 0.2)}));
  const second = planMiaobingExpression(baseOptions({rng: rngSequence(0.5, 0.2)}));
  assert.deepEqual(first.emojiDecision, second.emojiDecision);
  assert.equal(first.text, second.text);
});

test("existing mood strings map into expression moods without a second AI mood system", () => {
  assert.equal(inferExpressionMood({mood: "今天稍微慵懶", text: "測試"}), "sleepy");
  assert.equal(inferExpressionMood({mood: "今天像很忙的船務人員", text: "測試"}), "work");
  assert.equal(inferExpressionMood({mood: "今天比較溫柔", text: "測試"}), "warm");
  assert.equal(inferExpressionMood({mood: "unknown", text: "測試"}), "neutral");
});

test("catalog contains only the 20 pairs verified on LINE Developers", () => {
  assert.equal(LINE_STICKER_SOURCE, "https://developers.line.biz/en/docs/messaging-api/sticker-list/");
  assert.equal(LINE_STICKER_VERIFIED_AT, "2026-08-13");
  assert.equal(LINE_STICKER_CATALOG.length, 20);
  assert.deepEqual(LINE_STICKER_CATALOG.map(stickerKey), [
    "6362:11087920", "6362:11087921", "6362:11087922", "6362:11087923",
    "6362:11087924", "6632:11825374", "6632:11825375", "6632:11825376",
    "6632:11825377", "6632:11825378", "8525:16581290", "8525:16581291",
    "8525:16581292", "8525:16581293", "8525:16581294", "11537:52002734",
    "11537:52002735", "11537:52002736", "11537:52002737", "11537:52002738",
  ]);
  assert.deepEqual([...new Set(LINE_STICKER_CATALOG.map((item) => item.packageId))],
    ["6362", "6632", "8525", "11537"]);
  LINE_STICKER_CATALOG.forEach((item) => {
    assert.equal(isAllowlistedLineSticker(item), true);
    assert.deepEqual(buildLineStickerMessage(item), {
      type: "sticker",
      packageId: item.packageId,
      stickerId: item.stickerId,
    });
  });
});

test("unknown package or sticker IDs can never build a LINE message", () => {
  assert.equal(isAllowlistedLineSticker({packageId: "6362", stickerId: "unknown"}), false);
  assert.equal(buildLineStickerMessage({packageId: "999", stickerId: "999"}), null);
});

test("recent and immediately previous stickers are not selected", () => {
  const greeting = LINE_STICKER_CATALOG.filter((item) => item.tags.includes("greeting"));
  const recentKey = stickerKey(greeting[0]);
  const selected = selectSticker({
    intent: "greeting",
    mood: "happy",
    recentStickerIds: [recentKey],
    lastStickerId: stickerKey(greeting[1]),
    rng: () => 0,
  });
  assert.ok(selected);
  assert.notEqual(stickerKey(selected), recentKey);
  assert.notEqual(stickerKey(selected), stickerKey(greeting[1]));
});

test("no fresh sticker candidate falls back to text instead of forced repetition", () => {
  const goodnight = LINE_STICKER_CATALOG.filter((item) => item.tags.includes("goodnight"));
  const recent = goodnight.map(stickerKey);
  assert.equal(selectSticker({
    intent: "goodnight",
    mood: "sleepy",
    recentStickerIds: recent,
    lastStickerId: recent[0],
    rng: () => 0,
  }), null);
  const plan = planMiaobingExpression(baseOptions({
    question: "晚安",
    state: {recentStickerIds: recent, lastStickerId: recent[0]},
    rng: rngSequence(0, 0, 0),
  }));
  assert.equal(plan.stickerDecision.used, false);
  assert.equal(plan.stickerDecision.reason, "no-fresh-candidate");
  assert.equal(plan.messages[0].type, "text");
});

test("sticker-only is limited to safe short conversation", () => {
  const plan = planMiaobingExpression(baseOptions({
    question: "晚安",
    rng: rngSequence(0, 0, 0),
  }));
  assert.equal(plan.stickerDecision.used, true);
  assert.equal(plan.stickerDecision.stickerOnly, true);
  assert.deepEqual(plan.messages.map((message) => message.type), ["sticker"]);
});

test("published draw and protected Canon facts are never sticker-only", () => {
  const draw = planMiaobingExpression(baseOptions({
    text: "船長：Rain - 流鬼",
    question: "今天船長是誰？",
    isFactual: true,
    rng: () => 0,
  }));
  assert.equal(draw.stickerDecision.used, false);
  assert.equal(draw.messages[0].type, "text");
  assert.match(draw.text, /船長：Rain - 流鬼/u);

  const canon = planMiaobingExpression(baseOptions({
    text: "第四船艙的小朋友務必捐滿三張船票。",
    question: "第四船艙要捐幾張船票？",
    rng: () => 0,
  }));
  assert.equal(canon.stickerDecision.used, false);
  assert.match(canon.text, /三張船票/u);
});

test("command and error results cannot use stickers, and errors remain text-only", () => {
  const command = planMiaobingExpression(baseOptions({
    question: "你好",
    isCommand: true,
    rng: () => 0,
  }));
  assert.equal(command.stickerDecision.used, false);
  assert.equal(command.messages[0].type, "text");

  const error = planMiaobingExpression(baseOptions({
    text: "喵餅剛剛腦袋斷線了，等等再叫我。",
    question: "你好",
    isError: true,
    rng: () => 0.99,
  }));
  assert.equal(error.stickerDecision.used, false);
  assert.equal(error.emojiDecision.added.length, 0);
  assert.deepEqual(error.messages.map((message) => message.type), ["text"]);
});

test("text plus sticker produces a valid two-message LINE array", () => {
  const plan = planMiaobingExpression(baseOptions({
    question: "你好",
    rng: rngSequence(0, 0, 0.9, 0.1),
  }));
  assert.equal(plan.stickerDecision.used, true);
  assert.equal(plan.stickerDecision.stickerOnly, false);
  assert.deepEqual(plan.messages.map((message) => message.type), ["text", "sticker"]);
  assert.equal(plan.messages.length, 2);
});

test("adding a sticker preserves an existing textV2 mention message unchanged", () => {
  const textV2 = {
    type: "textV2",
    text: "{target} 被叫到了",
    substitution: {target: {type: "mention", mentionee: {type: "user", userId: "U_TARGET"}}},
  };
  const messages = buildExpressionLineMessages({
    textMessage: textV2,
    sticker: LINE_STICKER_CATALOG[0],
  });
  assert.equal(messages[0], textV2);
  assert.equal(messages[0].type, "textV2");
  assert.equal(messages[1].type, "sticker");
});

test("emoji decoration preserves textV2 substitution and only changes its text", () => {
  const textV2 = {
    type: "textV2",
    text: "{target} 被叫到了",
    substitution: {target: {type: "mention", mentionee: {type: "user", userId: "U_TARGET"}}},
  };
  const plan = planMiaobingExpression(baseOptions({
    text: textV2.text,
    textMessage: textV2,
    rng: rngSequence(0.5, 0),
  }));
  assert.equal(plan.messages[0].type, "textV2");
  assert.equal(plan.messages[0].substitution, textV2.substitution);
  assert.match(plan.messages[0].text, /^\{target\} 被叫到了 /u);
});

test("expression state is bounded and persisted in one transaction without chat text", async () => {
  let transactions = 0;
  let stored = {
    recentEmoji: Array(20).fill("😼"),
    recentStickerIds: LINE_STICKER_CATALOG.slice(0, 10).map(stickerKey),
  };
  const ref = {transaction: async (update) => {
    transactions += 1;
    stored = update(stored);
    return {committed: true};
  }};
  const plan = await directMiaobingExpression(ref, baseOptions({rng: () => 0.5}));
  assert.equal(plan.shouldReply, true);
  assert.equal(transactions, 1);
  assert.ok(stored.recentEmoji.length <= RECENT_EMOJI_LIMIT);
  assert.ok(stored.recentStickerIds.length <= RECENT_STICKER_LIMIT);
  assert.equal(JSON.stringify(stored).includes("本喵有聽到"), false);
  assert.equal(Object.hasOwn(stored, "text"), false);
});

test("personality OFF cannot be bypassed by the expression layer", () => {
  assert.deepEqual(planMiaobingExpression(baseOptions({personalityEnabled: false})), {
    shouldReply: false,
    messages: [],
    stateChanged: false,
  });
});

test("expression module has no history, Firebase, LINE token, or OpenAI access", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../lib/miaobingExpression.js"), "utf8");
  assert.doesNotMatch(source, /guildDraw\/main\/history|getDatabase|OPENAI_API_KEY|LINE_CHANNEL/u);
  assert.doesNotMatch(source, /require\(["']openai["']\)/u);
});

test("rule personality, group AI, and admin-private AI share one director after OFF gates", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../index.js"), "utf8");
  const aiHandler = source.match(
    /async function handleMiaobingAi[\s\S]*?(?=async function handleMiaobingPrivateAdminAi)/u,
  );
  const personalityHandler = source.match(
    /async function handleMiaobingPersonality[\s\S]*?(?=async function handleMiaobingAi)/u,
  );
  assert.ok(aiHandler);
  assert.ok(personalityHandler);
  for (const handler of [aiHandler[0], personalityHandler[0]]) {
    assert.match(handler, /guildDraw\/aiStyle\/expressionState/u);
    assert.match(handler, /directMiaobingExpression/u);
    assert.match(handler, /replyMessages\(event\.replyToken, messages/u);
    assert.ok(handler.indexOf("isPersonalityEnabled") <
      handler.indexOf("directMiaobingExpression"));
  }
  assert.match(source, /handleMiaobingAi\(\{event, aiPlan, token, isPrivateAdminTest: true\}\)/u);
});
