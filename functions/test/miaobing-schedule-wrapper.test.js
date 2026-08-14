"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  WRAPPER_FALLBACK,
  WRAPPER_MAX_CHARS,
  cleanWrapperPart,
  createScheduleWrapper,
  generateMiaobingScheduleWrapper,
  parseScheduleWrapper,
} = require("../lib/miaobingScheduleWrapper");

test("schedule wrapper uses one structured Responses API call with existing model settings", async () => {
  const requests = [];
  const result = await generateMiaobingScheduleWrapper({
    apiKey: "fake-key",
    coreText: "@ALL 明天第四船艙捐滿三張船票",
    client: {responses: {create: async (request) => {
      requests.push(request);
      return {status: "completed", output_text: JSON.stringify({intro: "先提醒一下。", outro: "記得交作業。"}),
        usage: {output_tokens: 20, output_tokens_details: {reasoning_tokens: 2}}};
    }}},
    rng: () => 0,
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].model, "gpt-5-mini");
  assert.deepEqual(requests[0].reasoning, {effort: "minimal"});
  assert.equal(requests[0].text.format.type, "json_schema");
  assert.equal(requests[0].store, false);
  assert.equal(result.wrapper.intro, "先提醒一下。");
  assert.equal(result.wrapper.outro, "記得交作業。");
});

test("wrapper parser allows intro-only, outro-only, or both but rejects empty", () => {
  assert.deepEqual(parseScheduleWrapper('{"intro":"提醒。","outro":""}', "mood"), {
    intro: "提醒。", outro: "", mood: "mood",
  });
  assert.equal(parseScheduleWrapper('{"intro":"","outro":""}'), null);
  assert.equal(parseScheduleWrapper("not-json"), null);
});

test("wrapper stays short and passes the profanity guard", () => {
  const value = cleanWrapperPart(`幹你娘 ${"很長".repeat(100)}`);
  assert.ok(value.length <= WRAPPER_MAX_CHARS);
  assert.doesNotMatch(value, /幹你娘/u);
});

test("OpenAI failure or empty output returns deterministic wrapper without blocking core", async () => {
  const failed = await createScheduleWrapper({
    apiKey: "fake", coreText: "核心",
    reserveUsage: async () => ({allowed: true}),
    generate: async () => { throw Object.assign(new Error("down"), {code: "openai_down"}); },
  });
  assert.equal(failed.usedFallback, true);
  assert.equal(failed.intro, WRAPPER_FALLBACK.intro);
  assert.equal(failed.openAiCalls, 1);
  const empty = await createScheduleWrapper({
    apiKey: "fake", coreText: "核心",
    reserveUsage: async () => ({allowed: true}),
    generate: async () => ({wrapper: null}),
  });
  assert.equal(empty.reason, "empty-output");
});

test("daily cap or rate limit skips OpenAI and still returns a wrapper", async () => {
  let calls = 0;
  const result = await createScheduleWrapper({
    apiKey: "fake", coreText: "核心",
    reserveUsage: async () => ({allowed: false, reason: "daily-limit"}),
    generate: async () => { calls += 1; },
  });
  assert.equal(calls, 0);
  assert.equal(result.reason, "daily-limit");
  assert.equal(result.openAiCalls, 0);
  assert.ok(result.intro || result.outro);
});

test("wrapper request has no conversation or long-term memory injection", async () => {
  let request;
  await generateMiaobingScheduleWrapper({
    apiKey: "fake", coreText: "一般活動提醒",
    client: {responses: {create: async (value) => {
      request = value;
      return {status: "completed", output_text: '{"intro":"提醒。","outro":""}'};
    }}},
  });
  const payload = JSON.stringify(request);
  assert.doesNotMatch(payload, /CURRENT USER:|aiConversation|aiMemory/u);
  assert.match(request.instructions, /核心公告由程式另外組裝/u);
});
