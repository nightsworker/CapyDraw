"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const plans = require("../lib/reservePlans");
const {syncReservePlans, renderPendingDraw} = require("../lib/reserveRuntime");
const {buildDrawLineMessage} = require("../lib/line");
const {createHistoryMemberSnapshot} = require("../lib/memberIdentity");

const NOW = new Date("2026-10-23T10:00:00+08:00");
const options = {now: NOW, pick: max => max - 1};
const clone = value => JSON.parse(JSON.stringify(value));
function state(overrides = {}) {
  return {guildMembers: Array.from({length:24}, (_, i) => `M${i + 1}`), presidentName:"P",
    cabin4ExcludedMembers:[], reserveQueue:["M1","M2","M3","M4","M5"],
    reservePool:[], reserveUsedPool:[], reserveUses:[], history:[], ...overrides};
}
function record(date, overrides = {}) {
  return {id:date, date, captain:"M10", guardian:"M11",
    cabin4:["M12","M13","M14","M15","M16"], ...overrides};
}

test("Taipei midnight defines today and tomorrow regardless of server timezone", () => {
  assert.equal(plans.day("2026-10-23T15:59:59Z"), "2026-10-23");
  assert.equal(plans.day("2026-10-23T16:00:00Z"), "2026-10-24");
  assert.equal(plans.nextDay("2026-12-31"), "2027-01-01");
});

test("legacy state keeps today's list but creates a different daily list for tomorrow", () => {
  const s = state();
  plans.ensure(s, options);
  assert.equal(s.reservePlanDate, "2026-10-23");
  assert.equal(s.tomorrowReserveDate, "2026-10-24");
  assert.deepEqual(s.reserveQueue, ["M1","M2","M3","M4","M5"]);
  assert.equal(s.tomorrowReserveQueue.length, 5);
  assert.deepEqual(s.tomorrowReserveQueue.filter(ref => s.reserveOriginalQueue.includes(ref)), []);
  assert.deepEqual(s.reserveOriginalQueue, s.reserveQueue);
  assert.deepEqual(s.tomorrowReserveOriginalQueue, s.tomorrowReserveQueue);
  assert.equal(s.reservePoolVersion, 2);
  assert.equal(s.reservePool.length, 24);
});

test("deployed two-day state migrates empty original fields without losing current queues", () => {
  const s = state({reservePlanDate:"2026-10-23", reserveOriginalQueue:[],
    tomorrowReserveDate:"2026-10-24", tomorrowReserveQueue:["M1","M2","M3","M4","M5"],
    tomorrowReserveOriginalQueue:[], tomorrowReserveSignature:"legacy"});
  plans.ensure(s, options);
  assert.deepEqual(s.reserveOriginalQueue, ["M1","M2","M3","M4","M5"]);
  assert.equal(s.tomorrowReserveQueue.length, 5);
  assert.ok(s.tomorrowReserveQueue.every(ref => !s.reserveOriginalQueue.includes(ref)));
  assert.deepEqual(s.tomorrowReserveOriginalQueue, s.tomorrowReserveQueue);
});

test("daily selection does not consume the active pool", () => {
  const s = state();
  plans.ensure(s, options);
  assert.equal(s.reservePool.length, 24);
  assert.ok(s.tomorrowReserveQueue.every(ref => s.reservePool.includes(ref)));
  plans.ensure(s, options);
  assert.equal(s.reservePool.length, 24);
});

test("tomorrow ship exclusions reconcile tomorrow only before publication", () => {
  const s = state();
  plans.ensure(s, options);
  const today = [...s.reserveQueue];
  const removed = s.tomorrowReserveQueue[0];
  s.history.push(record("2026-10-24", {captain:removed}));
  plans.ensure(s, options);
  assert.deepEqual(s.reserveQueue, today);
  assert.equal(s.tomorrowReserveQueue.length, 5);
  assert.ok(!s.tomorrowReserveQueue.includes(removed));
  assert.ok(s.tomorrowReserveQueue.every(ref => !today.includes(ref)));
});

