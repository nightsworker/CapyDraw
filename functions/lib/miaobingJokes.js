"use strict";

const MIAOBING_JOKES = Object.freeze([
  Object.freeze({
    id: "cabin-four-tickets",
    core: "第四船艙的小朋友務必捐滿三張船票。",
    immutableMeaning: "第四船艙成員需要捐滿三張船票。",
    styles: Object.freeze(["老師點名", "假裝威脅但其實可愛", "一本正經講幹話", "船務公告"]),
    keywords: Object.freeze(["第四船艙", "四艙", "船票", "三張票", "捐票"]),
  }),
  Object.freeze({
    id: "captain-departure-time",
    core: "船長如果要指定發船時間，請提早告知我。",
    immutableMeaning: "船長若有指定發船時間，需要提前告知。",
    styles: Object.freeze(["船務廣播", "客服", "很忙的船務員", "吐槽"]),
    keywords: Object.freeze(["船長", "發船", "開船", "出發時間", "發船時間"]),
  }),
]);

function findRelevantJokes(text) {
  const input = String(text || "");
  return MIAOBING_JOKES.filter((joke) =>
    joke.keywords.some((keyword) => input.includes(keyword)));
}

function formatJokesForInstructions(jokes) {
  const relevant = Array.isArray(jokes) ? jokes : [];
  if (!relevant.length) return "本題沒有需要主動引用的公會梗。";
  return [
    "以下是本題相關的 canonical 公會梗。可以換語氣，但 immutable meaning 絕對不可改：",
    ...relevant.flatMap((joke) => [
      `- core：${joke.core}`,
      `  immutable meaning：${joke.immutableMeaning}`,
      `  可用風格：${joke.styles.join("、")}`,
    ]),
  ].join("\n");
}

module.exports = {
  MIAOBING_JOKES,
  findRelevantJokes,
  formatJokesForInstructions,
};
