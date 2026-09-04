"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  ROLE_EXCLUSION_CONFIG,
  WEEKDAY_LABELS,
  getRoleEligibleMembers,
  getRoleExclusionSet,
  getRoleWeekdayRestrictedMemberIds,
  isDuplicateRoleWeekdayRestriction,
  listRoleWeekdayRestrictions,
  normalizeRoleExclusions,
  normalizeRoleWeekdayRestrictions,
  renameRoleExclusions,
  taipeiWeekday,
  validateRoleWeekdayRestriction,
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
    /pickOneFromPool\(working, "captainPool", working\.guildMembers,[\s\S]*?getRoleExclusionSet\(working, "captain", \[\], date\)/u);
  assert.match(indexSource,
    /pickOneFromPool\(working, "guardianPool", working\.highWarMembers,[\s\S]*?getRoleExclusionSet\(working, "guardian", \[captain\], date\)/u);
  assert.match(indexSource,
    /getRoleExclusionSet\([\s\S]*?working, "cabin4", \[captain, guardian, \.\.\.cabin4\], date\)/u);
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
  assert.match(indexSource, /設定為不可擔任守護/u);
  assert.match(indexSource, /特別日固定第四船艙包含永久排除成員/u);
  assert.match(indexSource, /特別日固定第四船艙包含今天不可擔任的成員/u);
});

function weekdayState(overrides = {}) {
  return {
    guildMembers: ["100", "200", "300", "400", "500", "600", "700", "800"],
    highWarMembers: ["100", "200", "300", "400", "500", "600"],
    captainPool: ["100", "200", "300", "400", "500", "600", "700", "800"],
    guardianPool: ["100", "200", "300", "400", "500", "600"],
    cabin4Pool: ["100", "200", "300", "400", "500", "600", "700", "800"],
    captainExcludedMembers: [],
    guardianExcludedMembers: [],
    cabin4ExcludedMembers: [],
    roleWeekdayRestrictions: {},
    history: [{id: "past", captain: "100"}],
    ...overrides,
  };
}

function rule(memberId, roles, blockedWeekdays) {
  return {memberId, roles, blockedWeekdays};
}

test("Monday captain restriction blocks only Monday and allows Tuesday", () => {
  const state = weekdayState({
    roleWeekdayRestrictions: {r1: rule("100", ["captain"], [1])},
  });
  assert.equal(getRoleEligibleMembers(state, "captain", "2026-09-07").includes("100"), false);
  assert.equal(getRoleEligibleMembers(state, "captain", "2026-09-08").includes("100"), true);
});

test("Sunday-only cabin member is blocked Monday through Saturday and eligible Sunday", () => {
  const state = weekdayState({
    roleWeekdayRestrictions: {sundayOnly: rule("100", ["cabin4"], [1, 2, 3, 4, 5, 6])},
  });
  for (const date of ["2026-09-07", "2026-09-08", "2026-09-09", "2026-09-10",
    "2026-09-11", "2026-09-12"]) {
    assert.equal(getRoleEligibleMembers(state, "cabin4", date).includes("100"), false);
  }
  assert.equal(getRoleEligibleMembers(state, "cabin4", "2026-09-06").includes("100"), true);
});

test("guardian weekday restriction retains high-war source semantics", () => {
  const state = weekdayState({
    roleWeekdayRestrictions: {r1: rule("200", ["guardian"], [1])},
  });
  assert.equal(getRoleEligibleMembers(state, "guardian", "2026-09-07").includes("200"), false);
  assert.equal(getRoleEligibleMembers(state, "captain", "2026-09-07").includes("200"), true);
  assert.equal(getRoleEligibleMembers(state, "guardian", "2026-09-07").includes("700"), false);
});

