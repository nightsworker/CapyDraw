"use strict";

const {onRequest} = require("firebase-functions/v2/https");
const {defineSecret, defineString} = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const {initializeApp} = require("firebase-admin/app");
const {getAuth} = require("firebase-admin/auth");
const {getDatabase, ServerValue} = require("firebase-admin/database");
const {assertAdminUid} = require("./lib/admin");
const {
  bindingKey,
  buildBindingListText,
  buildBotHelpText,
  buildDrawLineMessage,
  buildMemberBindingRows,
  buildUnboundListText,
  claimDefaultLineGroup,
  createBindingRecord,
  decideLineGroupAction,
  findMembersByLineName,
  listBindingRecords,
  maskLineUserId,
  planWebhookEvent,
  resolveBindingLineName,
  splitTextMessages,
  verifyLineSignature,
} = require("./lib/line");
const {
  buildMemberSyncPlan,
  buildObservedMemberRecord,
  buildSyncReply,
  decideLineSyncAccess,
  fetchAllGroupMemberIds,
  isFirebaseSafeKey,
  mapInBatches,
  resolveSyncMemberSource,
} = require("./lib/line-sync");

initializeApp();

const REGION = "asia-southeast1";
const LINE_API_BASE = "https://api.line.me/v2/bot";
const LINE_CHANNEL_ACCESS_TOKEN = defineSecret("LINE_CHANNEL_ACCESS_TOKEN");
const LINE_CHANNEL_SECRET = defineSecret("LINE_CHANNEL_SECRET");
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

async function replyTexts(replyToken, texts, token) {
  const messages = (Array.isArray(texts) ? texts : [texts])
    .filter((text) => String(text || "").trim())
    .slice(0, 5)
    .map((text) => ({type: "text", text: String(text)}));
  if (!replyToken || !messages.length) return;
  await callLine("/message/reply", token, {
    replyToken,
    messages,
  });
}

async function replyText(replyToken, text, token) {
  await replyTexts(replyToken, [text], token);
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

async function handleSyncCommand({event, token, db, settings, bindings, bindingsRef, members}) {
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
    await replyText(event.replyToken, message, token);
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
    await replyText(event.replyToken, buildSyncReply(result, source.mode), token);
  } catch (error) {
    logger.warn("LINE member sync failed", {groupId, status: error.lineStatus, message: error.message});
    await replyText(event.replyToken, syncErrorMessage(error), token);
  }
}

