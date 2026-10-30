(function attachReservePlans(root, factory) {
  const identity = typeof module === "object" && module.exports ? require("./memberIdentity") : root.CapyDrawMemberIdentity;
  const api = factory(identity);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.CapyDrawReservePlans = api;
})(typeof globalThis === "object" ? globalThis : this, function createReservePlans(identity) {
  "use strict";

  const POOL_VERSION = 2;

  function day(now = new Date()) {
    return new Date(new Date(now).getTime() + 8 * 3600000).toISOString().slice(0, 10);
  }
  function nextDay(date, offset = 1) {
    return new Date(Date.parse(`${date}T00:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);
  }
  function unique(values) {
    return [...new Set((Array.isArray(values) ? values : []).filter(Boolean))];
  }
  function identityMode(state) {
    return identity.hasActivatedMembersMaster(state);
  }
  function reference(state, value) {
    if (!identityMode(state)) return String(value || "").trim();
    const result = identity.resolveMember(value, state.members);
    return result.status === "mapped" ? result.member.memberId : null;
  }
  function references(state, values) {
    return unique((values || []).map(value => reference(state, value)));
  }
  function president(state) {
    return identityMode(state) ? state.presidentMemberId : state.presidentName;
  }
  function allowedMembers(state) {
    const members = identityMode(state) ? identity.activeMemberIds(state.members) : unique(state.guildMembers);
    const excluded = new Set(references(state, state.cabin4ExcludedMembers || []));
    const chief = president(state);
    if (!identityMode(state) && chief && !members.includes(chief)) members.push(chief);
    return members.filter(ref => !excluded.has(ref));
  }
  function normalMembers(state) {
    const chief = president(state);
    return allowedMembers(state).filter(ref => ref !== chief);
  }
  function eligibleMembers(state, date) {
    const weekday = new Date(`${date}T12:00:00+08:00`).getUTCDay() || 7;
    const blocked = new Set(Object.values(state.roleWeekdayRestrictions || {})
      .filter(rule => rule && (rule.roles || []).includes("cabin4") && (rule.blockedWeekdays || []).includes(weekday))
      .map(rule => reference(state, rule.memberId)));
    return allowedMembers(state).filter(ref => !blocked.has(ref));
  }
  function recordFor(state, date) {
    return (state.history || []).find(record => record.date === date) || null;
  }
  function aboardMembers(state, date) {
    const record = recordFor(state, date);
    if (!record) return [];
    const snapshot = record.memberIdentity;
    return snapshot ? references(state, [snapshot.captain && snapshot.captain.memberId,
      snapshot.guardian && snapshot.guardian.memberId, ...(snapshot.cabin4 || []).map(member => member.memberId)]) :
      references(state, [record.captain, record.guardian, ...(record.cabin4 || [])]);
  }
  function actionUses(state) {
    return [...(state.reserveUses || []), ...(state.history || []).flatMap(record =>
      (record.reserveUses || []).map(use => ({...use, date: use.date || record.date})))];
  }
  function memberName(state, ref) {
    return identityMode(state) ? identity.memberPlayerName(state.members[ref]) : ref;
  }
  function originalForRecord(state, record) {
    if (!record) return [];
    const values = record.memberIdentity && Array.isArray(record.memberIdentity.reserves) ?
      record.memberIdentity.reserves.map(member => member.memberId) : record.reserves || [];
    return references(state, values);
  }
  function storedOriginal(state, originalKey, queueKey) {
    const original = references(state, state[originalKey] || []);
    return original.length ? original : references(state, state[queueKey] || []);
  }
  function originalForDate(state, date) {
    if (state.reservePlanDate === date) return storedOriginal(state, "reserveOriginalQueue", "reserveQueue");
    if (state.tomorrowReserveDate === date) {
      return storedOriginal(state, "tomorrowReserveOriginalQueue", "tomorrowReserveQueue");
    }
    return originalForRecord(state, recordFor(state, date));
  }
  function isPublished(state, date) {
    const record = recordFor(state, date);
    return Boolean(record && ((record.lineReserves || []).length || record.lineSentAt || record.lineSendCount));
  }
  function snapshot(state, date, queue, original = queue) {
    const record = recordFor(state, date);
    if (!record) return;
    record.reserves = original.map(ref => memberName(state, ref));
    record.reserveRemaining = queue.map(ref => memberName(state, ref));
    if (identityMode(state) && record.memberIdentity) {
      record.memberIdentity.reserves = original.map(ref => identity.createHistoryMemberSnapshot(state.members[ref]));
    }
    record.warnings = (record.warnings || []).filter(warning => !warning.startsWith("補位人數不足"));
    if (queue.length < 5) record.warnings.push("補位人數不足：目前合格人選無法補滿 5 人。");
  }
  function migratePools(state, today) {
    const normal = normalMembers(state);
    const normalSet = new Set(normal);
    if (state.reservePoolVersion !== POOL_VERSION) {
      const usedToday = new Set(references(state, actionUses(state)
        .filter(use => use.date === today).map(use => use.memberId || use.member)));
      state.reserveUsedPool = normal.filter(ref => usedToday.has(ref));
      state.reservePool = normal.filter(ref => !usedToday.has(ref));
      state.reservePoolVersion = POOL_VERSION;
      return;
    }
    state.reserveUsedPool = references(state, state.reserveUsedPool || []).filter(ref => normalSet.has(ref));
    const used = new Set(state.reserveUsedPool);
    state.reservePool = references(state, state.reservePool || [])
      .filter(ref => normalSet.has(ref) && !used.has(ref));
    const known = new Set([...state.reservePool, ...state.reserveUsedPool]);
    state.reservePool.push(...normal.filter(ref => !known.has(ref)));
  }
  function availableNormal(state, eligible, excluded) {
    return state.reservePool.filter(ref => eligible.has(ref) && !excluded.has(ref));
  }
  function recycleUsedPool(state) {
    state.reservePool = unique([...(state.reservePool || []), ...(state.reserveUsedPool || [])]);
    state.reserveUsedPool = [];
  }
  function fill(state, date, queue, previous, randomIndex) {
    const eligible = new Set(eligibleMembers(state, date));
    const chief = president(state);
    const excluded = new Set([...aboardMembers(state, date),
      ...references(state, previous || []).filter(ref => ref !== chief)]);
    queue = references(state, queue || [])
      .filter(ref => eligible.has(ref) && !excluded.has(ref)).slice(0, 5);
    const occupied = new Set([...excluded, ...queue]);
    let available = availableNormal(state, eligible, occupied);
    if (available.length < 5 - queue.length && (state.reserveUsedPool || []).length) {
      recycleUsedPool(state);
      available = availableNormal(state, eligible, occupied);
    }
    while (queue.length < 5) {
      let picked;
      if (chief && eligible.has(chief) && !occupied.has(chief) && randomIndex(100) < 20) picked = chief;
      else {
        available = availableNormal(state, eligible, occupied);
        if (!available.length) break;
        picked = available[randomIndex(available.length)];
      }
      queue.push(picked);
      occupied.add(picked);
    }
    return queue;
  }
  function randomIndex(max) {
    if (globalThis.crypto && globalThis.crypto.getRandomValues) {
      const values = new Uint32Array(1);
      const limit = Math.floor(0x100000000 / max) * max;
      do { globalThis.crypto.getRandomValues(values); } while (values[0] >= limit);
      return values[0] % max;
    }
    return Math.floor(Math.random() * max);
  }
  function planSignature(state, date, previous) {
    return JSON.stringify(["daily-v4-chief20-repeat", date, eligibleMembers(state, date),
      aboardMembers(state, date), references(state, previous || [])]);
  }
  function reconcileTomorrow(state, date, pick, {fresh = false} = {}) {
    const previous = storedOriginal(state, "reserveOriginalQueue", "reserveQueue");
    const signature = planSignature(state, date, previous);
    if (isPublished(state, date)) {
      state.tomorrowReserveSignature = signature;
      snapshot(state, date, state.tomorrowReserveQueue || [],
        storedOriginal(state, "tomorrowReserveOriginalQueue", "tomorrowReserveQueue"));
      return;
    }
    if (fresh || signature !== state.tomorrowReserveSignature) {
      const seed = fresh ? [] : state.tomorrowReserveQueue || [];
      state.tomorrowReserveQueue = fill(state, date, seed, previous, pick);
      state.tomorrowReserveOriginalQueue = [...state.tomorrowReserveQueue];
      state.tomorrowReserveSignature = signature;
    }
    snapshot(state, date, state.tomorrowReserveQueue || [],
      storedOriginal(state, "tomorrowReserveOriginalQueue", "tomorrowReserveQueue"));
  }
  function ensure(state, {now = new Date(), pick = randomIndex} = {}) {
    const today = day(now);
    const tomorrow = nextDay(today);
    if (state.reservePlanDate && state.reservePlanDate > today) return state;
    migratePools(state, today);
    if (state.reservePlanDate !== today) {
      if (state.tomorrowReserveDate === today && (state.tomorrowReserveQueue || []).length) {
        state.reserveQueue = [...state.tomorrowReserveQueue];
        state.reserveOriginalQueue = storedOriginal(
          state, "tomorrowReserveOriginalQueue", "tomorrowReserveQueue");
      } else if (!state.reservePlanDate && (state.reserveQueue || []).length) {
        state.reserveQueue = fill(state, today, state.reserveQueue, [], pick);
        state.reserveOriginalQueue = [...state.reserveQueue];
      } else {
        const previous = originalForDate(state, nextDay(today, -1));
        state.reserveQueue = fill(state, today, [], previous, pick);
        state.reserveOriginalQueue = [...state.reserveQueue];
      }
      state.reservePlanDate = today;
      snapshot(state, today, state.reserveQueue, state.reserveOriginalQueue);
      state.tomorrowReserveQueue = [];
      state.tomorrowReserveOriginalQueue = [];
      state.tomorrowReserveSignature = null;
      state.tomorrowReserveDate = tomorrow;
      reconcileTomorrow(state, tomorrow, pick, {fresh: true});
    } else {
      const allowed = new Set(allowedMembers(state));
      state.reserveQueue = references(state, state.reserveQueue || []).filter(ref => allowed.has(ref)).slice(0, 5);
      state.reserveOriginalQueue = storedOriginal(state, "reserveOriginalQueue", "reserveQueue")
        .filter(ref => allowed.has(ref));
      snapshot(state, today, state.reserveQueue, state.reserveOriginalQueue);
      state.tomorrowReserveDate = tomorrow;
      reconcileTomorrow(state, tomorrow, pick);
    }
    return state;
  }
  function refresh(state, date, options = {}) {
    ensure(state, options);
    if (![state.reservePlanDate, state.tomorrowReserveDate].includes(date)) {
      throw new Error("補位僅維護今日與明日兩份名單；更後面的船艙會在進入明日時自動建立補位。");
    }
    if (date === state.tomorrowReserveDate && isPublished(state, date)) {
      throw new Error("明日補位已經透過 LINE 公布，名單不能再變更。");
    }
    const isToday = date === state.reservePlanDate;
    const key = isToday ? "reserveQueue" : "tomorrowReserveQueue";
    const originalKey = isToday ? "reserveOriginalQueue" : "tomorrowReserveOriginalQueue";
    const previous = isToday ? unique([
      ...originalForDate(state, nextDay(date, -1)),
      ...storedOriginal(state, "tomorrowReserveOriginalQueue", "tomorrowReserveQueue"),
    ]) : storedOriginal(state, "reserveOriginalQueue", "reserveQueue");
    const before = [...state[key]];
    state[key] = fill(state, date, before, previous, options.pick || randomIndex);
    if (isToday) {
      const additions = state[key].filter(ref => !before.includes(ref));
      state[originalKey] = unique([...(state[originalKey] || before), ...additions]);
    } else {
      state[originalKey] = [...state[key]];
      state.tomorrowReserveSignature = planSignature(state, date, previous);
    }
    snapshot(state, date, state[key], state[originalKey]);
    return before.filter(ref => !state[key].includes(ref));
  }
  function consume(state, {expected, replaced = "", action = "filled", now = new Date(), pick = randomIndex} = {}) {
    if (!["filled", "skipped"].includes(action)) throw new Error("補位操作不正確。");
    ensure(state, {now, pick});
    if (!state.reserveQueue.length || (expected && state.reserveQueue[0] !== expected)) {
      throw new Error("補位名單已變更或無可用人選，請重新操作。");
    }
    const record = recordFor(state, state.reservePlanDate);
    if (replaced && (!record || !(record.cabin4 || []).includes(replaced))) throw new Error("替補對象必須是今日第四船艙成員。");
    const ref = state.reserveQueue.shift();
    const chief = president(state);
    if (ref !== chief) {
      state.reservePool = references(state, state.reservePool || []).filter(member => member !== ref);
      state.reserveUsedPool = unique([...references(state, state.reserveUsedPool || []), ref]);
    }
    const use = {member: memberName(state, ref), ...(identityMode(state) ? {memberId: ref} : {}),
      action, replaced, date: state.reservePlanDate, at: new Date(now).toISOString()};
    state.reserveUses = [...(state.reserveUses || []), use];
    if (record) record.reserveUses = [...(record.reserveUses || []), use];
    snapshot(state, state.reservePlanDate, state.reserveQueue,
      storedOriginal(state, "reserveOriginalQueue", "reserveQueue"));
    return use;
  }
  function skip(state, options = {}) {
    return consume(state, {...options, action: "skipped", replaced: ""});
  }
  return {day, nextDay, allowedMembers, eligibleMembers, ensure, refresh, consume, skip, recordFor};
});
