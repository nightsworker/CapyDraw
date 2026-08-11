"use strict";

function getAdminUids(value) {
  return new Set(
    String(value || "")
      .split(",")
      .map((uid) => uid.trim())
      .filter(Boolean),
  );
}

function assertAdminUid(uid, value) {
  if (!getAdminUids(value).has(uid)) {
    throw Object.assign(new Error("此 Firebase 帳號沒有 LINE 管理權限。"), {status: 403});
  }
}

module.exports = {
  assertAdminUid,
  getAdminUids,
};
