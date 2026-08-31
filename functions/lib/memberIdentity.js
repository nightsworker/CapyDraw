(function attachMemberIdentity(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.CapyDrawMemberIdentity = api;
})(typeof globalThis === "object" ? globalThis : this, function createMemberIdentity() {
  "use strict";

  const MEMBER_ID_PATTERN = /^\d+$/u;

  function canonical(memberId, lineNameHint, gameName, legacyPlayerName = null, active = true) {
    const legacyPlayerNames = Array.isArray(legacyPlayerName) ? legacyPlayerName : [
      legacyPlayerName || `${lineNameHint} - ${gameName}`,
    ];
    return Object.freeze({
      memberId,
      lineNameHint,
      gameName,
      active,
      legacyPlayerNames: Object.freeze(legacyPlayerNames),
    });
  }

  const CANONICAL_MEMBERS = Object.freeze([
    canonical("3425733", "HappyStar", "HappyStar", "HappyStar（不在群組）"),
    canonical("3436651", "Edward", "判官天堂"),
    canonical("3150798", "信全", "我昨天很強欸"),
    canonical("1784727", "台東小米那裡民宿-林秉亮", "大象騎士",
      "台東小米那裡民宿 - 林秉亮 - 大象騎士"),
    canonical("4632059", "kenji", "ちゃらう"),
    canonical("2689770", "立竑Caesar", "歐皇弟弟", "立竑 Caesar - 歐皇弟弟"),
    canonical("820704", "CA", "哈難得姆巴賠"),
    canonical("3036362", "佳昌", "夭壽yy"),
    canonical("1493451", "貳零陸", "萬朔夜"),
    canonical("2482094", "𝓦𝓮𝓲", "從缺"),
    canonical("1136445", "陳昱錡", "老金八"),
    canonical("3266543", "Andy", "TWShiba㍿"),
    canonical("1016526", "愛唱歌的人", "嘻嘻愛唱歌"),
    canonical("978053", "小六", "嘻嘻的小象"),
    canonical("1905531", "🍎林日凱（Kim）", "阿金"),
    canonical("3606797", "黃健治", "你過來ㄚ"),
    canonical("2034661", "丫薰Vian", "萱小寶"),
    canonical("2655894", "REN✨", "REN"),
    canonical("1537124", "Rain", "流鬼"),
    canonical("1341772", "湯米", "沒心態：湯米"),
    canonical("1724973", "米漿爸", "只會反擊"),
    canonical("1009562", "品豪 Nash", "-紅茶拿鐵-", "品豪 Nash - - 紅茶拿鐵 -"),
    canonical("1160858", "羅彥晨(Ray)🇹🇼", "Ray"),
    canonical("2481528", "俊宏", "仰泳的魚"),
    canonical("3523917", "鮑あわび", "嘻布嘻あわび"),
    canonical("821932", "布布大王", "布布大王"),
    canonical("813304", "Meowmeow", "一二寶"),
    canonical("975286", "兔", "蛋蛋嘻嘻"),
    canonical("3378170", "𝒦𝒶𝒾謙", "善解人依"),
    canonical("4018284", "JL lunlunlun", "希希有希希"),
    canonical("4913788", "邱冠明", "哈姆湯郎"),
    canonical("4367945", "利", "利"),
    canonical("3616536", "PinMin", "PiinMiin"),
    canonical("1635753", "初瓏", "安康阿幾"),
    canonical("1311826", "初瓏", "奶瓏"),
    canonical("1453683", "吳俊樺", "小帥"),
    canonical("1102245", "samcheung", "卡皮巴拉毒撚"),
    canonical("1327188", "少廷(Hsiao)", "Rshaoshao"),
    canonical("796318", "豪", "戰神卡皮"),
    canonical("1259573", "KevenWz", "少冰養老"),
    canonical("1230080", "吳風鎮", "拉鍊卡皮"),
    canonical("876066", "子銘", "小朋友齊打交"),
    canonical("852177", "Chia", "CC x CC"),
    canonical("849633", "Chia", "嘻嘻不嘻嘻"),
    canonical("1443678", "@Hank", "挖系小嗨"),
    canonical("1474493", "竣棋", "璇璇很可愛", null, false),
    canonical("875114", "德", "MingWong", null, false),
    canonical("3612290", "saiyiu", "賓妹", null, false),
  ]);

  const CONFIRMED_LEGACY_BINDING_ALIASES = Object.freeze([
    Object.freeze({playerName: "竣棋 - 璇璇很可愛", memberId: "1474493"}),
    Object.freeze({playerName: "德 - MingWong", memberId: "875114"}),
    Object.freeze({playerName: "貳零陸 - 九章伏藏", memberId: "1493451"}),
    Object.freeze({playerName: "俊宏 - 趴地柒", memberId: "2481528"}),
    Object.freeze({playerName: "saiyiu - 賓妹", memberId: "3612290"}),
  ]);
  const INACTIVE_HISTORICAL_MEMBER_IDS = Object.freeze(["1474493", "875114", "3612290"]);

  function normalizeText(value) {
    return String(value || "")
      .replaceAll("\\n", "\n")
      .replaceAll("\r\n", "\n")
      .replaceAll("\r", "\n")
      .replace(/[–—－]/gu, "-")
      .replace(/\s*-\s*/gu, " - ")
      .replace(/[ \t]+/gu, " ")
      .trim()
      .normalize("NFKC");
  }

  function normalizedLookup(value) {
    return normalizeText(value).toLocaleLowerCase("en-US");
  }

  function normalizeMemberId(value) {
    const memberId = String(value ?? "").trim();
    return MEMBER_ID_PATTERN.test(memberId) ? memberId : null;
  }

  function validateMemberInput({memberId, gameName} = {}) {
    const normalizedId = normalizeMemberId(memberId);
    const normalizedGameName = normalizeText(gameName);
    if (!normalizedId) return {ok: false, reason: "invalid-member-id"};
    if (!normalizedGameName || normalizedGameName.length > 120) {
      return {ok: false, reason: "invalid-game-name"};
    }
    return {ok: true, memberId: normalizedId, gameName: normalizedGameName};
  }

  function canonicalMaster() {
    return Object.fromEntries(CANONICAL_MEMBERS.map((entry) => [entry.memberId, {
      memberId: entry.memberId,
      gameName: entry.gameName,
      lineNameHint: entry.lineNameHint,
      active: entry.active,
    }]));
  }

  const CANONICAL_BY_ID = new Map(CANONICAL_MEMBERS.map((entry) => [entry.memberId, entry]));
  const CANONICAL_ALIASES = new Map();
  const CANONICAL_GAME_NAMES = new Map();
  const CONFIRMED_BINDING_ALIAS_MAP = new Map(CONFIRMED_LEGACY_BINDING_ALIASES
    .map((entry) => [normalizedLookup(entry.playerName), entry.memberId]));
  CANONICAL_MEMBERS.forEach((entry) => {
    const aliases = [...entry.legacyPlayerNames, `${entry.lineNameHint} - ${entry.gameName}`];
    aliases.forEach((alias) => {
      const key = normalizedLookup(alias);
      if (!CANONICAL_ALIASES.has(key)) CANONICAL_ALIASES.set(key, []);
      CANONICAL_ALIASES.get(key).push(entry.memberId);
    });
    const gameKey = normalizedLookup(entry.gameName);
    if (!CANONICAL_GAME_NAMES.has(gameKey)) CANONICAL_GAME_NAMES.set(gameKey, []);
    CANONICAL_GAME_NAMES.get(gameKey).push(entry.memberId);
  });

  function uniqueIds(values) {
    const source = Array.isArray(values) ? values : Object.values(values || {});
    return [...new Set(source.map(normalizeMemberId).filter(Boolean))];
  }

  function normalizeMemberRecord(key, value) {
    const memberId = normalizeMemberId(key);
    const record = value && typeof value === "object" ? value : {};
    const embeddedId = normalizeMemberId(record.memberId);
    const gameName = normalizeText(record.gameName);
    if (!memberId || (embeddedId && embeddedId !== memberId) || !gameName) return null;
    return {
      memberId,
      gameName,
      lineNameHint: normalizeText(record.lineNameHint),
      active: record.active !== false,
    };
  }

  function normalizeMembersMaster(value) {
    const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const result = {};
    Object.entries(source).forEach(([key, raw]) => {
      const record = normalizeMemberRecord(key, raw);
      if (record) result[record.memberId] = record;
    });
    return result;
  }

  function hasMembersMaster(value) {
    return Object.keys(normalizeMembersMaster(value)).length > 0;
  }

  function hasActivatedMembersMaster(state) {
    const source = state && typeof state === "object" ? state : {};
    const master = normalizeMembersMaster(source.members);
    if (!Object.keys(master).length) return false;
    if (Number(source.memberIdentityVersion) >= 1) return true;
    const legacyReferences = memberValues(source.guildMembers);
    return legacyReferences.length > 0 && legacyReferences.every((value) => {
      const memberId = normalizeMemberId(value);
      return Boolean(memberId && master[memberId]);
    });
  }

  function memberValues(value) {
    if (Array.isArray(value)) return value;
    return Object.values(value && typeof value === "object" ? value : {});
  }

  function activeMemberIds(members) {
    return Object.values(normalizeMembersMaster(members))
      .filter((member) => member.active)
      .map((member) => member.memberId);
  }

  function memberLabel(member) {
    if (!member) return "";
    return `${member.gameName} (#${member.memberId})`;
  }

  function memberPlayerName(member) {
    if (!member) return "";
    const lineName = normalizeText(member.lineNameHint);
    return lineName && lineName !== member.gameName ? `${lineName} - ${member.gameName}` :
      member.gameName;
  }

  function resolveFromId(memberId, members = null) {
    const normalizedId = normalizeMemberId(memberId);
    if (!normalizedId) return null;
    const master = normalizeMembersMaster(members);
    if (master[normalizedId]) return {...master[normalizedId], source: "members"};
    const canonicalEntry = CANONICAL_BY_ID.get(normalizedId);
    return canonicalEntry ? {
      memberId: canonicalEntry.memberId,
      gameName: canonicalEntry.gameName,
      lineNameHint: canonicalEntry.lineNameHint,
      active: canonicalEntry.active,
      source: "canonical",
    } : null;
  }

  function resolveCanonicalMember(value) {
    if (value && typeof value === "object") {
      const byId = resolveFromId(value.memberId);
      if (byId) return {status: "mapped", matchType: "member-id", member: byId};
      value = value.playerName || value.fullName || value.gameName || value.nameSnapshot || "";
    }
    const directId = resolveFromId(value);
    if (directId) return {status: "mapped", matchType: "member-id", member: directId};
    const key = normalizedLookup(value);
    if (!key) return {status: "unmapped", value: ""};
    const aliasIds = [...new Set(CANONICAL_ALIASES.get(key) || [])];
    if (aliasIds.length === 1) {
      return {status: "mapped", matchType: "legacy-player-name",
        member: resolveFromId(aliasIds[0])};
    }
    if (aliasIds.length > 1) return {status: "ambiguous", value: normalizeText(value),
      candidateMemberIds: aliasIds};
    const gameIds = [...new Set(CANONICAL_GAME_NAMES.get(key) || [])];
    if (gameIds.length === 1) {
      return {status: "mapped", matchType: "unique-game-name",
        member: resolveFromId(gameIds[0])};
    }
    if (gameIds.length > 1) return {status: "ambiguous", value: normalizeText(value),
      candidateMemberIds: gameIds};
    return {status: "unmapped", value: normalizeText(value)};
  }

  function resolveLegacyBindingMember(value) {
    if (value && typeof value === "object") {
      const byId = resolveFromId(value.memberId);
      if (byId) return {status: "mapped", matchType: "member-id", member: byId};
      value = value.playerName || value.gameId || "";
    }
    const confirmedMemberId = CONFIRMED_BINDING_ALIAS_MAP.get(normalizedLookup(value));
    if (confirmedMemberId) {
      return {status: "mapped", matchType: "confirmed-legacy-binding-alias",
        member: resolveFromId(confirmedMemberId)};
    }
    return resolveCanonicalMember(value);
  }

  function buildMasterLookup(members) {
    const master = normalizeMembersMaster(members);
    const aliases = new Map();
    Object.values(master).forEach((member) => {
      const values = [member.memberId, member.gameName, memberPlayerName(member)];
      values.forEach((value) => {
        const key = normalizedLookup(value);
        if (!aliases.has(key)) aliases.set(key, []);
        aliases.get(key).push(member.memberId);
      });
    });
    return {master, aliases};
  }

  function resolveMember(value, members) {
    const lookup = buildMasterLookup(members);
    if (value && typeof value === "object") {
      const id = normalizeMemberId(value.memberId);
      if (id && lookup.master[id]) {
        return {status: "mapped", matchType: "member-id", member: lookup.master[id]};
      }
      value = value.playerName || value.fullName || value.gameName || value.nameSnapshot || "";
    }
    const directId = normalizeMemberId(value);
    if (directId && lookup.master[directId]) {
      return {status: "mapped", matchType: "member-id", member: lookup.master[directId]};
    }
    const ids = [...new Set(lookup.aliases.get(normalizedLookup(value)) || [])];
    if (ids.length === 1) return {status: "mapped", matchType: "master-exact",
      member: lookup.master[ids[0]]};
    if (ids.length > 1) return {status: "ambiguous", value: normalizeText(value),
      candidateMemberIds: ids};
    return resolveCanonicalMember(value);
  }

  function createHistoryMemberSnapshot(member) {
    const normalized = normalizeMemberRecord(member && member.memberId, member);
    if (!normalized) return null;
    return {
      memberId: normalized.memberId,
      nameSnapshot: normalized.gameName,
      ...(normalized.lineNameHint ? {lineNameSnapshot: normalized.lineNameHint} : {}),
    };
  }

  function normalizeHistoryMemberSnapshot(value, members = {}) {
    if (value && typeof value === "object") {
      const memberId = normalizeMemberId(value.memberId);
      const nameSnapshot = normalizeText(value.nameSnapshot);
      if (memberId && nameSnapshot) {
        const lineNameSnapshot = normalizeText(value.lineNameSnapshot);
        return {memberId, nameSnapshot,
          ...(lineNameSnapshot ? {lineNameSnapshot} : {})};
      }
    }
    const resolved = resolveMember(value, members);
    return resolved.status === "mapped" ? createHistoryMemberSnapshot(resolved.member) : null;
  }

  function historySnapshotDisplay(snapshot) {
    const normalized = normalizeHistoryMemberSnapshot(snapshot);
    if (!normalized) return "";
    return normalized.lineNameSnapshot && normalized.lineNameSnapshot !== normalized.nameSnapshot ?
      `${normalized.lineNameSnapshot} - ${normalized.nameSnapshot}` : normalized.nameSnapshot;
  }

  function analyzeValues(values, label) {
    const rows = memberValues(values).map((value, index) => {
      const result = resolveCanonicalMember(value);
      return {index, label, value: normalizeText(value), ...result};
    });
    return {
      total: rows.length,
      mapped: rows.filter((row) => row.status === "mapped"),
      ambiguous: rows.filter((row) => row.status === "ambiguous"),
      unmapped: rows.filter((row) => row.status === "unmapped"),
    };
  }

  function bindingValue(binding) {
    if (!binding || typeof binding !== "object") return "";
    if (normalizeMemberId(binding.memberId)) return binding.memberId;
    return binding.playerName || binding.gameId || "";
  }

  function analyzeBindings(bindings) {
    const rows = Object.entries(bindings && typeof bindings === "object" ? bindings : {})
      .filter(([, binding]) => binding && typeof binding === "object")
      .map(([bindingId, binding]) => ({bindingId, binding,
        result: resolveLegacyBindingMember(bindingValue(binding))}));
    const users = new Map();
    rows.forEach((row) => {
      const userId = String(row.binding.lineUserId || "");
      if (!userId) return;
      if (!users.has(userId)) users.set(userId, []);
      users.get(userId).push(row);
    });
    let userIndex = 0;
    const multiCharacterUsers = [];
    users.forEach((userRows) => {
      const memberIds = [...new Set(userRows
        .filter((row) => row.result.status === "mapped")
        .map((row) => row.result.member.memberId))];
      if (memberIds.length > 1) {
        userIndex += 1;
        multiCharacterUsers.push({safeUserRef: `LINE_USER_${String(userIndex).padStart(2, "0")}`,
          memberIds});
      }
    });
    return {
      total: rows.length,
      mapped: rows.filter((row) => row.result.status === "mapped"),
      ambiguous: rows.filter((row) => row.result.status === "ambiguous"),
      unmapped: rows.filter((row) => row.result.status === "unmapped"),
      multiCharacterUsers,
    };
  }

  function historyRoles(record) {
    const identity = record && record.memberIdentity && typeof record.memberIdentity === "object" ?
      record.memberIdentity : {};
    return [
      {role: "captain", value: identity.captain || record && record.captain},
      {role: "guardian", value: identity.guardian || record && record.guardian},
      ...memberValues(identity.cabin4 || record && record.cabin4)
        .map((value, index) => ({role: `cabin4[${index}]`, value})),
    ];
  }

  function analyzeHistory(history) {
    const records = memberValues(history).filter((record) => record && typeof record === "object");
    const rows = records.map((record, index) => {
      const roles = historyRoles(record).map((role) => ({...role,
        result: resolveCanonicalMember(role.value)}));
      const internalReferences = [];
      const appendReferences = (prefix, values) => memberValues(values).forEach((value, itemIndex) => {
        internalReferences.push({role: `${prefix}[${itemIndex}]`, value,
          result: resolveCanonicalMember(value)});
      });
      const consumed = record.consumed || {};
      appendReferences("consumed.captain", consumed.captain);
      appendReferences("consumed.guardian", consumed.guardian);
      appendReferences("consumed.cabin4", consumed.cabin4);
      for (const side of ["before", "after"]) {
        const snapshot = record.poolSnapshots && record.poolSnapshots[side] || {};
        appendReferences(`poolSnapshots.${side}.captainPool`, snapshot.captainPool);
        appendReferences(`poolSnapshots.${side}.guardianPool`, snapshot.guardianPool);
        appendReferences(`poolSnapshots.${side}.cabin4Pool`, snapshot.cabin4Pool);
      }
      const ambiguous = roles.filter((role) => role.result.status === "ambiguous");
      const unmapped = roles.filter((role) => role.result.status === "unmapped");
      const internalAmbiguous = internalReferences
        .filter((role) => role.result.status === "ambiguous");
      const internalUnmapped = internalReferences
        .filter((role) => role.result.status === "unmapped");
      return {
        index,
        recordId: String(record.id || ""),
        date: String(record.date || ""),
        safe: !ambiguous.length && !unmapped.length && roles.length >= 2,
        fullySafe: !ambiguous.length && !unmapped.length &&
          !internalAmbiguous.length && !internalUnmapped.length && roles.length >= 2,
        ambiguous,
        unmapped,
        internalAmbiguous,
        internalUnmapped,
      };
    });
    return {
      total: rows.length,
      safe: rows.filter((row) => row.safe),
      ambiguous: rows.filter((row) => !row.safe),
      internalUnsafe: rows.filter((row) => !row.fullySafe),
    };
  }

  function mappedIds(values) {
    const analysis = analyzeValues(values, "migration");
    if (analysis.ambiguous.length || analysis.unmapped.length) return null;
    return analysis.mapped.map((row) => row.member.memberId);
  }

  function buildMigrationProposal({main, bindings} = {}) {
    const state = main && typeof main === "object" ? main : {};
    const report = buildProductionDryRun({main: state, bindings});
    const memberIds = mappedIds(state.guildMembers);
    const highWarMemberIds = mappedIds(state.highWarMembers);
    const captainPool = mappedIds(state.captainPool);
    const guardianPool = mappedIds(state.guardianPool);
    const cabin4Pool = mappedIds(state.cabin4Pool);
    const captainExcludedMembers = mappedIds(state.captainExcludedMembers);
    const guardianExcludedMembers = mappedIds(state.guardianExcludedMembers);
    const cabin4ExcludedMembers = mappedIds(state.cabin4ExcludedMembers);
    const president = resolveCanonicalMember(state.presidentName);
    const bindingPatches = {};
    report.bindings.mapped.forEach((row) => {
      bindingPatches[row.bindingId] = {memberId: row.result.member.memberId};
    });
    const uniqueMappedMembers = memberIds && new Set(memberIds).size === memberIds.length;
    const memberMasterSafe = Boolean(uniqueMappedMembers);
    const roleStateSafe = Boolean(highWarMemberIds && captainPool && guardianPool && cabin4Pool &&
      captainExcludedMembers && guardianExcludedMembers && cabin4ExcludedMembers &&
      president.status === "mapped");
    const lineBindingsSafe = report.bindings.ambiguous.length === 0 &&
      report.bindings.unmapped.length === 0;
    const safety = {memberMaster: memberMasterSafe, roleState: roleStateSafe,
      lineBindings: lineBindingsSafe, historyBlocksMigration: false};
    const safe = memberMasterSafe && roleStateSafe && lineBindingsSafe;
    if (!safe) return {safe: false, safety, report, mainPatch: null, bindingPatches: null,
      legacyHistoryPreserved: true};
    const currentIds = new Set(memberIds);
    const members = canonicalMaster();
    Object.values(members).forEach((member) => { member.active = currentIds.has(member.memberId); });
    return {
      safe: true,
      report,
      mainPatch: {
        members,
        guildMembers: memberIds,
        highWarMembers: highWarMemberIds,
        highWarMemberIds,
        presidentMemberId: president.member.memberId,
        captainPool,
        guardianPool,
        cabin4Pool,
        captainExcludedMembers,
        guardianExcludedMembers,
        cabin4ExcludedMembers,
        memberIdentityVersion: 1,
      },
      bindingPatches,
      safety,
      legacyHistoryPreserved: true,
    };
  }

  function buildProductionDryRun({main, bindings} = {}) {
    const state = main && typeof main === "object" ? main : {};
    return {
      canonicalCount: CANONICAL_MEMBERS.length,
      members: analyzeValues(state.guildMembers, "guildMembers"),
      highWar: analyzeValues(state.highWarMembers, "highWarMembers"),
      captainPool: analyzeValues(state.captainPool, "captainPool"),
      guardianPool: analyzeValues(state.guardianPool, "guardianPool"),
      cabin4Pool: analyzeValues(state.cabin4Pool, "cabin4Pool"),
      exclusions: {
        captain: analyzeValues(state.captainExcludedMembers, "captainExcludedMembers"),
        guardian: analyzeValues(state.guardianExcludedMembers, "guardianExcludedMembers"),
        cabin4: analyzeValues(state.cabin4ExcludedMembers, "cabin4ExcludedMembers"),
      },
      bindings: analyzeBindings(bindings),
      history: analyzeHistory(state.history),
      hasMembersMaster: hasMembersMaster(state.members),
    };
  }

  return {
    CANONICAL_MEMBERS,
    CONFIRMED_LEGACY_BINDING_ALIASES,
    INACTIVE_HISTORICAL_MEMBER_IDS,
    MEMBER_ID_PATTERN,
    activeMemberIds,
    analyzeBindings,
    analyzeHistory,
    analyzeValues,
    buildProductionDryRun,
    buildMigrationProposal,
    canonicalMaster,
    createHistoryMemberSnapshot,
    hasActivatedMembersMaster,
    hasMembersMaster,
    historySnapshotDisplay,
    memberLabel,
    memberPlayerName,
    normalizeHistoryMemberSnapshot,
    normalizeMemberId,
    normalizeMembersMaster,
    normalizeText,
    resolveCanonicalMember,
    resolveLegacyBindingMember,
    resolveMember,
    uniqueIds,
    validateMemberInput,
  };
});
