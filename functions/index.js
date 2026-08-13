"use strict";

const {onRequest} = require("firebase-functions/v2/https");
const {defineSecret, defineString} = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const {initializeApp} = require("firebase-admin/app");
const {getAuth} = require("firebase-admin/auth");
const {getDatabase, ServerValue} = require("firebase-admin/database");
const {assertAdminUid} = require("./lib/admin");
const {
  generateMiaobingAiReply,
  planMiaobingAiTrigger,
  planMiaobingPrivateAiTrigger,
  processMiaobingAiRequest,
} = require("./lib/ai");
const {reserveAiUsage} = require("./lib/aiRateLimit");
const {
  loadPublishedDrawKnowledge,
  planPublishedDrawQuery,
} = require("./lib/drawKnowledge");
const {
  backfillDrawLinePublication,
  normalizePublishedAt,
  validateBackfillRecordId,
} = require("./lib/drawPublicationBackfill");
const {
  buildAdminBindingSuccessText,
  buildAdminUnbindSuccessText,
  bindingKeyForGroup,
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
  findMembersByLineName,
  listBindingRecords,
  maskLineUserId,
  normalizeMemberName,
  parseAdminBindArguments,
  planWebhookEvent,
  resolveBindingLineName,
  splitTextMessages,
  verifyLineSignature,
} = require("./lib/line");
const {
  buildLineBindingAdminRows,
  buildMemberSyncPlan,
  buildObservedMemberRecord,
  buildSyncReply,
  decideLineCommandAccess,
  decideLineSyncAccess,
  fetchAllGroupMemberIds,
  isFirebaseSafeKey,
  getBindingLockTransition,
  isBindingLocked,
  isLineBotAdmin,
  mapInBatches,
  planAdminBinding,
  planLineBotAdminChange,
  resolveSyncMemberSource,
  selectAdminUnbindBindings,
} = require("./lib/line-sync");
const {
  buildKnownLineGroupRecord,
  buildLineBindingMigrationPlan,
  buildLineGroupAdminRows,
  buildLineGroupSwitchUpdates,
  lineGroupKey,
  normalizeLineGroupSummary,
  planLineGroupJoin,
} = require("./lib/line-groups");
const {
  AMBIENT_COOLDOWN_MS,
  decorateCommandReply,
  detectPersonalityControl,
  getTaipeiHour,
  isCooldownElapsed,
  isPersonalityEnabled,
  personalityUserKey,
  planMiaobingMessage,
  planPersonalityControl,
} = require("./lib/miaobing-personality");
const {
  buildLoreReplyMessage,
  isSenderLorePerson,
  resolveLoreIdentity,
  resolveSenderRole,
} = require("./lib/miaobing-lore");

initializeApp();

const REGION = "asia-southeast1";
const LINE_API_BASE = "https://api.line.me/v2/bot";
const LINE_CHANNEL_ACCESS_TOKEN = defineSecret("LINE_CHANNEL_ACCESS_TOKEN");
const LINE_CHANNEL_SECRET = defineSecret("LINE_CHANNEL_SECRET");
const OPENAI_API_KEY = defineSecret("OPENAI_API_KEY");
const ALLOWED_ORIGIN = defineString("ALLOWED_ORIGIN");
const ADMIN_UID = defineString("ADMIN_UID");

function json(res, status, body) {
  res.status(status).type("application/json").send(JSON.stringify(body));
}

function allowedOrigins() {
  return new Set(ALLOWED_ORIGIN.value().split(",").map((item) => item.trim()).filter(Boolean));
}

function applyAdminCors(req, res) {
  const origin = String(req.get("origin") || "");
  const allowed = allowedOrigins();
  if (!origin || !allowed.has(origin)) return false;
  res.set("Access-Control-Allow-Origin", origin);
  res.set("Vary", "Origin");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.set("Access-Control-Max-Age", "3600");
  return true;
}

async function requireAdmin(req) {
  const match = String(req.get("authorization") || "").match(/^Bearer\s+(.+)$/i);
  if (!match) throw Object.assign(new Error("缺少 Firebase ID Token。"), {status: 401});
  const decoded = await getAuth().verifyIdToken(match[1]);
  assertAdminUid(decoded.uid, ADMIN_UID.value());
  return decoded;
}

async function withAdminRequest(req, res, methods, handler) {
  if (!applyAdminCors(req, res)) {
    json(res, 403, {ok: false, error: "Origin 不在允許清單。"});
    return;
  }
  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }
  if (!methods.includes(req.method)) {
    res.set("Allow", methods.join(", "));
    json(res, 405, {ok: false, error: "不支援的 HTTP method。"});
    return;
  }
  try {
    const adminUser = await requireAdmin(req);
    await handler(adminUser);
  } catch (error) {
    const status = Number(error.status) || (error.code && String(error.code).startsWith("auth/") ? 401 : 500);
    if (status >= 500) logger.error("LINE admin function failed", error);
    json(res, status, {ok: false, error: status >= 500 ? "伺服器處理失敗，請稍後再試。" : error.message});
  }
}

