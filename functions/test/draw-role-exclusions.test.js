"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  ROLE_EXCLUSION_CONFIG,
  getRoleEligibleMembers,
  getRoleExclusionSet,
  normalizeRoleExclusions,
  renameRoleExclusions,
} = require("../../draw-role-exclusions");

const indexSource = fs.readFileSync(path.resolve(__dirname, "../../index.html"), "utf8");

function drawState(overrides = {}) {
  return {
    guildMembers: ["A", "B", "C", "D", "E", "F", "G", "H"],
    highWarMembers: ["A", "B", "C", "D", "E", "F"],
    captainPool: ["A", "B", "C", "D", "E", "F", "G", "H"],
    guardianPool: ["A", "B", "C", "D", "E", "F"],
    cabin4Pool: ["A", "B", "C", "D", "E", "F", "G", "H"],
    captainExcludedMembers: [],
    guardianExcludedMembers: [],
    cabin4ExcludedMembers: [],
    history: [{id: "past", captain: "A"}],
    ...overrides,
  };
}

test("captain exclusion removes only captain eligibility", () => {
  const state = drawState({captainExcludedMembers: ["A"]});
  assert.equal(getRoleEligibleMembers(state, "captain").includes("A"), false);
  assert.equal(getRoleEligibleMembers(state, "guardian").includes("A"), true);
  assert.equal(getRoleEligibleMembers(state, "cabin4").includes("A"), true);
});

test("guardian exclusion removes only guardian eligibility", () => {
  const state = drawState({guardianExcludedMembers: ["B"]});
  assert.equal(getRoleEligibleMembers(state, "guardian").includes("B"), false);
  assert.equal(getRoleEligibleMembers(state, "captain").includes("B"), true);
  assert.equal(getRoleEligibleMembers(state, "cabin4").includes("B"), true);
});

test("cabin4 exclusion removes only cabin eligibility", () => {
  const state = drawState({cabin4ExcludedMembers: ["C"]});
  assert.equal(getRoleEligibleMembers(state, "cabin4").includes("C"), false);
  assert.equal(getRoleEligibleMembers(state, "captain").includes("C"), true);
  assert.equal(getRoleEligibleMembers(state, "guardian").includes("C"), true);
});

test("one member may be excluded from captain and guardian but remain cabin eligible", () => {
  const state = drawState({captainExcludedMembers: ["D"], guardianExcludedMembers: ["D"]});
  assert.equal(getRoleEligibleMembers(state, "captain").includes("D"), false);
  assert.equal(getRoleEligibleMembers(state, "guardian").includes("D"), false);
  assert.equal(getRoleEligibleMembers(state, "cabin4").includes("D"), true);
});

test("one member may be independently excluded from all three roles", () => {
  const state = drawState({
    captainExcludedMembers: ["E"], guardianExcludedMembers: ["E"],
    cabin4ExcludedMembers: ["E"],
  });
  for (const role of Object.keys(ROLE_EXCLUSION_CONFIG)) {
    assert.equal(getRoleEligibleMembers(state, role).includes("E"), false);
  }
});

test("removing an exclusion restores eligibility without changing its pool", () => {
  const pool = ["A", "B", "C"];
  const excluded = drawState({captainPool: pool, captainExcludedMembers: ["A"]});
  assert.equal(getRoleEligibleMembers(excluded, "captain").includes("A"), false);
  const restored = {...excluded, captainExcludedMembers: []};
  assert.equal(getRoleEligibleMembers(restored, "captain").includes("A"), true);
  assert.deepEqual(restored.captainPool, pool);
});

test("legacy state without new exclusion fields defaults to nobody excluded", () => {
  const legacy = drawState();
  delete legacy.captainExcludedMembers;
  delete legacy.guardianExcludedMembers;
  delete legacy.cabin4ExcludedMembers;
  const normalized = normalizeRoleExclusions(legacy);
  assert.deepEqual(normalized.captainExcludedMembers, []);
  assert.deepEqual(normalized.guardianExcludedMembers, []);
  assert.deepEqual(normalized.cabin4ExcludedMembers, []);
  assert.deepEqual(getRoleEligibleMembers(normalized, "captain"), legacy.guildMembers);
});

test("existing cabin4ExcludedMembers remains backward compatible", () => {
  const normalized = normalizeRoleExclusions(drawState({cabin4ExcludedMembers: ["F"]}));
  assert.deepEqual(normalized.cabin4ExcludedMembers, ["F"]);
  assert.equal(getRoleEligibleMembers(normalized, "cabin4").includes("F"), false);
});

test("legacy manual captainPool removal remains untouched by normalization", () => {
  const legacyPool = ["B", "C"];
  const normalized = normalizeRoleExclusions(drawState({captainPool: legacyPool}));
  assert.deepEqual(normalized.captainPool, legacyPool);
});

