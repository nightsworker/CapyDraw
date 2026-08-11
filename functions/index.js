"use strict";

const {onRequest} = require("firebase-functions/v2/https");
const {defineSecret, defineString} = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const {initializeApp} = require("firebase-admin/app");
const {getAuth} = require("firebase-admin/auth");
const {getDatabase, ServerValue} = require("firebase-admin/database");
const {
  bindingKey,
  buildBindingListText,
  buildDrawLineMessage,
  buildMemberBindingRows,
  buildUnboundListText,
  claimDefaultLineGroup,
  createBindingRecord,
  decideLineGroupAction,
  extractBindingCommand,
  findMembersByLineName,
  isGroupMessageEvent,
  listBindingRecords,
  maskLineUserId,
  resolveBindingLineName,
  splitTextMessages,
  verifyLineSignature,
} = require("./lib/line");

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
  const admins = new Set(ADMIN_UID.value().split(",").map((item) => item.trim()).filter(Boolean));
  if (!admins.size || !admins.has(decoded.uid)) {
    throw Object.assign(new Error("此 Firebase 帳號沒有 LINE 管理權限。"), {status: 403});
  }
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
    throw new Error(`LINE Messaging API 回傳 ${response.status}。`);
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

async function getGroupMemberProfile(groupId, userId, token) {
  try {
    return await callLine(
      `/group/${encodeURIComponent(groupId)}/member/${encodeURIComponent(userId)}`,
      token,
      null,
      "GET",
    );
  } catch (error) {
    logger.warn("Could not load LINE group member profile", {groupId, userId, message: error.message});
    return null;
  }
}

async function handleBindingCommand(event, command, token) {
  const db = getDatabase();
  const userId = event.source.userId;
  const groupId = event.source.groupId;
  if (!userId) {
    await replyText(event.replyToken, "❌ LINE 無法取得你的 userId，無法完成綁定。", token);
    return;
  }
  const settingsRef = db.ref("guildDraw/lineSettings");
  const defaultGroupRef = settingsRef.child("defaultGroupId");
  const defaultGroupId = (await defaultGroupRef.get()).val();
  const groupAction = decideLineGroupAction(defaultGroupId, groupId, command.type);
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

  if (command.type === "status") {
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
      ...gameIds.map((gameId) => `- ${gameId}`),
    ].join("\n"), token);
    return;
  }

  if (command.type === "unbind") {
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
  if (command.type === "binding-list") {
    const text = buildBindingListText(members, bindings, groupId);
    await replyTexts(event.replyToken, splitTextMessages(text), token);
    return;
  }

  if (command.type === "unbound-list") {
    const text = buildUnboundListText(members, bindings, groupId);
    await replyTexts(event.replyToken, splitTextMessages(text), token);
    return;
  }

  let profile = null;
  if (command.auto) {
    profile = await getGroupMemberProfile(groupId, userId, token);
    if (!profile || !profile.displayName) {
      await replyText(event.replyToken, "❌ 無法取得你的 LINE 顯示名稱，請改用：\n綁定 <LINE名稱>", token);
      return;
    }
  }
  const requestedLineName = resolveBindingLineName(command, profile && profile.displayName);
  const matches = findMembersByLineName(members, requestedLineName);
  if (!matches.length) {
    await replyText(event.replyToken, command.auto ?
      `❌ 找不到與你的 LINE 名稱「${requestedLineName}」對應的玩家。\n請改用：\n綁定 <LINE名稱>` :
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
      "如需更換，請先輸入「解除綁定」。",
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
      if (!isGroupMessageEvent(event)) return;
      const command = extractBindingCommand(event.message.text);
      if (command) await handleBindingCommand(event, command, LINE_CHANNEL_ACCESS_TOKEN.value());
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
