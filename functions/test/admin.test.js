"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {assertAdminUid, getAdminUids} = require("../lib/admin");

test("UID_A in the admin allowlist is accepted", () => {
  assert.equal(getAdminUids("UID_A,UID_B").has("UID_A"), true);
  assert.doesNotThrow(() => assertAdminUid("UID_A", "UID_A,UID_B"));
});

test("UID_B in the admin allowlist is accepted", () => {
  assert.equal(getAdminUids("UID_A,UID_B").has("UID_B"), true);
  assert.doesNotThrow(() => assertAdminUid("UID_B", "UID_A,UID_B"));
});

test("UID_C outside the admin allowlist is rejected with 403", () => {
  assert.throws(
    () => assertAdminUid("UID_C", "UID_A,UID_B"),
    (error) => error.status === 403,
  );
});

test("setLineBotAdmin authorization rejects a non-admin Firebase user with 403", () => {
  assert.throws(
    () => assertAdminUid("UID_MEMBER", "UID_ADMIN_A,UID_ADMIN_B"),
    (error) => error.status === 403,
  );
});

test("LINE group management rejects a non-admin Firebase user with 403", () => {
  assert.throws(
    () => assertAdminUid("UID_MEMBER", "UID_ADMIN_A,UID_ADMIN_B"),
    (error) => error.status === 403,
  );
});

test("spaces around comma-separated admin UIDs are ignored", () => {
  const adminUids = getAdminUids("UID_A, UID_B");
  assert.deepEqual([...adminUids], ["UID_A", "UID_B"]);
  assert.doesNotThrow(() => assertAdminUid("UID_B", "UID_A, UID_B"));
});

test("a single admin UID preserves the existing behavior", () => {
  assert.doesNotThrow(() => assertAdminUid("UID_A", "UID_A"));
  assert.throws(
    () => assertAdminUid("UID_B", "UID_A"),
    (error) => error.status === 403,
  );
});
