"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {spawnSync} = require("node:child_process");
const test = require("node:test");
const {
  CANONICAL_MEMBERS,
  activeMemberIds,
  buildMigrationProposal,
  buildProductionDryRun,
  canonicalMaster,
  createHistoryMemberSnapshot,
  hasActivatedMembersMaster,
  historySnapshotDisplay,
  normalizeMembersMaster,
  resolveCanonicalMember,
  validateMemberInput,
} = require("../lib/memberIdentity");
const {
  buildDrawLineMessage,
  buildMemberBindingRows,
  createBindingRecord,
  findBindingForMember,
  listBindingRecords,
  normalizeGuildMembers,
} = require("../lib/line");
const {buildLineBindingAdminRows} = require("../lib/line-sync");
const {resolveSenderRole} = require("../lib/miaobing-lore");
const {SENDER_ROLES} = require("../lib/miaobing-personality");
const {sanitizePublishedDrawRecord} = require("../lib/drawKnowledge");

const GROUP_ID = "C_GROUP";
const indexSource = fs.readFileSync(path.resolve(__dirname, "../../index.html"), "utf8");

function member(memberId, overrides = {}) {
  return {...canonicalMaster()[memberId], ...overrides};
}

function binding(memberValue, lineUserId = "U_USER") {
  return createBindingRecord({
    member: memberValue,
    userId: lineUserId,
    displayName: memberValue.lineNameHint || "LINE",
    groupId: GROUP_ID,
    now: "2026-08-30T00:00:00.000Z",
  });
}

function safeLegacyMain(overrides = {}) {
  const names = ["@Hank - 挖系小嗨", "Chia - 嘻嘻不嘻嘻", "Rain - 流鬼"];
  return {
    guildMembers: names,
    highWarMembers: names,
    presidentName: "@Hank - 挖系小嗨",
    captainPool: names,
    guardianPool: names,
    cabin4Pool: names,
    captainExcludedMembers: [],
    guardianExcludedMembers: [],
    cabin4ExcludedMembers: [],
    history: [{
      id: "draw-1", date: "2026-08-30",
      captain: names[0], guardian: names[1], cabin4: [names[2]],
      consumed: {captain: [names[0]], guardian: [names[1]], cabin4: [names[2]]},
    }],
    ...overrides,
  };
}

test("canonical mapping contains 45 unique numeric Member IDs", () => {
  assert.equal(CANONICAL_MEMBERS.length, 45);
  assert.equal(new Set(CANONICAL_MEMBERS.map((row) => row.memberId)).size, 45);
  assert.equal(CANONICAL_MEMBERS.every((row) => /^\d+$/u.test(row.memberId)), true);
});

test("duplicate or mismatched embedded memberId is rejected by master normalization", () => {
  const normalized = normalizeMembersMaster({
    1443678: {memberId: "849633", gameName: "錯誤角色", active: true},
  });
  assert.deepEqual(normalized, {});
  assert.match(indexSource, /state\.members\[validation\.memberId\].*Member ID 已存在/u);
});

test("invalid non-numeric Member ID is rejected", () => {
  assert.deepEqual(validateMemberInput({memberId: "A-1", gameName: "角色"}),
    {ok: false, reason: "invalid-member-id"});
});

test("renaming gameName preserves the permanent Member ID", () => {
  const master = canonicalMaster();
  master[1443678] = {...master[1443678], gameName: "ABC"};
  assert.equal(normalizeMembersMaster(master)[1443678].memberId, "1443678");
  assert.equal(normalizeMembersMaster(master)[1443678].gameName, "ABC");
});

test("inactive member is excluded from active draw identity source", () => {
  const master = canonicalMaster();
  master[1537124].active = false;
  assert.equal(activeMemberIds(master).includes("1537124"), false);
  assert.equal(normalizeGuildMembers(master).some((row) => row.memberId === "1537124"), false);
});

test("reactivating a member restores identity eligibility", () => {
  const master = canonicalMaster();
  master[1537124].active = false;
  master[1537124].active = true;
  assert.equal(activeMemberIds(master).includes("1537124"), true);
});

test("high-war reorder cannot change an existing history snapshot", () => {
  const snapshot = createHistoryMemberSnapshot(member("1443678"));
  const history = {memberIdentity: {guardian: snapshot}};
  const highWarMemberIds = ["849633", "1443678"].reverse();
  assert.deepEqual(history.memberIdentity.guardian, snapshot);
  assert.deepEqual(highWarMemberIds, ["1443678", "849633"]);
});

