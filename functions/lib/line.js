"use strict";

const crypto = require("node:crypto");
const {
  memberPlayerName,
  normalizeMemberId,
  normalizeMembersMaster,
  resolveCanonicalMember,
} = require("./memberIdentity");

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

function normalizeLineMember(value) {
  if (typeof value === "string") return parseMemberName(value);
  const record = value && typeof value === "object" ? value : {};
  const memberId = normalizeMemberId(record.memberId);
  const gameId = standardizeName(record.gameName || record.nameSnapshot || record.gameId || "");
  const lineName = standardizeName(record.lineNameHint || record.lineNameSnapshot ||
    record.lineName || "");
  if (memberId && gameId) {
    const fullName = memberPlayerName({memberId, gameName: gameId, lineNameHint: lineName});
    return {fullName, lineName: lineName || gameId, gameId, memberId,
      active: record.active !== false};
  }
  return parseMemberName(record.fullName || record.playerName || "");
}

function uniqueMembers(members) {
  const seen = new Set();
  return members.filter((member) => {
    const key = member.memberId ? `id:${member.memberId}` : normalizeMemberName(member.fullName);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeGuildMembers(memberNames) {
  const master = normalizeMembersMaster(memberNames);
  const values = Object.keys(master).length ? Object.values(master) : memberValues(memberNames);
  return uniqueMembers(values.map(normalizeLineMember)
    .filter((member) => member.fullName && member.active !== false));
}

function findMembersByLineName(memberNames, lineName) {
  const members = normalizeGuildMembers(memberNames);
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

function bindingKeyForGroup(playerName, groupId) {
  const groupDigest = crypto
    .createHash("sha256")
    .update(String(groupId || "").trim(), "utf8")
    .digest("base64url")
    .slice(0, 16);
  return `${bindingKey(playerName)}_${groupDigest}`;
}

function bindingKeyForMemberId(memberId, groupId) {
  const normalizedId = normalizeMemberId(memberId);
  if (!normalizedId) throw new Error("memberId 格式不正確。");
  const memberDigest = crypto.createHash("sha256")
    .update(`member:${normalizedId}`, "utf8").digest("base64url");
  const groupDigest = crypto.createHash("sha256")
    .update(String(groupId || "").trim(), "utf8").digest("base64url").slice(0, 16);
  return `p_${memberDigest}_${groupDigest}`;
}

const PREFIX_COMMANDS = new Map([
  ["綁定", "bind"],
  ["狀態", "status"],
  ["清單", "binding-list"],
  ["未綁定", "unbound-list"],
  ["解除", "unbind"],
  ["同步", "sync"],
  ["鎖定", "lock"],
  ["解除鎖定", "unlock"],
  ["幫綁", "admin-bind"],
  ["幫解除", "admin-unbind"],
  ["說明", "help"],
]);

const PREFIX_COMMANDS_WITH_ARGS = new Set(["bind", "admin-bind", "admin-unbind"]);

function commandResult(command, args) {
  const result = {command, args};
  if (command === "bind") {
    result.auto = !args;
    result.query = args || null;
  }
  return result;
}

function parseBotCommand(text) {
  const message = String(text || "").trim();
  if (!message) return null;
  if (!message.startsWith("!")) return null;

  const match = message.match(/^!(\S+)(?:\s+([\s\S]*))?$/u);
  if (!match) return {command: "unknown", args: "", input: message};
  const name = match[1];
  const args = String(match[2] || "").trim();
  const command = PREFIX_COMMANDS.get(name);
  if (!command || (!PREFIX_COMMANDS_WITH_ARGS.has(command) && args)) {
    return {command: "unknown", args, input: `!${name}`};
  }
  return commandResult(command, args);
}

function parseAdminBindArguments(args, message, {memberNames} = {}) {
  const input = String(args || "").trim();
  if (!input) return {status: "missing-arguments"};

  const mentionees = message && message.mention && Array.isArray(message.mention.mentionees) ?
    message.mention.mentionees : [];
  const userMentions = mentionees.filter((mentionee) =>
    mentionee && mentionee.type === "user" && mentionee.isSelf !== true &&
    typeof mentionee.userId === "string" && mentionee.userId.trim());
  if (userMentions.length > 1) return {status: "ambiguous-mention"};

  if (userMentions.length === 1) {
    const mentionee = userMentions[0];
    const text = String(message && message.text || "");
    const commandPrefix = text.match(/^\s*!幫綁(?:\s+|$)/u);
    const hasPosition = Number.isInteger(mentionee.index) && Number.isInteger(mentionee.length) &&
      mentionee.index >= 0 && mentionee.length > 0;
    let sourceLineName;
    let targetGuildLineName;

    if (commandPrefix && hasPosition) {
      if (mentionee.index !== commandPrefix[0].length) {
        return {status: "invalid-mention-position"};
      }
      sourceLineName = text.slice(mentionee.index, mentionee.index + mentionee.length).trim();
      targetGuildLineName = text.slice(mentionee.index + mentionee.length).trim() || null;
    } else {
      const parts = input.split(/\s+/u);
      sourceLineName = parts.shift() || "";
      targetGuildLineName = parts.join(" ").trim() || null;
    }

    return {
      status: "success",
      sourceLineName,
      targetGuildLineName,
      mentionedUserId: mentionee.userId.trim(),
      usedMention: true,
    };
  }

  if (findMembersByLineName(memberNames, input).length) {
    return {
      status: "success",
      sourceLineName: input,
      targetGuildLineName: input,
      mentionedUserId: null,
      usedMention: false,
    };
  }

  const parts = input.split(/\s+/u);
  const sourceLineName = parts.shift() || "";
  return {
    status: "success",
    sourceLineName,
    targetGuildLineName: parts.join(" ").trim() || sourceLineName,
    mentionedUserId: null,
    usedMention: false,
  };
}

function extractBindingCommand(text) {
  const parsed = parseBotCommand(text);
  if (!parsed || parsed.command === "unknown" || parsed.command === "help" || parsed.command === "sync") {
    return null;
  }
  const result = {type: parsed.command};
  if (parsed.command === "bind") {
    result.auto = parsed.auto;
    result.query = parsed.query;
  }
  return result;
}

function buildBotHelpText({bindingLocked = false, isAdmin = false} = {}) {
  const lines = [
    "🐾 喵餅指令",
    "",
  ];
  if (bindingLocked) {
    lines.push(
      "🔒 目前 LINE 綁定已鎖定",
      "如需修改請聯絡管理員。",
      "",
    );
  }
  lines.push(
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
  );
  if (isAdmin) {
    lines.push(
      "",
      "管理員指令：",
      "",
      "!同步",
      "同步可取得的群組成員",
      "",
      "!鎖定",
      "停止會員自行修改綁定",
      "",
      "!解除鎖定",
      "重新開放會員自行修改綁定",
      "",
      "!幫綁 <LINE名稱> [名單名稱]",
      "代替成員完成綁定",
      "名稱不同時可使用：!幫綁 @對方 名單名稱",
      "",
      "!幫解除 <LINE名稱>",
      "替指定成員解除綁定",
    );
  }
  return lines.join("\n");
}

function resolveBindingLineName(command, profileDisplayName) {
  if (!command || (command.command || command.type) !== "bind") return "";
  return String(command.auto ? profileDisplayName : command.query || "").trim();
}

function createBindingRecord({member, userId, displayName, groupId, now, boundAt}) {
  const parsed = normalizeLineMember(member);
  return {
    playerName: parsed.fullName,
    normalizedPlayerName: normalizeMemberName(parsed.fullName),
    lineName: parsed.lineName,
    gameId: parsed.gameId,
    ...(parsed.memberId ? {memberId: parsed.memberId} : {}),
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
      const parsed = normalizeLineMember(value);
      const inferred = resolveCanonicalMember(value.playerName || value.gameId || "");
      const memberId = normalizeMemberId(value.memberId) ||
        (inferred.status === "mapped" ? inferred.member.memberId : null);
      return {
        id,
        ...value,
        playerName: parsed.fullName,
        normalizedPlayerName: normalizeMemberName(parsed.fullName),
        lineName: parsed.lineName,
        gameId: parsed.gameId,
        memberId,
      };
    })
    .filter((binding) => binding.playerName);
}

function bindingIsInGroup(binding, groupId) {
  return Boolean(binding.lineUserId && (!groupId || binding.lineGroupId === groupId));
}

function bindingMatchesMember(binding, memberValue) {
  const member = normalizeLineMember(memberValue);
  if (member.memberId && binding && binding.memberId) {
    return member.memberId === binding.memberId;
  }
  return Boolean(binding && member.fullName &&
    binding.normalizedPlayerName === normalizeMemberName(member.fullName));
}

function findBindingForMember(memberName, bindings, groupId) {
  const member = normalizeLineMember(memberName);
  const records = listBindingRecords(bindings).filter((binding) => bindingIsInGroup(binding, groupId));
  if (member.memberId) {
    const byMemberId = records.find((binding) => binding.memberId === member.memberId);
    if (byMemberId) return byMemberId;
  }
  const exact = records.find((binding) => bindingMatchesMember(binding, member));
  if (exact) return exact;

  const sameLineName = records.filter((binding) =>
    binding.lineName === member.lineName);
  const userIds = new Set(sameLineName.map((binding) => binding.lineUserId));
  return userIds.size === 1 ? sameLineName[0] : null;
}

function buildMemberBindingRows(memberNames, bindings, groupId) {
  return normalizeGuildMembers(memberNames)
    .map((member) => {
      const binding = findBindingForMember(member, bindings, groupId);
      return {
        memberId: member.memberId,
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

function buildBindingListText(memberNames, bindings, groupId, bindingLocked = false) {
  const rows = buildMemberBindingRows(memberNames, bindings, groupId);
  const boundCount = rows.filter((row) => row.bound).length;
  const lines = [
    "📋 LINE 綁定清單",
    bindingLocked ? "🔒 綁定狀態：已鎖定" : "🔓 綁定狀態：開放中",
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

function buildBindingResultText(title, entries, footer) {
  const members = (Array.isArray(entries) ? entries : [])
    .map(normalizeLineMember)
    .filter((member) => member.fullName);
  const lineNames = [...new Set(members.map((member) => member.lineName))];
  const lines = [
    title,
    "",
    `LINE：${lineNames.join("、")}`,
    "遊戲 ID：",
    ...members.map((member) => `• ${member.gameId}`),
  ];
  if (footer) lines.push("", footer);
  return lines.join("\n");
}

function buildBindingSuccessText(members) {
  return buildBindingResultText("✅ LINE 綁定完成", members);
}

function buildUnbindSuccessText(bindings) {
  return buildBindingResultText(
    "✅ 已解除 LINE 綁定",
    bindings,
    `共解除 ${bindings.length} 個遊戲帳號。`,
  );
}

function buildAdminBindingSuccessText(members, sourceLineName) {
  const parsedMembers = (Array.isArray(members) ? members : [])
    .map(normalizeLineMember)
    .filter((member) => member.fullName);
  const targetGuildLineName = parsedMembers[0] ? parsedMembers[0].lineName : "";
  const actualLineName = String(sourceLineName || targetGuildLineName).trim();
  const lines = [
    "✅ 管理員綁定完成",
    "",
    "LINE：",
    actualLineName,
    "",
    "公會名單：",
    targetGuildLineName,
    "",
    "遊戲 ID：",
    ...parsedMembers.map((member) => `• ${member.gameId}`),
  ];
  if (actualLineName !== targetGuildLineName) {
    lines.push("", "ℹ️ LINE 名稱與公會登記名稱不同。");
  }
  return lines.join("\n");
}

function buildAdminUnbindSuccessText(bindings) {
  return buildBindingResultText(
    "✅ 管理員已解除 LINE 綁定",
    bindings,
    `共解除 ${bindings.length} 個遊戲帳號。`,
  );
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
    const member = normalizeLineMember(memberName);
    const binding = findBindingForMember(member, bindings, groupId);
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

  const identity = record.memberIdentity && typeof record.memberIdentity === "object" ?
    record.memberIdentity : null;
  const captainMember = identity && identity.captain || record.captain;
  const guardianMember = identity && identity.guardian || record.guardian;
  const cabinMembers = identity && Array.isArray(identity.cabin4) ? identity.cabin4 :
    Array.isArray(record.cabin4) ? record.cabin4 : [];
  const lines = [
    `${escapeTextV2Literal(formatDrawDate(record.date))}船長：${renderMember(captainMember, true)}`,
    `守護天使：${renderMember(guardianMember, true)}`,
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

function isGroupJoinEvent(event) {
  return Boolean(event && event.type === "join" && event.source &&
    event.source.type === "group" && event.source.groupId);
}

function isObservedGroupEvent(event) {
  return Boolean(event && event.source && event.source.type === "group" &&
    event.source.groupId && event.source.userId);
}

function planWebhookEvent(event) {
  return {
    joinGroup: isGroupJoinEvent(event),
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
  bindingKeyForGroup,
  bindingKeyForMemberId,
  bindingMatchesMember,
  buildAdminBindingSuccessText,
  buildAdminUnbindSuccessText,
  buildBindingSuccessText,
  buildBotHelpText,
  buildBindingListText,
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
  formatDrawDate,
  isGroupMessageEvent,
  isGroupJoinEvent,
  listBindingRecords,
  maskLineUserId,
  normalizeGuildMembers,
  normalizeLineMember,
  normalizeMemberName,
  parseAdminBindArguments,
  parseBotCommand,
  parseMemberName,
  planWebhookEvent,
  resolveBindingLineName,
  splitTextMessages,
  standardizeName,
  verifyLineSignature,
};
