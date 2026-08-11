"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const {
  bindingKey,
  buildBindingListText,
  buildDrawLineMessage,
  buildMemberBindingRows,
  buildUnboundListText,
  claimDefaultLineGroup,
  createBindingRecord,
  decideLineGroupAction,
  extractBindingCommand,
  findBindingForMember,
  findMembersByLineName,
  isGroupMessageEvent,
  parseMemberName,
  resolveBindingLineName,
  splitTextMessages,
  verifyLineSignature,
} = require("../lib/line");

const GROUP_ID = "C_GROUP_A";
const NOW = "2026-08-11T00:00:00.000Z";

function makeBinding(playerName, userId, displayName = parseMemberName(playerName).lineName) {
  return createBindingRecord({
    member: playerName,
    userId,
    displayName,
    groupId: GROUP_ID,
    now: NOW,
  });
}

test("A: Rain - 流鬼 parses LINE name on the left and game ID on the right", () => {
  assert.deepEqual(parseMemberName("Rain - 流鬼"), {
    fullName: "Rain - 流鬼",
    lineName: "Rain",
    gameId: "流鬼",
  });
});

test("B: @Hank - 挖系小嗨 preserves the leading @ in the LINE name", () => {
  assert.deepEqual(parseMemberName("@Hank - 挖系小嗨"), {
    fullName: "@Hank - 挖系小嗨",
    lineName: "@Hank",
    gameId: "挖系小嗨",
  });
});

test("C: parser only splits the first separator", () => {
  assert.deepEqual(parseMemberName("台東小米那裡民宿 - 林秉亮 - 大象騎士"), {
    fullName: "台東小米那裡民宿 - 林秉亮 - 大象騎士",
    lineName: "台東小米那裡民宿",
    gameId: "林秉亮 - 大象騎士",
  });
});

test("D: game IDs can begin and end with hyphens", () => {
  assert.deepEqual(parseMemberName("品豪 Nash - - 紅茶拿鐵 -"), {
    fullName: "品豪 Nash - - 紅茶拿鐵 -",
    lineName: "品豪 Nash",
    gameId: "- 紅茶拿鐵 -",
  });
});

test("E: names without a separator use a safe fallback", () => {
  assert.deepEqual(parseMemberName("HappyStar（不在群組）"), {
    fullName: "HappyStar（不在群組）",
    lineName: "HappyStar（不在群組）",
    gameId: "HappyStar（不在群組）",
  });
});

test("parser preserves Chinese, emoji and full-width parentheses", () => {
  assert.deepEqual(parseMemberName("🍎林日凱（Kim） - 阿金"), {
    fullName: "🍎林日凱（Kim） - 阿金",
    lineName: "🍎林日凱（Kim）",
    gameId: "阿金",
  });
});

test("F/G/H: captain and guardian show game IDs while cabin 4 only shows mentions", () => {
  const bindings = {
    rain: makeBinding("Rain - 流鬼", "U_RAIN"),
    hank: makeBinding("@Hank - 挖系小嗨", "U_HANK", "@Hank"),
    kim: makeBinding("🍎林日凱（Kim） - 阿金", "U_KIM"),
  };
  const result = buildDrawLineMessage({
    date: "2026-08-11",
    captain: "Rain - 流鬼",
    guardian: "@Hank - 挖系小嗨",
    cabin4: ["🍎林日凱（Kim） - 阿金"],
  }, bindings, GROUP_ID);

  assert.match(result.message.text, /8\/11船長：流鬼 \{mention0\}/);
  assert.match(result.message.text, /守護天使：挖系小嗨 \{mention1\}/);
  assert.match(result.message.text, /第四船艙：\{mention2\}/);
  assert.doesNotMatch(result.message.text, /第四船艙：[^\n]*阿金/);
  assert.equal(result.message.substitution.mention0.mentionee.userId, "U_RAIN");
  assert.equal(result.message.substitution.mention1.mentionee.userId, "U_HANK");
  assert.equal(result.message.substitution.mention2.mentionee.userId, "U_KIM");
});

