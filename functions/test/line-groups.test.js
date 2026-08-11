"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  bindingKey,
  bindingKeyForGroup,
  createBindingRecord,
  parseMemberName,
  planWebhookEvent,
} = require("../lib/line");
const {
  FALLBACK_GROUP_NAME,
  buildKnownLineGroupRecord,
  buildLineBindingMigrationPlan,
  buildLineGroupAdminRows,
  buildLineGroupSwitchUpdates,
  planLineGroupJoin,
} = require("../lib/line-groups");
const {resolveSenderRole} = require("../lib/miaobing-lore");
const {isPersonalityEnabled, SENDER_ROLES} = require("../lib/miaobing-personality");

const OLD_GROUP_ID = "C12345678901234567890";
const NEW_GROUP_ID = "C09876543210987654321";
const NOW = "2026-08-11T10:00:00.000Z";

function makeBinding(playerName, userId, groupId = OLD_GROUP_ID, displayName) {
  return createBindingRecord({
    member: parseMemberName(playerName),
    userId,
    displayName: displayName || parseMemberName(playerName).lineName,
    groupId,
    now: NOW,
  });
}

test("A-I: a group join registers a known group and builds the required introduction", () => {
  const eventPlan = planWebhookEvent({
    type: "join",
    replyToken: "reply-token",
    source: {type: "group", groupId: NEW_GROUP_ID},
  });
  assert.equal(eventPlan.joinGroup, true);
  assert.equal(eventPlan.observeMember, false);
  assert.equal(eventPlan.command, null);

  const plan = planLineGroupJoin({
    groupId: NEW_GROUP_ID,
    summary: {groupName: "正式公會群", pictureUrl: "https://example.com/group.png"},
    defaultGroupId: OLD_GROUP_ID,
    now: NOW,
  });
  assert.equal(plan.record.groupId, NEW_GROUP_ID);
  assert.equal(plan.record.groupName, "正式公會群");
  assert.equal(plan.record.joinedAt, NOW);
  assert.equal(plan.record.lastSeenAt, NOW);
  assert.equal(plan.isDefault, false);
  assert.match(plan.replyText, /^喵？這裡就是本喵以後要待的公會嗎？/);
  assert.match(plan.replyText, /!說明/);
  assert.match(plan.replyText, /平常也可以叫本喵，或是 @本喵跟本喵說話。/);
  assert.match(plan.replyText, /管理員記得去後台把這裡設成正式公會群喵。/);
  assert.doesNotMatch(plan.replyText, /!綁定/);
  assert.equal(Object.hasOwn(plan, "defaultGroupId"), false);
});

test("an already-default join omits the administrator reminder", () => {
  const plan = planLineGroupJoin({
    groupId: NEW_GROUP_ID,
    summary: {groupName: "正式公會群"},
    defaultGroupId: NEW_GROUP_ID,
    now: NOW,
  });
  assert.equal(plan.isDefault, true);
  assert.doesNotMatch(plan.replyText, /管理員記得去後台/);
});

test("group summary failure uses a safe fallback and still produces a join plan", () => {
  const plan = planLineGroupJoin({
    groupId: NEW_GROUP_ID,
    summary: null,
    defaultGroupId: OLD_GROUP_ID,
    now: NOW,
  });
  assert.equal(plan.record.groupName, FALLBACK_GROUP_NAME);
  assert.ok(plan.groupKey.startsWith("g_"));
  assert.ok(plan.replyText);
});

test("ordinary group events update lastSeen without replacing join metadata", () => {
  const current = {
    groupId: NEW_GROUP_ID,
    groupName: "正式公會群",
    pictureUrl: "https://example.com/old.png",
    joinedAt: NOW,
    lastSeenAt: NOW,
  };
  const next = buildKnownLineGroupRecord(current, {
    groupId: NEW_GROUP_ID,
    groupName: FALLBACK_GROUP_NAME,
    now: "2026-08-12T10:00:00.000Z",
  });
  assert.equal(next.groupName, "正式公會群");
  assert.equal(next.pictureUrl, current.pictureUrl);
  assert.equal(next.joinedAt, NOW);
  assert.equal(next.lastSeenAt, "2026-08-12T10:00:00.000Z");
});

test("getLineGroups rows expose only an opaque key and masked group ID", () => {
  const rows = buildLineGroupAdminRows({known: {
    groupId: NEW_GROUP_ID,
    groupName: "正式公會群",
    joinedAt: NOW,
    lastSeenAt: NOW,
  }}, NEW_GROUP_ID);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].isDefault, true);
  assert.ok(rows[0].groupKey.startsWith("g_"));
  assert.notEqual(rows[0].maskedGroupId, NEW_GROUP_ID);
  assert.equal(Object.hasOwn(rows[0], "groupId"), false);
});

