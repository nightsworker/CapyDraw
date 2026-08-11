"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {parseBotCommand} = require("../lib/line");
const {
  AMBIENT_COOLDOWN_MS,
  DIRECT_MENTION_COOLDOWN_MS,
  MIAOBING_RESPONSES,
  decorateCommandReply,
  detectMiaobingIntent,
  generateDirectMentionReply,
  getTaipeiHour,
  isBotMentioned,
  isCooldownElapsed,
  personalityUserKey,
  pickRandom,
  planMiaobingMessage,
  responsePoolStats,
} = require("../lib/miaobing-personality");

function textEvent(text, messageExtra = {}) {
  return {
    type: "message",
    replyToken: "reply-token",
    source: {type: "group", groupId: "C_GROUP_A", userId: "U_MEMBER_A"},
    message: {type: "text", text, ...messageExtra},
  };
}

test("A: a bind command stays in the command route and never enters personality chat", () => {
  const command = parseBotCommand("!綁定 喵餅");
  const plan = planMiaobingMessage({event: textEvent("!綁定 喵餅"), command, rng: () => 0});
  assert.equal(command.command, "bind");
  assert.deepEqual(plan, {shouldReply: false, reason: "command"});
});

test("B: an unknown prefixed command stays in the command route", () => {
  const command = parseBotCommand("!abc");
  const plan = planMiaobingMessage({event: textEvent("!abc"), command, rng: () => 0});
  assert.equal(command.command, "unknown");
  assert.deepEqual(plan, {shouldReply: false, reason: "command"});
});

test("unprefixed former commands continue through personality routing", () => {
  const command = parseBotCommand("綁定");
  const plan = planMiaobingMessage({event: textEvent("綁定"), command, rng: () => 0});
  assert.equal(command, null);
  assert.equal(plan.shouldReply, false);
  assert.equal(plan.reason, "ambient-not-selected");
});

test("C: a true LINE bot mention always plans a direct reply", () => {
  const event = textEvent("@喵餅 你好", {
    mention: {mentionees: [{type: "user", userId: "U_BOT", isSelf: true}]},
  });
  const plan = planMiaobingMessage({event, botUserId: "U_BOT", hourTaipei: 12, rng: () => 0.99});
  assert.equal(isBotMentioned(event.message, {botUserId: "U_BOT"}), true);
  assert.equal(plan.shouldReply, true);
  assert.equal(plan.kind, "direct");
  assert.equal(plan.reason, "true-mention");
});

test("bot destination is a safe fallback when older mention metadata lacks isSelf", () => {
  const message = {
    type: "text",
    text: "@喵餅",
    mention: {mentionees: [{type: "user", userId: "U_BOT"}]},
  };
  assert.equal(isBotMentioned(message, {botUserId: "U_BOT"}), true);
  assert.equal(isBotMentioned(message, {botUserId: "U_OTHER"}), false);
});

test("plain @喵餅 text is direct-name conversation, not a true LINE mention", () => {
  const event = textEvent("@喵餅 你好");
  assert.equal(isBotMentioned(event.message, {botUserId: "U_BOT"}), false);
  const plan = planMiaobingMessage({event, botUserId: "U_BOT", hourTaipei: 12, rng: () => 0});
  assert.equal(plan.shouldReply, true);
  assert.equal(plan.reason, "direct-name");
});

test("喵餅你好 remains a direct-name personality trigger", () => {
  const plan = planMiaobingMessage({event: textEvent("喵餅你好"), hourTaipei: 12, rng: () => 0});
  assert.equal(plan.shouldReply, true);
  assert.equal(plan.reason, "direct-name");
});

test("D: text that directly contains 喵餅 plans a reply", () => {
  const plan = planMiaobingMessage({event: textEvent("喵餅在嗎"), hourTaipei: 12, rng: () => 0});
  assert.equal(plan.shouldReply, true);
  assert.equal(plan.kind, "direct");
  assert.equal(plan.reason, "direct-name");
});

test("E: ordinary group chat without a trigger receives no personality reply", () => {
  const plan = planMiaobingMessage({event: textEvent("今晚九點有人嗎"), rng: () => 0});
  assert.equal(plan.shouldReply, false);
  assert.equal(plan.reason, "ambient-not-selected");
});

test("F: contextual ambient keywords use injectable 20 percent selection", () => {
  const hit = planMiaobingMessage({event: textEvent("好累"), hourTaipei: 12, rng: () => 0.1});
  const miss = planMiaobingMessage({event: textEvent("好累"), hourTaipei: 12, rng: () => 0.9});
  assert.equal(hit.shouldReply, true);
  assert.equal(hit.kind, "ambient");
  assert.equal(hit.intent, "tired");
  assert.equal(miss.shouldReply, false);
});

test("G: ambient cooldown blocks a reply until three minutes have elapsed", () => {
  const now = 1_000_000;
  assert.equal(isCooldownElapsed(now - AMBIENT_COOLDOWN_MS + 1, now, AMBIENT_COOLDOWN_MS), false);
  assert.equal(isCooldownElapsed(now - AMBIENT_COOLDOWN_MS, now, AMBIENT_COOLDOWN_MS), true);
});