test("unbound players use game ID plus plain @LINE name and are reported", () => {
  const result = buildDrawLineMessage({
    date: "2026-08-11",
    captain: "Rain - 流鬼",
    guardian: "@Hank - 挖系小嗨",
    cabin4: ["KevenWz - 少冰養老"],
  }, {}, GROUP_ID);
  assert.match(result.message.text, /船長：流鬼 @Rain/);
  assert.match(result.message.text, /守護天使：挖系小嗨 @@Hank/);
  assert.match(result.message.text, /第四船艙：@KevenWz/);
  assert.deepEqual(result.unboundMembers, ["Rain", "@Hank", "KevenWz"]);
});

test("I: one LINE user can bind multiple game IDs and mention both", () => {
  const memberNames = ["Chia - 嘻嘻不嘻嘻", "Chia - CC x CC"];
  const matches = findMembersByLineName(memberNames, "Chia");
  assert.equal(matches.length, 2);
  const bindings = Object.fromEntries(matches.map((member) => [
    bindingKey(member.fullName),
    makeBinding(member.fullName, "U_CHIA", "Chia"),
  ]));
  assert.equal(Object.keys(bindings).length, 2);

  const result = buildDrawLineMessage({
    date: "2026-08-11",
    captain: memberNames[0],
    guardian: "Rain - 流鬼",
    cabin4: [memberNames[1]],
  }, {...bindings, rain: makeBinding("Rain - 流鬼", "U_RAIN")}, GROUP_ID);
  assert.equal(result.message.substitution.mention0.mentionee.userId, "U_CHIA");
  assert.equal(result.message.substitution.mention2.mentionee.userId, "U_CHIA");
});

test("J: parameterless bind resolves the LINE profile displayName", () => {
  const command = extractBindingCommand("綁定");
  assert.deepEqual(command, {type: "bind", auto: true, query: null});
  assert.equal(resolveBindingLineName(command, "@Hank"), "@Hank");
  assert.deepEqual(
    findMembersByLineName(["@Hank - 挖系小嗨"], resolveBindingLineName(command, "@Hank")),
    [{fullName: "@Hank - 挖系小嗨", lineName: "@Hank", gameId: "挖系小嗨"}],
  );
});

test("manual bind only matches exact LINE names and returns all matching rows", () => {
  const command = extractBindingCommand("bind Chia");
  assert.deepEqual(command, {type: "bind", auto: false, query: "Chia"});
  const matches = findMembersByLineName([
    "Chia - 嘻嘻不嘻嘻",
    "Chia - CC x CC",
    "Chia2 - 其他帳號",
  ], command.query);
  assert.deepEqual(matches.map((member) => member.gameId), ["嘻嘻不嘻嘻", "CC x CC"]);
  assert.deepEqual(findMembersByLineName(["Rain - 流鬼"], "rain"), []);
});

test("K: binding list reports and aggregates bound and unbound game accounts", () => {
  const members = [
    "Rain - 流鬼",
    "@Hank - 挖系小嗨",
    "Chia - 嘻嘻不嘻嘻",
    "Chia - CC x CC",
    "KevenWz - 少冰養老",
  ];
  const bindings = {
    rain: makeBinding(members[0], "U_RAIN"),
    chia: makeBinding(members[2], "U_CHIA"),
  };
  const text = buildBindingListText(members, bindings, GROUP_ID);
  assert.match(text, /已綁定：3 \/ 5/);
  assert.match(text, /✅ Chia → 嘻嘻不嘻嘻、CC x CC/);
  assert.match(text, /❌ @Hank → 挖系小嗨/);
  assert.match(text, /❌ KevenWz → 少冰養老/);
});

test("L: unbound list treats duplicate game IDs as bound through one unique LINE identity", () => {
  const members = [
    "Chia - 嘻嘻不嘻嘻",
    "Chia - CC x CC",
    "REN✨ - REN",
  ];
  const bindings = {chia: makeBinding(members[0], "U_CHIA")};
  const rows = buildMemberBindingRows(members, bindings, GROUP_ID);
  assert.equal(rows.filter((row) => row.bound).length, 2);
  const text = buildUnboundListText(members, bindings, GROUP_ID);
  assert.doesNotMatch(text, /Chia/);
  assert.match(text, /REN✨ → REN/);
  assert.match(text, /共 1 人 \/ 1 個遊戲帳號未綁定/);
});

