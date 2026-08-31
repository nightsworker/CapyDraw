"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {parseBotCommand} = require("../lib/line");
const {decideLineCommandAccess} = require("../lib/line-sync");
const {
  JAPANESE_NAME_PROBABILITY,
  MIAOBING_LORE,
  MIAOBING_RESPONSES,
  PLATE_MENTION_COOLDOWN_MS,
  SENDER_ROLES,
  decorateCommandReply,
  detectMiaobingIntent,
  detectPersonalityControl,
  isCooldownElapsed,
  isJapaneseNameCandidate,
  isOwnerAliasCandidate,
  isPersonalityEnabled,
  isPlateCandidate,
  planMiaobingMessage,
  planPersonalityControl,
} = require("../lib/miaobing-personality");
const {
  buildLoreReplyMessage,
  isSenderLorePerson,
  resolveLoreIdentity,
  resolveSenderRole,
} = require("../lib/miaobing-lore");

const GROUP_ID = "C_GROUP_A";

function textEvent(text, userId = "U_MEMBER", messageExtra = {}) {
  return {
    type: "message",
    replyToken: "reply-token",
    source: {type: "group", groupId: GROUP_ID, userId},
    message: {type: "text", text, ...messageExtra},
  };
}

function binding(playerName, lineUserId, groupId = GROUP_ID) {
  return {
    playerName,
    lineUserId,
    lineGroupId: groupId,
    lineDisplayName: "profile",
  };
}

const loreBindings = {
  ownerA: binding("Chia - 嘻嘻不嘻嘻", "U_CHIA"),
  ownerB: binding("Chia - CC x CC", "U_CHIA"),
  leader: binding("@Hank - 挖系小嗨", "U_HANK"),
  plate: binding("貳零陸 - 九章伏藏", "U_PLATE"),
};

test("A: 主人是誰 is OWNER_IDENTITY", () => {
  assert.equal(detectMiaobingIntent("主人是誰").intent, "ownerIdentity");
});

test("B: owner identity semantic response points to Chia", () => {
  const plan = planMiaobingMessage({event: textEvent("主人是誰"), rng: () => 0});
  assert.equal(plan.mentionTarget, "owner");
  assert.equal(plan.fallbackName, "Chia");
  assert.match(plan.replyText, /\{target\}/u);
});

test("C: two Chia game IDs resolve to one owner LINE identity", () => {
  const owner = resolveLoreIdentity(loreBindings, GROUP_ID, "owner");
  assert.equal(owner.lineUserId, "U_CHIA");
  assert.deepEqual(new Set(owner.gameIds), new Set(["嘻嘻不嘻嘻", "CC x CC"]));
});

test("D: 嘻嘻 is an owner alias candidate", () => {
  assert.equal(detectMiaobingIntent("嘻嘻").intent, "ownerAlias");
});

test("E: 嘻嘻不嘻嘻 is an owner alias candidate", () => {
  assert.equal(detectMiaobingIntent("嘻嘻不嘻嘻").intent, "ownerAlias");
});

test("F: Chia is an owner alias candidate", () => {
  assert.equal(detectMiaobingIntent("找 Chia").intent, "ownerAlias");
});

test("G: standalone CC is an owner alias candidate", () => {
  assert.equal(isOwnerAliasCandidate("CC 在嗎"), true);
  assert.equal(detectMiaobingIntent("CC").intent, "ownerAlias");
});

test("H: ACCC, CCCCC, URLs, emails and programming tokens do not match CC", () => {
  for (const text of ["ACCC", "CCCCC", "https://example.com/CC", "a@b.cc", "const CC = value"] ) {
    assert.equal(isOwnerAliasCandidate(text), false, text);
  }
});

test("I: 盤子 is the plate easter egg", () => {
  assert.equal(isPlateCandidate("盤子"), true);
  assert.equal(detectMiaobingIntent("盤子").intent, "plate");
});

test("J: 小盤子 and supported reasonable phrases are plate candidates", () => {
  for (const text of ["小盤子", "盤子在哪", "誰是小盤子", "叫盤子出來"]) {
    assert.equal(isPlateCandidate(text), true, text);
  }
});

test("K: canonical 貳零陸 - 九章伏藏 binding resolves the plate target", () => {
  const plate = resolveLoreIdentity(loreBindings, GROUP_ID, "plateTarget");
  assert.equal(plate.lineUserId, "U_PLATE");
  assert.equal(plate.lineName, "貳零陸");
});

