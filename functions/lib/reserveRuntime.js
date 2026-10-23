"use strict";

const plans = require("./reservePlans");
const {buildDrawLineMessage} = require("./line");

async function syncReservePlans(mainRef, now = new Date()) {
  return mainRef.transaction(current => {
    // A new Admin SDK instance starts with an empty local cache. Returning
    // null keeps the transaction alive so the server can retry with real data.
    if (current === null) return null;
    if (!current || (!Object.keys(current.members || {}).length && !(current.guildMembers || []).length)) return;
    const working = JSON.parse(JSON.stringify(current));
    plans.ensure(working, {now});
    return JSON.stringify(working) === JSON.stringify(current) ? undefined : working;
  });
}

function renderPendingDraw(record, item, bindings, groupId) {
  const {message} = buildDrawLineMessage(record, bindings || {}, groupId, {useCurrentReserves: true});
  const originalText = item.message && item.message.text || "";
  const prefix = originalText.includes("\n\n") ? originalText.split("\n\n")[0] : "";
  return {
    ...item,
    message: {...message, text: prefix ? `${prefix}\n\n${message.text}` : message.text},
    reserveSnapshot: {
      names: record.reserves || [],
      identity: record.memberIdentity && record.memberIdentity.reserves || record.reserves || [],
    },
  };
}

module.exports = {syncReservePlans, renderPendingDraw};
