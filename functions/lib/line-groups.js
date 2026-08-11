"use strict";

const crypto = require("node:crypto");
const {
  bindingKeyForGroup,
  createBindingRecord,
  listBindingRecords,
  normalizeMemberName,
  parseMemberName,
} = require("./line");

const FALLBACK_GROUP_NAME = "LINE 群組";

function lineGroupKey(groupId) {
  const digest = crypto
    .createHash("sha256")
    .update(String(groupId || "").trim(), "utf8")
    .digest("base64url");
  return `g_${digest}`;
}

function maskLineGroupId(groupId) {
  const value = String(groupId || "");
  if (!value) return "";
  return value.length <= 12 ? `${value.slice(0, 2)}********${value.slice(-2)}` :
    `${value.slice(0, 5)}********${value.slice(-4)}`;
}

function normalizeLineGroupSummary(summary) {
  const value = summary && typeof summary === "object" ? summary : {};
  return {
    groupName: String(value.groupName || "").trim() || FALLBACK_GROUP_NAME,
    pictureUrl: String(value.pictureUrl || "").trim() || null,
  };
}

function buildKnownLineGroupRecord(current, {groupId, groupName, pictureUrl, now}) {
  const existing = current && typeof current === "object" ? current : {};
  const normalized = normalizeLineGroupSummary({groupName, pictureUrl});
  const record = {
    groupId,
    groupName: normalized.groupName !== FALLBACK_GROUP_NAME ?
      normalized.groupName : existing.groupName || FALLBACK_GROUP_NAME,
    joinedAt: existing.joinedAt || now,
    lastSeenAt: now,
  };
  const resolvedPicture = normalized.pictureUrl || existing.pictureUrl;
  if (resolvedPicture) record.pictureUrl = resolvedPicture;
  return record;
}

function buildLineJoinIntroduction(isDefault) {
  const lines = [
    "喵？這裡就是本喵以後要待的公會嗎？",
    "",
    "本喵叫「喵餅」，是這個公會的會貓 🐾",
    "會長負責管你們，本喵負責管會長。",
    "",
    "想知道本喵會做什麼，就輸入：",
    "!說明",
    "",
    "平常也可以叫本喵，或是 @本喵跟本喵說話。",
    "",
    "……但本喵要不要理你，就是另一回事了喵。",
  ];
  if (!isDefault) lines.push("", "管理員記得去後台把這裡設成正式公會群喵。");
  return lines.join("\n");
}

function planLineGroupJoin({groupId, summary, defaultGroupId, now}) {
  const normalized = normalizeLineGroupSummary(summary);
  return {
    groupKey: lineGroupKey(groupId),
    record: buildKnownLineGroupRecord(null, {groupId, ...normalized, now}),
    replyText: buildLineJoinIntroduction(groupId === defaultGroupId),
    isDefault: groupId === defaultGroupId,
  };
}

function buildLineGroupAdminRows(lineGroups, defaultGroupId) {
  const records = Object.values(lineGroups && typeof lineGroups === "object" ? lineGroups : {})
    .filter((group) => group && typeof group === "object" && group.groupId);
  if (defaultGroupId && !records.some((group) => group.groupId === defaultGroupId)) {
    records.push({
      groupId: defaultGroupId,
      groupName: "目前正式 LINE 群組",
      joinedAt: null,
      lastSeenAt: null,
    });
  }
  return records.map((group) => ({
    groupKey: lineGroupKey(group.groupId),
    groupName: String(group.groupName || "").trim() || FALLBACK_GROUP_NAME,
    pictureUrl: group.pictureUrl || null,
    joinedAt: group.joinedAt || null,
    lastSeenAt: group.lastSeenAt || null,
    maskedGroupId: maskLineGroupId(group.groupId),
    isDefault: group.groupId === defaultGroupId,
  })).sort((left, right) => {
    if (left.isDefault !== right.isDefault) return left.isDefault ? -1 : 1;
    return String(right.lastSeenAt || right.joinedAt || "")
      .localeCompare(String(left.lastSeenAt || left.joinedAt || ""));
  });
}

function memberValues(memberNames) {
  if (Array.isArray(memberNames)) return memberNames;
  if (memberNames && typeof memberNames === "object") return Object.values(memberNames);
  return [];
}

function buildLineBindingMigrationPlan({memberNames, bindings, oldGroupId, newGroupId, profiles, now}) {
  const members = new Map(memberValues(memberNames)
    .map(parseMemberName)
    .filter((member) => member.fullName)
    .map((member) => [normalizeMemberName(member.fullName), member]));
  const profileByUserId = new Map((profiles || [])
    .filter((profile) => profile && profile.userId)
    .map((profile) => [profile.userId, profile]));
  const records = listBindingRecords(bindings);
  const oldBindings = records.filter((binding) => binding.lineGroupId === oldGroupId);
  const newBindings = records.filter((binding) => binding.lineGroupId === newGroupId);
  const updates = {};
  const seenPlayers = new Set();
  let migratedBindings = 0;
  let skippedBindings = 0;
  let conflicts = 0;

  oldBindings.forEach((oldBinding) => {
    const normalized = oldBinding.normalizedPlayerName;
    if (seenPlayers.has(normalized)) {
      skippedBindings += 1;
      return;
    }
    seenPlayers.add(normalized);
    const member = members.get(normalized);
    const profile = profileByUserId.get(oldBinding.lineUserId);
    if (!member || !oldBinding.lineUserId || !profile ||
        profile.userId !== oldBinding.lineUserId || profile.displayName !== member.lineName) {
      skippedBindings += 1;
      return;
    }

    const samePlayer = newBindings.find((binding) =>
      binding.normalizedPlayerName === normalized);
    if (samePlayer) {
      if (samePlayer.lineUserId === oldBinding.lineUserId) skippedBindings += 1;
      else conflicts += 1;
      return;
    }
    if (newBindings.some((binding) =>
      binding.lineName === member.lineName && binding.lineUserId !== oldBinding.lineUserId)) {
      conflicts += 1;
      return;
    }

    const id = bindingKeyForGroup(member.fullName, newGroupId);
    const created = createBindingRecord({
      member,
      userId: oldBinding.lineUserId,
      displayName: profile.displayName,
      groupId: newGroupId,
      now,
      boundAt: oldBinding.boundAt,
    });
    updates[id] = created;
    newBindings.push({id, ...created, normalizedPlayerName: normalized});
    migratedBindings += 1;
  });

  return {updates, migratedBindings, skippedBindings, conflicts};
}

function buildLineGroupSwitchUpdates({oldGroupId, newGroupId, firebaseUid, changedAt,
  migrationUpdates}) {
  const updates = {
    "lineSettings/defaultGroupId": newGroupId,
    "lineSettings/defaultGroupChangedAt": changedAt,
    "lineSettings/defaultGroupChangedByFirebaseUid": firebaseUid,
    "lineSettings/updatedAt": changedAt,
  };
  if (oldGroupId && oldGroupId !== newGroupId) {
    updates["lineSettings/previousDefaultGroupId"] = oldGroupId;
  }
  Object.entries(migrationUpdates || {}).forEach(([id, binding]) => {
    updates[`lineBindings/${id}`] = binding;
  });
  return updates;
}

module.exports = {
  FALLBACK_GROUP_NAME,
  buildKnownLineGroupRecord,
  buildLineBindingMigrationPlan,
  buildLineGroupAdminRows,
  buildLineGroupSwitchUpdates,
  buildLineJoinIntroduction,
  lineGroupKey,
  maskLineGroupId,
  normalizeLineGroupSummary,
  planLineGroupJoin,
};
