"use strict";

const {CANON_LEVELS, findRelevantCanon} = require("./miaobingCanon");
const {
  LINE_STICKER_CATALOG,
  buildLineStickerMessage,
  stickerKey,
} = require("./lineStickerCatalog");

const EXPRESSION_TYPES = Object.freeze({
  UNICODE_EMOJI: "unicodeEmoji",
  LINE_EMOJI: "lineEmoji",
  STICKER: "sticker",
});
const EMOJI_PROBABILITIES = Object.freeze({none: 0.55, one: 0.40, two: 0.05});
const STICKER_PROBABILITY = 0.12;
const STICKER_ONLY_PROBABILITY = 0.35;
const RECENT_EMOJI_LIMIT = 10;
const RECENT_EMOJI_REPLY_LIMIT = 3;
const RECENT_EMOJI_SIGNATURE_LIMIT = 8;
const RECENT_STICKER_LIMIT = 6;
const RECENT_EXCLUSION_COUNT = 5;

const EMOJI_POOLS = Object.freeze({
  cute: Object.freeze(["🥺", "🥹", "🫶", "✨", "💕", "🌷", "🎀", "😽", "😸", "🐾", "💗", "🤍", "🌸", "🫧"]),
  happy: Object.freeze(["😸", "✨", "🫶", "💕", "🌷", "🐾", "💗", "🌸", "🫧"]),
  playful: Object.freeze(["😼", "🤭", "🫢", "😏", "🙃", "😹", "👀", "🫣", "😈", "🐾"]),
  annoyed: Object.freeze(["😾", "🙄", "💢", "😑", "😒", "🫥", "😮‍💨"]),
  work: Object.freeze(["📋", "📝", "🫡", "⚓", "🚢", "🧾", "🔔", "📌"]),
  sleepy: Object.freeze(["💤", "🥱", "😴", "☁️", "🫠"]),
  tired: Object.freeze(["💤", "🥱", "😴", "☁️", "🫠"]),
  food: Object.freeze(["🍪", "🧁", "🍮", "🐟", "🍗", "🥛", "🍬"]),
  warm: Object.freeze(["🥹", "🫶", "🤍", "🌷", "🐾", "☁️"]),
  surprised: Object.freeze(["😳", "🫢", "👀", "⁉️", "😹"]),
  neutral: Object.freeze(["😼", "🐾", "✨", "🫶", "📋", "⚓", "🤍", "🌷"]),
});

const MOOD_MAP = Object.freeze({
  "今天稍微慵懶": "sleepy",
  "今天像忙碌但願意幫忙的船務人員": "work",
  "今天有點調皮": "playful",
  "今天一本正經": "work",
  "今天比較溫柔": "warm",
  "今天嘴硬但心情不錯": "playful",
  // Read old state/test mood values without keeping them in the V2 persona prompt.
  "今天像很忙的船務人員": "work",
  "今天吐槽感稍強": "playful",
  "今天有點欠揍但不能攻擊人": "playful",
  sad: "warm",
  noisy: "annoyed",
  cannedFood: "food",
  churu: "food",
  dog: "annoyed",
  dogBetter: "annoyed",
  love: "cute",
  compliment: "cute",
  pet: "warm",
  hug: "warm",
  thanks: "warm",
  work: "work",
  tired: "sleepy",
  food: "food",
  greeting: "happy",
  whatDoing: "work",
});

const STICKER_ONLY_INTENTS = new Set([
  "goodnight", "greeting", "thanks", "apology", "compliment", "pet",
  "tired", "annoyed", "surprised", "laugh", "calling",
]);

const EMOJI_PATTERN = /\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?)*/gu;

function safeRandom(rng = Math.random) {
  const value = Number(rng());
  return Number.isFinite(value) ? Math.max(0, Math.min(value, 0.999999999)) : 0;
}

