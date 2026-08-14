"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildLineErrorLog,
  safeLineEndpoint,
  safePendingIds,
} = require("../lib/lineApiDiagnostics");

test("Reply errors retain only safe LINE response diagnostics", () => {
  const log = buildLineErrorLog({
    path: "/message/reply",
    status: 400,
    errorBody: {
      message: "Invalid reply token",
      details: [{message: "May not be empty", property: "messages[0].text"}],
      replyToken: "reply-token-secret",
      authorization: "Bearer channel-access-token",
      userId: "U_RAW_USER",
      groupId: "C_RAW_GROUP",
    },
    messageCount: 2,
    elapsedMs: 37,
    pendingIds: ["a_safePending_1", "bad/id", "a_safePending_2"],
  });
  assert.deepEqual(log, {
    endpoint: "reply",
    status: 400,
    lineErrorMessage: "Invalid reply token",
    details: [{message: "May not be empty", property: "messages[0].text"}],
    messageCount: 2,
    elapsedMs: 37,
    pendingIds: ["a_safePending_1", "a_safePending_2"],
  });
  const serialized = JSON.stringify(log);
  assert.doesNotMatch(serialized,
    /reply-token-secret|channel-access-token|U_RAW_USER|C_RAW_GROUP/u);
});

test("LINE diagnostics bound counts and tolerate a non-JSON response body", () => {
  assert.equal(safeLineEndpoint("/message/push"), "push");
  assert.equal(safeLineEndpoint("/group/C_SECRET/member/U_SECRET"), "other");
  assert.deepEqual(safePendingIds(["valid", "", "unsafe/id"]), ["valid"]);
  assert.deepEqual(buildLineErrorLog({
    path: "/message/reply",
    status: 429,
    errorBody: null,
    messageCount: 99,
    elapsedMs: -1,
  }), {
    endpoint: "reply",
    status: 429,
    lineErrorMessage: null,
    details: [],
    messageCount: 5,
    elapsedMs: 0,
    pendingIds: [],
  });
});