test("M: old schema bindings remain valid by reparsing canonical playerName", () => {
  const oldBinding = {
    playerName: "@Hank - 挖系小嗨",
    normalizedPlayerName: "@hank - 挖系小嗨",
    alias: "挖系小嗨",
    gameName: "@Hank",
    lineUserId: "U_HANK",
    lineDisplayName: "@Hank",
    lineGroupId: GROUP_ID,
    boundAt: NOW,
    updatedAt: NOW,
  };
  const binding = findBindingForMember("@Hank - 挖系小嗨", {old: oldBinding}, GROUP_ID);
  assert.equal(binding.lineName, "@Hank");
  assert.equal(binding.gameId, "挖系小嗨");
  assert.equal(binding.lineUserId, "U_HANK");

  const result = buildDrawLineMessage({
    date: "2026-08-11",
    captain: "Rain - 流鬼",
    guardian: "@Hank - 挖系小嗨",
    cabin4: [],
  }, {old: oldBinding}, GROUP_ID);
  assert.match(result.message.text, /守護天使：挖系小嗨 \{mention0\}/);
  assert.equal(result.message.substitution.mention0.mentionee.userId, "U_HANK");
});

test("new binding schema stores lineName/gameId and not ambiguous legacy fields", () => {
  const binding = makeBinding("Rain - 流鬼", "U_RAIN");
  assert.equal(binding.lineName, "Rain");
  assert.equal(binding.gameId, "流鬼");
  assert.equal("alias" in binding, false);
  assert.equal("gameName" in binding, false);
});

test("server list command aliases are recognized", () => {
  assert.equal(extractBindingCommand("綁定清單").type, "binding-list");
  assert.equal(extractBindingCommand("LINE清單").type, "binding-list");
  assert.equal(extractBindingCommand("line list").type, "binding-list");
  assert.equal(extractBindingCommand("未綁定清單").type, "unbound-list");
  assert.equal(extractBindingCommand("未綁定").type, "unbound-list");
});

test("long reply text is safely split and capped at five LINE messages", () => {
  const messages = splitTextMessages(Array.from({length: 30}, (_, index) => `玩家${index}-${"x".repeat(20)}`).join("\n"), 50, 5);
  assert.equal(messages.length, 5);
  assert.ok(messages.every((message) => message.length <= 50 || message.includes("內容過長")));
  assert.match(messages[4], /未綁定清單/);
});

test("LINE signature accepts correct signature and rejects incorrect signature", () => {
  const rawBody = Buffer.from('{"events":[]}');
  const secret = "test-secret";
  const signature = crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
  assert.equal(verifyLineSignature(rawBody, signature, secret), true);
  assert.equal(verifyLineSignature(rawBody, "wrong", secret), false);
});

test("non-group source cannot be treated as a group message", () => {
  assert.equal(isGroupMessageEvent({
    type: "message",
    message: {type: "text", text: "綁定 Rain"},
    source: {type: "user", userId: "U1"},
  }), false);
});

test("first valid bind can claim an unset default group", () => {
  const decision = decideLineGroupAction(null, GROUP_ID, "bind");
  assert.deepEqual(decision, {action: "claim-on-success", canProcess: true, canClaim: true});
  assert.equal(claimDefaultLineGroup(null, GROUP_ID), GROUP_ID);
});

test("commands from the current default group are processed", () => {
  ["bind", "status", "unbind", "binding-list", "unbound-list"].forEach((type) => {
    assert.equal(decideLineGroupAction(GROUP_ID, GROUP_ID, type).action, "process");
  });
});

test("ordinary text and commands from another group cannot change the send target", () => {
  assert.equal(decideLineGroupAction(GROUP_ID, "C_GROUP_B", null).action, "ignore");
  ["bind", "status", "unbind", "binding-list", "unbound-list"].forEach((type) => {
    assert.equal(decideLineGroupAction(GROUP_ID, "C_GROUP_B", type).action, "reject-other-group");
  });
  assert.equal(claimDefaultLineGroup(GROUP_ID, "C_GROUP_B"), GROUP_ID);
});

test("literal braces in unbound player names are escaped for textV2", () => {
  const result = buildDrawLineMessage({
    date: "2026-08-11",
    captain: "Rain{R} - 船{長}",
    guardian: "Hank - 守護",
    cabin4: [],
  }, {}, GROUP_ID);
  assert.match(result.message.text, /船\{\{長\}\} @Rain\{\{R\}\}/);
});