function uniqueStrings(values, limit) {
  const result = [];
  for (const value of Array.isArray(values) ? values : []) {
    const text = String(value || "").trim().slice(0, 40);
    if (text && !result.includes(text)) result.push(text);
    if (result.length >= limit) break;
  }
  return result;
}

function extractUnicodeEmoji(text) {
  return uniqueStrings(String(text || "").match(EMOJI_PATTERN) || [], RECENT_EMOJI_LIMIT);
}

function countEmoji(text) {
  return (String(text || "").match(EMOJI_PATTERN) || []).length;
}

function detectStickerIntent(text) {
  const input = String(text || "").normalize("NFKC").toLocaleLowerCase("zh-Hant");
  const rules = [
    ["goodnight", /(晚安|睡覺|去睡|おやすみ)/u],
    ["thanks", /(謝謝|感謝|thanks|thank you)/u],
    ["apology", /(對不起|抱歉|sorry)/u],
    ["compliment", /(可愛|漂亮|好棒|厲害|稱讚)/u],
    ["pet", /(摸摸|摸你|抱抱|抱你)/u],
    ["tired", /(好累|累了|想睡|睏|疲倦)/u],
    ["annoyed", /(好煩|煩死|閉嘴|討厭|吵死|你好吵)/u],
    ["surprised", /(嚇到|真的假的|居然|蛤|什麼[!?！？])/u],
    ["laugh", /(哈哈|笑死|好好笑|lol)/u],
    ["greeting", /(早安|午安|晚安|你好|哈囉|嗨|hello|hi)/u],
    ["calling", /^(?:有人叫你|在嗎|喵餅)?[。.!！?？\s]*$/u],
  ];
  const matched = rules.find(([, pattern]) => pattern.test(input));
  return matched ? matched[0] : null;
}

function inferExpressionMood({mood, text} = {}) {
  const intent = detectStickerIntent(text);
  if (intent === "goodnight" || intent === "tired") return "sleepy";
  if (["thanks", "apology", "pet"].includes(intent)) return "warm";
  if (intent === "compliment") return "cute";
  if (intent === "annoyed") return "annoyed";
  if (intent === "surprised") return "surprised";
  if (intent === "laugh") return "happy";
  const input = String(text || "");
  if (/(罐罐|肉泥|吃飯|好餓|零食)/u.test(input)) return "food";
  if (/(船務|公會|船票|發船|名冊|工作|上班)/u.test(input)) return "work";
  return MOOD_MAP[String(mood || "")] || "neutral";
}

function weightedPick(values, weightFor, rng) {
  if (!values.length) return null;
  const weights = values.map((value) => Math.max(0, Number(weightFor(value)) || 0));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (!total) return values[0];
  let target = safeRandom(rng) * total;
  for (let index = 0; index < values.length; index += 1) {
    target -= weights[index];
    if (target < 0) return values[index];
  }
  return values.at(-1);
}

function flattenRecentReplyEmoji(value) {
  return uniqueStrings((Array.isArray(value) ? value : []).flatMap((item) =>
    Array.isArray(item) ? item : []), RECENT_EMOJI_LIMIT);
}

function emojiSignature(values) {
  return uniqueStrings(values, 2).sort().join("|");
}