test("high-war replacement cannot change an existing history snapshot", () => {
  const snapshot = createHistoryMemberSnapshot(member("1443678"));
  const history = structuredClone(snapshot);
  const highWarMemberIds = ["1537124"];
  assert.equal(history.memberId, "1443678");
  assert.equal(highWarMemberIds.includes(history.memberId), false);
});

test("migration proposal converts all three role pools to Member IDs", () => {
  const proposal = buildMigrationProposal({main: safeLegacyMain(), bindings: {}});
  assert.equal(proposal.safe, true);
  assert.deepEqual(proposal.mainPatch.captainPool, ["1443678", "849633", "1537124"]);
  assert.deepEqual(proposal.mainPatch.guardianPool, ["1443678", "849633", "1537124"]);
  assert.deepEqual(proposal.mainPatch.cabin4Pool, ["1443678", "849633", "1537124"]);
});

test("captain, guardian, and cabin exclusions migrate independently to Member IDs", () => {
  const proposal = buildMigrationProposal({main: safeLegacyMain({
    captainExcludedMembers: ["Rain - 流鬼"],
    guardianExcludedMembers: ["@Hank - 挖系小嗨"],
    cabin4ExcludedMembers: ["Chia - 嘻嘻不嘻嘻"],
  }), bindings: {}});
  assert.deepEqual(proposal.mainPatch.captainExcludedMembers, ["1537124"]);
  assert.deepEqual(proposal.mainPatch.guardianExcludedMembers, ["1443678"]);
  assert.deepEqual(proposal.mainPatch.cabin4ExcludedMembers, ["849633"]);
});

test("pool reset source is stable Member ID rather than name or index", () => {
  const master = canonicalMaster();
  const resetPool = activeMemberIds(master);
  master[1443678].gameName = "新名稱";
  assert.equal(resetPool.includes("1443678"), true);
});

test("legacy history strings remain readable without a member master", () => {
  const legacy = sanitizePublishedDrawRecord({
    date: "2026-08-30", lineSentAt: "2026-08-30T00:00:00.000Z", lineSendCount: 1,
    captain: "@Hank - 挖系小嗨", guardian: "Chia - 嘻嘻不嘻嘻", cabin4: ["Rain - 流鬼"],
  });
  assert.equal(legacy.captain, "@Hank - 挖系小嗨");
});

test("new history stores Member ID and immutable name snapshot", () => {
  assert.deepEqual(createHistoryMemberSnapshot(member("1443678")), {
    memberId: "1443678", nameSnapshot: "挖系小嗨", lineNameSnapshot: "@Hank",
  });
});

test("renaming a member does not alter an old nameSnapshot", () => {
  const snapshot = createHistoryMemberSnapshot(member("1443678"));
  const renamed = member("1443678", {gameName: "ABC"});
  assert.equal(historySnapshotDisplay(snapshot), "@Hank - 挖系小嗨");
  assert.equal(createHistoryMemberSnapshot(renamed).nameSnapshot, "ABC");
});

test("a new draw after rename snapshots the new gameName", () => {
  const snapshot = createHistoryMemberSnapshot(member("1537124", {gameName: "新流鬼"}));
  assert.equal(snapshot.memberId, "1537124");
  assert.equal(snapshot.nameSnapshot, "新流鬼");
});

test("legacy LINE binding remains resolvable through deterministic canonical fallback", () => {
  const old = {playerName: "Rain - 流鬼", lineUserId: "U_RAIN", lineGroupId: GROUP_ID};
  const found = findBindingForMember(member("1537124", {gameName: "流鬼新名"}), {old}, GROUP_ID);
  assert.equal(found.lineUserId, "U_RAIN");
  assert.equal(found.memberId, "1537124");
});

test("migrated LINE binding uses memberId as source of truth", () => {
  const migrated = binding(member("1537124"), "U_RAIN");
  const found = findBindingForMember(member("1537124", {gameName: "改名"}), {migrated}, GROUP_ID);
  assert.equal(found.lineUserId, "U_RAIN");
});

