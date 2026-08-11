"use strict";

const {
  bindingKey,
  buildMemberBindingRows,
  createBindingRecord,
  findMembersByLineName,
  listBindingRecords,
  normalizeMemberName,
} = require("./line");

function isFirebaseSafeKey(value) {
  const key = String(value || "");
  return Boolean(key && !/[.#$\[\]/]/u.test(key));
}

function buildObservedMemberRecord(current, {lineUserId, displayName, groupId, pictureUrl}, now) {
  const existing = current && typeof current === "object" ? current : {};
  const record = {
    lineUserId,
    displayName,
    groupId,
    firstSeenAt: existing.firstSeenAt || now,
    lastSeenAt: now,
  };
  if (pictureUrl || existing.pictureUrl) record.pictureUrl = pictureUrl || existing.pictureUrl;
  return record;
}

function listObservedMembers(value) {
  return Object.values(value && typeof value === "object" ? value : {})
    .filter((member) => member && typeof member === "object" &&
      member.lineUserId && member.displayName);
}

function isLineBotAdmin(adminLineUserIds, userId) {
  if (!userId) return false;
  if (Array.isArray(adminLineUserIds)) return adminLineUserIds.includes(userId);
  return Boolean(adminLineUserIds && typeof adminLineUserIds === "object" &&
    adminLineUserIds[userId] === true);
}

function decideLineSyncAccess(defaultGroupId, eventGroupId, adminLineUserIds, userId) {
  if (!defaultGroupId) return {allowed: false, reason: "unconfigured"};
  if (defaultGroupId !== eventGroupId) return {allowed: false, reason: "other-group"};
  if (!isLineBotAdmin(adminLineUserIds, userId)) return {allowed: false, reason: "not-admin"};
  return {allowed: true, reason: null};
}

async function fetchAllGroupMemberIds(requestPage) {
  const memberIds = [];
  const seenIds = new Set();
  const seenTokens = new Set();
  let start = null;

  while (true) {
    const page = await requestPage(start);
    if (!page || !Array.isArray(page.memberIds)) {
      throw new Error("LINE 群組成員名單格式不正確。");
    }
    page.memberIds.forEach((userId) => {
      if (userId && !seenIds.has(userId)) {
        seenIds.add(userId);
        memberIds.push(userId);
      }
    });
    const next = typeof page.next === "string" ? page.next.trim() : "";
    if (!next) return memberIds;
    if (seenTokens.has(next)) throw new Error("LINE 群組成員分頁 token 重複。");
    seenTokens.add(next);
    start = next;
  }
}

async function resolveSyncMemberSource(fetchMemberIds, observedMembers) {
  try {
    return {mode: "full", memberIds: await fetchMemberIds(), observedMembers: []};
  } catch (error) {
    if (error && error.lineStatus === 403) {
      const observed = listObservedMembers(observedMembers);
      return {
        mode: "observed",
        memberIds: observed.map((member) => member.lineUserId),
        observedMembers: observed,
      };
    }
    throw error;
  }
}

async function mapInBatches(items, batchSize, mapper) {
  const results = [];
  for (let index = 0; index < items.length; index += batchSize) {
    const batch = items.slice(index, index + batchSize);
    results.push(...await Promise.all(batch.map(mapper)));
  }
  return results;
}

function memberValues(memberNames) {
  if (Array.isArray(memberNames)) return memberNames;
  if (memberNames && typeof memberNames === "object") return Object.values(memberNames);
  return [];
}

function buildMemberSyncPlan({memberNames, bindings, profiles, groupId, now}) {
  const members = memberValues(memberNames);
  const uniqueProfiles = [...new Map((profiles || [])
    .filter((profile) => profile && profile.userId)
    .map((profile) => [profile.userId, profile])).values()];
  const records = listBindingRecords(bindings);
  const updates = {};
  const ambiguousLineNames = new Set();
  const lineNameUsers = new Map();

  uniqueProfiles.forEach((profile) => {
    if (!profile.displayName || !findMembersByLineName(members, profile.displayName).length) return;
    if (!lineNameUsers.has(profile.displayName)) lineNameUsers.set(profile.displayName, new Set());
    lineNameUsers.get(profile.displayName).add(profile.userId);
  });
  lineNameUsers.forEach((userIds, lineName) => {
    if (userIds.size > 1) ambiguousLineNames.add(lineName);
  });

  let added = 0;
  let alreadyBound = 0;
  let nonGuild = 0;
  let conflicts = 0;
  const countedAmbiguous = new Set();

  uniqueProfiles.forEach((profile) => {
    const matches = findMembersByLineName(members, profile.displayName);
    if (!matches.length) {
      nonGuild += 1;
      return;
    }
    if (ambiguousLineNames.has(profile.displayName)) {
      if (!countedAmbiguous.has(profile.displayName)) {
        conflicts += matches.length;
        countedAmbiguous.add(profile.displayName);
      }
      return;
    }

    matches.forEach((member) => {
      const normalized = normalizeMemberName(member.fullName);
      const existing = records.find((binding) => binding.normalizedPlayerName === normalized);
      if (existing) {
        if (existing.lineGroupId !== groupId || existing.lineUserId !== profile.userId) {
          conflicts += 1;
          return;
        }
        const updated = createBindingRecord({
          member,
          userId: profile.userId,
          displayName: profile.displayName,
          groupId,
          now,
          boundAt: existing.boundAt,
        });
        updates[existing.id] = updated;
        Object.assign(existing, updated);
        alreadyBound += 1;
        return;
      }

      const related = records.filter((binding) => binding.lineName === member.lineName);
      if (related.some((binding) =>
        binding.lineGroupId !== groupId || binding.lineUserId !== profile.userId)) {
        conflicts += 1;
        return;
      }
      const id = bindingKey(member.fullName);
      const created = createBindingRecord({
        member,
        userId: profile.userId,
        displayName: profile.displayName,
        groupId,
        now,
      });
      updates[id] = created;
      records.push({id, ...created});
      added += 1;
    });
  });

  const finalBindings = {
    ...(bindings && typeof bindings === "object" ? bindings : {}),
    ...updates,
  };
  const rows = buildMemberBindingRows(members, finalBindings, groupId);
  const boundGuildAccounts = rows.filter((row) => row.bound).length;
  return {
    updates,
    scannedMembers: uniqueProfiles.length,
    added,
    alreadyBound,
    nonGuild,
    conflicts,
    boundGuildAccounts,
    totalGuildAccounts: rows.length,
    unboundGuildAccounts: rows.length - boundGuildAccounts,
  };
}

function buildSyncReply(result, mode) {
  const lines = ["🐾 喵餅同步完成", ""];
  if (mode === "observed") {
    lines.push(
      "⚠️ 目前 LINE 官方帳號無法取得完整群組成員名單。",
      "本次已改為同步「Bot 曾經看過的群組成員」。",
      "未曾在 Bot 加入後發言或產生 webhook 的成員，可能尚未被掃描。",
      "",
      `已觀察 LINE 成員：${result.scannedMembers}`,
    );
  } else {
    lines.push(`掃描 LINE 成員：${result.scannedMembers}`);
  }
  lines.push(
    `✅ 新增綁定：${result.added}`,
    `ℹ️ 已經綁定：${result.alreadyBound}`,
    `⏭️ 非公會成員：${result.nonGuild}`,
    `⚠️ 衝突：${result.conflicts}`,
    `❌ 尚未找到：${result.unboundGuildAccounts}`,
    "",
    "目前公會：",
    `已綁定 ${result.boundGuildAccounts} / ${result.totalGuildAccounts} 個遊戲帳號`,
    "",
    "輸入：",
    "!未綁定",
    "",
    "查看剩餘名單。",
  );
  return lines.join("\n");
}

module.exports = {
  buildMemberSyncPlan,
  buildObservedMemberRecord,
  buildSyncReply,
  decideLineSyncAccess,
  fetchAllGroupMemberIds,
  isFirebaseSafeKey,
  isLineBotAdmin,
  listObservedMembers,
  mapInBatches,
  resolveSyncMemberSource,
};
