"use strict";

const crypto = require("node:crypto");

const AMBIENT_COOLDOWN_MS = 3 * 60 * 1000;
const DIRECT_MENTION_COOLDOWN_MS = 4 * 1000;
const AMBIENT_CONTEXTUAL_PROBABILITY = 0.2;
const OWNER_ALIAS_PROBABILITY = 0.3;
const OWNER_ALIAS_LONG_PROBABILITY = 0.1;
const LEADER_ALIAS_PROBABILITY = 0.28;
const JAPANESE_NAME_PROBABILITY = 0.08;
const PLATE_MENTION_COOLDOWN_MS = 60 * 1000;
const NIGHT_FLAVOR_PROBABILITY = 0.3;
const COMMAND_FLAVOR_PROBABILITY = 0.8;

const MIAOBING_LORE = Object.freeze({
  owner: Object.freeze({
    lineName: "Chia",
    memberIds: Object.freeze(["852177", "849633"]),
    gameIds: Object.freeze(["嘻嘻不嘻嘻", "CC x CC"]),
    aliases: Object.freeze(["嘻嘻", "嘻嘻不嘻嘻", "Chia", "CC"]),
  }),
  guildLeader: Object.freeze({lineName: "@Hank", gameId: "挖系小嗨",
    memberIds: Object.freeze(["1443678"])}),
  plateTarget: Object.freeze({lineName: "貳零陸", gameId: "九章伏藏"}),
});

const SENDER_ROLES = Object.freeze({
  OWNER: "OWNER",
  GUILD_LEADER: "GUILD_LEADER",
  MEMBER: "MEMBER",
});

