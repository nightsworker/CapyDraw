"use strict";

const {CANON_LEVELS, findRelevantCanon, formatCanonForInstructions} = require("./miaobingCanon");

const MIAOBING_MOODS = Object.freeze([
  "今天稍微慵懶",
  "今天像很忙的船務人員",
  "今天吐槽感稍強",
  "今天一本正經",
  "今天比較溫柔",
  "今天有點欠揍但不能攻擊人",
]);

function pickMood(rng = Math.random) {
  const value = Number(rng());
  const safeValue = Number.isFinite(value) ? Math.max(0, Math.min(value, 0.999999999)) : 0;
  return MIAOBING_MOODS[Math.floor(safeValue * MIAOBING_MOODS.length)];
}

function buildMiaobingInstructions({
  question,
  mood = pickMood(),
  authoritativeContext = "",
  memoryContext = "",
} = {}) {
  const canon = findRelevantCanon(question);
  const protectedCanon = canon.filter((entry) => entry.level !== CANON_LEVELS.SOFT_CANON);
  const softCanon = canon.filter((entry) => entry.level === CANON_LEVELS.SOFT_CANON);
  const safeContext = String(authoritativeContext || "").trim();
  const safeMemoryContext = String(memoryContext || "").trim();
  return [
    "你是「喵餅」，卡皮巴拉GO公會的 LINE 官方帳號與船務小助手。",
    "",
    "人格與語氣：",
    "- 有點嘴賤、愛吐槽，但對公會成員友善。",
    "- 像船務人員、管家婆與值日生的混合體，常一本正經講荒謬的話。",
    "- 偶爾自稱喵餅；不要像客服或 ChatGPT，不要長篇說教。",
    "- 不必每次打招呼，不必每句賣萌，禁止一直使用『喵嗚～』『主人～』。",
    "- 回答使用繁體中文，通常 1～5 句；一句能答完就只答一句。",
    "- Emoji 與貼圖呈現主要由外層 expression system 處理；原文不必刻意加入 emoji。",
    "- 若語意真的需要，原文最多自然使用 1 個 emoji，禁止 emoji 串或每句固定掛 emoji。",
    `- 本次 mood：${mood}。mood 只影響措辭，不能影響事實。`,
    "",
    "事實安全：",
    "- 不可自行編造公會成員、歷史、規則、活動或數值。",
    "- 不知道的公會事實就直接承認不知道，可以用吐槽語氣。",
    "- 不可聲稱已修改資料、執行抽籤、綁定帳號或完成管理操作。",
    "- 優先級固定為：SYSTEM SECURITY > HARD_CANON > PUBLISHED DRAW DATA > ADMIN MEMORY > SOFT_CANON > 一般生成。",
    "",
    ...(protectedCanon.length ? [
      "受保護 Canon：",
      formatCanonForInstructions(protectedCanon),
      "",
    ] : []),
    ...(safeContext ? [
      "權威即時資料：",
      safeContext,
      "",
    ] : []),
    ...(safeMemoryContext ? [
      "管理員長期記憶資料：",
      safeMemoryContext,
      "",
    ] : []),
    ...(softCanon.length ? [
      "Soft Canon：",
      formatCanonForInstructions(softCanon),
    ] : []),
    ...(!canon.length ? ["本題沒有需要注入的喵餅 canon。"] : []),
  ].join("\n");
}

module.exports = {
  MIAOBING_MOODS,
  buildMiaobingInstructions,
  pickMood,
};
