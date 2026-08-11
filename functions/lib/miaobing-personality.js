"use strict";

const crypto = require("node:crypto");

const AMBIENT_COOLDOWN_MS = 3 * 60 * 1000;
const DIRECT_MENTION_COOLDOWN_MS = 4 * 1000;
const AMBIENT_CONTEXTUAL_PROBABILITY = 0.2;
const NIGHT_FLAVOR_PROBABILITY = 0.3;
const COMMAND_FLAVOR_PROBABILITY = 0.8;

const MIAOBING_RESPONSES = {
  greeting: [
    "喵？",
    "本喵在。叫這麼大聲幹嘛。",
    "……本喵有聽到。",
    "嗯？找本喵？",
    "有事快說，本喵很忙的。",
  ],
  compliment: [
    "……蛤？這種事情本喵自己知道。",
    "哼，你眼光倒是不差。",
    "再講一次也不是不行喵。",
    "不要以為誇本喵就能少捐船票。",
    "……本喵才沒有在高興。",
  ],
  love: [
    "？？？本喵是會貓，不是你的戀愛對象喵！",
    "這句本喵先記著。只是記著而已。",
    "……突然講這個幹嘛喵。",
    "哼，本喵勉強收下。",
  ],
  calling: [
    "喵？叫本喵幹嘛。",
    "本喵有聽到，不用一直叫。",
    "……說吧，本喵勉強聽一下。",
    "一直叫本喵，是有什麼事？",
  ],
  whatDoing: [
    "在巡船喵。才不是在等你叫本喵。",
    "整理船員名冊。你們真的很會製造工作。",
    "監督會長。",
    "本喵正在很重要地……趴著。",
  ],
  tired: [
    "人類真麻煩喵。……去休息啦。",
    "累了就去躺著，本喵批准了。",
    "今天先少嘴你兩句。去休息。",
  ],
  sad: [
    "……今天就不嘴你了喵。去休息一下吧。",
    "本喵沒有很會安慰人。可是……你先休息一下。",
    "今天可以先躲到船艙裡。明天再回來。",
    "……本喵在啦。",
  ],
  work: [
    "本喵每天都在上班，還沒有薪水。",
    "至少你上班有薪水。本喵只有船票。",
    "去上班啦。罐罐自己不會買回來喵。",
  ],
  food: [
    "餓了就去吃飯，別在本喵面前裝可憐。",
    "先吃飯喵。船員餓昏了還要本喵拖回船艙。",
  ],
  pet: [
    "不准。……只能一下。",
    "誰准你摸本喵的。",
    "手拿開。……欸，等一下。",
  ],
  hug: [
    "本喵拒絕。……（沒有走掉）",
    "不要突然抱過來喵！",
    "只能三秒。",
  ],
  dog: [
    "……出去。",
    "這裡是公會船，不是狗舍喵。",
  ],
  dogBetter: [
    "使用者已被本喵列入觀察名單。\n開玩笑的。……大概。",
    "本喵沒聽清楚，你再說一次？",
  ],
  thanks: [
    "哼，知道就好。",
    "不用謝。本喵只是順手。",
    "……下次記得帶罐罐。",
    "本喵才沒有特別幫你。",
  ],
  noisy: [
    "……好。本喵記住你了。",
    "哼，本喵本來也沒想理你。",
    "知道了喵。那等等不要又叫本喵。",
  ],
  angry: [
    "先喘口氣喵。生氣也不能把船拆了。",
    "本喵知道你在氣。先別急著咬人。",
  ],
  identity: [
    "本喵是這艘船的會貓。會長管人，本喵管會長。",
    "喵餅。公會會貓。職責是處理你們製造的麻煩。",
    "本喵負責名冊、船員，還有監督那些不乖的兩腳獸。",
  ],
  cannedFood: [
    "哪裡？",
    "……你最好不是隨便說說。",
    "本喵剛剛是不是聽到罐罐？",
  ],
  churu: [
    "拿來。",
    "什麼口味？",
    "先給本喵，再談其他事情。",
  ],
  guildLeader: [
    "會長管人，本喵管會長。",
    "會長？本喵正在監督。",
    "所以呢？本喵是會貓。",
  ],
  ticket: [
    "本喵聞到有人想裝死的味道了。",
    "三張。不要讓本喵再提醒喵。",
  ],
  captain: [
    "船長要好好開船喵。",
    "翻船的話本喵第一個跑。",
  ],
  cat: [
    "誰叫本喵？",
    "說到貓，本喵就勉強聽一下。",
  ],
  generalMention: [
    "嗯？叫本喵幹嘛。",
    "本喵有聽到喵。",
    "……說吧，本喵勉強聽一下。",
    "一直叫本喵，是有什麼事？",
    "喵？",
  ],
  night: [
    "你們兩腳獸不用睡覺的嗎？本喵都準備窩好了。",
    "這個時間還在群裡晃喵？",
    "小聲一點。本喵的睡覺時間到了。",
  ],
  command: {
    success: [
      "喵，這點小事當然難不倒本喵。",
      "哼，處理好了。",
      "好了喵。記得感謝本喵。",
      "本喵出手，當然沒問題。",
      "行啦，幫你弄好了。",
    ],
    failure: [
      "哈？這樣也能出問題喵。",
      "……不對喵，本喵再看了一眼。",
      "等一下，這筆有問題。",
      "本喵聞到哪裡怪怪的。",
    ],
    notFound: [
      "本喵翻遍名冊都沒看到。",
      "名冊裡沒有這個名字喵。",
      "這傢伙是不是還沒來報到？",
    ],
    locked: [
      "🔒 現在不給亂碰喵。",
      "🔒 本喵已經把名冊收起來了。",
      "🔒 鎖住了。誰都別想偷偷改。",
    ],
    sync: [
      "本喵來巡一次船員名冊。",
      "全部站好，本喵要點名了喵。",
      "哼，又到了本喵整理名冊的時間。",
    ],
    bind: [
      "喵，身份確認完畢。",
      "哼，總算來報到了。",
      "好了喵，現在本喵認得你了。",
    ],
    unbind: [
      "又要走？……隨便你喵。",
      "好啦，本喵幫你拆掉了。",
    ],
    lock: ["會長管不住的人，本喵來管。"],
    unlock: ["門開了喵。不要一開門就搞事。"],
    unboundList: ["還有人沒報到喵，到底要本喵等多久。"],
    adminBind: ["行啦，本喵幫你抓人。"],
    adminUnbind: ["管理員都開口了，本喵處理就是。"],
    help: ["喵，指令都放這裡了。", "看清楚喵，本喵只說一次。"],
    unknown: ["喵？本喵看不懂這個指令。", "這是哪門子的指令喵？"],
  },
  commandClosing: {
    bind: ["……才不是特別記住你的。"],
  },
};

