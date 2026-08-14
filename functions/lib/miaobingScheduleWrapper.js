"use strict";

const OpenAI = require("openai");
const {
  AI_MAX_OUTPUT_TOKENS,
  AI_MODEL,
  AI_REASONING_EFFORT,
  safeOpenAiResponseMeta,
} = require("./ai");
const {buildMiaobingInstructions, pickMood} = require("./miaobingPersona");
const {applyMiaobingStyleGuard} = require("./miaobingStyle");

const WRAPPER_MAX_CHARS = 60;
const WRAPPER_FALLBACK = Object.freeze({
  intro: "提醒一下，免得等等又有人裝沒看到。",
  outro: "",
  mood: "今天像忙碌但願意幫忙的船務人員",
});

function cleanWrapperPart(value) {
  const oneLine = String(value || "").replace(/\s*\n+\s*/gu, " ").trim().slice(0, WRAPPER_MAX_CHARS);
  return applyMiaobingStyleGuard(oneLine).text.trim().slice(0, WRAPPER_MAX_CHARS);
}

function parseScheduleWrapper(value, fallbackMood = WRAPPER_FALLBACK.mood) {
  let parsed;
  try {
    parsed = JSON.parse(String(value || ""));
  } catch {
    parsed = {};
  }
  const intro = cleanWrapperPart(parsed.intro);
  const outro = cleanWrapperPart(parsed.outro);
  if (!intro && !outro) return null;
  return {intro, outro, mood: String(fallbackMood || WRAPPER_FALLBACK.mood).slice(0, 80)};
}

async function generateMiaobingScheduleWrapper({apiKey, coreText, client, rng = Math.random} = {}) {
  if (!String(apiKey || "").trim()) throw Object.assign(
    new Error("OpenAI API key is unavailable."), {code: "missing_openai_api_key"});
  const mood = pickMood(rng);
  const subject = String(coreText || "").trim().slice(0, 1000);
  const openai = client || new OpenAI({apiKey, timeout: 12000, maxRetries: 0});
  const base = buildMiaobingInstructions({question: subject, mood});
  const response = await openai.responses.create({
    model: AI_MODEL,
    instructions: [
      base,
      "",
      "你現在只替一則自動公告產生非常短的喵餅開場與收尾。",
      "核心公告由程式另外組裝，絕對不要改寫、重複、摘要或引用核心內容。",
      "intro 與 outro 各為 0～1 句、各最多 30 個中文字；至少一個不可為空。",
      "不可新增日期、數字、玩家、規則、mention 或聲稱已執行任何操作。",
      "輸出只依指定 JSON schema。",
    ].join("\n"),
    input: `公告主題（只供判斷語氣，不可改寫）：\n${subject}`,
    max_output_tokens: Math.min(AI_MAX_OUTPUT_TOKENS, 300),
    reasoning: {effort: AI_REASONING_EFFORT},
    text: {
      verbosity: "low",
      format: {
        type: "json_schema",
        name: "miaobing_schedule_wrapper",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            intro: {type: "string"},
            outro: {type: "string"},
          },
          required: ["intro", "outro"],
        },
      },
    },
    store: false,
  });
  const wrapper = parseScheduleWrapper(response.output_text, mood);
  return {wrapper, responseMeta: safeOpenAiResponseMeta(response)};
}

async function createScheduleWrapper({apiKey, coreText, reserveUsage, generate} = {}) {
  try {
    const usage = await reserveUsage();
    if (!usage || !usage.allowed) {
      return {...WRAPPER_FALLBACK, usedFallback: true,
        reason: usage && usage.reason || "rate-limit-error", openAiCalls: 0};
    }
    const result = await generate({apiKey, coreText});
    if (!result || !result.wrapper) {
      return {...WRAPPER_FALLBACK, usedFallback: true, reason: "empty-output", openAiCalls: 1};
    }
    return {...result.wrapper, usedFallback: false, reason: "success", openAiCalls: 1,
      responseMeta: result.responseMeta};
  } catch (error) {
    return {...WRAPPER_FALLBACK, usedFallback: true,
      reason: String(error && (error.code || error.name) || "wrapper-error").slice(0, 80),
      openAiCalls: 1};
  }
}

module.exports = {
  WRAPPER_FALLBACK,
  WRAPPER_MAX_CHARS,
  cleanWrapperPart,
  createScheduleWrapper,
  generateMiaobingScheduleWrapper,
  parseScheduleWrapper,
};
