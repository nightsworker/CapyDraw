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
  const separator = " - ";
  const separatorIndex = fullName.indexOf(separator);
  if (separatorIndex < 0) {
    return {fullName, lineName: fullName, gameId: fullName};
  }

  const lineName = fullName.slice(0, separatorIndex).trim() || fullName;
  const gameId = fullName.slice(separatorIndex + separator.length).trim() || lineName;
  return {fullName, lineName, gameId};
}

function memberValues(memberNames) {
  if (Array.isArray(memberNames)) return memberNames;
  if (memberNames && typeof memberNames === "object") return Object.values(memberNames);
  return [];
}

function uniqueMembers(members) {
  const seen = new Set();
  return members.filter((member) => {
    const key = normalizeMemberName(member.fullName);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function findMembersByLineName(memberNames, lineName) {
  const members = uniqueMembers(memberValues(memberNames)
    .map(parseMemberName)
    .filter((member) => member.fullName));
  const exactQuery = String(lineName || "").trim();
  if (!exactQuery) return [];
  return members.filter((member) => member.lineName === exactQuery);
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

const PREFIX_COMMANDS = new Map([
  ["綁定", "bind"],
  ["狀態", "status"],
  ["清單", "binding-list"],
  ["未綁定", "unbound-list"],
  ["解除", "unbind"],
  ["同步", "sync"],
  ["說明", "help"],
]);

const LEGACY_COMMANDS = new Map([
  ["綁定", "bind"],
  ["bind", "bind"],
  ["綁定狀態", "status"],
  ["綁定清單", "binding-list"],
  ["LINE清單", "binding-list"],
  ["line list", "binding-list"],
  ["未綁定清單", "unbound-list"],
  ["未綁定", "unbound-list"],
  ["解除綁定", "unbind"],
]);

function commandResult(command, args, isLegacy) {
  const result = {command, args, isLegacy};
  if (command === "bind") {
    result.auto = !args;
    result.query = args || null;
  }
  return result;
}

function parseBotCommand(text) {
  const message = String(text || "").trim();
  if (!message) return null;

  if (message.startsWith("!")) {
    const match = message.match(/^!(\S+)(?:\s+([\s\S]*))?$/u);
    if (!match) return {command: "unknown", args: "", isLegacy: false, input: message};
    const name = match[1];
    const args = String(match[2] || "").trim();
    const command = PREFIX_COMMANDS.get(name);
    if (!command || (command !== "bind" && args)) {
      return {command: "unknown", args, isLegacy: false, input: `!${name}`};
    }
    return commandResult(command, args, false);
  }

  const normalizedEnglish = message.replace(/\s+/g, " ").toLowerCase();
  const exactCommand = LEGACY_COMMANDS.get(message) || LEGACY_COMMANDS.get(normalizedEnglish);
  if (exactCommand) return commandResult(exactCommand, "", true);

  const bindMatch = message.match(/^(?:綁定|bind)\s+([\s\S]+)$/iu);
  if (!bindMatch) return null;
  const query = String(bindMatch[1] || "").trim();
  return query ? commandResult("bind", query, true) : null;
}

function extractBindingCommand(text) {
  const parsed = parseBotCommand(text);
  if (!parsed || parsed.command === "unknown" || parsed.command === "help" || parsed.command === "sync") {
    return null;
  }
  const legacy = {type: parsed.command};
  if (parsed.command === "bind") {
    legacy.auto = parsed.auto;
    legacy.query = parsed.query;
  }
  return legacy;
}

function buildBotHelpText() {
  return [
    "🐾 喵餅指令",
    "",
    "!綁定",
    "依你的 LINE 名稱自動綁定遊戲帳號",
    "",
    "!綁定 <LINE名稱>",
    "手動指定 LINE 名稱綁定",
    "",
    "!狀態",
    "查看自己的綁定狀態",
    "",
    "!清單",
    "查看公會綁定狀況",
    "",
    "!未綁定",
    "查看尚未完成 LINE 綁定的公會成員",
    "",
    "!解除",
    "解除自己的 LINE 綁定",
    "",
    "管理員：",
    "!同步",
    "自動比對群組成員並建立綁定",
  ].join("\n");
}

function resolveBindingLineName(command, profileDisplayName) {
  if (!command || (command.command || command.type) !== "bind") return "";
  return String(command.auto ? profileDisplayName : command.query || "").trim();
}

function createBindingRecord({member, userId, displayName, groupId, now, boundAt}) {
  const parsed = typeof member === "string" ? parseMemberName(member) : member;
  return {
    playerName: parsed.fullName,
    normalizedPlayerName: normalizeMemberName(parsed.fullName),
    lineName: parsed.lineName,
    gameId: parsed.gameId,
    lineUserId: userId,
    lineDisplayName: displayName || parsed.lineName,
    lineGroupId: groupId,
    boundAt: boundAt || now,
    updatedAt: now,
  };
}

function listBindingRecords(bindings) {
  return Object.entries(bindings && typeof bindings === "object" ? bindings : {})
    .filter(([, value]) => value && typeof value === "object")
    .map(([id, value]) => {
      const parsed = parseMemberName(value.playerName || "");
      return {
        id,
        ...value,
        playerName: parsed.fullName,
        normalizedPlayerName: normalizeMemberName(parsed.fullName),
        lineName: parsed.lineName,
        gameId: parsed.gameId,
      };
    })
    .filter((binding) => binding.playerName);
}

function bindingIsInGroup(binding, groupId) {
  return Boolean(binding.lineUserId && (!groupId || binding.lineGroupId === groupId));
}

function findBindingForMember(memberName, bindings, groupId) {
  const member = parseMemberName(memberName);
  const records = listBindingRecords(bindings).filter((binding) => bindingIsInGroup(binding, groupId));
  const exact = records.find((binding) =>
    binding.normalizedPlayerName === normalizeMemberName(member.fullName));
  if (exact) return exact;

  const sameLineName = records.filter((binding) =>
    binding.lineName === member.lineName);
  const userIds = new Set(sameLineName.map((binding) => binding.lineUserId));
  return userIds.size === 1 ? sameLineName[0] : null;
}

function buildMemberBindingRows(memberNames, bindings, groupId) {
  return uniqueMembers(memberValues(memberNames).map(parseMemberName).filter((member) => member.fullName))
    .map((member) => {
      const binding = findBindingForMember(member.fullName, bindings, groupId);
      return {
        playerName: member.fullName,
        lineName: member.lineName,
        gameId: member.gameId,
        bound: Boolean(binding),
        bindingId: binding ? binding.id : null,
        lineDisplayName: binding ? binding.lineDisplayName : null,
        lineUserId: binding ? binding.lineUserId : null,
      };
    });
}

function groupBindingRows(rows) {
  const groups = new Map();
  rows.forEach((row) => {
    const key = row.lineName;
    if (!groups.has(key)) groups.set(key, {lineName: row.lineName, bound: [], unbound: []});
    groups.get(key)[row.bound ? "bound" : "unbound"].push(row.gameId);
  });
  return [...groups.values()];
}

function buildBindingListText(memberNames, bindings, groupId) {
  const rows = buildMemberBindingRows(memberNames, bindings, groupId);
  const boundCount = rows.filter((row) => row.bound).length;
  const lines = [
    "📋 LINE 綁定清單",
    `已綁定：${boundCount} / ${rows.length}`,
    `未綁定：${rows.length - boundCount}`,
    "",
  ];
  groupBindingRows(rows).forEach((group) => {
    if (group.bound.length) lines.push(`✅ ${group.lineName} → ${group.bound.join("、")}`);
    if (group.unbound.length) lines.push(`❌ ${group.lineName} → ${group.unbound.join("、")}`);
  });
  return lines.join("\n");
}

function buildUnboundListText(memberNames, bindings, groupId) {
  const unboundRows = buildMemberBindingRows(memberNames, bindings, groupId)
    .filter((row) => !row.bound);
  if (!unboundRows.length) return "✅ 所有遊戲帳號都已完成 LINE 綁定。";
  const groups = groupBindingRows(unboundRows);
  const lines = ["❌ 尚未綁定 LINE", ""];
  groups.forEach((group) => lines.push(`${group.lineName} → ${group.unbound.join("、")}`));
  lines.push("", `共 ${groups.length} 人 / ${unboundRows.length} 個遊戲帳號未綁定。`);
  return lines.join("\n");
}

function splitTextMessages(text, maxLength = 4500, maxMessages = 5) {
  const chunks = [];
  let current = "";
  const append = (part) => {
    if (!current) current = part;
    else if (current.length + part.length + 1 <= maxLength) current += `\n${part}`;
    else {
      chunks.push(current);
      current = part;
    }
  };

  String(text || "").split("\n").forEach((line) => {
    if (line.length <= maxLength) {
      append(line);
      return;
    }
    const characters = Array.from(line);
    for (let i = 0; i < characters.length; i += maxLength) append(characters.slice(i, i + maxLength).join(""));
  });
  if (current) chunks.push(current);
  if (chunks.length <= maxMessages) return chunks;
  return [
    ...chunks.slice(0, maxMessages - 1),
    "⚠️ 綁定清單內容過長，已省略其餘項目。\n請使用「!未綁定」查看尚未完成的玩家。",
  ];
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

  const renderMember = (memberName, includeGameId) => {
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
      mentionText = `@${escapeTextV2Literal(member.lineName)}`;
      if (!unboundMembers.includes(member.lineName)) unboundMembers.push(member.lineName);
    }
    return includeGameId ? `${escapeTextV2Literal(member.gameId)} ${mentionText}` : mentionText;
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

function isObservedGroupEvent(event) {
  return Boolean(event && event.source && event.source.type === "group" &&
    event.source.groupId && event.source.userId);
}

function planWebhookEvent(event) {
  return {
    observeMember: isObservedGroupEvent(event),
    command: isGroupMessageEvent(event) ? parseBotCommand(event.message.text) : null,
  };
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
  buildBotHelpText,
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
  formatDrawDate,
  isGroupMessageEvent,
  listBindingRecords,
  maskLineUserId,
  normalizeMemberName,
  parseBotCommand,
  parseMemberName,
  planWebhookEvent,
  resolveBindingLineName,
  splitTextMessages,
  standardizeName,
  verifyLineSignature,
};
