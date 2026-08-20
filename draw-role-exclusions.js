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

  function getRoleEligibleMembers(state, role) {
    const config = getRoleConfig(role);
    const excluded = new Set(getRoleExcludedMembers(state, role));
    return uniqueNames(state && state[config.sourceField]).filter((name) => !excluded.has(name));
  }

  function getRoleExclusionSet(state, role, additional = []) {
    return new Set([...getRoleExcludedMembers(state, role), ...uniqueNames(additional)]);
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

  return {
    ROLE_EXCLUSION_CONFIG,
    getRoleConfig,
    getRoleEligibleMembers,
    getRoleExcludedMembers,
    getRoleExclusionSet,
    normalizeRoleExclusions,
    renameRoleExclusions,
    uniqueNames,
  };
});