const INTENT_RULES = [
  {intent: "sad", keywords: ["難過", "心情不好", "心情很差", "很煩", "想哭", "今天很糟"]},
  {intent: "dogBetter", keywords: ["狗狗比較可愛", "狗比較可愛"]},
  {intent: "noisy", keywords: ["你好吵", "喵餅好吵", "閉嘴", "安靜"]},
  {intent: "cannedFood", keywords: ["罐罐"]},
  {intent: "churu", keywords: ["肉泥"]},
  {intent: "dog", keywords: ["汪"], match: "bark"},
  {intent: "identity", keywords: ["你是誰", "喵餅是誰", "你幹嘛的"]},
  {intent: "love", keywords: ["愛你", "喜歡你", "最愛喵餅", "love you"]},
  {intent: "compliment", keywords: ["好可愛", "可愛", "漂亮", "萌", "可愛い", "かわいい", "cute"]},
  {intent: "work", keywords: ["不想上班", "上班好累", "又要上班"]},
  {intent: "tired", keywords: ["好累", "累死", "累了", "想睡", "沒力"]},
  {intent: "whatDoing", keywords: ["在幹嘛", "在做什麼", "忙什麼"]},
  {intent: "pet", keywords: ["摸摸", "摸你", "摸貓", "摸一下"]},
  {intent: "hug", keywords: ["抱抱", "抱你"]},
  {intent: "thanks", keywords: ["謝謝", "感謝", "thanks", "thank you"]},
  {intent: "angry", keywords: ["生氣", "氣死", "火大"]},
  {intent: "food", keywords: ["餓了", "好餓", "吃飯"]},
  {intent: "guildLeader", keywords: ["會長"]},
  {intent: "ticket", keywords: ["船票"]},
  {intent: "captain", keywords: ["船長"]},
  {intent: "cat", keywords: ["貓"]},
  {intent: "greeting", keywords: ["你好", "嗨", "哈囉", "早安", "午安", "晚安", "在嗎"]},
];