test("one rule can block multiple roles without affecting another role", () => {
  const state = weekdayState({
    roleWeekdayRestrictions: {r1: rule("300", ["captain", "guardian"], [1])},
  });
  assert.equal(getRoleEligibleMembers(state, "captain", "2026-09-07").includes("300"), false);
  assert.equal(getRoleEligibleMembers(state, "guardian", "2026-09-07").includes("300"), false);
  assert.equal(getRoleEligibleMembers(state, "cabin4", "2026-09-07").includes("300"), true);
});

test("multiple matching rules use order-independent union semantics", () => {
  const left = weekdayState({roleWeekdayRestrictions: {
    first: rule("400", ["captain"], [1]), second: rule("500", ["captain"], [1]),
  }});
  const right = weekdayState({roleWeekdayRestrictions: {
    second: rule("500", ["captain"], [1]), first: rule("400", ["captain"], [1]),
  }});
  assert.deepEqual([...getRoleWeekdayRestrictedMemberIds(left, "captain", "2026-09-07")].sort(),
    ["400", "500"]);
  assert.deepEqual([...getRoleWeekdayRestrictedMemberIds(right, "captain", "2026-09-07")].sort(),
    ["400", "500"]);
});

test("permanent exclusion remains effective on a weekday not blocked by the rule", () => {
  const state = weekdayState({
    cabin4ExcludedMembers: ["100"],
    roleWeekdayRestrictions: {sundayOnly: rule("100", ["cabin4"], [1, 2, 3, 4, 5, 6])},
  });
  assert.equal(getRoleEligibleMembers(state, "cabin4", "2026-09-06").includes("100"), false);
});

test("rules remain bound to memberId when the current game name changes", () => {
  const restrictions = normalizeRoleWeekdayRestrictions({
    r1: rule("1493451", ["cabin4"], [1]),
  });
  const members = {1493451: {memberId: "1493451", gameName: "新名稱", active: true}};
  assert.equal(restrictions.r1.memberId, "1493451");
  assert.equal(members[restrictions.r1.memberId].gameName, "新名稱");
});

test("inactive member keeps its rule but is absent from base eligibility", () => {
  const state = weekdayState({
    guildMembers: ["200", "300", "400", "500", "600", "700", "800"],
    roleWeekdayRestrictions: {r1: rule("100", ["cabin4"], [1])},
  });
  assert.equal(listRoleWeekdayRestrictions(state)[0].memberId, "100");
  assert.equal(getRoleEligibleMembers(state, "cabin4", "2026-09-08").includes("100"), false);
});

test("reactivating a member restores normal eligibility while retaining its rule", () => {
  const inactive = weekdayState({
    guildMembers: ["200", "300", "400", "500", "600", "700", "800"],
    roleWeekdayRestrictions: {r1: rule("100", ["cabin4"], [1])},
  });
  const active = {...inactive, guildMembers: ["100", ...inactive.guildMembers]};
  assert.equal(getRoleEligibleMembers(active, "cabin4", "2026-09-08").includes("100"), true);
  assert.equal(getRoleEligibleMembers(active, "cabin4", "2026-09-07").includes("100"), false);
});

test("Asia/Taipei weekday helper uses canonical Monday=1 through Sunday=7", () => {
  assert.deepEqual(WEEKDAY_LABELS, {1: "週一", 2: "週二", 3: "週三", 4: "週四",
    5: "週五", 6: "週六", 7: "週日"});
  assert.equal(taipeiWeekday("2026-09-07"), 1);
  assert.equal(taipeiWeekday("2026-09-06"), 7);
});

test("UTC Saturday crossing Taipei midnight is evaluated as Sunday", () => {
  assert.equal(new Date("2026-09-05T16:30:00.000Z").getUTCDay(), 6);
  assert.equal(taipeiWeekday(new Date("2026-09-05T16:30:00.000Z")), 7);
  const state = weekdayState({
    roleWeekdayRestrictions: {sunday: rule("100", ["captain"], [7])},
  });
  assert.equal(getRoleEligibleMembers(
    state, "captain", new Date("2026-09-05T16:30:00.000Z")).includes("100"), false);
});