test("M/Q: exact new-group profile migrates bindings without deleting old bindings", () => {
  const members = ["Chia - 嘻嘻不嘻嘻", "Chia - CC x CC"];
  const bindings = Object.fromEntries(members.map((playerName) => [
    bindingKey(playerName),
    makeBinding(playerName, "U_CHIA"),
  ]));
  const before = JSON.parse(JSON.stringify(bindings));
  const plan = buildLineBindingMigrationPlan({
    memberNames: members,
    bindings,
    oldGroupId: OLD_GROUP_ID,
    newGroupId: NEW_GROUP_ID,
    profiles: [{userId: "U_CHIA", displayName: "Chia"}],
    now: "2026-08-12T10:00:00.000Z",
  });
  assert.equal(plan.migratedBindings, 2);
  assert.equal(plan.skippedBindings, 0);
  assert.equal(plan.conflicts, 0);
  assert.equal(Object.keys(plan.updates).length, 2);
  assert.ok(Object.values(plan.updates).every((binding) =>
    binding.lineGroupId === NEW_GROUP_ID && binding.lineUserId === "U_CHIA"));
  assert.deepEqual(bindings, before);
  members.forEach((playerName) => {
    assert.ok(bindings[bindingKey(playerName)]);
    assert.ok(plan.updates[bindingKeyForGroup(playerName, NEW_GROUP_ID)]);
  });
});

test("N/O: missing new-group profile and display-name mismatch are skipped", () => {
  const playerName = "Rain - 流鬼";
  const bindings = {[bindingKey(playerName)]: makeBinding(playerName, "U_RAIN")};
  const missing = buildLineBindingMigrationPlan({
    memberNames: [playerName], bindings, oldGroupId: OLD_GROUP_ID, newGroupId: NEW_GROUP_ID,
    profiles: [], now: NOW,
  });
  const mismatch = buildLineBindingMigrationPlan({
    memberNames: [playerName], bindings, oldGroupId: OLD_GROUP_ID, newGroupId: NEW_GROUP_ID,
    profiles: [{userId: "U_RAIN", displayName: "rain"}], now: NOW,
  });
  assert.equal(missing.skippedBindings, 1);
  assert.equal(mismatch.skippedBindings, 1);
  assert.deepEqual(missing.updates, {});
  assert.deepEqual(mismatch.updates, {});
});

test("P: an existing new-group conflict is never overwritten", () => {
  const playerName = "Rain - 流鬼";
  const oldKey = bindingKey(playerName);
  const newKey = bindingKeyForGroup(playerName, NEW_GROUP_ID);
  const conflicting = makeBinding(playerName, "U_OTHER", NEW_GROUP_ID);
  const bindings = {
    [oldKey]: makeBinding(playerName, "U_RAIN"),
    [newKey]: conflicting,
  };
  const plan = buildLineBindingMigrationPlan({
    memberNames: [playerName], bindings, oldGroupId: OLD_GROUP_ID, newGroupId: NEW_GROUP_ID,
    profiles: [{userId: "U_RAIN", displayName: "Rain"}], now: NOW,
  });
  assert.equal(plan.conflicts, 1);
  assert.deepEqual(plan.updates, {});
  assert.equal(bindings[newKey].lineUserId, "U_OTHER");
});

test("R-T: group switch updates preserve admins and never copy observed or personality state", () => {
  const migrationUpdates = {
    migration: makeBinding("Rain - 流鬼", "U_RAIN", NEW_GROUP_ID),
  };
  const updates = buildLineGroupSwitchUpdates({
    oldGroupId: OLD_GROUP_ID,
    newGroupId: NEW_GROUP_ID,
    firebaseUid: "FIREBASE_ADMIN",
    changedAt: 123456,
    migrationUpdates,
  });
  assert.equal(updates["lineSettings/defaultGroupId"], NEW_GROUP_ID);
  assert.equal(updates["lineSettings/previousDefaultGroupId"], OLD_GROUP_ID);
  assert.equal(updates["lineSettings/defaultGroupChangedByFirebaseUid"], "FIREBASE_ADMIN");
  assert.ok(updates["lineBindings/migration"]);
  assert.equal(Object.keys(updates).some((key) => key.includes("adminLineUserIds")), false);
  assert.equal(Object.keys(updates).some((key) => key.includes("lineObservedMembers")), false);
  assert.equal(Object.keys(updates).some((key) => key.includes("linePersonality")), false);
});

test("migration restores OWNER and GUILD_LEADER roles in the new group", () => {
  const members = ["Chia - 嘻嘻不嘻嘻", "@Hank - 挖系小嗨"];
  const bindings = {
    chia: makeBinding(members[0], "U_CHIA"),
    hank: makeBinding(members[1], "U_HANK"),
  };
  const plan = buildLineBindingMigrationPlan({
    memberNames: members,
    bindings,
    oldGroupId: OLD_GROUP_ID,
    newGroupId: NEW_GROUP_ID,
    profiles: [
      {userId: "U_CHIA", displayName: "Chia"},
      {userId: "U_HANK", displayName: "@Hank"},
    ],
    now: NOW,
  });
  const migrated = {...bindings, ...plan.updates};
  assert.equal(resolveSenderRole(migrated, NEW_GROUP_ID, "U_CHIA").senderRole, SENDER_ROLES.OWNER);
  assert.equal(resolveSenderRole(migrated, NEW_GROUP_ID, "U_HANK").senderRole,
    SENDER_ROLES.GUILD_LEADER);
});

test("U: an unset new-group personality flag defaults to enabled", () => {
  assert.equal(isPersonalityEnabled(undefined), true);
});