function selectEmoji({mood = "neutral", recentEmoji = [], lastReplyEmoji = [],
  recentReplyEmoji = [], recentEmojiSignatures = [], count = 1, rng = Math.random} = {}) {
  const pool = [...new Set(EMOJI_POOLS[mood] || EMOJI_POOLS.neutral)];
  const blocked = new Set(uniqueStrings(lastReplyEmoji, 2));
  const stronglyBlocked = new Set(flattenRecentReplyEmoji(recentReplyEmoji));
  const recent = new Set(uniqueStrings(recentEmoji, RECENT_EMOJI_LIMIT));
  const recentSignatures = new Set(uniqueStrings(
    recentEmojiSignatures,
    RECENT_EMOJI_SIGNATURE_LIMIT,
  ));
  const selected = [];
  const wanted = Math.max(0, Math.min(2, Number(count) || 0));
  while (selected.length < wanted) {
    const unused = pool.filter((emoji) => !blocked.has(emoji) &&
      !stronglyBlocked.has(emoji) && !selected.includes(emoji));
    const fresh = unused.filter((emoji) => !recent.has(emoji));
    const candidates = fresh.length ? fresh : unused;
    if (!candidates.length) break;
    const emoji = weightedPick(candidates, () => 1, rng);
    if (!emoji) break;
    if (selected.length === 1 && recentSignatures.has(emojiSignature([selected[0], emoji]))) {
      const differentPair = candidates.filter((candidate) =>
        !recentSignatures.has(emojiSignature([selected[0], candidate])));
      if (!differentPair.length) break;
      selected.push(weightedPick(differentPair, () => 1, rng));
      continue;
    }
    selected.push(emoji);
  }
  return selected;
}

function ensureSentenceEnding(text) {
  const value = String(text || "").trimEnd();
  if (!value || /[。.!！?？…」』）)]$/u.test(value)) return value;
  return `${value}。`;
}

function sanitizeDecorativeTrailingEmoji(text, state = {}, {maxEmoji = 2} = {}) {
  const value = String(text || "").trim();
  const match = value.match(/^(.*?)([\s。.!！?？，,～~]+)((?:\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?)*\s*)+)$/u);
  if (!match) return value;
  const prefix = `${match[1]}${match[2]}`.trimEnd();
  const trailing = String(match[3]).match(EMOJI_PATTERN) || [];
  const current = normalizeExpressionState(state);
  const last = new Set(current.lastReplyEmoji);
  const recentReplies = new Set(flattenRecentReplyEmoji(current.recentReplyEmoji));
  const signatures = new Set(current.recentEmojiSignatures);
  const kept = [];
  for (const emoji of trailing) {
    if (kept.length >= maxEmoji || kept.includes(emoji) || last.has(emoji) ||
        recentReplies.has(emoji)) continue;
    if (kept.length === 1 && signatures.has(emojiSignature([kept[0], emoji]))) continue;
    kept.push(emoji);
  }
  return kept.length ? `${prefix} ${kept.join(" ")}` : ensureSentenceEnding(prefix);
}

function chooseEmojiCount({conservative = false, existingEmojiCount = 0, rng = Math.random} = {}) {
  if (existingEmojiCount > 0) return 0;
  const roll = safeRandom(rng);
  if (conservative) return roll < 0.75 ? 0 : 1;
  if (roll < EMOJI_PROBABILITIES.none) return 0;
  if (roll < EMOJI_PROBABILITIES.none + EMOJI_PROBABILITIES.one) return 1;
  return 2;
}

function selectSticker({intent, mood, recentStickerIds = [], lastStickerId = null,
  rng = Math.random} = {}) {
  if (!intent) return null;
  const blocked = String(lastStickerId || "");
  const recent = new Set(uniqueStrings(recentStickerIds, RECENT_EXCLUSION_COUNT));
  const matchingTag = LINE_STICKER_CATALOG.filter((item) => item.tags.includes(intent));
  const matchingMood = LINE_STICKER_CATALOG.filter((item) => item.moods.includes(mood));
  const pool = matchingTag.length ? matchingTag : matchingMood;
  const unused = pool.filter((item) => stickerKey(item) !== blocked);
  const fresh = unused.filter((item) => !recent.has(stickerKey(item)));
  const candidates = fresh.length ? fresh : unused.filter((item) => !recent.has(stickerKey(item)));
  if (!candidates.length) return null;
  return weightedPick(candidates, (item) => item.weight, rng);
}

function isProtectedFactualQuestion(text) {
  return findRelevantCanon(text).some((entry) =>
    entry.level === CANON_LEVELS.HARD_CANON || entry.level === CANON_LEVELS.CLASSIC_LINE);
}

