"use strict";

const {listBindingRecords} = require("./line");
const {MIAOBING_LORE, SENDER_ROLES} = require("./miaobing-personality");

function matchingLoreBindings(bindings, groupId, lorePerson) {
  const gameIds = new Set(lorePerson.gameIds || [lorePerson.gameId]);
  const memberIds = new Set(lorePerson.memberIds || []);
  return listBindingRecords(bindings).filter((binding) =>
    binding.lineGroupId === groupId &&
    (memberIds.has(binding.memberId) ||
      (binding.lineName === lorePerson.lineName && gameIds.has(binding.gameId))) &&
    binding.lineUserId);
}

function resolveLorePerson(bindings, groupId, lorePerson) {
  const matches = matchingLoreBindings(bindings, groupId, lorePerson);
  const userIds = [...new Set(matches.map((binding) => binding.lineUserId))];
  if (userIds.length !== 1) return null;
  return {
    lineUserId: userIds[0],
    lineName: lorePerson.lineName,
    memberIds: [...new Set(matches.map((binding) => binding.memberId).filter(Boolean))],
    gameIds: [...new Set(matches.map((binding) => binding.gameId))],
  };
}

function resolveLoreIdentity(bindings, groupId, loreKey) {
  const lorePerson = MIAOBING_LORE[loreKey];
  return lorePerson ? resolveLorePerson(bindings, groupId, lorePerson) : null;
}

function isSenderLorePerson(bindings, groupId, loreKey, lineUserId) {
  if (!lineUserId) return false;
  const identity = resolveLoreIdentity(bindings, groupId, loreKey);
  return Boolean(identity && identity.lineUserId === lineUserId);
}

function resolveSenderRole(bindings, groupId, lineUserId) {
  if (isSenderLorePerson(bindings, groupId, "owner", lineUserId)) {
    return {senderRole: SENDER_ROLES.OWNER, isOwner: true, isGuildLeader: false};
  }
  if (isSenderLorePerson(bindings, groupId, "guildLeader", lineUserId)) {
    return {senderRole: SENDER_ROLES.GUILD_LEADER, isOwner: false, isGuildLeader: true};
  }
  return {senderRole: SENDER_ROLES.MEMBER, isOwner: false, isGuildLeader: false};
}

function buildLoreReplyMessage(plan, identity) {
  const replyText = String(plan && plan.replyText || "");
  const fallbackText = String(plan && plan.fallbackReplyText || "");
  if (!plan || !plan.mentionTarget || !replyText.includes("{target}")) {
    return replyText ? {type: "text", text: replyText} : null;
  }
  if (!identity || !identity.lineUserId) {
    const text = fallbackText || replyText.replaceAll("{target}", plan.fallbackName || "");
    return text.trim() ? {type: "text", text} : null;
  }
  return {
    type: "textV2",
    text: replyText,
    substitution: {
      target: {
        type: "mention",
        mentionee: {type: "user", userId: identity.lineUserId},
      },
    },
  };
}

module.exports = {
  buildLoreReplyMessage,
  isSenderLorePerson,
  matchingLoreBindings,
  resolveLoreIdentity,
  resolveLorePerson,
  resolveSenderRole,
};