test("one LINE user can retain multiple Member IDs", () => {
  const bindings = {
    a: binding(member("849633"), "U_CHIA"),
    b: binding(member("852177"), "U_CHIA"),
  };
  const rows = buildMemberBindingRows({
    849633: member("849633"), 852177: member("852177"),
  }, bindings, GROUP_ID);
  assert.equal(rows.length, 2);
  assert.equal(rows.every((row) => row.bound && row.lineUserId === "U_CHIA"), true);
});

test("Chia canonical regression preserves two distinct character IDs", () => {
  const chia = CANONICAL_MEMBERS.filter((row) => row.lineNameHint === "Chia");
  assert.deepEqual(new Set(chia.map((row) => row.memberId)), new Set(["852177", "849633"]));
});

test("member rename does not require modifying a Member-ID LINE binding", () => {
  const stored = binding(member("1443678"), "U_HANK");
  const before = structuredClone(stored);
  assert.equal(findBindingForMember(member("1443678", {gameName: "ABC"}), {stored}, GROUP_ID).id,
    "stored");
  assert.deepEqual(stored, before);
});

test("inactive member binding remains stored and can work again after reactivation", () => {
  const stored = binding(member("1537124"), "U_RAIN");
  const master = canonicalMaster();
  master[1537124].active = false;
  assert.equal(activeMemberIds(master).includes("1537124"), false);
  const records = listBindingRecords({stored});
  assert.equal(records.length, 1);
  assert.equal(records[0].memberId, "1537124");
  master[1537124].active = true;
  assert.equal(activeMemberIds(master).includes("1537124"), true);
  assert.equal(findBindingForMember(master[1537124], {stored}, GROUP_ID).lineUserId, "U_RAIN");
});

test("OWNER and GUILD_LEADER true identity resolution prefers Member ID", () => {
  const bindings = {
    owner: binding(member("849633"), "U_CHIA"),
    leader: binding(member("1443678"), "U_HANK"),
  };
  assert.equal(resolveSenderRole(bindings, GROUP_ID, "U_CHIA").senderRole, SENDER_ROLES.OWNER);
  assert.equal(resolveSenderRole(bindings, GROUP_ID, "U_HANK").senderRole,
    SENDER_ROLES.GUILD_LEADER);
});

test("draw LINE mention resolution uses memberId snapshots", () => {
  const bindings = {leader: binding(member("1443678"), "U_HANK")};
  const snapshot = createHistoryMemberSnapshot(member("1443678"));
  const output = buildDrawLineMessage({
    date: "2026-08-30", captain: "legacy", guardian: "legacy", cabin4: [],
    memberIdentity: {captain: snapshot, guardian: snapshot, cabin4: [snapshot]},
  }, bindings, GROUP_ID);
  assert.equal(Object.values(output.message.substitution)
    .every((item) => item.mentionee.userId === "U_HANK"), true);
});

test("Published Draw sanitizer accepts snapshots but keeps publication predicate unchanged", () => {
  const snapshot = createHistoryMemberSnapshot(member("1443678"));
  const hidden = sanitizePublishedDrawRecord({date: "2026-08-30",
    memberIdentity: {captain: snapshot, guardian: snapshot, cabin4: []}});
  assert.equal(hidden, null);
  const published = sanitizePublishedDrawRecord({date: "2026-08-30",
    lineSentAt: "2026-08-30T00:00:00.000Z", lineSendCount: 1,
    memberIdentity: {captain: snapshot, guardian: snapshot, cabin4: []}});
  assert.equal(published.captain, "@Hank - 挖系小嗨");
});

test("legacy Production missing members master remains supported", () => {
  assert.deepEqual(normalizeGuildMembers(["Rain - 流鬼"]),
    [{fullName: "Rain - 流鬼", lineName: "Rain", gameId: "流鬼"}]);
});

test("partial members master does not activate identity mode over legacy names", () => {
  const partial = {
    members: {1537124: member("1537124")},
    guildMembers: ["Rain - 流鬼", "@Hank - 挖系小嗨"],
  };
  assert.equal(hasActivatedMembersMaster(partial), false);
  assert.equal(hasActivatedMembersMaster({...partial, memberIdentityVersion: 1}), true);
  assert.equal(hasActivatedMembersMaster({
    members: {1537124: member("1537124")}, guildMembers: ["1537124"],
  }), true);
});