test("rename updates every role exclusion without cross-role leakage", () => {
  const renamed = renameRoleExclusions(drawState({
    captainExcludedMembers: ["A"], guardianExcludedMembers: ["B"],
    cabin4ExcludedMembers: ["C"],
  }), new Map([["A", "A2"], ["B", "B2"], ["C", "C2"]]));
  assert.deepEqual(renamed.captainExcludedMembers, ["A2"]);
  assert.deepEqual(renamed.guardianExcludedMembers, ["B2"]);
  assert.deepEqual(renamed.cabin4ExcludedMembers, ["C2"]);
});

test("member removal clears stale exclusions according to each role source", () => {
  const normalized = normalizeRoleExclusions(drawState({
    guildMembers: ["A", "B", "C"], highWarMembers: ["A"],
    captainExcludedMembers: ["A", "G"], guardianExcludedMembers: ["A", "B"],
    cabin4ExcludedMembers: ["C", "H"],
  }));
  assert.deepEqual(normalized.captainExcludedMembers, ["A"]);
  assert.deepEqual(normalized.guardianExcludedMembers, ["A"]);
  assert.deepEqual(normalized.cabin4ExcludedMembers, ["C"]);
});

test("all candidates excluded yields an empty eligible list without fallback", () => {
  const state = drawState({captainExcludedMembers: ["A", "B", "C", "D", "E", "F", "G", "H"]});
  assert.deepEqual(getRoleEligibleMembers(state, "captain"), []);
});

test("same-day exclusions merge with role exclusions", () => {
  const excluded = getRoleExclusionSet(drawState({guardianExcludedMembers: ["B"]}),
    "guardian", ["A"]);
  assert.deepEqual([...excluded].sort(), ["A", "B"]);
});

test("normalization and rename do not modify history or pool contents", () => {
  const state = drawState({captainExcludedMembers: ["A"]});
  const normalized = normalizeRoleExclusions(state);
  const renamed = renameRoleExclusions(normalized, new Map([["A", "A2"]]));
  assert.deepEqual(renamed.history, state.history);
  assert.deepEqual(renamed.captainPool, state.captainPool);
  assert.deepEqual(renamed.guardianPool, state.guardianPool);
  assert.deepEqual(renamed.cabin4Pool, state.cabin4Pool);
});

test("draw routing applies each role exclusion at the final eligibility step", () => {
  assert.match(indexSource,
    /pickOneFromPool\(working, "captainPool", working\.guildMembers,[\s\S]*?getRoleExclusionSet\(working, "captain"\)/u);
  assert.match(indexSource,
    /pickOneFromPool\(working, "guardianPool", working\.highWarMembers,[\s\S]*?getRoleExclusionSet\(working, "guardian", \[captain\]\)/u);
  assert.match(indexSource,
    /getRoleExclusionSet\(working, "cabin4", \[captain, guardian, \.\.\.cabin4\]\)/u);
});

test("adding an exclusion never removes the member from a role pool", () => {
  const handler = indexSource.match(
    /async function addRoleExcludedMember[\s\S]*?(?=\n    async function removeRoleExcludedMember)/u);
  assert.ok(handler);
  assert.match(handler[0], /state\[config\.exclusionField\]\.push\(selectedName\)/u);
  assert.doesNotMatch(handler[0], /state\[config\.poolField\].*filter|\.splice\(/u);
});

test("removing an exclusion does not reinsert or otherwise mutate a role pool", () => {
  const handler = indexSource.match(
    /async function removeRoleExcludedMember[\s\S]*?(?=\n    function openDetail)/u);
  assert.ok(handler);
  assert.match(handler[0], /state\[config\.exclusionField\] = state\[config\.exclusionField\]/u);
  assert.doesNotMatch(handler[0], /state\[config\.poolField\].*(?:push|filter|splice)/u);
});

test("pool reset keeps full role pools and leaves exclusion fields untouched", () => {
  const reset = indexSource.match(/\$\("resetPoolsBtn"\)[\s\S]*?(?=\n      \$\("deleteSelectedHistoryBtn")/u);
  assert.ok(reset);
  assert.match(reset[0], /captainPool = shuffle\(state\.guildMembers\)/u);
  assert.match(reset[0], /guardianPool = shuffle\(state\.highWarMembers\)/u);
  assert.match(reset[0], /cabin4Pool = shuffle\(state\.guildMembers\)/u);
  assert.doesNotMatch(reset[0], /ExcludedMembers\s*=/u);
});

test("UI exposes three separate authenticated role exclusion controls", () => {
  for (const role of ["captain", "guardian", "cabin4"]) {
    assert.match(indexSource, new RegExp(`id="${role}ExcludedAddSelect"`, "u"));
    assert.match(indexSource, new RegExp(`id="${role}ExcludedView"`, "u"));
    assert.match(indexSource,
      new RegExp(`<button[^>]*requires-auth[^>]*id="${role}ExcludedAddBtn"`, "u"));
  }
});

test("special-day fixed roles fail safely instead of bypassing exclusions", () => {
  assert.match(indexSource, /特別日固定守護目前在守護排除名單中/u);
  assert.match(indexSource, /特別日固定船艙 4 包含已排除成員/u);
});