test("K2: migrated plate binding resolves by Member ID after the current game-name change", () => {
  const migrated = {
    plate: {
      memberId: "1493451",
      playerName: "貳零陸 - 萬朔夜",
      lineName: "貳零陸",
      gameId: "萬朔夜",
      lineUserId: "U_PLATE",
      lineGroupId: GROUP_ID,
    },
  };
  assert.equal(resolveLoreIdentity(migrated, GROUP_ID, "plateTarget").lineUserId, "U_PLATE");
});

test("L: a bound plate target produces a real LINE textV2 mention payload", () => {
  const plan = planMiaobingMessage({event: textEvent("盤子"), rng: () => 0});
  const message = buildLoreReplyMessage(
    plan,
    resolveLoreIdentity(loreBindings, GROUP_ID, "plateTarget"),
  );
  assert.equal(message.type, "textV2");
  assert.equal(message.substitution.target.type, "mention");
  assert.equal(message.substitution.target.mentionee.userId, "U_PLATE");
});

test("M: an unbound plate target never produces a user mention", () => {
  const plan = planMiaobingMessage({event: textEvent("盤子"), rng: () => 0});
  const message = buildLoreReplyMessage(plan, null);
  assert.equal(message.type, "text");
  assert.equal("substitution" in message, false);
  assert.equal(message.text.includes("U_"), false);
});

test("N: plate mention cooldown blocks a second notification for 60 seconds", () => {
  const now = 1_000_000;
  assert.equal(PLATE_MENTION_COOLDOWN_MS, 60_000);
  assert.equal(isCooldownElapsed(now - 59_999, now, PLATE_MENTION_COOLDOWN_MS), false);
  assert.equal(isCooldownElapsed(now - 60_000, now, PLATE_MENTION_COOLDOWN_MS), true);
});

test("O: 會長是誰 is LEADER_IDENTITY", () => {
  assert.equal(detectMiaobingIntent("會長是誰").intent, "leaderIdentity");
});

test("P: centralized lore identifies @Hank - 挖系小嗨 as guild leader", () => {
  assert.equal(MIAOBING_LORE.guildLeader.lineName, "@Hank");
  assert.equal(MIAOBING_LORE.guildLeader.gameId, "挖系小嗨");
});

test("Q: an exact @Hank binding resolves a leader true mention", () => {
  const plan = planMiaobingMessage({event: textEvent("會長是誰"), rng: () => 0});
  const message = buildLoreReplyMessage(
    plan,
    resolveLoreIdentity(loreBindings, GROUP_ID, "guildLeader"),
  );
  assert.equal(message.type, "textV2");
  assert.equal(message.substitution.target.mentionee.userId, "U_HANK");
});

test("R: the verified leader saying 我是會長 gets leader-special reply", () => {
  const plan = planMiaobingMessage({
    event: textEvent("我是會長", "U_HANK"),
    isLeader: true,
    rng: () => 0,
  });
  assert.equal(isSenderLorePerson(loreBindings, GROUP_ID, "guildLeader", "U_HANK"), true);
  assert.equal(plan.shouldReply, true);
  assert.equal(plan.intent, "leaderClaim");
});

test("S: an unverified sender is never acknowledged as leader", () => {
  const plan = planMiaobingMessage({event: textEvent("我是會長"), isLeader: false, rng: () => 0});
  assert.equal(plan.shouldReply, false);
  assert.equal(plan.reason, "unverified-leader-claim");
});

test("T: hiragana name ちゃらう is a Japanese candidate", () => {
  assert.equal(isJapaneseNameCandidate("ちゃらう"), true);
});

test("U: mixed text 鮑あわび is a Japanese candidate", () => {
  assert.equal(isJapaneseNameCandidate("鮑あわび"), true);
});

test("V: Chinese Han characters alone are not a Japanese candidate", () => {
  assert.equal(isJapaneseNameCandidate("公會今天開船"), false);
});

test("W: Japanese candidate replies when RNG is below threshold", () => {
  const plan = planMiaobingMessage({event: textEvent("タナカ"), rng: () => 0.079});
  assert.equal(plan.shouldReply, true);
  assert.equal(plan.intent, "japaneseName");
  assert.match(plan.replyText, /^原來有日本成員/u);
});

test("X: Japanese candidate stays silent when RNG is above threshold", () => {
  const plan = planMiaobingMessage({event: textEvent("タナカ"), rng: () => 0.081});
  assert.equal(plan.shouldReply, false);
});

test("Y: Japanese ambient probability is exactly eight percent", () => {
  assert.equal(JAPANESE_NAME_PROBABILITY, 0.08);
});