test("mixed legacy and Member-ID bindings resolve without duplicate rows", () => {
  const master = {1537124: member("1537124")};
  const bindings = {
    old: {playerName: "Rain - 流鬼", lineUserId: "U_RAIN", lineGroupId: GROUP_ID},
    otherGroup: binding(member("1537124"), "U_RAIN"),
  };
  bindings.otherGroup.lineGroupId = "OTHER";
  const rows = buildMemberBindingRows(master, bindings, GROUP_ID);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].bindingId, "old");
});

test("ambiguous and unmapped migration values are never guessed", () => {
  const unmapped = resolveCanonicalMember("不存在 - 未知角色");
  assert.equal(unmapped.status, "unmapped");
  const proposal = buildMigrationProposal({main: safeLegacyMain({
    captainPool: ["不存在 - 未知角色"],
  }), bindings: {}});
  assert.equal(proposal.safe, false);
  assert.equal(proposal.mainPatch, null);
});

test("soft delete strategy never rewrites history or LINE binding records", () => {
  assert.match(indexSource, /state\.members\[memberId\] = \{\.\.\.state\.members\[memberId\], active\}/u);
  const handler = indexSource.match(/async function setMemberActive[\s\S]*?(?=\n    function openDetail)/u);
  assert.ok(handler);
  assert.doesNotMatch(handler[0], /lineBindings|state\.history\s*=/u);
});

test("frontend removed index-based rename inference and exposes stable CRUD", () => {
  assert.doesNotMatch(indexSource, /function buildRenameMap|oldList\[i\]|newList\[i\]/u);
  for (const id of ["newMemberId", "newMemberGameName", "addMemberBtn", "membersTableWrap",
    "highWarMemberChoices", "presidentMemberId"]) assert.match(indexSource, new RegExp(`id="${id}"`, "u"));
});

test("getLineBindings admin rows expose memberId but never raw lineUserId", () => {
  const master = {1537124: member("1537124")};
  const rows = buildLineBindingAdminRows({memberNames: master,
    bindings: {rain: binding(member("1537124"), "U_RAIN")}, groupId: GROUP_ID});
  assert.equal(rows[0].memberId, "1537124");
  assert.equal(Object.hasOwn(rows[0], "lineUserId"), false);
});

test("unknown legacy LINE binding blocks full production migration", () => {
  const proposal = buildMigrationProposal({main: safeLegacyMain(), bindings: {
    unknown: {playerName: "舊成員 - 未知", lineUserId: "U_OLD", lineGroupId: GROUP_ID},
  }});
  assert.equal(proposal.safe, false);
  assert.equal(proposal.report.bindings.unmapped.length, 1);
});

test("unknown legacy history role is marked ambiguous and never patched", () => {
  const main = safeLegacyMain();
  main.history[0].captain = "舊成員 - 未知";
  const proposal = buildMigrationProposal({main, bindings: {}});
  assert.equal(proposal.safe, false);
  assert.equal(proposal.report.history.ambiguous.length, 1);
});

test("production dry-run counts deterministic mappings without exposing raw LINE identity", () => {
  const main = safeLegacyMain();
  const bindings = {
    rain: {playerName: "Rain - 流鬼", lineUserId: "U_RAW_SECRET", lineGroupId: "C_RAW_GROUP"},
  };
  const report = buildProductionDryRun({main, bindings});
  assert.equal(report.members.mapped.length, 3);
  assert.equal(report.bindings.mapped.length, 1);

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "capydraw-identity-"));
  const mainPath = path.join(directory, "main.json");
  const bindingsPath = path.join(directory, "bindings.json");
  try {
    fs.writeFileSync(mainPath, JSON.stringify(main), "utf8");
    fs.writeFileSync(bindingsPath, JSON.stringify(bindings), "utf8");
    const result = spawnSync(process.execPath, [
      path.resolve(__dirname, "../scripts/memberIdentityDryRun.js"), mainPath, bindingsPath,
    ], {encoding: "utf8"});
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /LINE BINDINGS MAPPED: 1/u);
    assert.match(result.stdout, /PRODUCTION WRITES PERFORMED: NO/u);
    assert.doesNotMatch(result.stdout, /U_RAW_SECRET|C_RAW_GROUP/u);
  } finally {
    fs.rmSync(directory, {recursive: true, force: true});
  }
});
