"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  buildLinePublicationBackfillRequest,
  getLinePublicationView,
  isLinePublishedRecord,
} = require("../../history-publication-ui");

test("history publication status requires a valid lineSentAt and positive lineSendCount", () => {
  assert.equal(isLinePublishedRecord({
    lineSentAt: "2026-08-13T10:00:00.000Z",
    lineSendCount: 1,
  }), true);
  assert.equal(isLinePublishedRecord({
    lineSentAt: "2026-08-13T10:00:00.000Z",
    lineSendCount: 0,
  }), false);
  assert.equal(isLinePublishedRecord({lineSendCount: 1}), false);
  assert.equal(isLinePublishedRecord({lineSentAt: "not-a-date", lineSendCount: 1}), false);
});

test("an unpublished future record shows backfill only to an authorized admin", () => {
  const futureRecord = {id: "legacy", date: "2099-12-31"};
  assert.deepEqual(getLinePublicationView(futureRecord, {isAdmin: true}), {
    published: false,
    statusText: "⚠️ 無發布紀錄",
    showBackfillAction: true,
  });
  assert.deepEqual(getLinePublicationView(futureRecord, {isAdmin: false}), {
    published: false,
    statusText: "⚠️ 無發布紀錄",
    showBackfillAction: false,
  });
});

test("a published record shows its status and never offers backfill", () => {
  assert.deepEqual(getLinePublicationView({
    id: "published",
    lineSentAt: "2026-08-13T10:00:00.000Z",
    lineSendCount: 2,
  }, {isAdmin: true}), {
    published: true,
    statusText: "✅ 已發布",
    showBackfillAction: false,
  });
});

test("backfill request uses record.id and only targets backfillDrawLinePublished", () => {
  const request = buildLinePublicationBackfillRequest({id: "  legacy-record-id  "});
  assert.deepEqual(request, {
    endpoint: "backfillDrawLinePublished",
    body: {recordId: "legacy-record-id"},
  });
  assert.equal(JSON.stringify(request).includes("sendDrawToLine"), false);
  assert.throws(() => buildLinePublicationBackfillRequest({}), /歷史紀錄 ID/u);
});

test("frontend backfill handler does not send LINE or write publication metadata directly", () => {
  const indexPath = path.resolve(__dirname, "../../index.html");
  const source = fs.readFileSync(indexPath, "utf8");
  const handler = source.match(
    /async function backfillLegacyLinePublication[\s\S]*?(?=\n    function renderLineGroups)/u,
  );
  assert.ok(handler, "backfill handler should exist");
  assert.match(handler[0], /callLineAdminFunction\(request\.endpoint/u);
  assert.doesNotMatch(handler[0], /sendDrawToLine|\bcallLine\s*\(|\/message\/push/u);
  assert.doesNotMatch(handler[0], /lineSentAt\s*=|lineSendCount\s*=|lastLineSendStatus\s*=/u);
});