async function callLine(path, token, body, method = "POST") {
  const response = await fetch(`${LINE_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? {"Content-Type": "application/json"} : {}),
    },
    ...(body ? {body: JSON.stringify(body)} : {}),
  });
  if (!response.ok) {
    const detail = await response.text();
    logger.error("LINE Messaging API request failed", {path, status: response.status, detail});
    const error = new Error(`LINE Messaging API 回傳 ${response.status}。`);
    error.lineStatus = response.status;
    throw error;
  }
  if (response.status === 204) return null;
  return response.json();
}

async function replyMessages(replyToken, lineMessages, token) {
  const messages = (Array.isArray(lineMessages) ? lineMessages : [lineMessages])
    .filter((message) => message && typeof message === "object")
    .slice(0, 5);
  if (!replyToken || !messages.length) return;
  await callLine("/message/reply", token, {replyToken, messages});
}

async function replyTexts(replyToken, texts, token) {
  const messages = (Array.isArray(texts) ? texts : [texts])
    .filter((text) => String(text || "").trim())
    .map((text) => ({type: "text", text: String(text)}));
  await replyMessages(replyToken, messages, token);
}

async function replyText(replyToken, text, token) {
  await replyTexts(replyToken, [text], token);
}

function createCommandReplier(event, command, token, senderRole) {
  const decorate = (coreText, status) => decorateCommandReply({
    command: command.command,
    status,
    coreText,
    senderRole,
  });
  return {
    text: (coreText, status = "success") =>
      replyText(event.replyToken, decorate(coreText, status), token),
    longText: (coreText, status = "success") => {
      const decoratedMessages = splitTextMessages(decorate(coreText, status), 4500, 100);
      const messages = decoratedMessages.length <= 5 ?
        decoratedMessages : splitTextMessages(coreText);
      return replyTexts(event.replyToken, messages, token);
    },
  };
}

async function getEventSenderRole(event) {
  if (!event || !event.source || event.source.type !== "group" ||
      !event.source.groupId || !event.source.userId) return "MEMBER";
  const bindings = (await getDatabase().ref("guildDraw/lineBindings").get()).val() || {};
  return resolveSenderRole(bindings, event.source.groupId, event.source.userId).senderRole;
}

async function claimPersonalityCooldown(ref, now, cooldownMs) {
  const transaction = await ref.transaction((lastReplyAt) =>
    isCooldownElapsed(lastReplyAt, now, cooldownMs) ? now : undefined);
  return transaction.committed;
}

async function handleMiaobingPersonality({event, botUserId, token}) {
  if (!event || event.type !== "message" || !event.message || event.message.type !== "text" ||
      !event.source || event.source.type !== "group" || !event.source.groupId) return;
  const groupId = event.source.groupId;
  if (!isFirebaseSafeKey(groupId)) return;
  const text = String(event.message.text || "");
  const db = getDatabase();
  const groupRef = db.ref(`guildDraw/linePersonality/${groupId}`);
  const enabledValue = (await groupRef.child("enabled").get()).val();
  const personalityEnabled = isPersonalityEnabled(enabledValue);
  const control = detectPersonalityControl(text);

  let bindings = null;
  if (control) {
    const [settingsSnapshot, bindingsSnapshot] = await Promise.all([
      db.ref("guildDraw/lineSettings").get(),
      db.ref("guildDraw/lineBindings").get(),
    ]);
    const settings = settingsSnapshot.val() || {};
    bindings = bindingsSnapshot.val() || {};
    const userId = event.source.userId;
    const controlPlan = planPersonalityControl({
      text,
      personalityEnabled,
      isAdmin: isLineBotAdmin(settings.adminLineUserIds, userId),
      isOwner: isSenderLorePerson(bindings, groupId, "owner", userId),
    });
    if (controlPlan.authorized) {
      if (controlPlan.stateChange === false) {
        await replyText(event.replyToken, controlPlan.replyText, token);
        await groupRef.child("enabled").set(false);
      } else {
        await groupRef.child("enabled").set(true);
        await replyText(event.replyToken, controlPlan.replyText, token);
      }
      logger.info("Miaobing personality control", {control: controlPlan.control});
      return;
    }
    if (controlPlan.shouldReply) {
      await replyText(event.replyToken, controlPlan.replyText, token);
      return;
    }
    if (!personalityEnabled) return;
  }

  if (!personalityEnabled) return;
  if (!bindings) bindings = (await db.ref("guildDraw/lineBindings").get()).val() || {};
  const senderId = event.source.userId;
  const senderContext = resolveSenderRole(bindings || {}, groupId, senderId);
  const plan = planMiaobingMessage({
    event,
    botUserId,
    hourTaipei: getTaipeiHour(),
    personalityEnabled,
    senderRole: senderContext.senderRole,
    isOwner: senderContext.isOwner,
    isLeader: senderContext.isGuildLeader,
  });
  if (!plan.shouldReply) return;

  let identity = null;
  if (plan.mentionTarget) {
    if (!bindings) bindings = (await db.ref("guildDraw/lineBindings").get()).val() || {};
    identity = resolveLoreIdentity(bindings, groupId, plan.mentionTarget);
  }
  const message = buildLoreReplyMessage(plan, identity);
  if (!message) return;
  const now = Date.now();
  let cooldownRef;
  let cooldownMs = plan.cooldownMs;
  if (plan.kind === "plate" && identity) {
    cooldownRef = groupRef.child("lastPlateMentionAt");
  } else if (plan.kind === "plate") {
    cooldownRef = groupRef.child("lastAmbientReplyAt");
    cooldownMs = AMBIENT_COOLDOWN_MS;
  } else if (plan.kind === "direct" && senderId) {
    const userKey = personalityUserKey(senderId);
    if (!userKey || !isFirebaseSafeKey(userKey)) return;
    cooldownRef = groupRef.child(`lastMentionReplyAt/${userKey}`);
  } else if (plan.kind === "ambient") {
    cooldownRef = groupRef.child("lastAmbientReplyAt");
  }
  if (cooldownRef && !await claimPersonalityCooldown(cooldownRef, now, cooldownMs)) return;

  logger.info("Miaobing personality reply", {kind: plan.kind, intent: plan.intent});
  await replyMessages(event.replyToken, [message], token);
}

async function handleMiaobingAi({event, aiPlan, token, isPrivateAdminTest = false}) {
  if (!aiPlan || !aiPlan.shouldCallAi || !event || !event.source) return;
  const sourceType = event.source.type;
  const groupId = event.source.groupId;
  const userId = event.source.userId;
  const isGroupRequest = sourceType === "group" && isFirebaseSafeKey(groupId);
  const isPrivateRequest = sourceType === "user" && isPrivateAdminTest === true;
  if ((!isGroupRequest && !isPrivateRequest) || !isFirebaseSafeKey(userId)) return;

  const db = getDatabase();
  if (isGroupRequest) {
    const enabledValue = (await db.ref(`guildDraw/linePersonality/${groupId}/enabled`).get()).val();
    if (!isPersonalityEnabled(enabledValue)) return;
  }

  let apiKey = "";
  try {
    apiKey = OPENAI_API_KEY.value();
  } catch {
    apiKey = "";
  }
  const outcome = await processMiaobingAiRequest({
    apiKey,
    question: aiPlan.question,
    reserveUsage: () => reserveAiUsage(db.ref("guildDraw/aiUsage"), userId),
    generateReply: async ({apiKey: key, question}) => {
      const drawPlan = planPublishedDrawQuery(question);
      let authoritativeContext = "";
      if (drawPlan.shouldRetrieve) {
        authoritativeContext = (await loadPublishedDrawKnowledge(
          db.ref("guildDraw/main/history"),
          drawPlan,
        )).context;
      }
      return generateMiaobingAiReply({
        apiKey: key,
        question,
        authoritativeContext,
      });
    },
  });
  const logContext = {
    sourceType,
    isPrivateAdminTest: isPrivateRequest,
    maskedSender: maskLineUserId(userId),
  };
  if (outcome.reason === "openai-error") {
    logger.warn("Miaobing AI request failed", {
      ...logContext,
      ...(outcome.errorMeta || {type: "unknown_error", status: null}),
    });
  } else if (outcome.reason === "empty-output" || outcome.reason === "incomplete-output") {
    logger.warn("Miaobing AI returned no visible output", {
      ...logContext,
      result: outcome.reason,
      trigger: aiPlan.reason,
      ...(outcome.responseMeta || {
        status: null,
        incompleteReason: null,
        outputTokens: null,
        reasoningTokens: null,
      }),
    });
  } else {
    logger.info("Miaobing AI request", {
      ...logContext,
      result: outcome.reason,
      trigger: aiPlan.reason,
    });
  }
  await replyText(event.replyToken, outcome.text, token);
}

async function handleMiaobingPrivateAdminAi(event, token) {
  if (!event || event.type !== "message" || !event.message || event.message.type !== "text" ||
      !event.source || event.source.type !== "user" || !isFirebaseSafeKey(event.source.userId)) return;
  const adminLineUserIds = (await getDatabase()
    .ref("guildDraw/lineSettings/adminLineUserIds").get()).val() || {};
  const isAdmin = isLineBotAdmin(adminLineUserIds, event.source.userId);
  const aiPlan = planMiaobingPrivateAiTrigger({event, isAdmin});
  if (!aiPlan.shouldCallAi) return;
  await handleMiaobingAi({event, aiPlan, token, isPrivateAdminTest: true});
}

async function fetchGroupMemberProfile(groupId, userId, token) {
  return callLine(
    `/group/${encodeURIComponent(groupId)}/member/${encodeURIComponent(userId)}`,
    token,
    null,
    "GET",
  );
}

async function getGroupMemberProfile(groupId, userId, token) {
  try {
    return await fetchGroupMemberProfile(groupId, userId, token);
  } catch (error) {
    logger.warn("Could not load LINE group member profile", {groupId, userId, message: error.message});
    return null;
  }
}

async function getLineGroupSummary(groupId, token) {
  try {
    return await callLine(
      `/group/${encodeURIComponent(groupId)}/summary`,
      token,
      null,
      "GET",
    );
  } catch (error) {
    logger.warn("Could not load LINE group summary", {groupId, message: error.message});
    return null;
  }
}

async function rememberKnownLineGroup(groupId, summary, now = new Date().toISOString()) {
  if (!isFirebaseSafeKey(groupId)) return null;
  const normalized = normalizeLineGroupSummary(summary);
  const key = lineGroupKey(groupId);
  const ref = getDatabase().ref(`guildDraw/lineGroups/${key}`);
  const transaction = await ref.transaction((current) => buildKnownLineGroupRecord(current, {
    groupId,
    ...normalized,
    now,
  }));
  return transaction.snapshot.val();
}

async function handleLineGroupJoin(event, token) {
  const groupId = event && event.source && event.source.groupId;
  if (!groupId || !isFirebaseSafeKey(groupId)) return;
  const [summary, settingsSnapshot] = await Promise.all([
    getLineGroupSummary(groupId, token),
    getDatabase().ref("guildDraw/lineSettings").get(),
  ]);
  const now = new Date().toISOString();
  const plan = planLineGroupJoin({
    groupId,
    summary,
    defaultGroupId: settingsSnapshot.child("defaultGroupId").val(),
    now,
  });
  await rememberKnownLineGroup(groupId, summary, now);
  await replyText(event.replyToken, plan.replyText, token);
}

async function rememberObservedMember(event, profile) {
  const groupId = event.source.groupId;
  const userId = event.source.userId;
  if (!profile || !profile.displayName || !isFirebaseSafeKey(groupId) || !isFirebaseSafeKey(userId)) return;
  const now = new Date().toISOString();
  const ref = getDatabase().ref(`guildDraw/lineObservedMembers/${groupId}/${userId}`);
  await ref.transaction((current) => buildObservedMemberRecord(current, {
    lineUserId: userId,
    displayName: profile.displayName,
    groupId,
    pictureUrl: profile.pictureUrl,
  }, now));
}

async function getSyncMemberSource(groupId, token, observedMembers) {
  return resolveSyncMemberSource(
    () => fetchAllGroupMemberIds(async (start) => {
      const query = start ? `?start=${encodeURIComponent(start)}` : "";
      return callLine(
        `/group/${encodeURIComponent(groupId)}/members/ids${query}`,
        token,
        null,
        "GET",
      );
    }),
    observedMembers,
  );
}

async function loadSyncProfiles(source, groupId, token) {
  return mapInBatches(source.memberIds, 10, async (userId) => {
    const profile = await fetchGroupMemberProfile(groupId, userId, token);
    return {
      userId: profile.userId || userId,
      displayName: profile.displayName || "",
      pictureUrl: profile.pictureUrl || null,
    };
  });
}

function syncErrorMessage(error) {
  if (error && error.lineStatus === 404) {
    return "❌ 找不到目前群組，或 Bot 已不在這個群組中。";
  }
  if (error && error.lineStatus === 429) {
    return "⚠️ LINE API 目前請求過多，請稍後再試。";
  }
  return "❌ LINE 成員同步暫時失敗，請稍後再試。";
}

async function handleSyncCommand({event, token, db, settings, bindings, bindingsRef, members, replier}) {
  const groupId = event.source.groupId;
  const userId = event.source.userId;
  const access = decideLineSyncAccess(
    settings.defaultGroupId,
    groupId,
    settings.adminLineUserIds,
    userId,
  );
  if (!access.allowed) {
    const message = access.reason === "not-admin" ?
      "❌ 你沒有執行 LINE 成員同步的管理員權限。" :
      "❌ 只有目前正式公會群組可以執行同步。";
    await replier.text(message, "failure");
    return;
  }

  try {
    const observedSnapshot = await db.ref(`guildDraw/lineObservedMembers/${groupId}`).get();
    const source = await getSyncMemberSource(groupId, token, observedSnapshot.val() || {});
    const profiles = await loadSyncProfiles(source, groupId, token);
    const result = buildMemberSyncPlan({
      memberNames: members,
      bindings,
      profiles,
      groupId,
      now: new Date().toISOString(),
    });
    if (Object.keys(result.updates).length) await bindingsRef.update(result.updates);
    await replier.text(buildSyncReply(result, source.mode), "success");
  } catch (error) {
    logger.warn("LINE member sync failed", {groupId, status: error.lineStatus, message: error.message});
    await replier.text(syncErrorMessage(error), "failure");
  }
}

async function handleHelpCommand(event, token, senderRole) {
  const settings = (await getDatabase().ref("guildDraw/lineSettings").get()).val() || {};
  const replier = createCommandReplier(event, {command: "help"}, token, senderRole);
  await replier.text(buildBotHelpText({
    bindingLocked: isBindingLocked(settings.bindingLocked),
    isAdmin: isLineBotAdmin(settings.adminLineUserIds, event.source.userId),
  }));
}

async function handleBindingLockCommand({event, command, settings, settingsRef, replier}) {
  const requestedLocked = command.command === "lock";
  const transition = getBindingLockTransition(settings.bindingLocked, requestedLocked);
  if (!transition.changed) {
    await replier.text(requestedLocked ?
      "🔒 LINE 綁定目前已經是鎖定狀態。" :
      "🔓 LINE 綁定目前沒有鎖定。", requestedLocked ? "locked" : "success");
    return;
  }

  await settingsRef.update(requestedLocked ? {
    bindingLocked: true,
    bindingLockedAt: ServerValue.TIMESTAMP,
    bindingLockedBy: event.source.userId,
    updatedAt: ServerValue.TIMESTAMP,
  } : {
    bindingLocked: false,
    bindingLockedAt: null,
    bindingLockedBy: null,
    updatedAt: ServerValue.TIMESTAMP,
  });
  await replier.text(requestedLocked ? [
    "🔒 LINE 綁定已鎖定",
    "",
    "一般會員目前無法自行：",
    "• 綁定",
    "• 解除綁定",
    "",
    "管理員仍可代為處理。",
  ].join("\n") : [
    "🔓 LINE 綁定已解除鎖定",
    "",
    "公會成員現在可以自行使用：",
    "!綁定",
    "!解除",
  ].join("\n"));
}

async function loadAdminBindSourceProfiles(groupId, token, observedMembers) {
  try {
    const source = await getSyncMemberSource(groupId, token, observedMembers);
    if (source.mode === "full") return loadSyncProfiles(source, groupId, token);
    return source.observedMembers.map((member) => ({
      userId: member.lineUserId,
      displayName: member.displayName,
    }));
  } catch (error) {
    logger.warn("Could not load full LINE identities for admin bind", {
      status: error.lineStatus,
      message: error.message,
    });
    return Object.values(observedMembers && typeof observedMembers === "object" ? observedMembers : {})
      .filter((member) => member && member.lineUserId && member.displayName)
      .map((member) => ({userId: member.lineUserId, displayName: member.displayName}));
  }
}

async function handleAdminBindCommand({
  event, command, token, db, members, bindings, bindingsRef, replier,
}) {
  const parsed = parseAdminBindArguments(command.args, event.message, {memberNames: members});
  if (parsed.status === "missing-arguments") {
    await replier.text("請輸入：\n!幫綁 <LINE名稱> [名單名稱]", "failure");
    return;
  }
  if (parsed.status !== "success") {
    await replier.text([
      "⚠️ 請只真正 @一位要綁定的成員，",
      "並將 @對方 放在第一個參數：",
      "",
      "!幫綁 @對方 名單名稱",
    ].join("\n"), "failure");
    return;
  }
  const groupId = event.source.groupId;
  const observedSnapshot = await db.ref(`guildDraw/lineObservedMembers/${groupId}`).get();
  const observedMembers = observedSnapshot.val() || {};
  let sourceIdentity = null;
  let sourceProfiles = [];
  let targetGuildLineName = parsed.targetGuildLineName;

  if (parsed.usedMention) {
    const profile = await getGroupMemberProfile(groupId, parsed.mentionedUserId, token);
    if (!profile || !profile.displayName) {
      await replier.text([
        "⚠️ 無法讀取被 @成員的 LINE 身份。",
        "請確認對方仍在目前正式群組後再試一次。",
      ].join("\n"), "not-found");
      return;
    }
    sourceIdentity = {
      userId: parsed.mentionedUserId,
      displayName: profile.displayName,
      groupId,
    };
    targetGuildLineName = targetGuildLineName || profile.displayName;
  }

  const targetMembers = findMembersByLineName(members, targetGuildLineName);
  if (!targetMembers.length) {
    await replier.text(
      `❌ 找不到公會名單 LINE 名稱「${targetGuildLineName}」。`,
      "not-found",
    );
    return;
  }
  if (!parsed.usedMention) {
    sourceProfiles = await loadAdminBindSourceProfiles(groupId, token, observedMembers);
  }

  const plan = planAdminBinding({
    memberNames: members,
    bindings,
    observedMembers,
    sourceProfiles,
    sourceIdentity,
    sourceLineName: parsed.sourceLineName,
    targetGuildLineName,
    groupId,
    now: new Date().toISOString(),
  });
  if (plan.status === "line-identity-not-found") {
    await replier.text([
      `⚠️ 找不到 LINE 名稱為「${parsed.sourceLineName}」的成員。`,
      "請直接 @要綁定的本人：",
      "",
      `!幫綁 @對方 ${targetGuildLineName}`,
    ].join("\n"), "not-found");
    return;
  }
  if (plan.status === "ambiguous-line-identity") {
    await replier.text([
      `⚠️ 找到多個 LINE 名稱為「${parsed.sourceLineName}」的成員。`,
      "請直接 @要綁定的本人：",
      "",
      `!幫綁 @對方 ${targetGuildLineName}`,
    ].join("\n"), "failure");
    return;
  }
  if (plan.status === "binding-conflict") {
    await replier.text([
      `⚠️「${targetGuildLineName}」目前已經綁定其他 LINE 帳號。`,
      "",
      "如需重新指定，請先：",
      "",
      `!幫解除 ${targetGuildLineName}`,
      "",
      "再重新：",
      "",
      "!幫綁 ...",
    ].join("\n"), "failure");
    return;
  }

  if (Object.keys(plan.updates).length) await bindingsRef.update(plan.updates);
  await replier.text(buildAdminBindingSuccessText(plan.members, plan.identity.displayName));
}

async function handleAdminUnbindCommand({event, command, members, bindings, bindingsRef, replier}) {
  const lineName = String(command.args || "").trim();
  if (!lineName) {
    await replier.text("請輸入：\n!幫解除 <LINE名稱>", "failure");
    return;
  }
  const selected = selectAdminUnbindBindings({
    memberNames: members,
    bindings,
    lineName,
    groupId: event.source.groupId,
  });
  if (selected.status === "guild-member-not-found") {
    await replier.text(`❌ 找不到 LINE 名稱「${lineName}」對應的公會成員。`, "not-found");
    return;
  }
  if (selected.status === "binding-not-found") {
    await replier.text(`ℹ️ LINE 名稱「${lineName}」目前沒有可解除的綁定。`, "not-found");
    return;
  }
  const updates = {};
  selected.bindings.forEach((binding) => { updates[binding.id] = null; });
  await bindingsRef.update(updates);
  await replier.text(buildAdminUnbindSuccessText(selected.bindings));
}

async function handleBindingCommand(event, command, token, observedProfile, senderRole) {
  const db = getDatabase();
  const userId = event.source.userId;
  const groupId = event.source.groupId;
  const replier = createCommandReplier(event, command, token, senderRole);
  if (!userId) {
    await replier.text("❌ LINE 無法取得你的 userId，無法完成綁定。", "failure");
    return;
  }
  const settingsRef = db.ref("guildDraw/lineSettings");
  const defaultGroupRef = settingsRef.child("defaultGroupId");
  const settings = (await settingsRef.get()).val() || {};
  const defaultGroupId = settings.defaultGroupId;
  const commandAccess = decideLineCommandAccess({
    command: command.command,
    bindingLocked: settings.bindingLocked,
    defaultGroupId,
    eventGroupId: groupId,
    adminLineUserIds: settings.adminLineUserIds,
    userId,
  });
  if (!commandAccess.allowed) {
    if (commandAccess.reason === "binding-locked") {
      await replier.text([
        "🔒 LINE 綁定目前已鎖定",
        "",
        "目前無法自行修改綁定。",
        "如需處理，請聯絡管理員。",
      ].join("\n"), "locked");
    } else if (commandAccess.reason === "other-group") {
      await replier.text("❌ 此管理指令只能在目前正式 LINE 群組使用。", "failure");
    } else {
      await replier.text("❌ 你沒有執行此 LINE 管理指令的權限。", "failure");
    }
    return;
  }
  const groupAction = decideLineGroupAction(defaultGroupId, groupId, command.command);
  if (groupAction.action === "reject-other-group") {
    await replier.text("❌ 此 Bot 已綁定其他公會群組，請由管理員處理群組設定。", "failure");
    return;
  }
  if (groupAction.action === "reject-unconfigured") {
    await replier.text("ℹ️ 尚未設定正式公會群組，請先在正式群組完成玩家綁定。", "failure");
    return;
  }
  if (!groupAction.canProcess) return;

  if (command.command === "lock" || command.command === "unlock") {
    await handleBindingLockCommand({event, command, settings, settingsRef, replier});
    return;
  }

  const bindingsRef = db.ref("guildDraw/lineBindings");
  const bindings = (await bindingsRef.get()).val() || {};
  const bindingEntries = listBindingRecords(bindings);
  const ownBindings = bindingEntries.filter((binding) =>
    binding.lineUserId === userId && binding.lineGroupId === groupId);

  if (command.command === "status") {
    const members = (await db.ref("guildDraw/main/guildMembers").get()).val() || [];
    const ownRows = buildMemberBindingRows(members, bindings, groupId)
      .filter((row) => row.bound && row.lineUserId === userId);
    if (!ownRows.length) {
      await replier.text("ℹ️ 你目前尚未綁定玩家。", "not-found");
      return;
    }
    const lineNames = [...new Set(ownRows.map((row) => row.lineName))];
    const gameIds = [...new Set(ownRows.map((row) => row.gameId))];
    await replier.text([
      "✅ 你的 LINE 綁定",
      "",
      `LINE：${lineNames.join("、")}`,
      "遊戲 ID：",
      ...gameIds.map((gameId) => `• ${gameId}`),
    ].join("\n"));
    return;
  }

  if (command.command === "unbind") {
    if (!ownBindings.length) {
      await replier.text("ℹ️ 你目前沒有可解除的綁定。", "not-found");
      return;
    }
    const updates = {};
    ownBindings.forEach((binding) => { updates[binding.id] = null; });
    await bindingsRef.update(updates);
    await replier.text(buildUnbindSuccessText(ownBindings));
    return;
  }

  const members = (await db.ref("guildDraw/main/guildMembers").get()).val() || [];
  if (command.command === "binding-list") {
    const text = buildBindingListText(members, bindings, groupId, isBindingLocked(settings.bindingLocked));
    await replier.longText(text);
    return;
  }

  if (command.command === "unbound-list") {
    const text = buildUnboundListText(members, bindings, groupId);
    await replier.longText(text);
    return;
  }

  if (command.command === "sync") {
    await handleSyncCommand({event, token, db, settings, bindings, bindingsRef, members, replier});
    return;
  }

  if (command.command === "admin-bind") {
    await handleAdminBindCommand({event, command, token, db, members, bindings, bindingsRef, replier});
    return;
  }

  if (command.command === "admin-unbind") {
    await handleAdminUnbindCommand({event, command, members, bindings, bindingsRef, replier});
    return;
  }

  let profile = observedProfile || null;
  if (command.auto) {
    if (!profile) profile = await getGroupMemberProfile(groupId, userId, token);
    if (!profile || !profile.displayName) {
      await replier.text("❌ 無法取得你的 LINE 顯示名稱，請改用：\n!綁定 <LINE名稱>", "failure");
      return;
    }
  }
  const requestedLineName = resolveBindingLineName(command, profile && profile.displayName);
  const matches = findMembersByLineName(members, requestedLineName);
  if (!matches.length) {
    await replier.text(command.auto ?
      `❌ 找不到與你的 LINE 名稱「${requestedLineName}」對應的玩家。\n請改用：\n!綁定 <LINE名稱>` :
      `❌ 找不到 LINE 名稱「${requestedLineName}」對應的玩家，請確認名稱。`, "not-found");
    return;
  }

  const canonicalLineName = matches[0].lineName;
  const otherOwnLineNames = [...new Set(ownBindings
    .filter((binding) => binding.lineName !== canonicalLineName)
    .map((binding) => binding.lineName))];
  if (otherOwnLineNames.length) {
    await replier.text([
      "ℹ️ 你的 LINE 帳號目前已綁定其他 LINE 名稱：",
      ...otherOwnLineNames.map((lineName) => `- ${lineName}`),
      "如需更換，請先輸入「!解除」。",
    ].join("\n"), "failure");
    return;
  }
  const conflictingBindings = bindingEntries.filter((binding) =>
    binding.lineGroupId === groupId &&
    binding.lineName === canonicalLineName &&
    binding.lineUserId !== userId);
  if (conflictingBindings.length) {
    await replier.text(`❌ LINE 名稱「${requestedLineName}」已由其他 LINE 帳號綁定。`, "failure");
    return;
  }

  if (!profile) profile = await getGroupMemberProfile(groupId, userId, token);
  const now = new Date().toISOString();
  if (groupAction.canClaim) {
    const claimResult = await defaultGroupRef.transaction((current) =>
      claimDefaultLineGroup(current, groupId));
    if (claimResult.snapshot.val() !== groupId) {
      await replier.text("❌ 此 Bot 已綁定其他公會群組，請由管理員處理群組設定。", "failure");
      return;
    }
    await settingsRef.child("updatedAt").set(ServerValue.TIMESTAMP);
  }

  const updates = {};
  matches.forEach((member) => {
    const existing = bindingEntries.find((binding) =>
      binding.normalizedPlayerName === normalizeMemberName(member.fullName) &&
      binding.lineUserId === userId && binding.lineGroupId === groupId);
    const key = existing ? existing.id : bindingKeyForGroup(member.fullName, groupId);
    updates[key] = createBindingRecord({
      member,
      userId,
      displayName: profile && profile.displayName,
      groupId,
      now,
      boundAt: existing && existing.boundAt,
    });
  });
  await bindingsRef.update(updates);
  await replier.text(buildBindingSuccessText(matches));
}

exports.lineWebhook = onRequest({
  region: REGION,
  secrets: [LINE_CHANNEL_SECRET, LINE_CHANNEL_ACCESS_TOKEN, OPENAI_API_KEY],
  timeoutSeconds: 30,
}, async (req, res) => {
  if (req.method !== "POST") {
    res.set("Allow", "POST");
    json(res, 405, {ok: false});
    return;
  }
  const rawBody = req.rawBody;
  if (!verifyLineSignature(rawBody, req.get("x-line-signature"), LINE_CHANNEL_SECRET.value())) {
    json(res, 401, {ok: false});
    return;
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    json(res, 400, {ok: false});
    return;
  }

  try {
    const events = Array.isArray(payload.events) ? payload.events : [];
    await Promise.all(events.map(async (event) => {
      if (event && event.source && event.source.type === "user") {
        await handleMiaobingPrivateAdminAi(event, LINE_CHANNEL_ACCESS_TOKEN.value());
        return;
      }
      const eventPlan = planWebhookEvent(event);
      if (eventPlan.joinGroup) {
        await handleLineGroupJoin(event, LINE_CHANNEL_ACCESS_TOKEN.value());
        return;
      }
      if (event && event.source && event.source.type === "group" && event.source.groupId) {
        await rememberKnownLineGroup(event.source.groupId, null);
      }
      let profile = null;
      if (eventPlan.observeMember) {
        profile = await getGroupMemberProfile(
          event.source.groupId,
          event.source.userId,
          LINE_CHANNEL_ACCESS_TOKEN.value(),
        );
        if (profile) await rememberObservedMember(event, profile);
      }
      if (!eventPlan.command) {
        const control = event && event.message && event.message.type === "text" ?
          detectPersonalityControl(event.message.text) : null;
        if (control) {
          await handleMiaobingPersonality({
            event,
            botUserId: payload.destination,
            token: LINE_CHANNEL_ACCESS_TOKEN.value(),
          });
          return;
        }
        const aiPlan = planMiaobingAiTrigger({
          event,
          command: eventPlan.command,
          botUserId: payload.destination,
        });
        if (aiPlan.shouldCallAi) {
          await handleMiaobingAi({
            event,
            aiPlan,
            token: LINE_CHANNEL_ACCESS_TOKEN.value(),
          });
          return;
        }
        await handleMiaobingPersonality({
          event,
          botUserId: payload.destination,
          token: LINE_CHANNEL_ACCESS_TOKEN.value(),
        });
        return;
      }
      const senderRole = await getEventSenderRole(event);
      if (eventPlan.command.command === "help") {
        await handleHelpCommand(event, LINE_CHANNEL_ACCESS_TOKEN.value(), senderRole);
        return;
      }
      if (eventPlan.command.command === "unknown") {
        const replier = createCommandReplier(
          event,
          eventPlan.command,
          LINE_CHANNEL_ACCESS_TOKEN.value(),
          senderRole,
        );
        await replier.text([
          `找不到指令「${eventPlan.command.input}」`,
          "輸入 !說明 查看可用指令。",
        ].join("\n"), "failure");
        return;
      }
      await handleBindingCommand(
        event,
        eventPlan.command,
        LINE_CHANNEL_ACCESS_TOKEN.value(),
        profile,
        senderRole,
      );
    }));
    json(res, 200, {ok: true});
  } catch (error) {
    logger.error("LINE webhook processing failed", error);
    json(res, 500, {ok: false});
  }
});

exports.sendDrawToLine = onRequest({
  region: REGION,
  secrets: [LINE_CHANNEL_ACCESS_TOKEN],
  timeoutSeconds: 30,
}, async (req, res) => withAdminRequest(req, res, ["POST"], async () => {
  const recordId = req.body && typeof req.body.recordId === "string" ? req.body.recordId.trim() : "";
  if (!recordId || recordId.length > 200) {
    json(res, 400, {ok: false, error: "recordId 格式不正確。"});
    return;
  }

  const db = getDatabase();
  const [historySnapshot, bindingsSnapshot, settingsSnapshot] = await Promise.all([
    db.ref("guildDraw/main/history").get(),
    db.ref("guildDraw/lineBindings").get(),
    db.ref("guildDraw/lineSettings").get(),
  ]);
  const rawHistory = historySnapshot.val();
  const historyEntries = Array.isArray(rawHistory) ?
    rawHistory.map((record, index) => ({record, key: String(index)})) :
    Object.entries(rawHistory || {}).map(([key, record]) => ({record, key}));
  const found = historyEntries.find(({record}) => record && record.id === recordId);
  if (!found) {
    json(res, 404, {ok: false, error: "找不到指定的抽籤紀錄。"});
    return;
  }

  const groupId = settingsSnapshot.child("defaultGroupId").val();
  if (!groupId) {
    json(res, 409, {ok: false, error: "尚未設定正式 LINE 群組，請先完成一筆有效綁定，或由管理員明確設定。"});
    return;
  }
  const {message, unboundMembers} = buildDrawLineMessage(found.record, bindingsSnapshot.val() || {}, groupId);
  await callLine("/message/push", LINE_CHANNEL_ACCESS_TOKEN.value(), {
    to: groupId,
    messages: [message],
  });

  const sentAt = new Date().toISOString();
  const historyRef = db.ref("guildDraw/main/history");
  const transaction = await historyRef.transaction((currentHistory) => {
    if (!currentHistory) return;
    const nextHistory = Array.isArray(currentHistory) ? [...currentHistory] : {...currentHistory};
    const currentEntry = Array.isArray(nextHistory) ?
      nextHistory.findIndex((record) => record && record.id === recordId) :
      Object.keys(nextHistory).find((key) => nextHistory[key] && nextHistory[key].id === recordId);
    if (currentEntry === -1 || currentEntry === undefined) return;
    const current = nextHistory[currentEntry];
    nextHistory[currentEntry] = {
      ...current,
      lineSentAt: sentAt,
      lineSendCount: (Number(current.lineSendCount) || 0) + 1,
      lastLineSendStatus: "sent",
    };
    return nextHistory;
  });
  const updatedHistory = transaction.snapshot.val();
  const updatedValues = Array.isArray(updatedHistory) ? updatedHistory : Object.values(updatedHistory || {});
  const updated = updatedValues.find((record) => record && record.id === recordId) || found.record;
  json(res, 200, {
    ok: true,
    unboundMembers,
    lineSentAt: updated.lineSentAt,
    lineSendCount: updated.lineSendCount,
  });
}));

exports.backfillDrawLinePublished = onRequest({region: REGION}, async (req, res) =>
  withAdminRequest(req, res, ["POST"], async (adminUser) => {
    const recordId = validateBackfillRecordId(req.body && req.body.recordId);
    if (!recordId) {
      json(res, 400, {ok: false, error: "recordId 格式不正確。"});
      return;
    }
    const now = new Date();
    const publishedAtResult = normalizePublishedAt(req.body && req.body.publishedAt, {now});
    if (!publishedAtResult.ok) {
      const error = publishedAtResult.reason === "future-published-at" ?
        "publishedAt 不可晚於目前時間。" : "publishedAt 必須是合法的 ISO datetime。";
      json(res, 400, {ok: false, error});
      return;
    }

    const outcome = await backfillDrawLinePublication(
      getDatabase().ref("guildDraw/main/history"),
      {recordId, publishedAt: publishedAtResult.publishedAt, now},
    );
    if (outcome.status === "not-found") {
      json(res, 404, {ok: false, error: "找不到指定的抽籤紀錄。"});
      return;
    }
    if (outcome.status === "future-record" || outcome.status === "invalid-record-date") {
      const error = outcome.status === "future-record" ?
        "不可將未來日期的抽籤紀錄標記為已發布。" : "抽籤紀錄日期無效，無法安全補登。";
      json(res, 409, {ok: false, error});
      return;
    }

    logger.info("Legacy draw publication backfill", {
      recordId,
      recordDate: outcome.recordDate,
      publishedAt: outcome.publishedAt,
      adminUid: adminUser.uid,
      alreadyPublished: outcome.alreadyPublished,
    });
    json(res, 200, {
      ok: true,
      alreadyPublished: outcome.alreadyPublished,
      recordDate: outcome.recordDate,
      publishedAt: outcome.publishedAt,
    });
  }));

exports.getLineBindings = onRequest({region: REGION}, async (req, res) =>
  withAdminRequest(req, res, ["GET"], async () => {
    const db = getDatabase();
    const [membersSnapshot, bindingsSnapshot, settingsSnapshot] = await Promise.all([
      db.ref("guildDraw/main/guildMembers").get(),
      db.ref("guildDraw/lineBindings").get(),
      db.ref("guildDraw/lineSettings").get(),
    ]);
    const settings = settingsSnapshot.val() || {};
    const groupId = settings.defaultGroupId;
    const members = buildLineBindingAdminRows({
      memberNames: membersSnapshot.val() || [],
      bindings: bindingsSnapshot.val() || {},
      groupId,
      adminLineUserIds: settings.adminLineUserIds,
    });
    json(res, 200, {ok: true, hasDefaultGroup: Boolean(groupId), members});
  }));

exports.removeLineBinding = onRequest({region: REGION}, async (req, res) =>
  withAdminRequest(req, res, ["POST"], async () => {
    const bindingId = req.body && typeof req.body.bindingId === "string" ? req.body.bindingId : "";
    if (!/^p_[A-Za-z0-9_-]{20,100}$/.test(bindingId)) {
      json(res, 400, {ok: false, error: "bindingId 格式不正確。"});
      return;
    }
    const bindingRef = getDatabase().ref(`guildDraw/lineBindings/${bindingId}`);
    const snapshot = await bindingRef.get();
    if (!snapshot.exists()) {
      json(res, 404, {ok: false, error: "找不到這筆 LINE 綁定。"});
      return;
    }
    await bindingRef.remove();
    json(res, 200, {ok: true});
  }));

exports.getLineGroups = onRequest({region: REGION}, async (req, res) =>
  withAdminRequest(req, res, ["GET"], async () => {
    const db = getDatabase();
    const [groupsSnapshot, settingsSnapshot] = await Promise.all([
      db.ref("guildDraw/lineGroups").get(),
      db.ref("guildDraw/lineSettings").get(),
    ]);
    const groups = buildLineGroupAdminRows(
      groupsSnapshot.val() || {},
      settingsSnapshot.child("defaultGroupId").val(),
    );
    json(res, 200, {ok: true, groups});
  }));

exports.setDefaultLineGroup = onRequest({
  region: REGION,
  secrets: [LINE_CHANNEL_ACCESS_TOKEN],
  timeoutSeconds: 120,
}, async (req, res) =>
  withAdminRequest(req, res, ["POST"], async (adminUser) => {
    const requestedKey = req.body && typeof req.body.groupKey === "string" ?
      req.body.groupKey.trim() : "";
    const legacyGroupId = req.body && typeof req.body.groupId === "string" ?
      req.body.groupId.trim() : "";
    if (!requestedKey && !legacyGroupId) {
      json(res, 400, {ok: false, error: "請選擇 Bot 已知的 LINE 群組。"});
      return;
    }

    const db = getDatabase();
    const [groupsSnapshot, settingsSnapshot, membersSnapshot, bindingsSnapshot] = await Promise.all([
      db.ref("guildDraw/lineGroups").get(),
      db.ref("guildDraw/lineSettings").get(),
      db.ref("guildDraw/main/guildMembers").get(),
      db.ref("guildDraw/lineBindings").get(),
    ]);
    const knownGroups = Object.values(groupsSnapshot.val() || {});
    const selectedGroup = requestedKey ?
      knownGroups.find((group) => group && lineGroupKey(group.groupId) === requestedKey) :
      knownGroups.find((group) => group && group.groupId === legacyGroupId);
    const newGroupId = selectedGroup && selectedGroup.groupId;
    if (!selectedGroup || !/^C[A-Za-z0-9_-]{20,100}$/.test(newGroupId)) {
      json(res, 404, {ok: false, error: "找不到 Bot 已登記的 LINE 群組，請讓 Bot 重新加入該群。"});
      return;
    }

    const settings = settingsSnapshot.val() || {};
    const oldGroupId = settings.defaultGroupId || null;
    const bindings = bindingsSnapshot.val() || {};
    let migration = {updates: {}, migratedBindings: 0, skippedBindings: 0, conflicts: 0};
    if (oldGroupId && oldGroupId !== newGroupId) {
      const userIds = [...new Set(listBindingRecords(bindings)
        .filter((binding) => binding.lineGroupId === oldGroupId && binding.lineUserId)
        .map((binding) => binding.lineUserId))];
      const profiles = (await mapInBatches(userIds, 10, async (userId) => {
        const profile = await getGroupMemberProfile(
          newGroupId,
          userId,
          LINE_CHANNEL_ACCESS_TOKEN.value(),
        );
        return profile ? {
          userId: profile.userId || userId,
          displayName: profile.displayName || "",
        } : null;
      })).filter(Boolean);
      migration = buildLineBindingMigrationPlan({
        memberNames: membersSnapshot.val() || [],
        bindings,
        oldGroupId,
        newGroupId,
        profiles,
        now: new Date().toISOString(),
      });
    }

    const changedAt = ServerValue.TIMESTAMP;
    const updates = buildLineGroupSwitchUpdates({
      oldGroupId,
      newGroupId,
      firebaseUid: adminUser.uid,
      changedAt,
      migrationUpdates: migration.updates,
    });
    await db.ref("guildDraw").update(updates);
    json(res, 200, {
      ok: true,
      groupName: selectedGroup.groupName || "LINE 群組",
      migratedBindings: migration.migratedBindings,
      skippedBindings: migration.skippedBindings,
      conflicts: migration.conflicts,
    });
  }));

exports.setLineBotAdmin = onRequest({region: REGION}, async (req, res) =>
  withAdminRequest(req, res, ["POST"], async () => {
    const bindingId = req.body && typeof req.body.bindingId === "string" ? req.body.bindingId : "";
    const enabled = req.body && req.body.enabled;
    if (!/^p_[A-Za-z0-9_-]{20,100}$/.test(bindingId) || typeof enabled !== "boolean") {
      json(res, 400, {ok: false, error: "bindingId 或 enabled 格式不正確。"});
      return;
    }

    const db = getDatabase();
    const [bindingSnapshot, settingsSnapshot] = await Promise.all([
      db.ref(`guildDraw/lineBindings/${bindingId}`).get(),
      db.ref("guildDraw/lineSettings").get(),
    ]);
    if (!bindingSnapshot.exists()) {
      json(res, 404, {ok: false, error: "找不到這筆 LINE 綁定。"});
      return;
    }
    const binding = bindingSnapshot.val();
    const settings = settingsSnapshot.val() || {};
    const change = planLineBotAdminChange({
      binding,
      defaultGroupId: settings.defaultGroupId,
      enabled,
    });
    if (change.status !== "success") {
      json(res, 409, {ok: false, error: "只能設定目前正式群組中已綁定的 LINE 使用者。"});
      return;
    }

    await db.ref("guildDraw/lineSettings").update({
      [`adminLineUserIds/${change.lineUserId}`]: change.value,
      updatedAt: ServerValue.TIMESTAMP,
    });
    json(res, 200, {ok: true, enabled});
  }));