test("H: a direct mention does not use the ambient cooldown", () => {
  const event = textEvent("@喵餅", {
    mention: {mentionees: [{type: "user", isSelf: true}]},
  });
  const plan = planMiaobingMessage({event, hourTaipei: 12, rng: () => 0});
  assert.equal(plan.shouldReply, true);
  assert.equal(plan.kind, "direct");
  assert.equal(plan.cooldownMs, DIRECT_MENTION_COOLDOWN_MS);
  const now = 1_000_000;
  assert.equal(isCooldownElapsed(now - DIRECT_MENTION_COOLDOWN_MS + 1, now,
    DIRECT_MENTION_COOLDOWN_MS), false);
  assert.equal(isCooldownElapsed(now - DIRECT_MENTION_COOLDOWN_MS, now,
    DIRECT_MENTION_COOLDOWN_MS), true);
});

test("I: canned food is a strong trigger but still uses the group ambient cooldown", () => {
  const plan = planMiaobingMessage({event: textEvent("罐罐"), hourTaipei: 12, rng: () => 0.99});
  assert.equal(plan.shouldReply, true);
  assert.equal(plan.kind, "ambient");
  assert.equal(plan.reason, "strong-trigger");
  assert.equal(plan.cooldownMs, AMBIENT_COOLDOWN_MS);
});

test("J: image and sticker messages are ignored by personality routing", () => {
  for (const type of ["image", "sticker"]) {
    const event = textEvent("");
    event.message = {type};
    assert.equal(planMiaobingMessage({event, rng: () => 0}).shouldReply, false);
  }
});

test("K: sad intent always selects from the gentle sad pool", () => {
  const response = generateDirectMentionReply({text: "喵餅，我今天心情不好但謝謝你", hourTaipei: 12, rng: () => 0});
  assert.equal(response.intent, "sad");
  assert.equal(MIAOBING_RESPONSES.sad.includes(response.text), true);
  assert.equal(MIAOBING_RESPONSES.noisy.includes(response.text), false);
});

test("ordered intent detection prioritizes dog comparison and noisy phrases", () => {
  assert.equal(detectMiaobingIntent("狗狗比較可愛").intent, "dogBetter");
  assert.equal(detectMiaobingIntent("喵餅閉嘴").intent, "noisy");
  assert.equal(detectMiaobingIntent("汪").intent, "dog");
  assert.equal(detectMiaobingIntent("汪小明今天請假").intent, "unknown");
});

test("long contextual chat is ignored while strong easter eggs remain eligible", () => {
  const longTired = `好累${"，但這是一般長篇聊天".repeat(8)}`;
  assert.equal(planMiaobingMessage({event: textEvent(longTired), rng: () => 0}).shouldReply, false);
  const longCannedFood = `罐罐${"真的出現在很長的句子裡".repeat(8)}`;
  assert.equal(planMiaobingMessage({event: textEvent(longCannedFood), hourTaipei: 12,
    rng: () => 0.99}).shouldReply, true);
});

test("L: Asia/Taipei late-night direct replies can use a night variant", () => {
  assert.equal(getTaipeiHour(new Date("2026-08-10T18:30:00.000Z")), 2);
  const response = generateDirectMentionReply({text: "喵餅", hourTaipei: 2, rng: () => 0});
  assert.equal(response.night, true);
  assert.equal(MIAOBING_RESPONSES.night.includes(response.text), true);
});

test("M/P: personality plans and storage keys never retain raw text or expose LINE userId", () => {
  const rawText = "喵餅，這段訊息不可以被保存 raw-chat-marker";
  const userId = "U_FULL_PRIVATE_LINE_USER_ID";
  const plan = planMiaobingMessage({event: textEvent(rawText), hourTaipei: 12, rng: () => 0});
  const key = personalityUserKey(userId);
  assert.equal(key.includes(userId), false);
  assert.equal(plan.replyText.includes(userId), false);
  assert.equal(JSON.stringify(plan).includes("raw-chat-marker"), false);
});

test("N: command decoration preserves the complete structured core reply", () => {
  const coreText = "✅ LINE 綁定完成\n\nLINE：Rain\n遊戲 ID：\n• 流鬼";
  const decorated = decorateCommandReply({
    command: "bind",
    status: "success",
    coreText,
    rng: () => 0,
    flavorProbability: 1,
  });
  assert.match(decorated, /喵，身份確認完畢。/);
  assert.equal(decorated.includes(coreText), true);
  const unknown = decorateCommandReply({
    command: "unknown",
    status: "failure",
    coreText: "輸入 !說明 查看可用指令。",
    rng: () => 0,
    flavorProbability: 1,
  });
  assert.match(unknown, /喵？本喵看不懂這個指令。/);
});

test("O: random pool selection is deterministic with an injected RNG", () => {
  assert.equal(pickRandom(["first", "second", "third"], () => 0), "first");
  assert.equal(pickRandom(["first", "second", "third"], () => 0.999), "third");
});

test("response pools are centralized and contain a substantial first-version vocabulary", () => {
  const stats = responsePoolStats();
  assert.ok(stats.poolCount >= 30);
  assert.ok(stats.phraseCount >= 80);
});