test("using today #1 consumes only today and leaves tomorrow frozen", () => {
  const s = state({history:[record("2026-10-23"), record("2026-10-24")]});
  plans.ensure(s, options);
  const tomorrow = [...s.tomorrowReserveQueue];
  const use = plans.consume(s, {...options, expected:"M1", replaced:"M12"});
  assert.deepEqual(s.reserveQueue, ["M2","M3","M4","M5"]);
  assert.deepEqual(s.tomorrowReserveQueue, tomorrow);
  assert.ok(!s.reservePool.includes("M1"));
  assert.ok(s.reserveUsedPool.includes("M1"));
  assert.equal(use.replaced, "M12");
  assert.deepEqual(s.history[0].reserves, ["M1","M2","M3","M4","M5"]);
  assert.deepEqual(s.history[0].reserveRemaining, ["M2","M3","M4","M5"]);
});

test("skipping has the same pool cooldown without changing tomorrow", () => {
  const s = state({history:[record("2026-10-23"), record("2026-10-24")]});
  plans.ensure(s, options);
  const tomorrow = [...s.tomorrowReserveQueue];
  const use = plans.skip(s, {...options, expected:"M1"});
  assert.equal(use.action, "skipped");
  assert.equal(use.replaced, "");
  assert.ok(s.reserveUsedPool.includes("M1"));
  assert.deepEqual(s.tomorrowReserveQueue, tomorrow);
});

test("periodic scheduler runs never refill today's consumed slots", () => {
  const s = state();
  plans.ensure(s, options);
  plans.consume(s, options);
  const before = clone(s);
  plans.ensure(s, options);
  plans.ensure(s, options);
  assert.deepEqual(s, before);
  assert.equal(s.reserveQueue.length, 4);
});

test("manual today refill excludes both yesterday and the already planned tomorrow list", () => {
  const s = state({history:[record("2026-10-22", {reserves:["M17","M18","M19","M20","M21"]})]});
  plans.ensure(s, options);
  const tomorrow = [...s.tomorrowReserveQueue];
  plans.consume(s, options);
  plans.refresh(s, "2026-10-23", options);
  assert.equal(s.reserveQueue.length, 5);
  assert.ok(s.reserveQueue.every(ref => !tomorrow.includes(ref)));
  assert.ok(s.reserveQueue.every(ref => !["M17","M18","M19","M20","M21"].includes(ref)));
  assert.ok(s.reserveOriginalQueue.length > 5);
});

test("00:00 promotes tomorrow and draws a new non-overlapping following day", () => {
  const s = state({history:[record("2026-10-24"), record("2026-10-25")]});
  plans.ensure(s, options);
  const tomorrow = [...s.tomorrowReserveQueue];
  plans.ensure(s, {...options, now:new Date("2026-10-23T16:00:00Z")});
  assert.equal(s.reservePlanDate, "2026-10-24");
  assert.equal(s.tomorrowReserveDate, "2026-10-25");
  assert.deepEqual(s.reserveQueue, tomorrow);
  assert.equal(s.tomorrowReserveQueue.length, 5);
  assert.ok(s.tomorrowReserveQueue.every(ref => !s.reserveOriginalQueue.includes(ref)));
});

test("rollover is idempotent and stale retries cannot move state backward", () => {
  const s = state();
  plans.ensure(s, options);
  const midnight = {...options, now:new Date("2026-10-24T00:00:00+08:00")};
  plans.ensure(s, midnight);
  const before = clone(s);
  plans.ensure(s, midnight);
  plans.ensure(s, options);
  assert.deepEqual(s, before);
});

test("used pool recycles all at once when eligible active members cannot fill five", () => {
  const s = state({reservePoolVersion:2, reservePlanDate:"2026-10-23",
    reserveOriginalQueue:["M1","M2","M3","M4","M5"],
    tomorrowReserveDate:"2026-10-24", tomorrowReserveQueue:[], tomorrowReserveOriginalQueue:[],
    reservePool:["M6"], reserveUsedPool:Array.from({length:18}, (_, i) => `M${i + 7}`)});
  plans.ensure(s, options);
  assert.equal(s.tomorrowReserveQueue.length, 5);
  assert.deepEqual(s.reserveUsedPool, []);
  assert.ok(s.reservePool.includes("M7"));
});

