(function attachDrawRoleExclusions(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.CapyDrawRoleExclusions = api;
})(typeof globalThis === "object" ? globalThis : this, function createDrawRoleExclusions() {
  "use strict";

  const ROLE_EXCLUSION_CONFIG = Object.freeze({
    captain: Object.freeze({
      role: "captain",
      label: "船長",
      sourceField: "guildMembers",
      poolField: "captainPool",
      exclusionField: "captainExcludedMembers",
    }),
    guardian: Object.freeze({
      role: "guardian",
      label: "守護",
      sourceField: "highWarMembers",
      poolField: "guardianPool",
      exclusionField: "guardianExcludedMembers",
    }),
    cabin4: Object.freeze({
      role: "cabin4",
      label: "第四船艙",
      sourceField: "guildMembers",
      poolField: "cabin4Pool",
      exclusionField: "cabin4ExcludedMembers",
    }),
  });

  const ROLE_WEEKDAY_RESTRICTIONS_FIELD = "roleWeekdayRestrictions";
  const WEEKDAY_LABELS = Object.freeze({
    1: "週一",
    2: "週二",
    3: "週三",
    4: "週四",
    5: "週五",
    6: "週六",
    7: "週日",
  });
  const TAIPEI_TIME_ZONE = "Asia/Taipei";
  const MEMBER_ID_PATTERN = /^\d+$/u;
  const RULE_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/u;
  const WEEKDAY_BY_SHORT_NAME = Object.freeze({
    Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7,
  });

  function uniqueNames(value) {
    const values = Array.isArray(value) ? value : [];
    return [...new Set(values.map((name) => String(name || "").trim()).filter(Boolean))];
  }

  function getRoleConfig(role) {
    const config = ROLE_EXCLUSION_CONFIG[String(role || "")];
    if (!config) throw new Error("不支援的抽籤角色。");
    return config;
  }

  function getRoleExcludedMembers(state, role) {
    const config = getRoleConfig(role);
    return uniqueNames(state && state[config.exclusionField]);
  }

  function normalizeWeekdays(value) {
    const source = Array.isArray(value) ? value : [];
    return [...new Set(source.map(Number)
      .filter((weekday) => Number.isInteger(weekday) && weekday >= 1 && weekday <= 7))]
      .sort((left, right) => left - right);
  }

  function normalizeRestrictionRoles(value) {
    const requested = new Set(Array.isArray(value) ? value.map(String) : []);
    return Object.keys(ROLE_EXCLUSION_CONFIG).filter((role) => requested.has(role));
  }

  function validateRoleWeekdayRestriction(value) {
    const source = value && typeof value === "object" ? value : {};
    const memberId = String(source.memberId || "").trim();
    const roles = normalizeRestrictionRoles(source.roles);
    const blockedWeekdays = normalizeWeekdays(source.blockedWeekdays);
    if (!MEMBER_ID_PATTERN.test(memberId)) {
      return {ok: false, reason: "invalid-member-id"};
    }
    if (!roles.length) return {ok: false, reason: "missing-role"};
    if (!blockedWeekdays.length) return {ok: false, reason: "missing-weekday"};
    return {ok: true, rule: {memberId, roles, blockedWeekdays}};
  }

  function normalizeRoleWeekdayRestrictions(value) {
    const source = value && typeof value === "object" ? value : {};
    const entries = Array.isArray(source) ? source.map((rule, index) =>
      [rule && rule.ruleId || `legacy_${index}`, rule]) : Object.entries(source);
    const normalized = {};
    entries.forEach(([rawRuleId, rawRule]) => {
      const ruleId = String(rawRuleId || "").trim();
      const validation = validateRoleWeekdayRestriction(rawRule);
      if (!RULE_ID_PATTERN.test(ruleId) || !validation.ok) return;
      normalized[ruleId] = validation.rule;
    });
    return normalized;
  }

  function listRoleWeekdayRestrictions(state) {
    const rules = normalizeRoleWeekdayRestrictions(
      state && state[ROLE_WEEKDAY_RESTRICTIONS_FIELD]);
    return Object.entries(rules).map(([ruleId, rule]) => ({ruleId, ...rule}));
  }

  function taipeiWeekday(value = new Date()) {
    let instant;
    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value)) {
      instant = new Date(`${value}T12:00:00+08:00`);
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: TAIPEI_TIME_ZONE,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).formatToParts(instant);
      const fields = Object.fromEntries(parts.map((part) => [part.type, part.value]));
      if (`${fields.year}-${fields.month}-${fields.day}` !== value) {
        throw new Error("抽籤日期格式不正確。");
      }
    } else {
      instant = value instanceof Date ? new Date(value.getTime()) : new Date(value);
    }
    if (!Number.isFinite(instant.getTime())) throw new Error("抽籤日期格式不正確。");
    const shortName = new Intl.DateTimeFormat("en-US", {
      timeZone: TAIPEI_TIME_ZONE,
      weekday: "short",
    }).format(instant);
    return WEEKDAY_BY_SHORT_NAME[shortName];
  }

  function getRoleWeekdayRestrictedMemberIds(state, role, dateOrInstant = new Date()) {
    getRoleConfig(role);
    const weekday = taipeiWeekday(dateOrInstant);
    return new Set(listRoleWeekdayRestrictions(state)
      .filter((rule) => rule.roles.includes(role) && rule.blockedWeekdays.includes(weekday))
      .map((rule) => rule.memberId));
  }

  function getRoleEligibleMembers(state, role, dateOrInstant = new Date()) {
    const config = getRoleConfig(role);
    const excluded = new Set(getRoleExcludedMembers(state, role));
    getRoleWeekdayRestrictedMemberIds(state, role, dateOrInstant)
      .forEach((memberId) => excluded.add(memberId));
    return uniqueNames(state && state[config.sourceField]).filter((name) => !excluded.has(name));
  }

  function getRoleExclusionSet(state, role, additional = [], dateOrInstant = new Date()) {
    return new Set([
      ...getRoleExcludedMembers(state, role),
      ...getRoleWeekdayRestrictedMemberIds(state, role, dateOrInstant),
      ...uniqueNames(additional),
    ]);
  }

  function normalizeRoleExclusions(state) {
    const source = state && typeof state === "object" ? state : {};
    const normalized = {...source};
    Object.values(ROLE_EXCLUSION_CONFIG).forEach((config) => {
      const allowed = new Set(uniqueNames(source[config.sourceField]));
      normalized[config.exclusionField] = uniqueNames(source[config.exclusionField])
        .filter((name) => allowed.has(name));
    });
    return normalized;
  }

  function renameRoleExclusions(state, renameMap) {
    const source = state && typeof state === "object" ? state : {};
    const renamed = {...source};
    const replacement = (name) => {
      if (renameMap instanceof Map) return renameMap.get(name) || name;
      if (renameMap && typeof renameMap === "object") return renameMap[name] || name;
      return name;
    };
    Object.values(ROLE_EXCLUSION_CONFIG).forEach((config) => {
      renamed[config.exclusionField] = uniqueNames(
        uniqueNames(source[config.exclusionField]).map(replacement),
      );
    });
    return renamed;
  }

  function isDuplicateRoleWeekdayRestriction(state, candidate, ignoredRuleId = null) {
    const validation = validateRoleWeekdayRestriction(candidate);
    if (!validation.ok) return false;
    const target = validation.rule;
    return listRoleWeekdayRestrictions(state).some((rule) =>
      rule.ruleId !== ignoredRuleId &&
      rule.memberId === target.memberId &&
      rule.roles.join(",") === target.roles.join(",") &&
      rule.blockedWeekdays.join(",") === target.blockedWeekdays.join(","));
  }

  return {
    ROLE_EXCLUSION_CONFIG,
    ROLE_WEEKDAY_RESTRICTIONS_FIELD,
    TAIPEI_TIME_ZONE,
    WEEKDAY_LABELS,
    getRoleConfig,
    getRoleEligibleMembers,
    getRoleExcludedMembers,
    getRoleExclusionSet,
    getRoleWeekdayRestrictedMemberIds,
    isDuplicateRoleWeekdayRestriction,
    listRoleWeekdayRestrictions,
    normalizeRoleExclusions,
    normalizeRoleWeekdayRestrictions,
    normalizeWeekdays,
    renameRoleExclusions,
    taipeiWeekday,
    uniqueNames,
    validateRoleWeekdayRestriction,
  };
});