async function handleBindingCommand(event, command, token, observedProfile) {
  const db = getDatabase();
  const userId = event.source.userId;
  const groupId = event.source.groupId;
  if (!userId) {
    await replyText(event.replyToken, "❌ LINE 無法取得你的 userId，無法完成綁定。", token);
    return;
  }
  const settingsRef = db.ref("guildDraw/lineSettings");
  const defaultGroupRef = settingsRef.child("defaultGroupId");
  const settings = (await settingsRef.get()).val() || {};
  const defaultGroupId = settings.defaultGroupId;
  const groupAction = decideLineGroupAction(defaultGroupId, groupId, command.command);
  if (groupAction.action === "reject-other-group") {
    await replyText(event.replyToken, "❌ 此 Bot 已綁定其他公會群組，請由管理員處理群組設定。", token);
    return;
  }
  if (groupAction.action === "reject-unconfigured") {
    await replyText(event.replyToken, "ℹ️ 尚未設定正式公會群組，請先在正式群組完成玩家綁定。", token);
    return;
  }
  if (!groupAction.canProcess) return;

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
      await replyText(event.replyToken, "ℹ️ 你目前尚未綁定玩家。", token);
      return;
    }
    const lineNames = [...new Set(ownRows.map((row) => row.lineName))];
    const gameIds = [...new Set(ownRows.map((row) => row.gameId))];
    await replyText(event.replyToken, [
      "✅ 你的 LINE 綁定",
      "",
      `LINE：${lineNames.join("、")}`,
      "遊戲 ID：",
      ...gameIds.map((gameId) => `• ${gameId}`),
    ].join("\n"), token);
    return;
  }

  if (command.command === "unbind") {
    if (!ownBindings.length) {
      await replyText(event.replyToken, "ℹ️ 你目前沒有可解除的綁定。", token);
      return;
    }
    const updates = {};
    ownBindings.forEach((binding) => { updates[binding.id] = null; });
    await bindingsRef.update(updates);
    await replyText(event.replyToken, `✅ 已解除 LINE 綁定\n共解除 ${ownBindings.length} 個遊戲帳號。`, token);
    return;
  }

  const members = (await db.ref("guildDraw/main/guildMembers").get()).val() || [];
  if (command.command === "binding-list") {
    const text = buildBindingListText(members, bindings, groupId);
    await replyTexts(event.replyToken, splitTextMessages(text), token);
    return;
  }

  if (command.command === "unbound-list") {
    const text = buildUnboundListText(members, bindings, groupId);
    await replyTexts(event.replyToken, splitTextMessages(text), token);
    return;
  }

  if (command.command === "sync") {
    await handleSyncCommand({event, token, db, settings, bindings, bindingsRef, members});
    return;
  }

  let profile = observedProfile || null;
  if (command.auto) {
    if (!profile) profile = await getGroupMemberProfile(groupId, userId, token);
    if (!profile || !profile.displayName) {
      await replyText(event.replyToken, "❌ 無法取得你的 LINE 顯示名稱，請改用：\n!綁定 <LINE名稱>", token);
      return;
    }
  }
  const requestedLineName = resolveBindingLineName(command, profile && profile.displayName);
  const matches = findMembersByLineName(members, requestedLineName);
  if (!matches.length) {
    await replyText(event.replyToken, command.auto ?
      `❌ 找不到與你的 LINE 名稱「${requestedLineName}」對應的玩家。\n請改用：\n!綁定 <LINE名稱>` :
      `❌ 找不到 LINE 名稱「${requestedLineName}」對應的玩家，請確認名稱。`, token);
    return;
  }

  const canonicalLineName = matches[0].lineName;
  const otherOwnLineNames = [...new Set(ownBindings
    .filter((binding) => binding.lineName !== canonicalLineName)
    .map((binding) => binding.lineName))];
  if (otherOwnLineNames.length) {
    await replyText(event.replyToken, [
      "ℹ️ 你的 LINE 帳號目前已綁定其他 LINE 名稱：",
      ...otherOwnLineNames.map((lineName) => `- ${lineName}`),
      "如需更換，請先輸入「!解除」。",
    ].join("\n"), token);
    return;
  }
  const conflictingBindings = bindingEntries.filter((binding) =>
    binding.lineGroupId === groupId &&
    binding.lineName === canonicalLineName &&
    binding.lineUserId !== userId);
  if (conflictingBindings.length) {
    await replyText(event.replyToken, `❌ LINE 名稱「${requestedLineName}」已由其他 LINE 帳號綁定。`, token);
    return;
  }

  if (!profile) profile = await getGroupMemberProfile(groupId, userId, token);
  const now = new Date().toISOString();
  if (groupAction.canClaim) {
    const claimResult = await defaultGroupRef.transaction((current) =>
      claimDefaultLineGroup(current, groupId));
    if (claimResult.snapshot.val() !== groupId) {
      await replyText(event.replyToken, "❌ 此 Bot 已綁定其他公會群組，請由管理員處理群組設定。", token);
      return;
    }
    await settingsRef.child("updatedAt").set(ServerValue.TIMESTAMP);
  }

  const updates = {};
  matches.forEach((member) => {
    const key = bindingKey(member.fullName);
    const existing = bindingEntries.find((binding) =>
      binding.id === key && binding.lineUserId === userId && binding.lineGroupId === groupId);
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
  await replyText(event.replyToken, [
    "✅ LINE 綁定完成",
    "",
    canonicalLineName,
    ...matches.map((member) => `→ ${member.gameId}`),
  ].join("\n"), token);
}

exports.lineWebhook = onRequest({
  region: REGION,
  secrets: [LINE_CHANNEL_SECRET, LINE_CHANNEL_ACCESS_TOKEN],
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
      const eventPlan = planWebhookEvent(event);
      let profile = null;
      if (eventPlan.observeMember) {
        profile = await getGroupMemberProfile(
          event.source.groupId,
          event.source.userId,
          LINE_CHANNEL_ACCESS_TOKEN.value(),
        );
        if (profile) await rememberObservedMember(event, profile);
      }
      if (!eventPlan.command) return;
      if (eventPlan.command.command === "help") {
        await replyText(event.replyToken, buildBotHelpText(), LINE_CHANNEL_ACCESS_TOKEN.value());
        return;
      }
      if (eventPlan.command.command === "unknown") {
        await replyText(event.replyToken, [
          `找不到指令「${eventPlan.command.input}」`,
          "輸入 !說明 查看可用指令。",
        ].join("\n"), LINE_CHANNEL_ACCESS_TOKEN.value());
        return;
      }
      await handleBindingCommand(
        event,
        eventPlan.command,
        LINE_CHANNEL_ACCESS_TOKEN.value(),
        profile,
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

exports.getLineBindings = onRequest({region: REGION}, async (req, res) =>
  withAdminRequest(req, res, ["GET"], async () => {
    const db = getDatabase();
    const [membersSnapshot, bindingsSnapshot, settingsSnapshot] = await Promise.all([
      db.ref("guildDraw/main/guildMembers").get(),
      db.ref("guildDraw/lineBindings").get(),
      db.ref("guildDraw/lineSettings/defaultGroupId").get(),
    ]);
    const groupId = settingsSnapshot.val();
    const members = buildMemberBindingRows(
      membersSnapshot.val() || [],
      bindingsSnapshot.val() || {},
      groupId,
    ).map((member) => ({
      playerName: member.playerName,
      lineName: member.lineName,
      gameId: member.gameId,
      bound: member.bound,
      bindingId: member.bindingId,
      lineDisplayName: member.lineDisplayName,
      maskedLineUserId: maskLineUserId(member.lineUserId),
    }));
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

exports.setDefaultLineGroup = onRequest({region: REGION}, async (req, res) =>
  withAdminRequest(req, res, ["POST"], async () => {
    const groupId = req.body && typeof req.body.groupId === "string" ? req.body.groupId.trim() : "";
    if (!/^C[A-Za-z0-9_-]{20,100}$/.test(groupId)) {
      json(res, 400, {ok: false, error: "groupId 格式不正確。"});
      return;
    }
    await getDatabase().ref("guildDraw/lineSettings").update({
      defaultGroupId: groupId,
      updatedAt: ServerValue.TIMESTAMP,
    });
    json(res, 200, {ok: true, hasDefaultGroup: true});
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
    if (!binding.lineUserId || !isFirebaseSafeKey(binding.lineUserId) ||
        (enabled && binding.lineGroupId !== settings.defaultGroupId)) {
      json(res, 409, {ok: false, error: "只能設定目前正式群組中已綁定的 LINE 使用者。"});
      return;
    }

    await db.ref("guildDraw/lineSettings").update({
      [`adminLineUserIds/${binding.lineUserId}`]: enabled ? true : null,
      updatedAt: ServerValue.TIMESTAMP,
    });
    json(res, 200, {ok: true, enabled});
  }));
