"use strict";

const MEMORY_ACTIONS = Object.freeze({
  CREATE_FACT: "create_fact",
  CREATE_EXACT_REPLY: "create_exact_reply",
  CREATE_INSTRUCTION: "create_instruction",
  UPDATE: "update",
  FORGET: "forget",
  LIST: "list",
  QUERY: "query_memory",
});

function cleanMemoryText(value, limit = 300) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001F\u007F]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, limit);
}

function stripOuterQuotes(value) {
  let text = cleanMemoryText(value);
  const pairs = [["「", "」"], ["『", "』"], ["“", "”"], ["\"", "\""], ["'", "'"]];
  for (const [open, close] of pairs) {
    if (text.startsWith(open) && text.endsWith(close) && text.length > 1) {
      text = text.slice(open.length, -close.length).trim();
      break;
    }
  }
  return text.replace(/[。.!！]+$/gu, "").trim();
}

function stripTeachingPrefix(value) {
  return cleanMemoryText(value)
    .replace(/^\s*@?喵餅(?:[，,：:、。！？!?\s]*)/u, "")
    .trim();
}

function extractSubject(content) {
  const text = cleanMemoryText(content, 120)
    .replace(/^(?:關於|那個|這個)\s*/u, "")
    .replace(/^(?:更正一下|更正|改成)\s*[，,：:]?\s*/u, "");
  const match = text.match(/^(.{1,40}?)(?=其實|原來|並不|不會|不是|不喜歡|很|是|會|有|怕|愛|喜歡|討厭|需要|只要)/u);
  if (match) return cleanMemoryText(match[1], 40);
  const first = text.split(/[，,。.!！?？：:\s]/u)[0];
  return cleanMemoryText(first, 40);
}

function parseRuleTeaching(text) {
  const patterns = [
    /^(?:記住[，,：:\s]*)?以後(?:只要)?(?:有人)?(?:問|說|提到|聽到|遇到)\s*(.+?)\s*[，,]?\s*(?:你)?就(?:回答|回覆|回|說)\s*(.+)$/u,
    /^以後(?:只要)?(?:有人)?(?:問|說|提到|聽到|遇到)\s*(.+?)\s*[，,]?\s*(?:你)?就(?:回答|回覆|回|說)\s*(.+)$/u,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const trigger = stripOuterQuotes(match[1]);
    const response = stripOuterQuotes(match[2]);
    if (trigger && response) {
      return {action: MEMORY_ACTIONS.CREATE_EXACT_REPLY, trigger, response};
    }
  }

  const instructionMatch = text.match(
    /^(?:記住[，,：:\s]*)?以後(?:只要)?(?:有人)?(?:問|說|提到|聽到|遇到)\s*(.+?)\s*[，,]?\s*(?:你)?就\s*(.+)$/u,
  );
  if (!instructionMatch) return null;
  const trigger = stripOuterQuotes(instructionMatch[1]);
  const instruction = stripOuterQuotes(instructionMatch[2]);
  return trigger && instruction ?
    {action: MEMORY_ACTIONS.CREATE_INSTRUCTION, trigger, instruction} : null;
}

function parseMemoryTeachingAction(value) {
  const text = stripTeachingPrefix(value);
  if (!text) return null;

  if (/^列出我教過你的反應規則[。.!！?？]*$/u.test(text)) {
    return {action: MEMORY_ACTIONS.LIST, filter: "rules"};
  }
  if (/^(?:你現在)?記得哪些(?:事情|東西|記憶)?[？?]?$/u.test(text) ||
      /^列出(?:我教過你的)?(?:反應規則|記憶|事情)[。.!！?？]*$/u.test(text)) {
    return {action: MEMORY_ACTIONS.LIST, filter: "all"};
  }
  let match = text.match(/^你記得(.+?)什麼[？?]?$/u) ||
    text.match(/^你記得什麼關於(.+?)[？?]?$/u);
  if (match) {
    const searchTerms = stripOuterQuotes(match[1]);
    return searchTerms ? {action: MEMORY_ACTIONS.QUERY, searchTerms} : null;
  }

  match = text.match(/^(?:忘掉|忘記|不要再記)\s*(.+)$/u);
  if (match) {
    const target = stripOuterQuotes(match[1])
      .replace(/(?:這件事|那件事|這一件|那一件)$/u, "")
      .trim();
    if (/^(?:剛才|剛剛|上一條|剛才那條|剛剛那條)$/u.test(target)) {
      return {action: MEMORY_ACTIONS.FORGET, targetLast: true};
    }
    return target ? {
      action: MEMORY_ACTIONS.FORGET,
      subject: extractSubject(target),
      searchTerms: target,
    } : null;
  }

  match = text.match(/^(?:更正一下|更正|改成)\s*[，,：:]?\s*(.+)$/u);
  if (match) {
    const content = stripOuterQuotes(match[1]);
    return content ? {
      action: MEMORY_ACTIONS.UPDATE,
      subject: extractSubject(content),
      content,
      searchTerms: content,
    } : null;
  }

  const rule = parseRuleTeaching(text);
  if (rule) return rule;

  match = text.match(/^(?:記住|幫我記(?:一下)?|記一下|以後要記得)\s*[，,：:]?\s*(.+)$/u);
  if (match) {
    const content = stripOuterQuotes(match[1]);
    if (!content) return null;
    return {
      action: MEMORY_ACTIONS.CREATE_FACT,
      subject: extractSubject(content),
      content,
    };
  }
  return null;
}

function isPossibleMemoryTeaching(value) {
  const text = stripTeachingPrefix(value);
  if (!text) return false;
  return /^(?:記住|幫我記|記一下|以後要記得|更正|改成|把.+改掉|忘掉|忘記|不要再記|以後(?:只要)?(?:有人)?(?:問|說|提到|聽到|遇到)|你記得|列出)/u
    .test(text) || /記得哪些(?:事情|東西|記憶)/u.test(text);
}

function planAdminPrivateMemoryRoute({event, isAdmin = false} = {}) {
  if (!event || event.type !== "message" || !event.message || event.message.type !== "text" ||
      !event.source || event.source.type !== "user" || !event.source.userId) {
    return {shouldHandle: false, reason: "not-private-text"};
  }
  if (!isAdmin) return {shouldHandle: false, reason: "not-admin"};
  const text = String(event.message.text || "").trim();
  if (!isPossibleMemoryTeaching(text)) {
    return {shouldHandle: false, reason: "ordinary-private-chat"};
  }
  const memoryAction = parseMemoryTeachingAction(text);
  return memoryAction ?
    {shouldHandle: true, reason: "memory-action", memoryAction} :
    {shouldHandle: true, reason: "needs-clarification", memoryAction: null};
}

module.exports = {
  MEMORY_ACTIONS,
  cleanMemoryText,
  extractSubject,
  isPossibleMemoryTeaching,
  parseMemoryTeachingAction,
  planAdminPrivateMemoryRoute,
  stripTeachingPrefix,
};