test("used members remain unavailable while at least five eligible active members remain", () => {
  const active = Array.from({length:18}, (_, i) => `M${i + 1}`).filter(ref => ref !== "M6");
  const s = state({reservePoolVersion:2, reservePool:active, reserveUsedPool:["M6"]});
  plans.ensure(s, options);
  assert.ok(!s.tomorrowReserveQueue.includes("M6"));
  assert.deepEqual(s.reserveUsedPool, ["M6"]);
});

test("president chance is 20 percent per vacancy and can repeat the next day", () => {
  for (const [roll, chosen] of [[19, true], [20, false]]) {
    const s = state();
    plans.ensure(s, {now:NOW, pick:max => max === 100 ? roll : 0});
    assert.equal(s.tomorrowReserveQueue.includes("P"), chosen);
    assert.ok(!s.reservePool.includes("P"));
    assert.ok(!s.reserveUsedPool.includes("P"));
  }
  const withPresidentToday = state({reserveQueue:["P","M1","M2","M3","M4"]});
  plans.ensure(withPresidentToday, {now:NOW, pick:() => 0});
  assert.ok(withPresidentToday.tomorrowReserveQueue.includes("P"));
});

test("using or skipping the president never changes either normal reserve pool", () => {
  for (const action of ["filled", "skipped"]) {
    const s = state({reserveQueue:["P","M1","M2","M3","M4"]});
    plans.ensure(s, options);
    const active = [...s.reservePool];
    const used = [...s.reserveUsedPool];
    plans.consume(s, {...options, expected:"P", action});
    assert.deepEqual(s.reservePool, active);
    assert.deepEqual(s.reserveUsedPool, used);
  }
});

test("published tomorrow list is immutable even if a later ship change conflicts", () => {
  const tomorrow = ["M6","M7","M8","M9","M17"];
  const s = state({reservePoolVersion:2, reservePool:Array.from({length:24}, (_, i) => `M${i + 1}`),
    reservePlanDate:"2026-10-23", reserveOriginalQueue:["M1","M2","M3","M4","M5"],
    tomorrowReserveDate:"2026-10-24", tomorrowReserveQueue:[...tomorrow],
    tomorrowReserveOriginalQueue:[...tomorrow], history:[record("2026-10-24", {
      captain:"M6", lineReserves:tomorrow,
    })]});
  plans.ensure(s, options);
  assert.deepEqual(s.tomorrowReserveQueue, tomorrow);
  assert.throws(() => plans.refresh(s, "2026-10-24", options), /已經透過 LINE 公布/u);
});

test("permanent and weekday exclusions apply to both daily lists", () => {
  const s = state({cabin4ExcludedMembers:["M1"],
    roleWeekdayRestrictions:{friday:{memberId:"M2", roles:["cabin4"], blockedWeekdays:[5]}}});
  plans.ensure(s, options);
  assert.ok(!s.reserveQueue.includes("M1"));
  assert.ok(!s.reserveQueue.includes("M2"));
  assert.ok(!s.tomorrowReserveQueue.includes("M1"));
});

test("Member IDs survive daily pools, exclusions, snapshots and consumption", () => {
  const members = Object.fromEntries(Array.from({length:24}, (_, i) => [String(i + 1),
    {memberId:String(i + 1), gameName:`Player${i + 1}`, lineNameHint:`Line${i + 1}`, active:true}]));
  const snap = ref => createHistoryMemberSnapshot(members[ref]);
  const s = state({members, memberIdentityVersion:1, presidentMemberId:"24", reserveQueue:["1","2","3","4","5"],
    history:[record("2026-10-23", {memberIdentity:{captain:snap("10"), guardian:snap("11"), cabin4:[snap("12")]}})]});
  plans.ensure(s, options);
  assert.ok(s.tomorrowReserveQueue.every(ref => /^\d+$/u.test(ref)));
  const expected = s.reserveQueue[0];
  plans.consume(s, {...options, expected});
  assert.equal(s.reserveUses[0].memberId, expected);
  assert.ok(s.reserveUsedPool.includes(expected));
  assert.equal(s.history[0].memberIdentity.reserves[0].memberId, "1");
});

