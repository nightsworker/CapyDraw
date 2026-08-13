"use strict";

const OpenAI = require("openai");
const {buildMiaobingInstructions, pickMood} = require("./miaobingPersona");
const {isBotMentioned} = require("./miaobing-personality");

const AI_MODEL = "gpt-5-mini";
const AI_MAX_OUTPUT_TOKENS = 220;
const AI_FALLBACK_TEXT = "喵餅剛剛腦袋斷線了，等等再叫我。";
const AI_COOLDOWN_TEXT = "慢點，喵餅只有一顆腦。";
const AI_MINUTE_LIMIT_TEXT = "先讓本喵喘口氣，船務處一分鐘只接五張單。";
const AI_DAILY_LIMIT_TEXT = "喵餅今天腦容量用完了，船務處暫停營業。";

function createOpenAiClient(apiKey) {
  return new OpenAI({apiKey, timeout: 12000, maxRetries: 0});
}

function normalizeAiText(value) {
  const text = String(value || "").trim();
  return text ? text.slice(0, 1200) : AI_FALLBACK_TEXT;
}

function normalizeAiQuestion(value) {
  const question = String(value || "").trim();
  return (question || "有人叫你，請簡短回應。").slice(0, 1000);
}

function stripMiaobingCallPrefix(text) {
  const input = String(text || "");
  const match = input.match(/^\s*@?喵餅(?:[\s，,：:、。！？!?]*)/u);
  return match ? input.slice(match[0].length).trim() : input.trim();
}

function planMiaobingAiTrigger({event, command, botUserId} = {}) {
  if (command || String(event && event.message && event.message.text || "").trim().startsWith("!")) {
    return {shouldCallAi: false, reason: "command"};
  }
  if (!event || event.type !== "message" || !event.message || event.message.type !== "text" ||
      !event.source || event.source.type !== "group" || !event.source.groupId) {
    return {shouldCallAi: false, reason: "unsupported-event"};
  }
  const text = String(event.message.text || "");
  const trueMention = isBotMentioned(event.message, {botUserId});
  const directName = /^\s*@?喵餅(?:[\s，,：:、。！？!?]|$)/u.test(text) || /^\s*@?喵餅\S/u.test(text);
  if (!trueMention && !directName) return {shouldCallAi: false, reason: "not-addressed"};
  return {
    shouldCallAi: true,
    reason: trueMention ? "true-mention" : "direct-name",
    question: stripMiaobingCallPrefix(text) || "有人叫你，請簡短回應。",
  };
}

function planMiaobingPrivateAiTrigger({event, isAdmin = false} = {}) {
  if (!event || event.type !== "message" || !event.message || event.message.type !== "text" ||
      !event.source || event.source.type !== "user" || !event.source.userId) {
    return {shouldCallAi: false, reason: "unsupported-event"};
  }
  if (!isAdmin) return {shouldCallAi: false, reason: "not-admin"};
  const text = String(event.message.text || "").trim();
  if (!text) return {shouldCallAi: false, reason: "unsupported-event"};
  return {
    shouldCallAi: true,
    reason: "private-admin",
    question: stripMiaobingCallPrefix(text) || "有人叫你，請簡短回應。",
  };
}

async function generateMiaobingAiReply({apiKey, question, rng = Math.random, client} = {}) {
  if (!String(apiKey || "").trim()) {
    const error = new Error("OpenAI API key is unavailable.");
    error.code = "missing_openai_api_key";
    throw error;
  }
  const mood = pickMood(rng);
  const safeQuestion = normalizeAiQuestion(question);
  const openai = client || createOpenAiClient(apiKey);
  const response = await openai.responses.create({
    model: AI_MODEL,
    instructions: buildMiaobingInstructions({question: safeQuestion, mood}),
    input: safeQuestion,
    max_output_tokens: AI_MAX_OUTPUT_TOKENS,
    store: false,
  });
  return {text: normalizeAiText(response.output_text), mood};
}

function safeOpenAiErrorMeta(error) {
  const status = Number(error && error.status);
  return {
    status: Number.isFinite(status) ? status : null,
    type: String(error && (error.code || error.name) || "unknown_error").slice(0, 80),
  };
}

async function processMiaobingAiRequest({apiKey, question, reserveUsage, generateReply} = {}) {
  if (!String(apiKey || "").trim()) {
    return {text: AI_FALLBACK_TEXT, calledOpenAI: false, reason: "missing-api-key"};
  }
  let calledOpenAI = false;
  try {
    const usage = await reserveUsage();
    if (!usage.allowed) {
      const texts = {
        cooldown: AI_COOLDOWN_TEXT,
        "minute-limit": AI_MINUTE_LIMIT_TEXT,
        "daily-limit": AI_DAILY_LIMIT_TEXT,
      };
      return {
        text: texts[usage.reason] || AI_FALLBACK_TEXT,
        calledOpenAI: false,
        reason: usage.reason || "rate-limit-error",
      };
    }
    calledOpenAI = true;
    const result = await generateReply({apiKey, question});
    return {text: normalizeAiText(result && result.text), calledOpenAI: true, reason: "success"};
  } catch (error) {
    return {
      text: AI_FALLBACK_TEXT,
      calledOpenAI,
      reason: "openai-error",
      errorMeta: safeOpenAiErrorMeta(error),
    };
  }
}

module.exports = {
  AI_COOLDOWN_TEXT,
  AI_DAILY_LIMIT_TEXT,
  AI_FALLBACK_TEXT,
  AI_MAX_OUTPUT_TOKENS,
  AI_MINUTE_LIMIT_TEXT,
  AI_MODEL,
  generateMiaobingAiReply,
  normalizeAiQuestion,
  normalizeAiText,
  planMiaobingAiTrigger,
  planMiaobingPrivateAiTrigger,
  processMiaobingAiRequest,
  safeOpenAiErrorMeta,
};