function updateRecent(current, used, limit) {
  const selected = uniqueStrings(used, limit);
  return uniqueStrings([...selected.slice().reverse(), ...current], limit);
}

function buildExpressionLineMessages({text, textMessage, sticker, stickerOnly = false} = {}) {
  const stickerMessage = buildLineStickerMessage(sticker);
  if (stickerOnly) return stickerMessage ? [stickerMessage] : [];
  const baseMessage = textMessage && typeof textMessage === "object" ? textMessage :
    {type: "text", text: String(text || "")};
  return stickerMessage ? [baseMessage, stickerMessage] : [baseMessage];
}

function normalizeExpressionState(value) {
  const state = value && typeof value === "object" ? value : {};
  const recentReplyEmoji = (Array.isArray(state.recentReplyEmoji) ? state.recentReplyEmoji : [])
    .map((item) => uniqueStrings(item, 2))
    .slice(0, RECENT_EMOJI_REPLY_LIMIT);
  return {
    recentEmoji: uniqueStrings(state.recentEmoji, RECENT_EMOJI_LIMIT),
    lastReplyEmoji: uniqueStrings(state.lastReplyEmoji, 2),
    recentReplyEmoji,
    recentEmojiSignatures: uniqueStrings(
      state.recentEmojiSignatures,
      RECENT_EMOJI_SIGNATURE_LIMIT,
    ),
    recentStickerIds: uniqueStrings(state.recentStickerIds, RECENT_STICKER_LIMIT),
    lastStickerId: String(state.lastStickerId || "").slice(0, 40),
  };
}