test("Z: missing personality enabled value defaults to true", () => {
  assert.equal(isPersonalityEnabled(undefined), true);
  assert.equal(isPersonalityEnabled(false), false);
});

test("AA: admin mute control plans enabled=false", () => {
  const plan = planPersonalityControl({text: "喵餅真的閉嘴", isAdmin: true, personalityEnabled: true});
  assert.equal(plan.authorized, true);
  assert.equal(plan.stateChange, false);
});

test("AB: owner Chia mute control plans enabled=false", () => {
  const plan = planPersonalityControl({text: "喵餅 真的閉嘴！", isOwner: true, personalityEnabled: true});
  assert.equal(plan.authorized, true);
  assert.equal(plan.stateChange, false);
  assert.match(plan.replyText, /主人/u);
});

test("AC: ordinary member mute does not modify state", () => {
  const plan = planPersonalityControl({text: "喵餅真的閉嘴", personalityEnabled: true, rng: () => 0});
  assert.equal(plan.authorized, false);
  assert.equal(plan.stateChange, null);
});

test("AD: disabled personality ignores canned food without running RNG", () => {
  let calls = 0;
  const plan = planMiaobingMessage({
    event: textEvent("罐罐"),
    personalityEnabled: false,
    rng: () => { calls += 1; return 0; },
  });
  assert.equal(plan.shouldReply, false);
  assert.equal(calls, 0);
});

test("AE: disabled personality ignores a true bot mention", () => {
  const plan = planMiaobingMessage({
    event: textEvent("@喵餅", "U_MEMBER", {mention: {mentionees: [{type: "user", isSelf: true}]}}),
    personalityEnabled: false,
    rng: () => 0,
  });
  assert.equal(plan.shouldReply, false);
});

test("AF: disabled personality never plans a plate mention", () => {
  const plan = planMiaobingMessage({event: textEvent("盤子"), personalityEnabled: false, rng: () => 0});
  assert.equal(plan.shouldReply, false);
  assert.equal(plan.mentionTarget, undefined);
});

test("AG: disabled personality ignores Japanese candidates", () => {
  const plan = planMiaobingMessage({event: textEvent("あわび"), personalityEnabled: false, rng: () => 0});
  assert.equal(plan.shouldReply, false);
});

test("AH: commands remain in command route while personality is disabled", () => {
  const command = parseBotCommand("!狀態");
  const plan = planMiaobingMessage({
    event: textEvent("!狀態"),
    command,
    personalityEnabled: false,
    rng: () => 0,
  });
  assert.equal(command.command, "status");
  assert.deepEqual(plan, {shouldReply: false, reason: "command"});
});

test("AI: admin wake control plans enabled=true while disabled", () => {
  const plan = planPersonalityControl({text: "喵餅我想你了", isAdmin: true, personalityEnabled: false});
  assert.equal(plan.authorized, true);
  assert.equal(plan.stateChange, true);
});

test("AJ: owner wake with 妳 plans enabled=true while disabled", () => {
  const plan = planPersonalityControl({text: "喵餅 我想妳了", isOwner: true, personalityEnabled: false});
  assert.equal(plan.authorized, true);
  assert.equal(plan.stateChange, true);
  assert.match(plan.replyText, /主人/u);
});

test("AK: ordinary member wake cannot enable disabled personality", () => {
  const plan = planPersonalityControl({text: "喵餅我想你了", personalityEnabled: false});
  assert.equal(plan.authorized, false);
  assert.equal(plan.stateChange, null);
  assert.equal(plan.shouldReply, false);
});

test("AL: wake control parser works before any enabled-state gate", () => {
  assert.equal(detectPersonalityControl("喵餅，我想你了！"), "wake");
  assert.equal(detectPersonalityControl("喵餅 我想妳了"), "wake");
});

test("ambiguous lore bindings never select an arbitrary LINE user", () => {
  const bindings = {
    one: binding("Chia - 嘻嘻不嘻嘻", "U_ONE"),
    two: binding("Chia - CC x CC", "U_TWO"),
  };
  assert.equal(resolveLoreIdentity(bindings, GROUP_ID, "owner"), null);
});

test("sender role A: a bound Chia sender is OWNER", () => {
  assert.deepEqual(resolveSenderRole(loreBindings, GROUP_ID, "U_CHIA"), {
    senderRole: SENDER_ROLES.OWNER,
    isOwner: true,
    isGuildLeader: false,
  });
});

