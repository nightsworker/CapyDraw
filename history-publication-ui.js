(function attachHistoryPublicationUi(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.CapyDrawHistoryPublicationUi = api;
})(typeof globalThis === "object" ? globalThis : this, function createHistoryPublicationUi() {
  "use strict";

  function isLinePublishedRecord(record) {
    if (!record || typeof record !== "object") return false;
    const sentAt = String(record.lineSentAt || "").trim();
    const sendCount = Number(record.lineSendCount);
    return Boolean(sentAt && Number.isFinite(Date.parse(sentAt)) &&
      Number.isFinite(sendCount) && sendCount > 0);
  }

  function getLinePublicationView(record, {isAdmin = false} = {}) {
    const published = isLinePublishedRecord(record);
    return {
      published,
      statusText: published ? "✅ 已發布" : "⚠️ 無發布紀錄",
      showBackfillAction: Boolean(isAdmin) && !published,
    };
  }

  function buildLinePublicationBackfillRequest(record) {
    const recordId = record && typeof record.id === "string" ? record.id.trim() : "";
    if (!recordId) throw new Error("找不到可補登的歷史紀錄 ID。");
    return {
      endpoint: "backfillDrawLinePublished",
      body: {recordId},
    };
  }

  return {
    buildLinePublicationBackfillRequest,
    getLinePublicationView,
    isLinePublishedRecord,
  };
});