test("small guild cannot reuse yesterday's list just to reach five", () => {
  const s = state({guildMembers:["M1","M2"], presidentName:"", reserveQueue:["M1","M2"]});
  plans.ensure(s, options);
  assert.deepEqual(s.reserveQueue, ["M1","M2"]);
  assert.deepEqual(s.tomorrowReserveQueue, []);
});

test("future pre-draw does not change either active daily list", () => {
  const s = state();
  plans.ensure(s, options);
  const before = clone([s.reserveQueue, s.tomorrowReserveQueue, s.reservePool]);
  s.history.unshift(record("2026-10-25"));
  plans.ensure(s, options);
  assert.deepEqual([s.reserveQueue, s.tomorrowReserveQueue, s.reservePool], before);
  assert.equal(s.history[0].reserves, undefined);
});

test("stale #1 and invalid replacement are rejected without consuming a member", () => {
  const s = state();
  plans.ensure(s, options);
  assert.throws(() => plans.consume(s, {...options, expected:"M2"}), /變更/u);
  assert.throws(() => plans.consume(s, {...options, replaced:"absent"}), /第四船艙/u);
  assert.equal(s.reserveQueue.length, 5);
  assert.equal(s.reserveUsedPool.length, 0);
});

test("server initializes plans atomically and repeated reconciliation is write-free", async () => {
  let current = state({history:[record("2026-10-24")]});
  let writes = 0;
  const ref = {transaction:async update => {
    const next = update(clone(current));
    if (next) { current = next; writes++; }
    return {committed:Boolean(next)};
  }};
  await syncReservePlans(ref, NOW);
  await syncReservePlans(ref, NOW);
  assert.equal(writes, 1);
  assert.equal(current.history[0].reserves.length, 5);
});

test("cold Firebase cache keeps reconciliation alive until server data arrives", async () => {
  let current = state({history:[record("2026-10-24")]});
  const ref = {transaction:async update => {
    assert.equal(update(null), null);
    const next = update(clone(current));
    if (next) current = next;
    return {committed:Boolean(next)};
  }};
  await syncReservePlans(ref, NOW);
  assert.equal(current.reservePlanDate, "2026-10-23");
  assert.equal(current.tomorrowReserveDate, "2026-10-24");
});

test("queued LINE draw uses current plan while historical rendering stays frozen", () => {
  const r = record("2026-10-24", {reserves:["New - Current"], lineReserves:["Old - Frozen"]});
  const rendered = renderPendingDraw(r, {type:"draw", message:{type:"textV2", text:"Tomorrow title\n\nOld reserve"}}, {}, "group");
  assert.match(rendered.message.text, /^Tomorrow title\n\n/u);
  assert.match(rendered.message.text, /1\. Current @New/u);
  assert.doesNotMatch(rendered.message.text, /@Old/u);
  assert.deepEqual(rendered.reserveSnapshot.names, ["New - Current"]);
  assert.match(buildDrawLineMessage(r, {}, "group").message.text, /1\. Frozen @Old/u);
});

test("frontend loads daily planner and exposes active and used reserve pools", () => {
  const html = fs.readFileSync(path.join(__dirname, "../../index.html"), "utf8");
  new vm.Script(html.slice(html.lastIndexOf("<script>") + 8, html.lastIndexOf("</script>")));
  assert.match(html, /id="tomorrowReservePanel"/u);
  assert.match(html, /id="reserveUsedPoolView"/u);
  assert.match(html, /daily-reserves-v4-chief20/u);
  assert.match(html, /id="skipReserveBtn"/u);
});

test("filled and skipped actions remain distinct", () => {
  const s = state();
  plans.ensure(s, options);
  assert.equal(plans.consume(s, options).action, "filled");
  assert.equal(plans.skip(s, options).action, "skipped");
  assert.deepEqual(s.reserveUses.map(use => use.action), ["filled", "skipped"]);
});
