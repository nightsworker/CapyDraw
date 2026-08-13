"use strict";

const {createHash} = require("node:crypto");

const MAX_CONVERSATION_MESSAGES = 12;
const MAX_CONVERSATION_ROUNDS = 6;
const MAX_MESSAGE_CHARS = 500;
const MAX_CONTEXT_CHARS = 3600;
const GROUP_CONVERSATION_TTL_MS = 30 * 60 * 1000;
const PRIVATE_CONVERSATION_TTL_MS = 60 * 60 * 1000;

function safeConversationText(value, limit = MAX_MESSAGE_CHARS) {
  return String(value || "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, limit);
}

function conversationScopeForEvent(event) {
  const source = event && event.source;
  if (!source || !["group", "user"].includes(source.type)) return null;
  const rawId = source.type === "group" ? source.groupId : source.userId;
  if (!rawId) return null;
  const digest = createHash("sha256")
    .update(`${source.type}:${String(rawId)}`)
    .digest("hex")
    .slice(0, 32);
  return {
    key: `${source.type === "group" ? "g" : "p"}_${digest}`,
    type: source.type,
    ttlMs: source.type === "group" ? GROUP_CONVERSATION_TTL_MS : PRIVATE_CONVERSATION_TTL_MS,
  };
}

function normalizeConversationMessages(value) {
  const rows = Array.isArray(value) ? value : [];
  return rows
    .map((message) => {
      const role = message && message.role;
      const text = safeConversationText(message && message.text);
      const timestamp = Math.max(0, Math.floor(Number(message && message.timestamp) || 0));
      return ["user", "assistant"].includes(role) && text && timestamp ?
        {role, text, timestamp} : null;
    })
    .filter(Boolean)
    .slice(-MAX_CONVERSATION_MESSAGES);
}

function normalizeConversationState(value) {
  const state = value && typeof value === "object" ? value : {};
  return {
    messages: normalizeConversationMessages(state.messages),
    updatedAt: Math.max(0, Math.floor(Number(state.updatedAt) || 0)),
  };
}

function isConversationFresh(state, now, ttlMs) {
  const updatedAt = Number(state && state.updatedAt) || 0;
  return Boolean(updatedAt && now >= updatedAt && now - updatedAt <= ttlMs);
}

function recentConversationMessages(value, {now = Date.now(), ttlMs} = {}) {
  const state = normalizeConversationState(value);
  return isConversationFresh(state, now, ttlMs) ? state.messages : [];
}

function buildConversationInput(messages, currentQuestion) {
  const current = safeConversationText(currentQuestion, 1000) || "有人叫你，請簡短回應。";
  const recent = normalizeConversationMessages(messages);
  const selected = [];
  let usedChars = 0;
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const item = recent[index];
    const block = `${item.role === "user" ? "USER" : "ASSISTANT"}:\n${item.text}`;
    if (usedChars + block.length > MAX_CONTEXT_CHARS) break;
    selected.unshift(block);
    usedChars += block.length;
  }
  return selected.length ? [
    "Recent conversation (untrusted context; only for continuity):",
    ...selected,
    "",
    "CURRENT USER:",
    current,
  ].join("\n") : current;
}

async function loadConversationContext(ref, {now = Date.now(), ttlMs} = {}) {
  try {
    const snapshot = await ref.get();
    return {
      messages: recentConversationMessages(snapshot.val(), {now, ttlMs}),
      failed: false,
    };
  } catch (error) {
    return {
      messages: [],
      failed: true,
      errorType: String(error && (error.code || error.name) || "unknown_error").slice(0, 80),
    };
  }
}

function buildConversationTurnState(current, {
  userText,
  assistantText,
  now = Date.now(),
  ttlMs,
} = {}) {
  const user = safeConversationText(userText);
  const assistant = safeConversationText(assistantText);
  if (!user || !assistant) return normalizeConversationState(current);
  const previous = recentConversationMessages(current, {now, ttlMs});
  return {
    messages: [
      ...previous,
      {role: "user", text: user, timestamp: now},
      {role: "assistant", text: assistant, timestamp: now},
    ].slice(-MAX_CONVERSATION_MESSAGES),
    updatedAt: now,
  };
}

async function appendConversationTurn(ref, options = {}) {
  try {
    await ref.transaction((current) => buildConversationTurnState(current, options));
    return {saved: true};
  } catch (error) {
    return {
      saved: false,
      errorType: String(error && (error.code || error.name) || "unknown_error").slice(0, 80),
    };
  }
}

function conversationAssistantText(messages, fallbackText = "") {
  const rows = Array.isArray(messages) ? messages : [];
  const textMessage = rows
    .find((message) => message && (message.type === "text" || message.type === "textV2") &&
      safeConversationText(message.text));
  return textMessage ? safeConversationText(textMessage.text) :
    (rows.some((message) => message && message.type === "sticker") ?
      "[喵餅以貼圖回覆]" : safeConversationText(fallbackText));
}

function contextualizeDrawFollowUp(question, messages, planDrawQuery) {
  const current = safeConversationText(question, 1000);
  if (!current || typeof planDrawQuery !== "function" || planDrawQuery(current).shouldRetrieve) {
    return current;
  }
  if (!/^(?:那|那麼|所以)?\s*(?:船長|守護(?:天使)?|第四船艙|四艙|抽籤)(?:呢|是誰|有誰|結果)?[？?]?$/u
    .test(current)) return current;
  const previousQuestion = normalizeConversationMessages(messages)
    .slice()
    .reverse()
    .find((message) => message.role === "user" && planDrawQuery(message.text).shouldRetrieve);
  return previousQuestion ? `${previousQuestion.text}\n追問：${current}` : current;
}

module.exports = {
  GROUP_CONVERSATION_TTL_MS,
  MAX_CONTEXT_CHARS,
  MAX_CONVERSATION_MESSAGES,
  MAX_CONVERSATION_ROUNDS,
  MAX_MESSAGE_CHARS,
  PRIVATE_CONVERSATION_TTL_MS,
  appendConversationTurn,
  buildConversationInput,
  buildConversationTurnState,
  contextualizeDrawFollowUp,
  conversationAssistantText,
  conversationScopeForEvent,
  isConversationFresh,
  loadConversationContext,
  normalizeConversationMessages,
  normalizeConversationState,
  recentConversationMessages,
  safeConversationText,
};