const MIAOBING_RESPONSES = {
  ownerIdentity: [
    "主人？當然是 {target} 喵。\n……不要跟她說本喵有承認。",
    "嘻嘻啊。\n她負責養本喵，本喵負責管這艘船。",
    "Chia 是本喵真正的主人。\n……本喵才沒有很黏她。",
  ],
  ownerAlias: [
    "你在叫主人喵？",
    "嘻嘻？……她又跑去哪裡了。",
    "Chia 是主人。這件事情有什麼好大驚小怪的喵。",
    "本喵才沒有在等主人。",
    "CC？你說主人其中一個遊戲帳號喵？",
  ],
  role: {
    OWNER: {
      direct: [
        "……主人叫就沒辦法了喵。",
        "本喵有聽到啦，主人。",
        "才沒有特別快回你。",
        "主人今天怎麼這麼閒，跑來找本喵？",
        "嗯……本喵在。",
        "主人要摸的話……只能一下。",
      ],
      commandSuccess: [
        "主人都開口了，本喵當然會處理。",
        "……這種事直接叫本喵就好了。",
        "主人交代的，本喵弄好了。",
        "好了喵。主人可以不要一直盯著本喵看。",
      ],
      sync: ["主人要點名？行啦，本喵來巡船。"],
      lock: ["主人說鎖，那本喵就把名冊收起來。"],
      adminBind: ["主人又要本喵抓人了喵。"],
      cannedFood: ["……主人有帶給本喵嗎？"],
      pet: ["……主人例外。只能一下喵。"],
      hug: ["……只有主人可以。三秒。"],
      compliment: ["主人也這樣覺得？\n……那本喵就勉強高興一下。"],
    },
    GUILD_LEADER: {
      direct: [
        "會長又怎麼了喵？",
        "本喵正在監督你，別想偷懶。",
        "嗯？會長有事？",
        "先說好，本喵不一定聽會長的。",
        "又有事情要本喵收拾了是不是。",
      ],
      commandSuccess: ["會長交代的，本喵處理好了。"],
      sync: ["會長終於想到要點名了喵。\n行，本喵來巡一次。"],
      lock: ["知道了會長。\n你管不住的人，本喵來管。"],
      unlock: ["會長說開門，那就開喵。\n等等出事別怪本喵。"],
      adminBind: ["會長又抓到漏網船員了喵？"],
      adminUnbind: ["又有人要從名冊上拆下來了嗎？\n本喵處理。"],
      pet: ["會長不要趁機摸本喵。"],
      obedience: ["你是不是搞錯上下關係了喵？"],
      goodCat: ["先管好你的船員再來管本喵。"],
    },
  },
  plate: [
    "盤子？你是說 {target} 嗎喵？",
    "{target}，有人叫你小盤子喵。",
    "本喵不評論，但 {target} 好像被點名了。",
  ],
  plateUnbound: [
    "盤子本人還沒完成 LINE 綁定喵，\n本喵現在抓不到他。",
  ],
  leaderIdentity: [
    "現任會長是 {target}，遊戲裡叫挖系小嗨喵。\n\n會長管人，本喵管會長。",
  ],
  leaderAlias: [
    "會長？本喵有在盯著他喵。",
    "挖系小嗨是會長。\n不過也是本喵的管理對象。",
    "會長最近有沒有偷懶，本喵都看得到。",
  ],
  leaderSelf: [
    "本喵知道。\n那又怎樣？會長也是本喵管的。",
    "會長管人，本喵管會長。忘了喵？",
    "嗯，你是會長。\n然後本喵是管會長的。",
  ],
  japaneseName: [
    "べ、別にあんたのために話してるわけじゃないニャ。",
    "勘違いしないでよね。たまたま日本語も話せるだけニャ。",
    "呼んだ？べつに暇だったわけじゃないニャ。",
    "ちゃんと聞いてるニャ。別に気にしてるわけじゃないけど。",
    "べ、別に日本語が得意って自慢してるわけじゃないからね。",
  ],
  control: {
    unauthorizedMute: [
      "你叫本喵閉嘴，本喵就要閉嘴喵？\n想得美。",
      "這種命令只有主人跟管理員說了算喵。",
    ],
    ownerMute: ["……主人都這樣說了。\n\n本喵去睡就是了喵。"],
    adminMute: ["哼，管理員命令是吧。\n\n本喵去船艙睡覺就是了。"],
    mute: [
      "……好啦，真的閉嘴就是了喵。\n\n本喵去船艙睡覺。\n需要我的時候……再叫我。",
    ],
    wake: [
      "……現在才想起本喵？",
      "哼，本喵只是剛好睡醒。",
      "回來了喵。\n才不是因為你說想本喵。",
      "……本喵聽到了。\n再陪你們一下就是了喵。",
    ],
    ownerWake: ["……主人現在才想起本喵？\n\n哼。\n本喵回來了喵。"],
    adminWake: ["……現在才想起本喵？\n\n行啦，本喵回來了。"],
  },
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
  {intent: "ownerIdentity", keywords: [
    "主人是誰", "你的主人是誰", "喵餅主人是誰", "誰是你主人", "誰養你的", "你主人", "主人呢",
  ]},
  {intent: "leaderIdentity", keywords: [
    "誰是會長", "會長是誰", "現在會長誰", "現任會長", "喵餅誰是會長",
  ]},
  {intent: "leaderClaim", keywords: ["我是會長", "我可是會長", "本會長"]},
  {intent: "leaderObedience", keywords: ["喵餅聽話"]},
  {intent: "leaderGoodCat", keywords: ["喵餅乖"]},
  {intent: "sad", keywords: ["難過", "心情不好", "心情很差", "很煩", "想哭", "今天很糟"]},
  {intent: "dogBetter", keywords: ["狗狗比較可愛", "狗比較可愛"]},
  {intent: "noisy", keywords: ["你好吵", "喵餅好吵", "閉嘴", "安靜"]},
  {intent: "cannedFood", keywords: ["罐罐"]},
  {intent: "churu", keywords: ["肉泥"]},
  {intent: "dog", keywords: ["汪"], match: "bark"},
  {intent: "identity", keywords: ["你是誰", "喵餅是誰", "你幹嘛的"]},
  {intent: "love", keywords: ["愛你", "喜歡你", "最愛喵餅", "想你了", "想妳了", "love you"]},
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

const OWNER_IDENTITY_INTENT = "ownerIdentity";
const LEADER_IDENTITY_INTENT = "leaderIdentity";
const SPECIAL_DIRECT_INTENTS = new Set([
  OWNER_IDENTITY_INTENT, LEADER_IDENTITY_INTENT, "leaderClaim",
  "leaderObedience", "leaderGoodCat",
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

function compactControlText(text) {
  return String(text || "")
    .replace(/[\s，,。.!！?？、~～…：:；;「」『』（）()]+/gu, "")
    .toLowerCase();
}

function detectPersonalityControl(text) {
  const compact = compactControlText(text);
  if (compact === "喵餅真的閉嘴") return "mute";
  if (compact === "喵餅我想你了" || compact === "喵餅我想妳了") return "wake";
  return null;
}

function hasUnsafeAliasContext(text) {
  return /(?:https?:\/\/|www\.|\S+@\S+|`|::|=>|\b(?:const|let|var|class|function)\s+)/iu.test(text);
}

function hasAsciiToken(text, token) {
  if (hasUnsafeAliasContext(text)) return false;
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}($|[^\\p{L}\\p{N}_])`, "iu").test(text);
}

function isOwnerAliasCandidate(text) {
  const value = String(text || "");
  return MIAOBING_LORE.owner.aliases.some((alias) =>
    /^[\x00-\x7F]+$/u.test(alias) ? hasAsciiToken(value, alias) : value.includes(alias));
}

function isPlateCandidate(text) {
  const compact = String(text || "")
    .replace(/[\s，,。.!！?？、~～…：:；;「」『』（）()]+/gu, "");
  return /^(?:(?:誰是|叫))?小?盤子(?:在哪|出來|呢|是誰|本人)?$/u.test(compact);
}

function isJapaneseNameCandidate(text) {
  const value = String(text || "").trim();
  if (!value || [...value].length > 50) return false;
  const tokens = value.match(/[ぁ-ゖァ-ヺー]+/gu) || [];
  return tokens.some((token) => [...token].length >= 2);
}

function detectMiaobingIntent(text) {
  const normalized = normalizeText(text);
  const withoutBotName = normalized.replaceAll("@喵餅", "").replaceAll("喵餅", "").trim();
  const rule = INTENT_RULES.find((item) => {
    if (item.match === "bark") return /^汪+[!！。?？~～\s]*$/u.test(withoutBotName);
    return item.keywords.some((keyword) => normalized.includes(keyword.toLowerCase()));
  });
  if (rule) {
    const intent = rule.intent;
    const strength = SPECIAL_DIRECT_INTENTS.has(intent) ? "direct" :
      STRONG_INTENTS.has(intent) ? "strong" :
        CONTEXTUAL_INTENTS.has(intent) ? "contextual" : "none";
    return {intent, strength};
  }
  if (isPlateCandidate(text)) return {intent: "plate", strength: "plate"};
  if (String(text || "").includes(MIAOBING_LORE.guildLeader.gameId)) {
    return {intent: "leaderAlias", strength: "leader-alias"};
  }
  if (isOwnerAliasCandidate(text)) return {intent: "ownerAlias", strength: "owner-alias"};
  if (isJapaneseNameCandidate(text)) return {intent: "japaneseName", strength: "japanese"};
  const intent = "unknown";
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

function semanticReply(intent, text, rng) {
  if (intent === "ownerIdentity") {
    return {
      intent,
      text: pickRandom(MIAOBING_RESPONSES.ownerIdentity, rng),
      mentionTarget: "owner",
      fallbackName: MIAOBING_LORE.owner.lineName,
    };
  }
  if (intent === "leaderIdentity") {
    return {
      intent,
      text: pickRandom(MIAOBING_RESPONSES.leaderIdentity, rng),
      mentionTarget: "guildLeader",
      fallbackName: MIAOBING_LORE.guildLeader.gameId,
    };
  }
  if (intent === "plate") {
    return {
      intent,
      text: pickRandom(MIAOBING_RESPONSES.plate, rng),
      mentionTarget: "plateTarget",
      fallbackReplyText: pickRandom(MIAOBING_RESPONSES.plateUnbound, rng),
    };
  }
  if (intent === "japaneseName") {
    return {
      intent,
      text: `原來有日本成員，本喵也是會講日文的。\n${pickRandom(MIAOBING_RESPONSES.japaneseName, rng)}`,
    };
  }
  return {intent, text: pickRandom(poolForIntent(intent), rng)};
}

function effectiveSenderRole(senderRole, isOwner, isLeader) {
  if (senderRole === SENDER_ROLES.OWNER || isOwner) return SENDER_ROLES.OWNER;
  if (senderRole === SENDER_ROLES.GUILD_LEADER || isLeader) return SENDER_ROLES.GUILD_LEADER;
  return SENDER_ROLES.MEMBER;
}

function roleResponsePool(senderRole, intent) {
  const rolePools = MIAOBING_RESPONSES.role[senderRole];
  if (!rolePools) return null;
  const keyMap = {
    leaderObedience: "obedience",
    leaderGoodCat: "goodCat",
  };
  return rolePools[keyMap[intent] || intent] || null;
}

function generateDirectMentionReply({text, hourTaipei, senderRole, isOwner = false, isLeader = false,
  rng = Math.random}) {
  const detected = detectMiaobingIntent(text);
  const intent = detected.intent === "unknown" && mentionsMiaobingName(text) ? "calling" : detected.intent;
  const role = effectiveSenderRole(senderRole, isOwner, isLeader);
  const senderIsLeader = role === SENDER_ROLES.GUILD_LEADER;
  if (intent === "leaderClaim" && !senderIsLeader) return {intent, silence: true, night: false};
  if (intent === "leaderClaim") {
    return {intent, text: pickRandom(MIAOBING_RESPONSES.leaderSelf, rng), night: false};
  }
  if (intent === "leaderObedience" || intent === "leaderGoodCat") {
    const leaderPool = senderIsLeader ? roleResponsePool(role, intent) : null;
    return {
      intent: leaderPool ? intent : "calling",
      text: pickRandom(leaderPool || MIAOBING_RESPONSES.calling, rng),
      night: false,
    };
  }
  if (["ownerIdentity", "leaderIdentity", "plate", "ownerAlias", "leaderAlias",
    "japaneseName"].includes(intent)) {
    return {...semanticReply(intent, text, rng), night: false};
  }
  const directRolePool = ["unknown", "calling", "greeting"].includes(intent) ?
    roleResponsePool(role, "direct") : roleResponsePool(role, intent);
  if (directRolePool) {
    return {intent, text: pickRandom(directRolePool, rng), night: false, senderRole: role};
  }
  if (intent !== "sad" && isNightHour(hourTaipei) && rng() < NIGHT_FLAVOR_PROBABILITY) {
    return {intent, text: pickRandom(MIAOBING_RESPONSES.night, rng), night: true};
  }
  return {intent, text: pickRandom(poolForIntent(intent), rng), night: false};
}

function shouldAmbientReply({triggerStrength, rng = Math.random}) {
  if (triggerStrength === "strong") return true;
  if (triggerStrength === "contextual") return rng() < AMBIENT_CONTEXTUAL_PROBABILITY;
  if (triggerStrength === "leader-alias") return rng() < LEADER_ALIAS_PROBABILITY;
  if (triggerStrength === "japanese") return rng() < JAPANESE_NAME_PROBABILITY;
  return false;
}

function isPersonalityEnabled(value) {
  return value !== false;
}

function planPersonalityControl({text, personalityEnabled, isAdmin = false, isOwner = false,
  rng = Math.random}) {
  const control = detectPersonalityControl(text);
  if (!control) return {control: null};
  const authorized = isAdmin || isOwner;
  if (!authorized) {
    if (!isPersonalityEnabled(personalityEnabled) || control === "wake") {
      return {control, authorized: false, shouldReply: false, stateChange: null};
    }
    return {
      control,
      authorized: false,
      shouldReply: true,
      replyText: pickRandom(MIAOBING_RESPONSES.control.unauthorizedMute, rng),
      stateChange: null,
    };
  }
  const role = isOwner ? "owner" : "admin";
  const pool = control === "mute" ?
    MIAOBING_RESPONSES.control[`${role}Mute`] || MIAOBING_RESPONSES.control.mute :
    MIAOBING_RESPONSES.control[`${role}Wake`] || MIAOBING_RESPONSES.control.wake;
  return {
    control,
    authorized: true,
    shouldReply: true,
    replyText: pickRandom(pool, rng),
    stateChange: control === "wake",
  };
}

function planMiaobingMessage({event, command, botUserId, hourTaipei, personalityEnabled,
  senderRole, isOwner = false, isLeader = false, rng = Math.random}) {
  if (command || String(event && event.message && event.message.text || "").trim().startsWith("!")) {
    return {shouldReply: false, reason: "command"};
  }
  if (!event || event.type !== "message" || !event.message || event.message.type !== "text" ||
      !event.source || event.source.type !== "group" || !event.source.groupId) {
    return {shouldReply: false, reason: "unsupported-event"};
  }
  if (!isPersonalityEnabled(personalityEnabled)) {
    return {shouldReply: false, reason: "personality-disabled"};
  }

  const text = String(event.message.text || "");
  const role = effectiveSenderRole(senderRole, isOwner, isLeader);
  const trueMention = isBotMentioned(event.message, {botUserId});
  const directName = mentionsMiaobingName(text);
  if (trueMention || directName) {
    const generated = generateDirectMentionReply({
      text, hourTaipei, senderRole: role, isOwner, isLeader, rng,
    });
    if (generated.silence) {
      return {shouldReply: false, reason: "unverified-leader-claim", intent: generated.intent};
    }
    const kind = generated.intent === "plate" ? "plate" : "direct";
    return {
      shouldReply: true,
      kind,
      reason: trueMention ? "true-mention" : "direct-name",
      intent: generated.intent,
      replyText: generated.text,
      mentionTarget: generated.mentionTarget,
      fallbackName: generated.fallbackName,
      fallbackReplyText: generated.fallbackReplyText,
      night: generated.night,
      cooldownMs: kind === "plate" ? PLATE_MENTION_COOLDOWN_MS : DIRECT_MENTION_COOLDOWN_MS,
    };
  }

  const detected = detectMiaobingIntent(text);
  if (detected.intent === "leaderClaim") {
    if (role !== SENDER_ROLES.GUILD_LEADER) {
      return {shouldReply: false, reason: "unverified-leader-claim", intent: detected.intent};
    }
    return {
      shouldReply: true,
      kind: "direct",
      reason: "verified-leader-claim",
      intent: detected.intent,
      replyText: pickRandom(MIAOBING_RESPONSES.leaderSelf, rng),
      cooldownMs: DIRECT_MENTION_COOLDOWN_MS,
    };
  }
  const senderPool = roleResponsePool(role, detected.intent);
  if (senderPool) {
    return {
      shouldReply: true,
      kind: "direct",
      reason: "sender-role-trigger",
      intent: detected.intent,
      replyText: pickRandom(senderPool, rng),
      senderRole: role,
      cooldownMs: DIRECT_MENTION_COOLDOWN_MS,
    };
  }
  if (detected.strength === "direct") {
    const generated = semanticReply(detected.intent, text, rng);
    return {
      shouldReply: true,
      kind: "direct",
      reason: "lore-identity",
      intent: detected.intent,
      replyText: generated.text,
      mentionTarget: generated.mentionTarget,
      fallbackName: generated.fallbackName,
      cooldownMs: DIRECT_MENTION_COOLDOWN_MS,
    };
  }
  if (detected.strength === "plate") {
    const generated = semanticReply(detected.intent, text, rng);
    return {
      shouldReply: true,
      kind: "plate",
      reason: "plate-trigger",
      intent: detected.intent,
      replyText: generated.text,
      mentionTarget: generated.mentionTarget,
      fallbackReplyText: generated.fallbackReplyText,
      cooldownMs: PLATE_MENTION_COOLDOWN_MS,
    };
  }
  if (detected.strength === "contextual" && [...text].length > 40) {
    return {shouldReply: false, reason: "ambient-message-too-long", intent: detected.intent};
  }
  if (detected.strength === "owner-alias") {
    const probability = [...text].length <= 20 ? OWNER_ALIAS_PROBABILITY : OWNER_ALIAS_LONG_PROBABILITY;
    if (rng() >= probability) {
      return {shouldReply: false, reason: "ambient-not-selected", intent: detected.intent};
    }
  } else if (!shouldAmbientReply({triggerStrength: detected.strength, rng})) {
    return {shouldReply: false, reason: "ambient-not-selected", intent: detected.intent};
  }
  const semanticIntents = new Set(["ownerAlias", "leaderAlias", "japaneseName"]);
  const generated = semanticIntents.has(detected.intent) ?
    semanticReply(detected.intent, text, rng) :
    generateDirectMentionReply({text, hourTaipei, senderRole: role, isOwner, isLeader, rng});
  const reasons = {
    strong: "strong-trigger",
    contextual: "contextual-trigger",
    "owner-alias": "owner-alias-trigger",
    "leader-alias": "leader-alias-trigger",
    japanese: "japanese-trigger",
  };
  return {
    shouldReply: true,
    kind: "ambient",
    reason: reasons[detected.strength] || "ambient-trigger",
    intent: detected.intent,
    replyText: generated.text,
    night: Boolean(generated.night),
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

function senderCommandPool(senderRole, command, status) {
  if (status !== "success") return null;
  const pools = MIAOBING_RESPONSES.role[senderRole];
  if (!pools) return null;
  const commandKeys = {"admin-bind": "adminBind", "admin-unbind": "adminUnbind"};
  return pools[commandKeys[command] || command] || pools.commandSuccess || null;
}

function decorateCommandReply({
  command,
  status = "success",
  coreText,
  senderRole = SENDER_ROLES.MEMBER,
  rng = Math.random,
  flavorProbability = COMMAND_FLAVOR_PROBABILITY,
}) {
  const core = String(coreText || "").trim();
  if (!core || rng() >= flavorProbability) return core;
  const opening = pickRandom(senderCommandPool(senderRole, command, status) ||
    commandPool(command, status), rng);
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
  JAPANESE_NAME_PROBABILITY,
  LEADER_ALIAS_PROBABILITY,
  MIAOBING_LORE,
  MIAOBING_RESPONSES,
  OWNER_ALIAS_LONG_PROBABILITY,
  OWNER_ALIAS_PROBABILITY,
  PLATE_MENTION_COOLDOWN_MS,
  SENDER_ROLES,
  decorateCommandReply,
  detectMiaobingIntent,
  detectPersonalityControl,
  generateDirectMentionReply,
  getTaipeiHour,
  isBotMentioned,
  isCooldownElapsed,
  isJapaneseNameCandidate,
  isOwnerAliasCandidate,
  isPersonalityEnabled,
  isPlateCandidate,
  mentionsMiaobingName,
  personalityUserKey,
  pickRandom,
  planMiaobingMessage,
  planPersonalityControl,
  responsePoolStats,
  shouldAmbientReply,
};