test("empty weekday-restricted candidate set fails closed without fallback", () => {
  const blocked = weekdayState({
    guildMembers: ["100"],
    roleWeekdayRestrictions: {r1: rule("100", ["captain"], [1])},
  });
  assert.deepEqual(getRoleEligibleMembers(blocked, "captain", "2026-09-07"), []);
  assert.match(indexSource, /沒有可擔任船長的成員，請檢查永久排除與週間限制/u);
});

test("weekday schema accepts only memberId, supported roles, and canonical weekdays", () => {
  assert.equal(validateRoleWeekdayRestriction(
    rule("1493451", ["cabin4"], [1, 2, 3, 4, 5, 6])).ok, true);
  assert.equal(validateRoleWeekdayRestriction(
    rule("萬朔夜", ["cabin4"], [1])).reason, "invalid-member-id");
  assert.equal(validateRoleWeekdayRestriction(rule("1493451", [], [1])).reason, "missing-role");
  assert.equal(validateRoleWeekdayRestriction(
    rule("1493451", ["cabin4"], [0, 8])).reason, "missing-weekday");
});

test("normalization preserves history and all pool arrays", () => {
  const state = weekdayState({roleWeekdayRestrictions: {
    r1: rule("100", ["cabin4"], [6, 1, 1]),
  }});
  const normalized = normalizeRoleWeekdayRestrictions(state.roleWeekdayRestrictions);
  assert.deepEqual(normalized.r1.blockedWeekdays, [1, 6]);
  assert.deepEqual(state.history, [{id: "past", captain: "100"}]);
  assert.deepEqual(state.captainPool, ["100", "200", "300", "400", "500", "600", "700", "800"]);
});

test("duplicate detection ignores rule ordering and supports editing the same rule", () => {
  const state = weekdayState({roleWeekdayRestrictions: {
    r1: rule("100", ["captain", "cabin4"], [1, 2]),
  }});
  const duplicate = rule("100", ["cabin4", "captain"], [2, 1]);
  assert.equal(isDuplicateRoleWeekdayRestriction(state, duplicate), true);
  assert.equal(isDuplicateRoleWeekdayRestriction(state, duplicate, "r1"), false);
});

test("weekday UI uses member master and separate role/weekday checkboxes", () => {
  for (const id of ["newWeekdayRestrictionBtn", "weekdayRestrictionMemberId",
    "saveWeekdayRestrictionBtn", "weekdayRestrictionsView"]) {
    assert.match(indexSource, new RegExp(`id="${id}"`, "u"));
  }
  assert.match(indexSource, /class="weekday-role-checkbox requires-member-master"/u);
  assert.match(indexSource, /class="weekday-block-checkbox requires-member-master"/u);
  assert.match(indexSource, /roleWeekdayRestrictions: normalizeRoleWeekdayRestrictions/u);
});

test("weekday restriction CRUD never modifies history, pools, or LINE state", () => {
  const handlers = indexSource.match(
    /async function saveWeekdayRestriction[\s\S]*?(?=\n    async function addMember)/u);
  assert.ok(handlers);
  assert.doesNotMatch(handlers[0], /state\.(?:history|captainPool|guardianPool|cabin4Pool|lineBindings)\s*=/u);
  assert.match(handlers[0], /state\.roleWeekdayRestrictions\[ruleId\] = validation\.rule/u);
  assert.match(handlers[0], /delete state\.roleWeekdayRestrictions\[ruleId\]/u);
});

test("weekday eligibility leaves role pool order and fairness state untouched", () => {
  const state = weekdayState({roleWeekdayRestrictions: {
    r1: rule("100", ["captain"], [1]),
  }});
  const before = JSON.stringify(state);
  getRoleEligibleMembers(state, "captain", "2026-09-07");
  assert.equal(JSON.stringify(state), before);
});