const STRONG_INTENTS = new Set(["cannedFood", "churu", "dog", "dogBetter"]);
const CONTEXTUAL_INTENTS = new Set([
  "tired", "work", "sad", "guildLeader", "ticket", "captain", "cat",
]);

function pickRandom(items, rng = Math.random) {
  if (!Array.isArray(items) || !items.length) return "";
  const value = Number(rng());
  const normalized = Number.isFinite(value) ? Math.min(Math.max(value, 0), 0.999999999) : 0;
  return items[Math.floor(normalized * items.length)];
}

function normalizeText(text) {
  return String(text || "").trim().toLowerCase();
}

function detectMiaobingIntent(text) {
  const normalized = normalizeText(text);
  const withoutBotName = normalized.replaceAll("@喵餅", "").replaceAll("喵餅", "").trim();
  const rule = INTENT_RULES.find((item) => {
    if (item.match === "bark") return /^汪+[!！。?？~～\s]*$/u.test(withoutBotName);
    return item.keywords.some((keyword) => normalized.includes(keyword.toLowerCase()));
  });
  const intent = rule ? rule.intent : "unknown";
  const strength = STRONG_INTENTS.has(intent) ? "strong" :
    CONTEXTUAL_INTENTS.has(intent) ? "contextual" : "none";
  return {intent, strength};
}

function isBotMentioned(message, {botUserId} = {}) {
  const mentionees = message && message.mention && Array.isArray(message.mention.mentionees) ?
    message.mention.mentionees : [];
  if (mentionees.some((mentionee) =>
    mentionee && mentionee.type === "user" && mentionee.isSelf === true)) return true;
  const destination = String(botUserId || "");
  return Boolean(destination && mentionees.some((mentionee) =>
    mentionee && mentionee.type === "user" && mentionee.userId === destination));
}

function mentionsMiaobingName(text) {
  return String(text || "").includes("喵餅");
}

function isNightHour(hourTaipei) {
  const hour = Number(hourTaipei);
  return Number.isInteger(hour) && hour >= 1 && hour <= 5;
}

function getTaipeiHour(date = new Date()) {
  return Number(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Taipei",
    hour: "2-digit",
    hourCycle: "h23",
  }).format(date));
}

function poolForIntent(intent) {
  return MIAOBING_RESPONSES[intent] || MIAOBING_RESPONSES.generalMention;
}

function generateDirectMentionReply({text, hourTaipei, rng = Math.random}) {
  const detected = detectMiaobingIntent(text);
  const intent = detected.intent === "unknown" && mentionsMiaobingName(text) ? "calling" : detected.intent;
  if (intent !== "sad" && isNightHour(hourTaipei) && rng() < NIGHT_FLAVOR_PROBABILITY) {
    return {intent, text: pickRandom(MIAOBING_RESPONSES.night, rng), night: true};
  }
  return {intent, text: pickRandom(poolForIntent(intent), rng), night: false};
}

function shouldAmbientReply({triggerStrength, rng = Math.random}) {
  if (triggerStrength === "strong") return true;
  if (triggerStrength === "contextual") return rng() < AMBIENT_CONTEXTUAL_PROBABILITY;
  return false;
}

