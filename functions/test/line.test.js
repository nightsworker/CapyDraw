"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const {
  bindingKey,
  buildAdminBindingSuccessText,
  buildAdminUnbindSuccessText,
  buildBindingListText,
  buildBindingSuccessText,
  buildBotHelpText,
  buildDrawLineMessage,
  buildMemberBindingRows,
  buildUnboundListText,
  buildUnbindSuccessText,
  claimDefaultLineGroup,
  createBindingRecord,
  decideLineGroupAction,
  extractBindingCommand,
  findBindingForMember,
  findMembersByLineName,
  isGroupMessageEvent,
  parseBotCommand,
  parseMemberName,
  planWebhookEvent,
  resolveBindingLineName,
  splitTextMessages,
  verifyLineSignature,
} = require("../lib/line");
const {
  buildMemberSyncPlan,
  buildObservedMemberRecord,
  buildSyncReply,
  decideLineCommandAccess,
  decideLineSyncAccess,
  fetchAllGroupMemberIds,
  getBindingLockTransition,
  isBindingLocked,
  planAdminBinding,
  resolveSyncMemberSource,
  selectAdminUnbindBindings,
} = require("../lib/line-sync");

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
  assert.match(messages[4], /!未綁定/);
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
  ["bind", "status", "unbind", "binding-list", "unbound-list", "sync"].forEach((type) => {
    assert.equal(decideLineGroupAction(GROUP_ID, GROUP_ID, type).action, "process");
  });
});

