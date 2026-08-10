"use strict";

const crypto = require("node:crypto");

function standardizeName(value) {
  return String(value || "")
    .replaceAll("\\n", "\n")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replace(/[–—－]/g, "-")
    .replace(/\s*-\s*/g, " - ")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function normalizeMemberName(value) {
  return standardizeName(value).normalize("NFKC").toLocaleLowerCase("en-US");
}

function parseMemberName(value) {
  const fullName = standardizeName(value);
  const separatorIndex = fullName.indexOf(" - ");
  if (separatorIndex < 0) {
    return {fullName, gameName: fullName, alias: fullName};
  }

  const gameName = fullName.slice(0, separatorIndex).trim() || fullName;
  const alias = fullName.slice(separatorIndex + 3).trim() || gameName;
  return {fullName, gameName, alias};
}

function uniqueMatches(matches) {
  const seen = new Set();
  return matches.filter((member) => {
    const key = normalizeMemberName(member.fullName);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function findMemberMatches(memberNames, query) {
  const members = (Array.isArray(memberNames) ? memberNames : [])
    .map(parseMemberName)
    .filter((member) => member.fullName);
  const standardizedQuery = standardizeName(query);
  if (!standardizedQuery) return {matches: [], matchedBy: null};

  const fullNameMatches = uniqueMatches(
    members.filter((member) => member.fullName === standardizedQuery),
  );
  if (fullNameMatches.length) return {matches: fullNameMatches, matchedBy: "fullName"};

  const aliasMatches = uniqueMatches(
    members.filter((member) => member.alias === standardizedQuery),
  );
  if (aliasMatches.length) return {matches: aliasMatches, matchedBy: "alias"};

  const normalizedQuery = normalizeMemberName(standardizedQuery);
  const normalizedMatches = uniqueMatches(members.filter((member) => [
    member.fullName,
    member.alias,
    member.gameName,
  ].some((candidate) => normalizeMemberName(candidate) === normalizedQuery)));
  return {matches: normalizedMatches, matchedBy: normalizedMatches.length ? "normalized" : null};
}

function verifyLineSignature(rawBody, signature, channelSecret) {
  if (!Buffer.isBuffer(rawBody) || !signature || !channelSecret) return false;
  const expected = crypto
    .createHmac("sha256", channelSecret)
    .update(rawBody)
    .digest("base64");
  const expectedBuffer = Buffer.from(expected, "utf8");
  const actualBuffer = Buffer.from(String(signature), "utf8");
  return expectedBuffer.length === actualBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

function bindingKey(playerName) {
  const digest = crypto
    .createHash("sha256")
    .update(normalizeMemberName(playerName), "utf8")
    .digest("base64url");
  return `p_${digest}`;
}

function extractBindingCommand(text) {
  const message = String(text || "").trim();
  if (message === "綁定狀態") return {type: "status"};
  if (message === "解除綁定") return {type: "unbind"};
  const bindMatch = message.match(/^(?:綁定\s+|bind\s+)(.+)$/iu);
  if (!bindMatch) return null;
  const query = standardizeName(bindMatch[1]);
  return query ? {type: "bind", query} : null;
}

function createBindingRecord({member, userId, displayName, groupId, now}) {
  const parsed = typeof member === "string" ? parseMemberName(member) : member;
  return {
    playerName: parsed.fullName,
    normalizedPlayerName: normalizeMemberName(parsed.fullName),
    alias: parsed.alias,
    lineUserId: userId,
    lineDisplayName: displayName || parsed.alias,
    lineGroupId: groupId,
    boundAt: now,
    updatedAt: now,
  };
}

function listBindingRecords(bindings) {
  return Object.entries(bindings && typeof bindings === "object" ? bindings : {})
    .filter(([, value]) => value && typeof value === "object")
    .map(([id, value]) => ({id, ...value}));
}

function findBindingForMember(memberName, bindings, groupId) {
  const normalized = normalizeMemberName(memberName);
  return listBindingRecords(bindings).find((binding) =>
    binding.normalizedPlayerName === normalized &&
    binding.lineUserId &&
    (!groupId || binding.lineGroupId === groupId),
  ) || null;
}

function formatDrawDate(value) {
  const match = String(value || "").match(/^\d{4}-(\d{2})-(\d{2})$/);
  if (!match) return String(value || "");
  return `${Number(match[1])}/${Number(match[2])}`;
}

function escapeTextV2Literal(value) {
  return String(value || "").replaceAll("{", "{{").replaceAll("}", "}}");
}

function buildDrawLineMessage(record, bindings, groupId) {
  if (!record || typeof record !== "object") throw new Error("抽籤紀錄格式不正確。");
  const substitutions = {};
  const unboundMembers = [];
  let mentionIndex = 0;

  const renderMember = (memberName, includeGameName) => {
    const member = parseMemberName(memberName);
    const binding = findBindingForMember(member.fullName, bindings, groupId);
    let mentionText;
    if (binding) {
      const key = `mention${mentionIndex++}`;
      mentionText = `{${key}}`;
      substitutions[key] = {
        type: "mention",
        mentionee: {type: "user", userId: binding.lineUserId},
      };
    } else {
      mentionText = `@${escapeTextV2Literal(member.alias || member.gameName)}`;
      if (!unboundMembers.includes(member.alias || member.gameName)) {
        unboundMembers.push(member.alias || member.gameName);
      }
    }
    return includeGameName ? `${escapeTextV2Literal(member.gameName)} ${mentionText}` : mentionText;
  };

  const cabinMembers = Array.isArray(record.cabin4) ? record.cabin4 : [];
  const lines = [
    `${escapeTextV2Literal(formatDrawDate(record.date))}船長：${renderMember(record.captain, true)}`,
    `守護天使：${renderMember(record.guardian, true)}`,
    `第四船艙：${cabinMembers.map((name) => renderMember(name, false)).join(" ")}`,
    "",
    "船長如果要指定發船時間，請提早告知我。",
    "",
    "第四船艙的小朋友務必捐滿三張船票。",
  ];
  const message = {type: "textV2", text: lines.join("\n")};
  if (Object.keys(substitutions).length) message.substitution = substitutions;
  return {message, unboundMembers};
}

function isGroupMessageEvent(event) {
  return Boolean(event && event.type === "message" &&
    event.message && event.message.type === "text" &&
    event.source && event.source.type === "group" && event.source.groupId);
}

function decideLineGroupAction(defaultGroupId, eventGroupId, commandType) {
  const currentGroupId = String(defaultGroupId || "").trim() || null;
  const candidateGroupId = String(eventGroupId || "").trim() || null;
  if (!candidateGroupId || !commandType) {
    return {action: "ignore", canProcess: false, canClaim: false};
  }
  if (currentGroupId && currentGroupId !== candidateGroupId) {
    return {action: "reject-other-group", canProcess: false, canClaim: false};
  }
  if (currentGroupId === candidateGroupId) {
    return {action: "process", canProcess: true, canClaim: false};
  }
  if (commandType === "bind") {
    return {action: "claim-on-success", canProcess: true, canClaim: true};
  }
  return {action: "reject-unconfigured", canProcess: false, canClaim: false};
}

function claimDefaultLineGroup(currentGroupId, candidateGroupId) {
  return String(currentGroupId || "").trim() || String(candidateGroupId || "").trim() || null;
}

function maskLineUserId(value) {
  const text = String(value || "");
  if (text.length <= 12) return text ? `${text.slice(0, 2)}********${text.slice(-2)}` : "";
  return `${text.slice(0, 5)}********${text.slice(-4)}`;
}

module.exports = {
  bindingKey,
  buildDrawLineMessage,
  claimDefaultLineGroup,
  createBindingRecord,
  decideLineGroupAction,
  extractBindingCommand,
  findBindingForMember,
  findMemberMatches,
  formatDrawDate,
  isGroupMessageEvent,
  listBindingRecords,
  maskLineUserId,
  normalizeMemberName,
  parseMemberName,
  standardizeName,
  verifyLineSignature,
};
