"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  CANON_LEVELS,
  CLASSIC_LINE,
  HARD_CANON,
  MAX_RELEVANT_CANON,
  MIAOBING_CANON,
  SOFT_CANON,
  findRelevantCanon,
  formatCanonForInstructions,
} = require("../lib/miaobingCanon");
const {MIAOBING_LORE, SENDER_ROLES} = require("../lib/miaobing-personality");
const {buildMiaobingInstructions} = require("../lib/miaobingPersona");

function byId(entries, id) {
  return entries.find((entry) => entry.id === id);
}

test("canon library exposes hard, soft, and classic levels", () => {
  assert.ok(HARD_CANON.length > 0);
  assert.ok(SOFT_CANON.length > 0);
  assert.ok(CLASSIC_LINE.length > 0);
  assert.equal(HARD_CANON.every((entry) => entry.level === CANON_LEVELS.HARD_CANON), true);
  assert.equal(SOFT_CANON.every((entry) => entry.level === CANON_LEVELS.SOFT_CANON), true);
  assert.equal(CLASSIC_LINE.every((entry) => entry.level === CANON_LEVELS.CLASSIC_LINE), true);
});

test("hard canon preserves Chia, Hank, and plate identities", () => {
  const owner = byId(HARD_CANON, "owner-chia");
  const leader = byId(HARD_CANON, "guild-leader-hank");
  const plate = byId(HARD_CANON, "plate-target");
  assert.match(owner.immutableMeaning, /Chia/u);
  assert.match(owner.immutableMeaning, /嘻嘻不嘻嘻/u);
  assert.match(owner.immutableMeaning, /CC x CC/u);
  assert.match(leader.immutableMeaning, /@Hank/u);
  assert.match(leader.immutableMeaning, /挖系小嗨/u);
  assert.match(plate.immutableMeaning, /貳零陸/u);
  assert.match(plate.immutableMeaning, /九章伏藏/u);
});

test("the fourth cabin ticket count is immutable at three", () => {
  const hard = byId(HARD_CANON, "cabin-four-tickets");
  const classic = byId(CLASSIC_LINE, "classic-cabin-four-tickets");
  assert.match(hard.immutableMeaning, /3 張/u);
  assert.deepEqual(hard.forbiddenChanges, ["數字 3 絕對不可改", "不可改成建議、選填或其他船艙"]);
  assert.equal(classic.classicLines[0], "第四船艙的小朋友務必捐滿三張船票。");
});

test("OWNER and guild leader remain distinct canonical roles", () => {
  assert.notEqual(SENDER_ROLES.OWNER, SENDER_ROLES.GUILD_LEADER);
  assert.equal(MIAOBING_LORE.owner.lineName, "Chia");
  assert.equal(MIAOBING_LORE.guildLeader.lineName, "@Hank");
  assert.match(byId(HARD_CANON, "owner-leader-distinction").immutableMeaning,
    /兩個不同角色/u);
});

test("personality roles are explicitly separate from admin authorization", () => {
  const separation = byId(HARD_CANON, "role-authorization-separation");
  assert.match(separation.immutableMeaning, /不同系統/u);
  assert.match(separation.immutableMeaning, /不會自動取得管理權限/u);
  assert.match(byId(HARD_CANON, "binding-based-role-resolution").immutableMeaning,
    /binding/u);
});

test("canon retrieval selects only relevant entries and never injects the whole library", () => {
  const relevant = findRelevantCanon("第四船艙要捐幾張船票？");
  assert.ok(relevant.length > 0);
  assert.ok(relevant.length <= MAX_RELEVANT_CANON);
  assert.ok(relevant.length < MIAOBING_CANON.length);
  assert.equal(relevant.some((entry) => entry.id === "cabin-four-tickets"), true);
  assert.equal(relevant.some((entry) => entry.id === "plate-target"), false);
  assert.deepEqual(findRelevantCanon("完全無關的隨機問題"), []);
});

test("canon retrieval respects the hard maximum even with many matching topics", () => {
  const relevant = findRelevantCanon(
    "主人 Chia 嘻嘻 CC 會長 Hank 盤子 第四船艙 船票 船長 發船 管理員 綁定 閉嘴",
    {limit: 999},
  );
  assert.equal(relevant.length, MAX_RELEVANT_CANON);
});

test("AI instructions include relevant canon but omit unrelated identity facts", () => {
  const instructions = buildMiaobingInstructions({question: "第四船艙要捐幾張船票？", mood: "測試"});
  assert.match(instructions, /第四船艙的小朋友務必捐滿三張船票/u);
  assert.match(instructions, /數字 3 絕對不可改/u);
  assert.doesNotMatch(instructions, /貳零陸 - 九章伏藏/u);
  assert.match(formatCanonForInstructions(findRelevantCanon("船長何時發船")),
    /需要提前告知/u);
});