test("sender role B: exact @Hank - 挖系小嗨 sender is GUILD_LEADER", () => {
  assert.deepEqual(resolveSenderRole(loreBindings, GROUP_ID, "U_HANK"), {
    senderRole: SENDER_ROLES.GUILD_LEADER,
    isOwner: false,
    isGuildLeader: true,
  });
});

test("sender role C: an unbound sender named Chia by displayName remains MEMBER", () => {
  const context = resolveSenderRole(loreBindings, GROUP_ID, "U_DISPLAY_NAME_ONLY_CHIA");
  assert.equal(context.senderRole, SENDER_ROLES.MEMBER);
  assert.equal(context.isOwner, false);
});

test("sender role D: OWNER direct mention uses the owner pool", () => {
  const plan = planMiaobingMessage({
    event: textEvent("喵餅在嗎", "U_CHIA"),
    senderRole: SENDER_ROLES.OWNER,
    rng: () => 0,
  });
  assert.equal(MIAOBING_RESPONSES.role.OWNER.direct.includes(plan.replyText), true);
});

test("sender role E: GUILD_LEADER direct mention uses the leader pool", () => {
  const plan = planMiaobingMessage({
    event: textEvent("喵餅在嗎", "U_HANK"),
    senderRole: SENDER_ROLES.GUILD_LEADER,
    rng: () => 0,
  });
  assert.equal(MIAOBING_RESPONSES.role.GUILD_LEADER.direct.includes(plan.replyText), true);
});

test("sender role F: MEMBER direct mention falls back to the generic pool", () => {
  const plan = planMiaobingMessage({
    event: textEvent("喵餅在嗎"),
    senderRole: SENDER_ROLES.MEMBER,
    rng: () => 0,
  });
  assert.equal(MIAOBING_RESPONSES.greeting.includes(plan.replyText), true);
});

test("sender role G: OWNER command flavor preserves core and uses owner pool", () => {
  const core = "✅ core command result";
  const decorated = decorateCommandReply({
    command: "status",
    coreText: core,
    senderRole: SENDER_ROLES.OWNER,
    flavorProbability: 1,
    rng: () => 0,
  });
  assert.equal(decorated.includes(core), true);
  assert.equal(decorated.includes(MIAOBING_RESPONSES.role.OWNER.commandSuccess[0]), true);
});

test("sender role H: GUILD_LEADER command flavor preserves core and uses leader pool", () => {
  const core = "✅ sync core result";
  const decorated = decorateCommandReply({
    command: "sync",
    coreText: core,
    senderRole: SENDER_ROLES.GUILD_LEADER,
    flavorProbability: 1,
    rng: () => 0,
  });
  assert.equal(decorated.includes(core), true);
  assert.equal(decorated.includes(MIAOBING_RESPONSES.role.GUILD_LEADER.sync[0]), true);
});

test("sender role I: OWNER 摸摸 uses owner pet variant", () => {
  const plan = planMiaobingMessage({
    event: textEvent("摸摸", "U_CHIA"),
    senderRole: SENDER_ROLES.OWNER,
    rng: () => 0,
  });
  assert.equal(plan.replyText, MIAOBING_RESPONSES.role.OWNER.pet[0]);
});

test("sender role J: GUILD_LEADER 我是會長 uses leader-only variant", () => {
  const plan = planMiaobingMessage({
    event: textEvent("我是會長", "U_HANK"),
    senderRole: SENDER_ROLES.GUILD_LEADER,
    rng: () => 0,
  });
  assert.equal(MIAOBING_RESPONSES.leaderSelf.includes(plan.replyText), true);
});

test("sender role K: MEMBER 我是會長 cannot use leader-only variant", () => {
  const plan = planMiaobingMessage({
    event: textEvent("我是會長"),
    senderRole: SENDER_ROLES.MEMBER,
    rng: () => 0,
  });
  assert.equal(plan.shouldReply, false);
});

test("sender role L: personality role never bypasses LINE Bot admin authorization", () => {
  for (const senderRole of [SENDER_ROLES.OWNER, SENDER_ROLES.GUILD_LEADER]) {
    const access = decideLineCommandAccess({
      command: "sync",
      bindingLocked: false,
      defaultGroupId: GROUP_ID,
      eventGroupId: GROUP_ID,
      adminLineUserIds: {},
      userId: senderRole === SENDER_ROLES.OWNER ? "U_CHIA" : "U_HANK",
    });
    assert.deepEqual(access, {allowed: false, reason: "not-admin"});
  }
});
