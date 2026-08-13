"use strict";

const OpenAI = require("openai");
const {buildMiaobingInstructions, pickMood} = require("./miaobingPersona");
const {isBotMentioned} = require("./miaobing-personality");
const {buildConversationInput} = require("./miaobingConversation");
const {applyMiaobingStyleGuard} = require("./miaobingStyle");

const AI_MODEL = "gpt-5-mini";
const AI_MAX_OUTPUT_TOKENS = 600;
const AI_REASONING_EFFORT = "minimal";
const AI_GENERATION_TIMEOUT_MS = 18000;
const AI_FALLBACK_TEXT = "喵餅剛剛腦袋斷線了，等等再叫我。";
const AI_COOLDOWN_TEXT = "慢點，喵餅只有一顆腦。";
const AI_MINUTE_LIMIT_TEXT = "先讓本喵喘口氣，船務處一分鐘只接五張單。";
const AI_DAILY_LIMIT_TEXT = "喵餅今天腦容量用完了，船務處暫停營業。";

function createOpenAiClient(apiKey) {
  return new OpenAI({apiKey, timeout: 12000, maxRetries: 0});
}

function normalizeGeneratedAiText(value) {
  const text = String(value || "").trim();
  return text.slice(0, 1200);
}

function normalizeAiText(value) {
  return normalizeGeneratedAiText(value) || AI_FALLBACK_TEXT;
}

function safeMetadataText(value) {
  const text = String(value || "").trim();
  return text ? text.slice(0, 80) : null;
}

function safeTokenCount(value) {
  if (value === null || value === undefined || value === "") return null;
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? Math.floor(count) : null;
}

function normalizeOpenAiResponseMeta(value) {
  const meta = value && typeof value === "object" ? value : {};
  return {
    status: safeMetadataText(meta.status),
    incompleteReason: safeMetadataText(meta.incompleteReason),
    outputTokens: safeTokenCount(meta.outputTokens),
    reasoningTokens: safeTokenCount(meta.reasoningTokens),
  };
}

function safeOpenAiResponseMeta(response) {
  const usage = response && response.usage;
  return normalizeOpenAiResponseMeta({
    status: response && response.status,
    incompleteReason: response && response.incomplete_details &&
      response.incomplete_details.reason,
    outputTokens: usage && usage.output_tokens,
    reasoningTokens: usage && usage.output_tokens_details &&
      usage.output_tokens_details.reasoning_tokens,
  });
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

async function generateMiaobingAiReply({
  apiKey,
  question,
  authoritativeContext = "",
  memoryContext = "",
  conversationMessages = [],
  rng = Math.random,
  client,
} = {}) {
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
    instructions: buildMiaobingInstructions({
      question: safeQuestion,
      mood,
      authoritativeContext,
      memoryContext,
    }),
    input: buildConversationInput(conversationMessages, safeQuestion),
    max_output_tokens: AI_MAX_OUTPUT_TOKENS,
    reasoning: {effort: AI_REASONING_EFFORT},
    store: false,
  });
  const guarded = applyMiaobingStyleGuard(normalizeGeneratedAiText(response.output_text));
  return {
    text: normalizeGeneratedAiText(guarded.text),
    mood,
    responseMeta: safeOpenAiResponseMeta(response),
    styleMeta: {profanitySanitized: guarded.sanitized},
  };
}

function safeOpenAiErrorMeta(error) {
  const status = Number(error && error.status);
  return {
    status: Number.isFinite(status) ? status : null,
    type: String(error && (error.code || error.name) || "unknown_error").slice(0, 80),
  };
}

async function processMiaobingAiRequest({
  apiKey,
  question,
  reserveUsage,
  generateReply,
  generationTimeoutMs = AI_GENERATION_TIMEOUT_MS,
} = {}) {
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
    const timeoutMs = Math.max(1, Number(generationTimeoutMs) || AI_GENERATION_TIMEOUT_MS);
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error("Miaobing AI generation timed out.");
        error.code = "ai_generation_timeout";
        reject(error);
      }, timeoutMs);
    });
    const result = await Promise.race([
      Promise.resolve(generateReply({apiKey, question})),
      timeout,
    ]).finally(() => clearTimeout(timer));
    const text = normalizeGeneratedAiText(result && result.text);
    if (!text) {
      const responseMeta = normalizeOpenAiResponseMeta(result && result.responseMeta);
      return {
        text: AI_FALLBACK_TEXT,
        calledOpenAI: true,
        reason: responseMeta.status === "incomplete" || responseMeta.incompleteReason ?
          "incomplete-output" : "empty-output",
        responseMeta,
      };
    }
    const mood = String(result && result.mood || "").trim().slice(0, 80);
    return {
      text,
      calledOpenAI: true,
      reason: "success",
      ...(mood ? {mood} : {}),
      ...(result && result.styleMeta && result.styleMeta.profanitySanitized ?
        {styleSanitized: true} : {}),
    };
  } catch (error) {
    const errorMeta = safeOpenAiErrorMeta(error);
    return {
      text: AI_FALLBACK_TEXT,
      calledOpenAI,
      reason: errorMeta.type === "ai_generation_timeout" ? "ai-timeout" : "openai-error",
      errorMeta,
    };
  }
}

module.exports = {
  AI_COOLDOWN_TEXT,
  AI_DAILY_LIMIT_TEXT,
  AI_FALLBACK_TEXT,
  AI_GENERATION_TIMEOUT_MS,
  AI_MAX_OUTPUT_TOKENS,
  AI_MINUTE_LIMIT_TEXT,
  AI_MODEL,
  AI_REASONING_EFFORT,
  generateMiaobingAiReply,
  normalizeAiQuestion,
  normalizeAiText,
  planMiaobingAiTrigger,
  planMiaobingPrivateAiTrigger,
  processMiaobingAiRequest,
  safeOpenAiErrorMeta,
  safeOpenAiResponseMeta,
};