function planMiaobingExpression({text, textMessage, mood, question, state, isFactual = false,
  isCommand = false, isError = false, personalityEnabled = true, rng = Math.random} = {}) {
  if (!personalityEnabled) {
    return {shouldReply: false, messages: [], stateChanged: false};
  }
  const originalText = String(text || "").trim();
  const current = normalizeExpressionState(state);
  const expressionMood = inferExpressionMood({mood, text: question});
  const intent = detectStickerIntent(question);
  const protectedContent = Boolean(isFactual || isProtectedFactualQuestion(question));
  const stickerEligible = !isCommand && !isError && !protectedContent && Boolean(intent);
  let selectedSticker = null;
  let stickerOnly = false;
  let stickerReason = stickerEligible ? "probability-skip" : "ineligible";

  if (stickerEligible && safeRandom(rng) < STICKER_PROBABILITY) {
    selectedSticker = selectSticker({
      intent,
      mood: expressionMood,
      recentStickerIds: current.recentStickerIds,
      lastStickerId: current.lastStickerId,
      rng,
    });
    if (selectedSticker) {
      stickerOnly = STICKER_ONLY_INTENTS.has(intent) && String(question || "").length <= 30 &&
        safeRandom(rng) < STICKER_ONLY_PROBABILITY;
      stickerReason = stickerOnly ? "safe-conversation-sticker-only" : "safe-conversation-with-text";
    } else {
      stickerReason = "no-fresh-candidate";
    }
  }

  const sanitizedText = protectedContent ? originalText :
    sanitizeDecorativeTrailingEmoji(originalText, current, {
      maxEmoji: selectedSticker ? 1 : 2,
    });
  const existingEmoji = extractUnicodeEmoji(sanitizedText);
  const addedEmoji = stickerOnly || isError ? [] : selectEmoji({
    mood: expressionMood,
    recentEmoji: current.recentEmoji,
    lastReplyEmoji: current.lastReplyEmoji,
    recentReplyEmoji: current.recentReplyEmoji,
    recentEmojiSignatures: current.recentEmojiSignatures,
    count: chooseEmojiCount({
      conservative: protectedContent || isCommand || Boolean(selectedSticker),
      existingEmojiCount: existingEmoji.length,
      rng,
    }),
    rng,
  });
  const decoratedText = addedEmoji.length ? `${sanitizedText} ${addedEmoji.join(" ")}` :
    sanitizedText;
  const replyEmoji = stickerOnly ? [] : extractUnicodeEmoji(decoratedText).slice(0, 2);
  const signature = replyEmoji.length === 2 ? emojiSignature(replyEmoji) : "";
  const selectedStickerKey = selectedSticker ? stickerKey(selectedSticker) : "";
  const decoratedTextMessage = textMessage && typeof textMessage === "object" ?
    {...textMessage, text: decoratedText} : null;
  const nextState = {
    recentEmoji: updateRecent(current.recentEmoji, replyEmoji, RECENT_EMOJI_LIMIT),
    lastReplyEmoji: replyEmoji,
    recentReplyEmoji: [replyEmoji, ...current.recentReplyEmoji]
      .slice(0, RECENT_EMOJI_REPLY_LIMIT),
    recentEmojiSignatures: signature ? updateRecent(
      current.recentEmojiSignatures,
      [signature],
      RECENT_EMOJI_SIGNATURE_LIMIT,
    ) : current.recentEmojiSignatures,
    recentStickerIds: selectedStickerKey ?
      updateRecent(current.recentStickerIds, [selectedStickerKey], RECENT_STICKER_LIMIT) :
      current.recentStickerIds,
    lastStickerId: selectedStickerKey,
  };
  return {
    shouldReply: true,
    text: decoratedText,
    messages: buildExpressionLineMessages({
      text: decoratedText,
      textMessage: decoratedTextMessage,
      sticker: selectedSticker,
      stickerOnly,
    }),
    mood: expressionMood,
    emojiDecision: {
      type: EXPRESSION_TYPES.UNICODE_EMOJI,
      used: replyEmoji.length > 0,
      existingCount: existingEmoji.length,
      added: addedEmoji,
      count: replyEmoji.length,
    },
    stickerDecision: {
      type: EXPRESSION_TYPES.STICKER,
      used: Boolean(selectedSticker),
      stickerOnly,
      packageId: selectedSticker && selectedSticker.packageId || null,
      stickerId: selectedSticker && selectedSticker.stickerId || null,
      reason: stickerReason,
    },
    nextState,
    stateChanged: true,
  };
}

function createReplayRng(rng, sampleCount = 16) {
  const samples = Array.from({length: sampleCount}, () => safeRandom(rng));
  return () => {
    let index = 0;
    return () => samples[index++ % samples.length];
  };
}

async function directMiaobingExpression(stateRef, options = {}) {
  const replayFactory = createReplayRng(options.rng || Math.random);
  let plan = planMiaobingExpression({...options, state: null, rng: replayFactory()});
  if (!plan.shouldReply) return plan;
  await stateRef.transaction((currentState) => {
    plan = planMiaobingExpression({
      ...options,
      state: currentState,
      rng: replayFactory(),
    });
    return {
      ...(currentState && typeof currentState === "object" ? currentState : {}),
      ...plan.nextState,
    };
  });
  return plan;
}

module.exports = {
  EMOJI_POOLS,
  EMOJI_PROBABILITIES,
  EXPRESSION_TYPES,
  RECENT_EMOJI_LIMIT,
  RECENT_EMOJI_REPLY_LIMIT,
  RECENT_EMOJI_SIGNATURE_LIMIT,
  RECENT_STICKER_LIMIT,
  STICKER_ONLY_PROBABILITY,
  STICKER_PROBABILITY,
  buildExpressionLineMessages,
  chooseEmojiCount,
  countEmoji,
  detectStickerIntent,
  directMiaobingExpression,
  extractUnicodeEmoji,
  inferExpressionMood,
  isProtectedFactualQuestion,
  emojiSignature,
  planMiaobingExpression,
  sanitizeDecorativeTrailingEmoji,
  selectEmoji,
  selectSticker,
};
