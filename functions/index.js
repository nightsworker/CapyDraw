"use strict";

const {onRequest} = require("firebase-functions/v2/https");
const {defineSecret, defineString} = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const {initializeApp} = require("firebase-admin/app");
const {getAuth} = require("firebase-admin/auth");
const {getDatabase, ServerValue} = require("firebase-admin/database");
const {assertAdminUid} = require("./lib/admin");
const {
  buildAdminBindingSuccessText,
  buildAdminUnbindSuccessText,
  bindingKey,
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

async function handleHelpCommand(event, token) {
  const settings = (await getDatabase().ref("guildDraw/lineSettings").get()).val() || {};
  await replyText(event.replyToken, buildBotHelpText({
    bindingLocked: isBindingLocked(settings.bindingLocked),
    isAdmin: isLineBotAdmin(settings.adminLineUserIds, event.source.userId),
  }), token);
}

async function handleBindingLockCommand({event, command, settings, settingsRef, token}) {
  const requestedLocked = command.command === "lock";
  const transition = getBindingLockTransition(settings.bindingLocked, requestedLocked);
  if (!transition.changed) {
    await replyText(event.replyToken, requestedLocked ?
      "🔒 LINE 綁定目前已經是鎖定狀態。" :
      "🔓 LINE 綁定目前沒有鎖定。", token);
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
  await replyText(event.replyToken, requestedLocked ? [
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
  ].join("\n"), token);
}

async function handleAdminBindCommand({event, command, token, db, members, bindings, bindingsRef}) {
  const lineName = String(command.args || "").trim();
  if (!lineName) {
    await replyText(event.replyToken, "請輸入：\n!幫綁 <LINE名稱>", token);
    return;
  }
  const groupId = event.source.groupId;
  const observedSnapshot = await db.ref(`guildDraw/lineObservedMembers/${groupId}`).get();
  const plan = planAdminBinding({
    memberNames: members,
    bindings,
    observedMembers: observedSnapshot.val() || {},
    lineName,
    groupId,
    now: new Date().toISOString(),
  });
  if (plan.status === "guild-member-not-found") {
    await replyText(event.replyToken, `❌ 找不到 LINE 名稱「${lineName}」對應的公會成員。`, token);
    return;
  }
  if (plan.status === "line-identity-not-found") {
    await replyText(event.replyToken, [
      `⚠️ 找得到公會成員「${lineName}」，`,
      "但目前還無法取得他的 LINE 身份。",
      "",
      `請讓 ${lineName} 在這個群組發任意一則訊息，`,
      "再重新執行：",
      "",
      `!幫綁 ${lineName}`,
    ].join("\n"), token);
    return;
  }
  if (plan.status === "ambiguous-line-identity") {
    await replyText(event.replyToken, [
      `⚠️ 找到多個 LINE 使用者名稱皆為「${lineName}」`,
      "",
      "為避免綁錯帳號，本次沒有進行綁定。",
      "",
      "請讓本人使用：",
      "",
      "!綁定",
      "",
      "或使用其他安全方式確認身份。",
    ].join("\n"), token);
    return;
  }
  if (plan.status === "binding-conflict") {
    await replyText(event.replyToken, [
      "⚠️ 綁定衝突",
      "",
      `「${lineName}」目前已有其他 LINE 綁定。`,
      "為避免綁錯，本次沒有修改。",
      "",
      "請先確認後使用管理員解除功能。",
    ].join("\n"), token);
    return;
  }

  if (Object.keys(plan.updates).length) await bindingsRef.update(plan.updates);
  await replyText(event.replyToken, buildAdminBindingSuccessText(plan.members), token);
}

async function handleAdminUnbindCommand({event, command, token, members, bindings, bindingsRef}) {
  const lineName = String(command.args || "").trim();
  if (!lineName) {
    await replyText(event.replyToken, "請輸入：\n!幫解除 <LINE名稱>", token);
    return;
  }
  const selected = selectAdminUnbindBindings({
    memberNames: members,
    bindings,
    lineName,
    groupId: event.source.groupId,
  });
  if (selected.status === "guild-member-not-found") {
    await replyText(event.replyToken, `❌ 找不到 LINE 名稱「${lineName}」對應的公會成員。`, token);
    return;
  }
  if (selected.status === "binding-not-found") {
    await replyText(event.replyToken, `ℹ️ LINE 名稱「${lineName}」目前沒有可解除的綁定。`, token);
    return;
  }
  const updates = {};
  selected.bindings.forEach((binding) => { updates[binding.id] = null; });
  await bindingsRef.update(updates);
  await replyText(event.replyToken, buildAdminUnbindSuccessText(selected.bindings), token);
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
      await replyText(event.replyToken, [
        "🔒 LINE 綁定目前已鎖定",
        "",
        "目前無法自行修改綁定。",
        "如需處理，請聯絡管理員。",
      ].join("\n"), token);
    } else if (commandAccess.reason === "other-group") {
      await replyText(event.replyToken, "❌ 此管理指令只能在目前正式 LINE 群組使用。", token);
    } else {
      await replyText(event.replyToken, "❌ 你沒有執行此 LINE 管理指令的權限。", token);
    }
    return;
  }
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

  if (command.command === "lock" || command.command === "unlock") {
    await handleBindingLockCommand({event, command, settings, settingsRef, token});
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
    await replyText(event.replyToken, buildUnbindSuccessText(ownBindings), token);
    return;
  }

  const members = (await db.ref("guildDraw/main/guildMembers").get()).val() || [];
  if (command.command === "binding-list") {
    const text = buildBindingListText(members, bindings, groupId, isBindingLocked(settings.bindingLocked));
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

  if (command.command === "admin-bind") {
    await handleAdminBindCommand({event, command, token, db, members, bindings, bindingsRef});
    return;
  }

  if (command.command === "admin-unbind") {
    await handleAdminUnbindCommand({event, command, token, members, bindings, bindingsRef});
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
  await replyText(event.replyToken, buildBindingSuccessText(matches), token);
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
        await handleHelpCommand(event, LINE_CHANNEL_ACCESS_TOKEN.value());
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
