"use strict";

const DISALLOWED_PROFANITY = Object.freeze([
  /幹你(?:娘|媽)/giu,
  /(?:操|肏)你(?:媽|娘)/giu,
  /草泥馬/giu,
  /去你媽(?:的)?/giu,
  /他媽的|媽的/giu,
  /靠北|靠邀/giu,
  /(?:雞|機)掰/giu,
  /(?:雞巴|懶叫)/giu,
  /(?:臭)?婊子|賤貨/giu,
  /去死/giu,
]);

function containsDisallowedProfanity(value) {
  const text = String(value || "");
  return DISALLOWED_PROFANITY.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
}

function sanitizeDisallowedProfanity(value) {
  let text = String(value || "");
  const replacements = [
    [/幹你(?:娘|媽)|(?:操|肏)你(?:媽|娘)|草泥馬|去你媽(?:的)?/giu, "你真的很煩耶"],
    [/他媽的|媽的/giu, "真是的"],
    [/靠北|靠邀/giu, "少來"],
    [/(?:雞|機)掰|(?:雞巴|懶叫)/giu, "難搞"],
    [/(?:臭)?婊子|賤貨/giu, "討厭鬼"],
    [/去死/giu, "走開啦"],
  ];
  for (const [pattern, replacement] of replacements) text = text.replace(pattern, replacement);
  return text.replace(/\s{2,}/gu, " ").trim();
}

function redactDisallowedProfanity(value) {
  let text = String(value || "");
  for (const pattern of DISALLOWED_PROFANITY) {
    pattern.lastIndex = 0;
    text = text.replace(pattern, "[粗俗用語]");
  }
  return text.replace(/\s{2,}/gu, " ").trim();
}

function applyMiaobingStyleGuard(value) {
  const original = String(value || "").trim();
  if (!original) return {text: "", profanityDetected: false, sanitized: false};
  const profanityDetected = containsDisallowedProfanity(original);
  const text = profanityDetected ? sanitizeDisallowedProfanity(original) : original;
  return {
    text: text || "少來。本喵不說那種話。",
    profanityDetected,
    sanitized: profanityDetected,
  };
}

module.exports = {
  DISALLOWED_PROFANITY,
  applyMiaobingStyleGuard,
  containsDisallowedProfanity,
  redactDisallowedProfanity,
  sanitizeDisallowedProfanity,
};
