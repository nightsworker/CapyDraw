(function attachLineSchedulesUi(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.CapyDrawLineSchedulesUi = api;
})(typeof globalThis === "object" ? globalThis : this, function createLineSchedulesUi() {
  "use strict";

  const WEEKDAY_LABELS = Object.freeze(["一", "二", "三", "四", "五", "六", "日"]);

  function parseDateKey(value) {
    const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function addDays(value, days) {
    const date = parseDateKey(value);
    if (!date) return "";
    date.setUTCDate(date.getUTCDate() + Number(days || 0));
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-` +
      `${String(date.getUTCDate()).padStart(2, "0")}`;
  }

  function formatDateToken(dateKey, offsetDays, format) {
    const value = addDays(dateKey, offsetDays);
    const date = parseDateKey(value);
    if (!date) return "日期無效";
    const month = date.getUTCMonth() + 1;
    const day = date.getUTCDate();
    return format === "YYYY/MM/DD" ?
      `${date.getUTCFullYear()}/${String(month).padStart(2, "0")}/${String(day).padStart(2, "0")}` :
      `${month}/${day}`;
  }

  function templateTokenLabel(token) {
    if (!token || typeof token !== "object") return "無效內容";
    if (token.type === "text") return token.text;
    if (token.type === "all") return "@ALL";
    if (token.type === "member") return token.display || "@成員";
    if (token.type === "date") {
      const offset = Number(token.offsetDays) || 0;
      return `日期 ${offset >= 0 ? "+" : ""}${offset}天（${token.format || "M/D"}）`;
    }
    return "無效內容";
  }

  function previewTemplate(tokens, occurrenceDate) {
    return (Array.isArray(tokens) ? tokens : []).map((token) => {
      if (token.type === "text") return String(token.text || "");
      if (token.type === "all") return "@ALL";
      if (token.type === "member") return String(token.display || "@成員");
      if (token.type === "date") {
        return formatDateToken(occurrenceDate, token.offsetDays, token.format);
      }
      return "";
    }).join("");
  }

  function recurrenceLabel(schedule) {
    const recurrence = schedule && schedule.recurrence || {};
    if (recurrence.type === "daily") return "每天";
    if (["weekly", "biweekly"].includes(recurrence.type)) {
      const weekdays = (recurrence.weekdays || []).map((day) => WEEKDAY_LABELS[Number(day) - 1])
        .filter(Boolean).join("、");
      return `${recurrence.type === "weekly" ? "每週" : "每雙週"} ${weekdays}`;
    }
    if (recurrence.type === "monthly") return `每月 ${recurrence.dayOfMonth} 日（缺日取月底）`;
    return "未知";
  }

  function runStatusLabel(status) {
    const labels = {
      sent: "✅ 已發送",
      "sent-via-reply": "✅ 已透過 Reply 發布",
      "queued-for-reply": "⏳ 等待群組訊息後免費回覆",
      "waiting-for-draw": "⏳ 等待抽籤",
      "skipped-already-published": "✅ 已由其他方式發布",
      "expired-no-draw": "⌛ 到期仍無抽籤",
      "ambiguous-draw-records": "⚠️ 同日期多筆，已停止",
      "failed-retryable": "🔄 等待重試",
      failed: "❌ 排入失敗",
      expired: "⌛ 已錯過執行日",
      sending: "📥 排入公告中",
      checking: "🔎 檢查中",
    };
    return labels[status] || (status ? `ℹ️ ${status}` : "尚未執行");
  }

  function buildScheduleRequest(values) {
    const source = values && typeof values === "object" ? values : {};
    return {
      name: String(source.name || "").trim(),
      enabled: source.enabled !== false,
      messageTemplate: (Array.isArray(source.messageTemplate) ? source.messageTemplate : [])
        .map((token) => ({...token})),
      startDate: String(source.startDate || ""),
      endDate: source.endDate ? String(source.endDate) : null,
      recurrence: {
        type: String(source.recurrenceType || "daily"),
        weekdays: (Array.isArray(source.weekdays) ? source.weekdays : []).map(Number),
        dayOfMonth: source.dayOfMonth === null || source.dayOfMonth === undefined ?
          null : Number(source.dayOfMonth),
      },
      time: String(source.time || ""),
    };
  }

  return {
    WEEKDAY_LABELS,
    addDays,
    buildScheduleRequest,
    formatDateToken,
    previewTemplate,
    recurrenceLabel,
    runStatusLabel,
    templateTokenLabel,
  };
});
