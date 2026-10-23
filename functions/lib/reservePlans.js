(function attachReservePlans(root, factory) {
  const identity = typeof module === "object" && module.exports ? require("./memberIdentity") : root.CapyDrawMemberIdentity;
  const api = factory(identity);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.CapyDrawReservePlans = api;
})(typeof globalThis === "object" ? globalThis : this, function createReservePlans(identity) {
  "use strict";

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
  function usedMembers(state, date) {
    const dates = [date, nextDay(date, -1)];
    const uses = [...(state.reserveUses || []), ...(state.history || []).flatMap(record =>
      (record.reserveUses || []).map(use => ({...use, date: use.date || record.date})))];
    return references(state, uses.filter(use => dates.includes(use.date)).map(use => use.memberId || use.member));
  }
  function memberName(state, ref) {
    return identityMode(state) ? identity.memberPlayerName(state.members[ref]) : ref;
  }
  function snapshot(state, date, queue) {
    const record = recordFor(state, date);
    if (!record) return;
    record.reserves = queue.map(ref => memberName(state, ref));
    record.reserveRemaining = [...record.reserves];
    if (identityMode(state) && record.memberIdentity) {
      record.memberIdentity.reserves = queue.map(ref => identity.createHistoryMemberSnapshot(state.members[ref]));
    }
    record.warnings = (record.warnings || []).filter(warning => !warning.startsWith("補位人數不足"));
    if (queue.length < 5) record.warnings.push("補位人數不足：目前合格人選無法補滿 5 人。");
  }
  function fill(state, date, queue, randomIndex) {
    const eligible = new Set(eligibleMembers(state, date));
    const excluded = new Set([...aboardMembers(state, date), ...usedMembers(state, date)]);
    const chief = president(state);
    const normal = allowedMembers(state).filter(ref => ref !== chief);
    const poolAllowed = new Set(normal);
    state.reservePool = references(state, state.reservePool || []).filter(ref => poolAllowed.has(ref));
    queue = references(state, queue || []).filter(ref => eligible.has(ref) && !excluded.has(ref)).slice(0, 5);
    while (queue.length < 5) {
      const occupied = new Set([...excluded, ...queue]);
      let picked;
      if (chief && eligible.has(chief) && !occupied.has(chief) && randomIndex(100) < 30) picked = chief;
      else {
        let available = state.reservePool.filter(ref => eligible.has(ref) && !occupied.has(ref));
        if (!available.length) {
          const missing = normal.filter(ref => !state.reservePool.includes(ref));
          state.reservePool.push(...missing);
          available = state.reservePool.filter(ref => eligible.has(ref) && !occupied.has(ref));
        }
        if (!available.length) break;
        picked = available[randomIndex(available.length)];
        state.reservePool = state.reservePool.filter(ref => ref !== picked);
      }
      queue.push(picked);
    }
    snapshot(state, date, queue);
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
  function tomorrowSignature(state, date) {
    return JSON.stringify([date, eligibleMembers(state, date), aboardMembers(state, date), usedMembers(state, date)]);
  }
  function reconcileTomorrow(state, date, pick, force = false, seed = null) {
    const signature = tomorrowSignature(state, date);
    if (force || signature !== state.tomorrowReserveSignature) {
      state.tomorrowReserveQueue = fill(state, date, seed || state.tomorrowReserveQueue || state.reserveQueue, pick);
      state.tomorrowReserveSignature = signature;
    } else snapshot(state, date, state.tomorrowReserveQueue || []);
  }
  function ensure(state, {now = new Date(), pick = randomIndex} = {}) {
    const today = day(now);
    const tomorrow = nextDay(today);
    const initial = !state.reservePlanDate;
    if (state.reservePlanDate && state.reservePlanDate > today) return state;
    if (state.reservePlanDate !== today) {
      const seed = initial ? state.reserveQueue || [] : state.tomorrowReserveQueue || state.reserveQueue || [];
      state.reserveQueue = fill(state, today, seed, pick);
      state.reservePlanDate = today;
      reconcileTomorrow(state, tomorrow, pick, true, state.reserveQueue);
    } else {
      const allowed = new Set(allowedMembers(state));
      state.reserveQueue = references(state, state.reserveQueue || []).filter(ref => allowed.has(ref));
      snapshot(state, today, state.reserveQueue);
      reconcileTomorrow(state, tomorrow, pick);
    }
    state.tomorrowReserveDate = tomorrow;
    return state;
  }
  function refresh(state, date, options = {}) {
    ensure(state, options);
    if (![state.reservePlanDate, state.tomorrowReserveDate].includes(date)) {
      throw new Error("補位僅維護今日與明日兩份名單；更後面的船艙會在進入明日時自動建立補位。");
    }
    const key = date === state.reservePlanDate ? "reserveQueue" : "tomorrowReserveQueue";
    const before = [...state[key]];
    state[key] = fill(state, date, before, options.pick || randomIndex);
    if (key === "reserveQueue") reconcileTomorrow(state, state.tomorrowReserveDate, options.pick || randomIndex);
    else state.tomorrowReserveSignature = tomorrowSignature(state, date);
    return before.filter(ref => !state[key].includes(ref));
  }
  function consume(state, {expected, replaced = "", now = new Date(), pick = randomIndex} = {}) {
    ensure(state, {now, pick});
    if (!state.reserveQueue.length || (expected && state.reserveQueue[0] !== expected)) {
      throw new Error("補位名單已變更或無可用人選，請重新操作。");
    }
    const record = recordFor(state, state.reservePlanDate);
    if (replaced && (!record || !(record.cabin4 || []).includes(replaced))) throw new Error("替補對象必須是今日第四船艙成員。");
    const ref = state.reserveQueue.shift();
    const use = {member: memberName(state, ref), ...(identityMode(state) ? {memberId: ref} : {}),
      replaced, date: state.reservePlanDate, at: new Date(now).toISOString()};
    state.reserveUses = [...(state.reserveUses || []), use];
    if (record) record.reserveUses = [...(record.reserveUses || []), use];
    snapshot(state, state.reservePlanDate, state.reserveQueue);
    reconcileTomorrow(state, state.tomorrowReserveDate, pick);
    return use;
  }
  return {day, nextDay, allowedMembers, eligibleMembers, ensure, refresh, consume, recordFor};
});