test("ordinary text and commands from another group cannot change the send target", () => {
  assert.equal(decideLineGroupAction(GROUP_ID, "C_GROUP_B", null).action, "ignore");
  ["bind", "status", "unbind", "binding-list", "unbound-list", "sync"].forEach((type) => {
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

test("prefixed command parser ignores ordinary chat", () => {
  assert.equal(parseBotCommand("綁定一下晚點再說"), null);
  assert.equal(parseBotCommand("今天還沒綁定"), null);
});

test("prefixed bind command supports trim and an optional exact LINE name", () => {
  const automatic = parseBotCommand("  !綁定  ");
  assert.deepEqual(automatic, {
    command: "bind",
    args: "",
    isLegacy: false,
    auto: true,
    query: null,
  });
  const manual = parseBotCommand("!綁定 @Hank");
  assert.deepEqual(manual, {
    command: "bind",
    args: "@Hank",
    isLegacy: false,
    auto: false,
    query: "@Hank",
  });
  assert.equal(resolveBindingLineName(automatic, "@Hank"), "@Hank");
  assert.equal(resolveBindingLineName(manual, "ignored"), "@Hank");
});

test("all official prefixed commands are parsed centrally", () => {
  const commands = new Map([
    ["!狀態", "status"],
    ["!清單", "binding-list"],
    ["!未綁定", "unbound-list"],
    ["!解除", "unbind"],
    ["!同步", "sync"],
    ["!鎖定", "lock"],
    ["!解除鎖定", "unlock"],
    ["!說明", "help"],
  ]);
  commands.forEach((command, input) => {
    assert.deepEqual(parseBotCommand(input), {command, args: "", isLegacy: false});
  });
  assert.deepEqual(parseBotCommand("!abc"), {
    command: "unknown",
    args: "",
    isLegacy: false,
    input: "!abc",
  });
});

test("legacy commands remain centralized and backward compatible", () => {
  assert.equal(parseBotCommand("綁定").isLegacy, true);
  assert.equal(parseBotCommand("綁定 @Hank").command, "bind");
  assert.equal(parseBotCommand("bind @Hank").args, "@Hank");
  assert.equal(parseBotCommand("綁定狀態").command, "status");
  assert.equal(parseBotCommand("LINE清單").command, "binding-list");
  assert.equal(parseBotCommand("解除綁定").command, "unbind");
});

test("LINE name matching preserves @ and case exactly", () => {
  assert.equal(findMembersByLineName(["@Hank - 挖系小嗨"], "@Hank").length, 1);
  assert.equal(findMembersByLineName(["@Hank - 挖系小嗨"], "Hank").length, 0);
  assert.equal(findMembersByLineName(["Rain - 流鬼"], "Rain").length, 1);
  assert.equal(findMembersByLineName(["Rain - 流鬼"], "rain").length, 0);
  assert.equal(findMembersByLineName(["A  B - 帳號"], "A  B").length, 0);
});

test("member sync binds all exact game IDs for one LINE identity", () => {
  const result = buildMemberSyncPlan({
    memberNames: ["Chia - 嘻嘻不嘻嘻", "Chia - CC x CC"],
    bindings: {},
    profiles: [{userId: "U_CHIA", displayName: "Chia"}],
    groupId: GROUP_ID,
    now: NOW,
  });
  assert.equal(result.added, 2);
  assert.equal(result.boundGuildAccounts, 2);
  assert.deepEqual(new Set(Object.values(result.updates).map((row) => row.lineUserId)), new Set(["U_CHIA"]));
});

test("member sync skips non-guild LINE members", () => {
  const result = buildMemberSyncPlan({
    memberNames: ["Rain - 流鬼"],
    bindings: {},
    profiles: [{userId: "U_GUEST", displayName: "路人甲"}],
    groupId: GROUP_ID,
    now: NOW,
  });
  assert.equal(result.nonGuild, 1);
  assert.equal(result.added, 0);
  assert.deepEqual(result.updates, {});
});

test("full group member API pagination follows every next token", async () => {
  const starts = [];
  const memberIds = await fetchAllGroupMemberIds(async (start) => {
    starts.push(start);
    if (!start) return {memberIds: ["U1", "U2"], next: "PAGE_2"};
    return {memberIds: ["U2", "U3"]};
  });
  assert.deepEqual(starts, [null, "PAGE_2"]);
  assert.deepEqual(memberIds, ["U1", "U2", "U3"]);
});

test("group member API 403 falls back to observed members", async () => {
  const forbidden = Object.assign(new Error("forbidden"), {lineStatus: 403});
  const source = await resolveSyncMemberSource(async () => {
    throw forbidden;
  }, {
    U1: {lineUserId: "U1", displayName: "Rain", groupId: GROUP_ID},
  });
  assert.equal(source.mode, "observed");
  assert.deepEqual(source.memberIds, ["U1"]);
  assert.match(buildSyncReply({
    scannedMembers: 1,
    added: 0,
    alreadyBound: 0,
    nonGuild: 0,
    conflicts: 0,
    unboundGuildAccounts: 1,
    boundGuildAccounts: 0,
    totalGuildAccounts: 1,
  }, source.mode), /Bot 曾經看過的群組成員/);
});

test("group member API errors other than 403 never use observed fallback", async () => {
  for (const lineStatus of [404, 429, 500]) {
    const error = Object.assign(new Error(String(lineStatus)), {lineStatus});
    await assert.rejects(
      resolveSyncMemberSource(async () => { throw error; }, {}),
      (caught) => caught.lineStatus === lineStatus,
    );
  }
  const networkError = new Error("network");
  await assert.rejects(
    resolveSyncMemberSource(async () => { throw networkError; }, {}),
    (caught) => caught === networkError,
  );
});

test("verified group webhook identity builds observed member metadata", () => {
  const event = {
    type: "message",
    message: {type: "text", text: "普通聊天"},
    source: {type: "group", groupId: GROUP_ID, userId: "U_HANK"},
  };
  const plan = planWebhookEvent(event);
  assert.equal(plan.observeMember, true);
  assert.equal(plan.command, null);
  const first = buildObservedMemberRecord(null, {
    lineUserId: "U_HANK",
    displayName: "@Hank",
    groupId: GROUP_ID,
    pictureUrl: "https://example.com/hank.png",
  }, NOW);
  const next = buildObservedMemberRecord(first, {
    lineUserId: "U_HANK",
    displayName: "@Hank",
    groupId: GROUP_ID,
  }, "2026-08-12T00:00:00.000Z");
  assert.equal(next.firstSeenAt, NOW);
  assert.equal(next.lastSeenAt, "2026-08-12T00:00:00.000Z");
  assert.equal("message" in next, false);
});

test("member sync updates an existing identity without adding a duplicate", () => {
  const playerName = "Rain - 流鬼";
  const key = bindingKey(playerName);
  const result = buildMemberSyncPlan({
    memberNames: [playerName],
    bindings: {[key]: makeBinding(playerName, "U_RAIN")},
    profiles: [{userId: "U_RAIN", displayName: "Rain"}],
    groupId: GROUP_ID,
    now: "2026-08-12T00:00:00.000Z",
  });
  assert.equal(result.added, 0);
  assert.equal(result.alreadyBound, 1);
  assert.deepEqual(Object.keys(result.updates), [key]);
});

test("member sync reports a conflicting userId without overwriting", () => {
  const playerName = "Rain - 流鬼";
  const key = bindingKey(playerName);
  const existing = makeBinding(playerName, "U_RAIN_A");
  const result = buildMemberSyncPlan({
    memberNames: [playerName],
    bindings: {[key]: existing},
    profiles: [{userId: "U_RAIN_B", displayName: "Rain"}],
    groupId: GROUP_ID,
    now: "2026-08-12T00:00:00.000Z",
  });
  assert.equal(result.conflicts, 1);
  assert.equal(result.added, 0);
  assert.deepEqual(result.updates, {});
  assert.equal(existing.lineUserId, "U_RAIN_A");
});

test("member sync requires a LINE admin in the default group", () => {
  const admins = {U_ADMIN: true};
  assert.deepEqual(decideLineSyncAccess(GROUP_ID, GROUP_ID, admins, "U_MEMBER"), {
    allowed: false,
    reason: "not-admin",
  });
  assert.deepEqual(decideLineSyncAccess(GROUP_ID, "C_GROUP_B", admins, "U_ADMIN"), {
    allowed: false,
    reason: "other-group",
  });
  assert.deepEqual(decideLineSyncAccess(GROUP_ID, GROUP_ID, admins, "U_ADMIN"), {
    allowed: true,
    reason: null,
  });
});

test("help documents member, lock, and admin command visibility", () => {
  const help = buildBotHelpText();
  ["!綁定", "!狀態", "!清單", "!未綁定", "!解除"].forEach((command) => {
    assert.match(help, new RegExp(command.replace("!", "\\!")));
  });
  assert.doesNotMatch(help, /管理員指令：|!同步|!幫綁/);
  const lockedHelp = buildBotHelpText({bindingLocked: true});
  assert.match(lockedHelp, /目前 LINE 綁定已鎖定/);
  const adminHelp = buildBotHelpText({bindingLocked: true, isAdmin: true});
  ["!同步", "!鎖定", "!解除鎖定", "!幫綁 <LINE名稱>", "!幫解除 <LINE名稱>"].forEach((command) => {
    assert.match(adminHelp, new RegExp(command.replace("!", "\\!")));
  });
  const lines = help.split("\n");
  ["綁定狀態", "解除綁定", "line list"].forEach((legacyCommand) => {
    assert.equal(lines.includes(legacyCommand), false);
  });
});

test("binding success uses the same LINE and game ID format for one or many accounts", () => {
  assert.equal(buildBindingSuccessText([parseMemberName("Rain - 流鬼")]), [
    "✅ LINE 綁定完成",
    "",
    "LINE：Rain",
    "遊戲 ID：",
    "• 流鬼",
  ].join("\n"));
  assert.equal(buildBindingSuccessText([
    parseMemberName("Chia - 嘻嘻不嘻嘻"),
    parseMemberName("Chia - CC x CC"),
  ]), [
    "✅ LINE 綁定完成",
    "",
    "LINE：Chia",
    "遊戲 ID：",
    "• 嘻嘻不嘻嘻",
    "• CC x CC",
  ].join("\n"));
});

test("unbind success derives LINE names and game IDs from removed playerName values", () => {
  assert.equal(buildUnbindSuccessText([{playerName: "Rain - 流鬼"}]), [
    "✅ 已解除 LINE 綁定",
    "",
    "LINE：Rain",
    "遊戲 ID：",
    "• 流鬼",
    "",
    "共解除 1 個遊戲帳號。",
  ].join("\n"));
  const removedBindings = [
    {playerName: "Chia - 嘻嘻不嘻嘻"},
    {playerName: "Chia - CC x CC"},
  ];
  assert.equal(buildUnbindSuccessText(removedBindings), [
    "✅ 已解除 LINE 綁定",
    "",
    "LINE：Chia",
    "遊戲 ID：",
    "• 嘻嘻不嘻嘻",
    "• CC x CC",
    "",
    "共解除 2 個遊戲帳號。",
  ].join("\n"));
});

test("bindingLocked defaults to false and lock transitions avoid redundant writes", () => {
  assert.equal(isBindingLocked(undefined), false);
  assert.deepEqual(getBindingLockTransition(undefined, true), {changed: true, bindingLocked: true});
  assert.deepEqual(getBindingLockTransition(true, true), {changed: false, bindingLocked: true});
  assert.deepEqual(getBindingLockTransition(true, false), {changed: true, bindingLocked: false});
  assert.deepEqual(getBindingLockTransition(false, false), {changed: false, bindingLocked: false});
});

test("binding lock only blocks member self-service writes", () => {
  const decide = (command, bindingLocked, userId = "U_MEMBER") => decideLineCommandAccess({
    command,
    bindingLocked,
    defaultGroupId: GROUP_ID,
    eventGroupId: GROUP_ID,
    adminLineUserIds: {U_ADMIN: true},
    userId,
  });
  assert.equal(decide("bind", false).allowed, true);
  assert.equal(decide("bind", true).reason, "binding-locked");
  assert.equal(decide("unbind", true).reason, "binding-locked");
  ["status", "binding-list", "unbound-list", "help"].forEach((command) => {
    assert.equal(decide(command, true).allowed, true);
  });
  assert.equal(decide("sync", true, "U_ADMIN").allowed, true);
  assert.equal(decide("bind", true, "U_ADMIN").reason, "binding-locked");
  assert.equal(decide("lock", false).reason, "not-admin");
  assert.equal(decide("admin-bind", true).reason, "not-admin");
  assert.equal(decide("admin-unbind", true, "U_ADMIN").allowed, true);
});

test("admin modifying commands are limited to the default group", () => {
  const access = decideLineCommandAccess({
    command: "lock",
    bindingLocked: false,
    defaultGroupId: GROUP_ID,
    eventGroupId: "C_GROUP_B",
    adminLineUserIds: {U_ADMIN: true},
    userId: "U_ADMIN",
  });
  assert.deepEqual(access, {allowed: false, reason: "other-group"});
});

test("admin bind parser uses exact command tokens and arguments", () => {
  assert.deepEqual(parseBotCommand("!幫綁 @Hank"), {
    command: "admin-bind",
    args: "@Hank",
    isLegacy: false,
  });
  assert.deepEqual(parseBotCommand("!幫解除 @Hank"), {
    command: "admin-unbind",
    args: "@Hank",
    isLegacy: false,
  });
  assert.equal(parseBotCommand("!解除鎖定").command, "unlock");
  assert.notEqual(parseBotCommand("!解除鎖定").command, "unbind");
  assert.notEqual(parseBotCommand("!幫解除 @Hank").command, "unbind");
});

test("admin bind requires exact guild and observed LINE names", () => {
  const success = planAdminBinding({
    memberNames: ["@Hank - 挖系小嗨"],
    bindings: {},
    observedMembers: {
      U_HANK: {lineUserId: "U_HANK", displayName: "@Hank", groupId: GROUP_ID},
    },
    lineName: "@Hank",
    groupId: GROUP_ID,
    now: NOW,
  });
  assert.equal(success.status, "success");
  assert.equal(Object.values(success.updates)[0].lineUserId, "U_HANK");
  const missingAt = planAdminBinding({
    memberNames: ["@Hank - 挖系小嗨"],
    bindings: {},
    observedMembers: {},
    lineName: "Hank",
    groupId: GROUP_ID,
    now: NOW,
  });
  assert.equal(missingAt.status, "guild-member-not-found");
});

test("admin bind refuses missing and ambiguous observed identities", () => {
  const base = {
    memberNames: ["Rain - 流鬼"],
    bindings: {},
    lineName: "Rain",
    groupId: GROUP_ID,
    now: NOW,
  };
  assert.equal(planAdminBinding({...base, observedMembers: {}}).status, "line-identity-not-found");
  const ambiguous = planAdminBinding({...base, observedMembers: {
    U_RAIN_1: {lineUserId: "U_RAIN_1", displayName: "Rain", groupId: GROUP_ID},
    U_RAIN_2: {lineUserId: "U_RAIN_2", displayName: "Rain", groupId: GROUP_ID},
  }});
  assert.equal(ambiguous.status, "ambiguous-line-identity");
  assert.deepEqual(ambiguous.updates, {});
});

test("admin bind handles multiple game IDs and never overwrites conflicts", () => {
  const memberNames = ["Chia - 嘻嘻不嘻嘻", "Chia - CC x CC"];
  const observedMembers = {
    U_CHIA: {lineUserId: "U_CHIA", displayName: "Chia", groupId: GROUP_ID},
  };
  const success = planAdminBinding({
    memberNames,
    bindings: {},
    observedMembers,
    lineName: "Chia",
    groupId: GROUP_ID,
    now: NOW,
  });
  assert.equal(success.members.length, 2);
  assert.equal(Object.keys(success.updates).length, 2);
  const conflictingKey = bindingKey(memberNames[0]);
  const conflict = planAdminBinding({
    memberNames,
    bindings: {[conflictingKey]: makeBinding(memberNames[0], "U_OTHER")},
    observedMembers,
    lineName: "Chia",
    groupId: GROUP_ID,
    now: NOW,
  });
  assert.equal(conflict.status, "binding-conflict");
  assert.deepEqual(conflict.updates, {});
});

test("admin unbind selects only the exact LINE name in the current group", () => {
  const hankOne = "@Hank - 挖系小嗨";
  const hankTwo = "@Hank - 第二帳號";
  const rain = "Rain - 流鬼";
  const bindings = {
    hankOne: makeBinding(hankOne, "U_HANK"),
    hankTwo: makeBinding(hankTwo, "U_HANK"),
    rain: makeBinding(rain, "U_RAIN"),
  };
  const selected = selectAdminUnbindBindings({
    memberNames: [hankOne, hankTwo, rain],
    bindings,
    lineName: "@Hank",
    groupId: GROUP_ID,
  });
  assert.equal(selected.status, "success");
  assert.deepEqual(selected.bindings.map((binding) => binding.gameId), ["挖系小嗨", "第二帳號"]);
  assert.equal(selected.bindings.some((binding) => binding.lineName === "Rain"), false);
});

test("admin bind and unbind success replies use the unified detail format", () => {
  const members = [parseMemberName("Chia - 嘻嘻不嘻嘻"), parseMemberName("Chia - CC x CC")];
  const bindText = buildAdminBindingSuccessText(members);
  assert.match(bindText, /^✅ 管理員完成 LINE 綁定/m);
  assert.match(bindText, /LINE：Chia\n遊戲 ID：\n• 嘻嘻不嘻嘻\n• CC x CC/);
  assert.match(bindText, /共綁定 2 個遊戲帳號。/);
  const unbindText = buildAdminUnbindSuccessText(members.map((member) => ({playerName: member.fullName})));
  assert.match(unbindText, /^✅ 管理員已解除 LINE 綁定/m);
  assert.match(unbindText, /共解除 2 個遊戲帳號。/);
});

test("binding list displays whether self-service binding is locked", () => {
  assert.match(buildBindingListText(["Rain - 流鬼"], {}, GROUP_ID), /🔓 綁定狀態：開放中/);
  assert.match(buildBindingListText(["Rain - 流鬼"], {}, GROUP_ID, true), /🔒 綁定狀態：已鎖定/);
});
