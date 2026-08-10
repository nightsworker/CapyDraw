"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const {
  buildDrawLineMessage,
  claimDefaultLineGroup,
  createBindingRecord,
  decideLineGroupAction,
  extractBindingCommand,
  findMemberMatches,
  isGroupMessageEvent,
  parseMemberName,
  verifyLineSignature,
} = require("../lib/line");

test("parseMemberName parses game name and alias", () => {
  assert.deepEqual(parseMemberName("流鬼 - Rain"), {
    fullName: "流鬼 - Rain",
    gameName: "流鬼",
    alias: "Rain",
  });
});

test("parseMemberName handles names without a hyphen", () => {
  assert.deepEqual(parseMemberName("純名字"), {
    fullName: "純名字",
    gameName: "純名字",
    alias: "純名字",
  });
});

test("parseMemberName preserves Chinese, emoji and full-width parentheses", () => {
  assert.deepEqual(parseMemberName("林日凱 - 🍎林日凱（Kim）"), {
    fullName: "林日凱 - 🍎林日凱（Kim）",
    gameName: "林日凱",
    alias: "🍎林日凱（Kim）",
  });
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

test("A: first valid bind can claim an unset default group", () => {
  const decision = decideLineGroupAction(null, "C_GROUP_A", "bind");
  assert.deepEqual(decision, {action: "claim-on-success", canProcess: true, canClaim: true});
  assert.equal(claimDefaultLineGroup(null, "C_GROUP_A"), "C_GROUP_A");
});

test("B: bind commands from the current default group are processed", () => {
  assert.deepEqual(decideLineGroupAction("C_GROUP_A", "C_GROUP_A", "bind"), {
    action: "process",
    canProcess: true,
    canClaim: false,
  });
  assert.equal(decideLineGroupAction("C_GROUP_A", "C_GROUP_A", "status").action, "process");
  assert.equal(decideLineGroupAction("C_GROUP_A", "C_GROUP_A", "unbind").action, "process");
});

test("C: ordinary text from another group cannot overwrite the default group", () => {
  const decision = decideLineGroupAction("C_GROUP_A", "C_GROUP_B", null);
  assert.deepEqual(decision, {action: "ignore", canProcess: false, canClaim: false});
  assert.equal(claimDefaultLineGroup("C_GROUP_A", "C_GROUP_B"), "C_GROUP_A");
});

test("D: bind commands from another group are rejected before creating a binding", () => {
  const decision = decideLineGroupAction("C_GROUP_A", "C_GROUP_B", "bind");
  assert.deepEqual(decision, {action: "reject-other-group", canProcess: false, canClaim: false});
});

test("E: a second group cannot change the active send target", () => {
  const originalSendTarget = "C_GROUP_A";
  const decision = decideLineGroupAction(originalSendTarget, "C_GROUP_B", "status");
  const sendTargetAfterEvent = decision.canClaim ?
    claimDefaultLineGroup(originalSendTarget, "C_GROUP_B") : originalSendTarget;
  assert.equal(decision.action, "reject-other-group");
  assert.equal(decideLineGroupAction(originalSendTarget, "C_GROUP_B", "unbind").action, "reject-other-group");
  assert.equal(sendTargetAfterEvent, "C_GROUP_A");
});

test("bind command resolves a unique alias and binding retains userId", () => {
  const command = extractBindingCommand("綁定 Rain");
  const {matches} = findMemberMatches(["流鬼 - Rain", "挖系小嗨 - Hank"], command.query);
  assert.equal(matches.length, 1);
  const binding = createBindingRecord({
    member: matches[0],
    userId: "U123",
    displayName: "Rain LINE",
    groupId: "C123",
    now: "2026-08-10T00:00:00.000Z",
  });
  assert.equal(binding.lineUserId, "U123");
  assert.equal(binding.playerName, "流鬼 - Rain");
});

test("ambiguous aliases are returned instead of fuzzy-selected", () => {
  const {matches} = findMemberMatches(["甲 - Rain", "乙 - Rain"], "Rain");
  assert.deepEqual(matches.map((item) => item.fullName), ["甲 - Rain", "乙 - Rain"]);
});

test("unbound members remain plain text and are reported", () => {
  const record = {
    date: "2026-08-10",
    captain: "流鬼 - Rain",
    guardian: "挖系小嗨 - Hank",
    cabin4: ["甲 - A"],
  };
  const result = buildDrawLineMessage(record, {}, "C123");
  assert.match(result.message.text, /8\/10船長：流鬼 @Rain/);
  assert.deepEqual(result.unboundMembers, ["Rain", "Hank", "A"]);
  assert.equal(result.message.substitution, undefined);
});

test("literal braces in unbound player names are escaped for textV2", () => {
  const result = buildDrawLineMessage({
    date: "2026-08-10",
    captain: "船{長} - Rain{R}",
    guardian: "守護 - Hank",
    cabin4: [],
  }, {}, "C123");
  assert.match(result.message.text, /船\{\{長\}\} @Rain\{\{R\}\}/);
});

test("all selected roles use genuine textV2 mention substitutions", () => {
  const names = ["流鬼 - Rain", "挖系小嗨 - Hank", "甲 - A", "乙 - B", "丙 - C", "丁 - D", "戊 - E"];
  const bindings = Object.fromEntries(names.map((name, index) => {
    const parsed = parseMemberName(name);
    return [`key${index}`, createBindingRecord({
      member: parsed,
      userId: `U${index}`,
      displayName: parsed.alias,
      groupId: "C123",
      now: "2026-08-10T00:00:00.000Z",
    })];
  }));
  const result = buildDrawLineMessage({
    date: "2026-08-10",
    captain: names[0],
    guardian: names[1],
    cabin4: names.slice(2),
    specialDay: true,
  }, bindings, "C123");
  assert.equal(result.message.type, "textV2");
  assert.deepEqual(Object.keys(result.message.substitution), [
    "mention0", "mention1", "mention2", "mention3", "mention4", "mention5", "mention6",
  ]);
  assert.equal(result.message.substitution.mention0.mentionee.userId, "U0");
  assert.deepEqual(result.unboundMembers, []);
  assert.doesNotMatch(result.message.text, /specialDay/);
});