function planMiaobingMessage({event, command, botUserId, hourTaipei, rng = Math.random}) {
  if (command || String(event && event.message && event.message.text || "").trim().startsWith("!")) {
    return {shouldReply: false, reason: "command"};
  }
  if (!event || event.type !== "message" || !event.message || event.message.type !== "text" ||
      !event.source || event.source.type !== "group" || !event.source.groupId) {
    return {shouldReply: false, reason: "unsupported-event"};
  }

  const text = String(event.message.text || "");
  const trueMention = isBotMentioned(event.message, {botUserId});
  const directName = mentionsMiaobingName(text);
  if (trueMention || directName) {
    const generated = generateDirectMentionReply({text, hourTaipei, rng});
    return {
      shouldReply: true,
      kind: "direct",
      reason: trueMention ? "true-mention" : "direct-name",
      intent: generated.intent,
      replyText: generated.text,
      night: generated.night,
      cooldownMs: DIRECT_MENTION_COOLDOWN_MS,
    };
  }

  const detected = detectMiaobingIntent(text);
  if (detected.strength === "contextual" && [...text].length > 40) {
    return {shouldReply: false, reason: "ambient-message-too-long", intent: detected.intent};
  }
  if (!shouldAmbientReply({triggerStrength: detected.strength, rng})) {
    return {shouldReply: false, reason: "ambient-not-selected", intent: detected.intent};
  }
  const generated = generateDirectMentionReply({text, hourTaipei, rng});
  return {
    shouldReply: true,
    kind: "ambient",
    reason: detected.strength === "strong" ? "strong-trigger" : "contextual-trigger",
    intent: detected.intent,
    replyText: generated.text,
    night: generated.night,
    cooldownMs: AMBIENT_COOLDOWN_MS,
  };
}

function isCooldownElapsed(lastReplyAt, now, cooldownMs) {
  const previous = Number(lastReplyAt) || 0;
  const current = Number(now) || 0;
  return current > 0 && (previous <= 0 || current - previous >= cooldownMs);
}

function personalityUserKey(userId) {
  const value = String(userId || "");
  if (!value) return "";
  return crypto.createHash("sha256").update(value, "utf8").digest("base64url").slice(0, 24);
}

function commandPool(command, status) {
  if (command === "unknown") return MIAOBING_RESPONSES.command.unknown;
  if (status === "locked") return MIAOBING_RESPONSES.command.locked;
  if (status === "not-found") return MIAOBING_RESPONSES.command.notFound;
  if (status === "failure") return MIAOBING_RESPONSES.command.failure;
  const pools = {
    bind: MIAOBING_RESPONSES.command.bind,
    unbind: MIAOBING_RESPONSES.command.unbind,
    sync: MIAOBING_RESPONSES.command.sync,
    lock: MIAOBING_RESPONSES.command.lock,
    unlock: MIAOBING_RESPONSES.command.unlock,
    "unbound-list": MIAOBING_RESPONSES.command.unboundList,
    "admin-bind": MIAOBING_RESPONSES.command.adminBind,
    "admin-unbind": MIAOBING_RESPONSES.command.adminUnbind,
    help: MIAOBING_RESPONSES.command.help,
    unknown: MIAOBING_RESPONSES.command.unknown,
  };
  return pools[command] || MIAOBING_RESPONSES.command.success;
}

function decorateCommandReply({
  command,
  status = "success",
  coreText,
  rng = Math.random,
  flavorProbability = COMMAND_FLAVOR_PROBABILITY,
}) {
  const core = String(coreText || "").trim();
  if (!core || rng() >= flavorProbability) return core;
  const opening = pickRandom(commandPool(command, status), rng);
  const closingPool = status === "success" ? MIAOBING_RESPONSES.commandClosing[command] : null;
  const closing = closingPool && rng() < 0.35 ? pickRandom(closingPool, rng) : "";
  return [opening, core, closing].filter(Boolean).join("\n\n");
}

function responsePoolStats() {
  let poolCount = 0;
  let phraseCount = 0;
  const visit = (value) => {
    if (Array.isArray(value)) {
      poolCount += 1;
      phraseCount += value.length;
      return;
    }
    Object.values(value || {}).forEach(visit);
  };
  visit(MIAOBING_RESPONSES);
  return {poolCount, phraseCount};
}

module.exports = {
  AMBIENT_CONTEXTUAL_PROBABILITY,
  AMBIENT_COOLDOWN_MS,
  COMMAND_FLAVOR_PROBABILITY,
  DIRECT_MENTION_COOLDOWN_MS,
  INTENT_RULES,
  MIAOBING_RESPONSES,
  decorateCommandReply,
  detectMiaobingIntent,
  generateDirectMentionReply,
  getTaipeiHour,
  isBotMentioned,
  isCooldownElapsed,
  mentionsMiaobingName,
  personalityUserKey,
  pickRandom,
  planMiaobingMessage,
  responsePoolStats,
  shouldAmbientReply,
};
