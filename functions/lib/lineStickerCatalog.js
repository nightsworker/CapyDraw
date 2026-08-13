"use strict";

// Source of truth: LINE Developers, "Stickers" / Messaging API sticker list.
// https://developers.line.biz/en/docs/messaging-api/sticker-list/
// Verified 2026-08-13. Only package/sticker pairs shown in the official
// Sticker definitions are included here.
const LINE_STICKER_SOURCE = "https://developers.line.biz/en/docs/messaging-api/sticker-list/";
const LINE_STICKER_VERIFIED_AT = "2026-08-13";

function sticker(entry) {
  return Object.freeze({
    ...entry,
    moods: Object.freeze([...entry.moods]),
    tags: Object.freeze([...entry.tags]),
  });
}

const LINE_STICKER_CATALOG = Object.freeze([
  sticker({packageId: "6362", stickerId: "11087920", moods: ["happy", "work"],
    tags: ["greeting", "celebration", "success"], weight: 1}),
  sticker({packageId: "6362", stickerId: "11087921", moods: ["work", "annoyed"],
    tags: ["work", "unimpressed"], weight: 1}),
  sticker({packageId: "6362", stickerId: "11087922", moods: ["work", "happy"],
    tags: ["work", "greeting", "success"], weight: 1}),
  sticker({packageId: "6362", stickerId: "11087923", moods: ["sleepy", "tired"],
    tags: ["goodnight", "tired"], weight: 1.2}),
  sticker({packageId: "6362", stickerId: "11087924", moods: ["warm", "food"],
    tags: ["comfort", "food", "thanks"], weight: 1}),

  sticker({packageId: "6632", stickerId: "11825374", moods: ["warm", "sleepy"],
    tags: ["apology", "goodnight", "tired"], weight: 1}),
  sticker({packageId: "6632", stickerId: "11825375", moods: ["warm"],
    tags: ["comfort", "hug", "apology"], weight: 1.2}),
  sticker({packageId: "6632", stickerId: "11825376", moods: ["cute", "happy", "warm"],
    tags: ["thanks", "compliment", "love"], weight: 1}),
  sticker({packageId: "6632", stickerId: "11825377", moods: ["annoyed", "surprised"],
    tags: ["apology", "annoyed", "surprised"], weight: 1}),
  sticker({packageId: "6632", stickerId: "11825378", moods: ["warm"],
    tags: ["apology", "thanks"], weight: 1}),

  sticker({packageId: "8525", stickerId: "16581290", moods: ["happy", "work"],
    tags: ["success", "greeting", "thanks"], weight: 1}),
  sticker({packageId: "8525", stickerId: "16581291", moods: ["warm", "happy"],
    tags: ["thanks", "compliment"], weight: 1.2}),
  sticker({packageId: "8525", stickerId: "16581292", moods: ["cute", "playful"],
    tags: ["compliment", "calling"], weight: 1}),
  sticker({packageId: "8525", stickerId: "16581293", moods: ["happy", "playful"],
    tags: ["greeting", "success", "laugh"], weight: 1}),
  sticker({packageId: "8525", stickerId: "16581294", moods: ["surprised", "playful"],
    tags: ["calling", "surprised", "annoyed"], weight: 1}),

  sticker({packageId: "11537", stickerId: "52002734", moods: ["happy", "work"],
    tags: ["celebration", "success", "greeting"], weight: 1}),
  sticker({packageId: "11537", stickerId: "52002735", moods: ["happy", "playful"],
    tags: ["laugh", "greeting", "compliment"], weight: 1.1}),
  sticker({packageId: "11537", stickerId: "52002736", moods: ["cute", "warm"],
    tags: ["thanks", "love", "compliment"], weight: 1}),
  sticker({packageId: "11537", stickerId: "52002737", moods: ["warm", "cute"],
    tags: ["hug", "pet", "comfort"], weight: 1}),
  sticker({packageId: "11537", stickerId: "52002738", moods: ["playful", "happy"],
    tags: ["calling", "greeting", "surprised"], weight: 1.1}),
]);

function stickerKey(value) {
  const packageId = String(value && value.packageId || "");
  const stickerId = String(value && value.stickerId || "");
  return packageId && stickerId ? `${packageId}:${stickerId}` : "";
}

const ALLOWLISTED_STICKER_KEYS = new Set(LINE_STICKER_CATALOG.map(stickerKey));

function isAllowlistedLineSticker(value) {
  return ALLOWLISTED_STICKER_KEYS.has(stickerKey(value));
}

function buildLineStickerMessage(value) {
  if (!isAllowlistedLineSticker(value)) return null;
  return {
    type: "sticker",
    packageId: String(value.packageId),
    stickerId: String(value.stickerId),
  };
}

module.exports = {
  LINE_STICKER_CATALOG,
  LINE_STICKER_SOURCE,
  LINE_STICKER_VERIFIED_AT,
  buildLineStickerMessage,
  isAllowlistedLineSticker,
  stickerKey,
};
