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
  return {guildMembers: Array.from({length:24}, (_,i) => `M${i+1}`), presidentName:"P",
    cabin4ExcludedMembers:[],reserveQueue:["M1","M2","M3","M4","M5"],
    reservePool:[],reserveUses:[],history:[],...overrides};
}
function record(date, overrides = {}) {
  return {id:date,date,captain:"M10",guardian:"M11",cabin4:["M12","M13","M14","M15","M16"],...overrides};
}
test("Taipei midnight defines today and tomorrow regardless of server timezone", () => {
  assert.equal(plans.day("2026-10-23T15:59:59Z"),"2026-10-23");
  assert.equal(plans.day("2026-10-23T16:00:00Z"),"2026-10-24");
  assert.equal(plans.nextDay("2026-12-31"),"2027-01-01");
});
test("legacy queue migrates into two independently stored dated lists", () => {
  const s=state(); plans.ensure(s,options);
  assert.equal(s.reservePlanDate,"2026-10-23");
  assert.equal(s.tomorrowReserveDate,"2026-10-24");
  assert.deepEqual(s.reserveQueue,["M1","M2","M3","M4","M5"]);
  assert.deepEqual(s.tomorrowReserveQueue,s.reserveQueue);
  assert.notEqual(s.tomorrowReserveQueue,s.reserveQueue);
});
test("tomorrow ship exclusions change tomorrow only and preserve eligible order", () => {
  const s=state({history:[record("2026-10-24",{captain:"M1",guardian:"M2",cabin4:["M3","M12","M13","M14","M15"]})]});
  plans.ensure(s,options);
  assert.deepEqual(s.reserveQueue,["M1","M2","M3","M4","M5"]);
  assert.deepEqual(s.tomorrowReserveQueue.slice(0,2),["M4","M5"]);
  assert.equal(s.tomorrowReserveQueue.length,5);
  assert.ok(s.tomorrowReserveQueue.every(ref=>!["M1","M2","M3"].includes(ref)));
});
test("using today #1 shifts FIFO, does not refill today, and replaces that member tomorrow", () => {
  const s=state({history:[record("2026-10-23"),record("2026-10-24")]}); plans.ensure(s,options);
  const use=plans.consume(s,{...options,expected:"M1",replaced:"M12"});
  assert.deepEqual(s.reserveQueue,["M2","M3","M4","M5"]);
  assert.deepEqual(s.tomorrowReserveQueue.slice(0,4),s.reserveQueue);
  assert.equal(s.tomorrowReserveQueue.length,5);
  assert.ok(!s.tomorrowReserveQueue.includes("M1"));
  assert.equal(use.replaced,"M12");
  assert.equal(s.history[0].reserveUses[0].member,"M1");
  assert.equal(s.reserveUses.length,1);
});
test("using someone absent from tomorrow leaves its full list unchanged", () => {
  const s=state({history:[record("2026-10-24",{captain:"M1"})]}); plans.ensure(s,options);
  const tomorrow=[...s.tomorrowReserveQueue]; plans.consume(s,options);
  assert.deepEqual(s.tomorrowReserveQueue,tomorrow);
});
test("scheduler reconciliation never refills today after a reserve is used", () => {
  const s=state(); plans.ensure(s,options); plans.consume(s,options);
  const before=clone(s); plans.ensure(s,options); plans.ensure(s,options);
  assert.deepEqual(s,before); assert.equal(s.reserveQueue.length,4);
});
test("00:00 promotes tomorrow and immediately generates the following day's plan", () => {
  const s=state({history:[record("2026-10-24"),record("2026-10-25",{captain:"M1"})]}); plans.ensure(s,options);
  const tomorrow=[...s.tomorrowReserveQueue];
  plans.ensure(s,{...options,now:new Date("2026-10-23T16:00:00Z")});
  assert.equal(s.reservePlanDate,"2026-10-24"); assert.equal(s.tomorrowReserveDate,"2026-10-25");
  assert.deepEqual(s.reserveQueue,tomorrow); assert.equal(s.tomorrowReserveQueue.length,5);
  assert.ok(!s.tomorrowReserveQueue.includes("M1"));
});
test("rollover is idempotent and stale retries cannot move the state backward", () => {
  const s=state(); plans.ensure(s,options);
  const midnight={...options,now:new Date("2026-10-24T00:00:00+08:00")}; plans.ensure(s,midnight);
  const before=clone(s); plans.ensure(s,midnight); plans.ensure(s,options); assert.deepEqual(s,before);
});
test("missing tomorrow ship still creates a plan and later ship draws reconcile only tomorrow", () => {
  const s=state(); plans.ensure(s,options); assert.equal(s.tomorrowReserveQueue.length,5);
  s.history.push(record("2026-10-24",{captain:"M1"})); plans.ensure(s,options);
  assert.ok(!s.tomorrowReserveQueue.includes("M1")); assert.equal(s.tomorrowReserveQueue.length,5);
  assert.equal(s.history[0].reserves.length,5); assert.equal(s.reserveQueue[0],"M1");
});
test("pre-drawing the day after tomorrow never changes either active queue", () => {
  const s=state(); plans.ensure(s,options); const before=clone([s.reserveQueue,s.tomorrowReserveQueue,s.reservePool]);
  s.history.unshift(record("2026-10-25",{captain:"M1"})); plans.ensure(s,options);
  assert.deepEqual([s.reserveQueue,s.tomorrowReserveQueue,s.reservePool],before);
  assert.equal(s.history[0].reserves,undefined);
});
test("already-used reserves cannot reenter either active plan after pool rollover", () => {
  const s=state({reservePool:["M1"],reserveUses:[{date:"2026-10-23",member:"M1"}]});
  plans.ensure(s,options); plans.refresh(s,"2026-10-23",options);
  assert.ok(!s.reserveQueue.includes("M1")); assert.ok(!s.tomorrowReserveQueue.includes("M1"));
});
test("president chance is 30 percent per vacancy and president is never in the normal pool", () => {
  for(const [roll,chosen] of [[29,true],[30,false]]) {
    const s=state({reserveQueue:["M1","M2","M3","M4"]});
    plans.ensure(s,{now:NOW,pick:max=>max===100?roll:0});
    assert.equal(s.reserveQueue.includes("P"),chosen);
    assert.ok(s.reserveQueue.filter(ref=>ref==="P").length<=1); assert.ok(!s.reservePool.includes("P"));
  }
});
test("president aboard tomorrow is excluded tomorrow while remaining in today's queue", () => {
  const s=state({reserveQueue:["P","M1","M2","M3","M4"],history:[record("2026-10-24",{guardian:"P"})]});
  plans.ensure(s,{...options,pick:()=>0});
  assert.equal(s.reserveQueue[0],"P"); assert.ok(!s.tomorrowReserveQueue.includes("P"));
});
test("permanent exclusions clean both plans without changing notified historical snapshots", () => {
  const s=state({cabin4ExcludedMembers:["M1"],history:[record("2026-10-24",{lineReserves:["M1"]})]});
  plans.ensure(s,options); assert.ok(!s.reserveQueue.includes("M1")); assert.ok(!s.tomorrowReserveQueue.includes("M1"));
  assert.deepEqual(s.history[0].lineReserves,["M1"]);
});
test("Member IDs, weekly restrictions and use propagation work across both dates", () => {
  const members=Object.fromEntries(Array.from({length:24},(_,i)=>[String(i+1),{memberId:String(i+1),gameName:`Player${i+1}`,lineNameHint:`Line${i+1}`,active:true}]));
  const snap=ref=>createHistoryMemberSnapshot(members[ref]);
  const s=state({members,memberIdentityVersion:1,presidentMemberId:"24",reserveQueue:["1","2","3","4","5"],
    roleWeekdayRestrictions:{friday:{memberId:"1",roles:["cabin4"],blockedWeekdays:[5]}},
    history:[record("2026-10-24",{memberIdentity:{captain:snap("10"),guardian:snap("11"),cabin4:[snap("12")]}})]});
  plans.ensure(s,options); assert.ok(!s.reserveQueue.includes("1"));
  assert.ok(s.tomorrowReserveQueue.every(ref=>/^\d+$/.test(ref)));
  assert.equal(s.history[0].memberIdentity.reserves[0].memberId,s.tomorrowReserveQueue[0]);
  const expected=s.reserveQueue[0]; plans.consume(s,{...options,expected});
  assert.equal(s.reserveUses[0].memberId,expected); assert.ok(!s.tomorrowReserveQueue.includes(expected));
});
test("refresh affects selected active date and rejects dates beyond tomorrow", () => {
  const s=state(); plans.ensure(s,options); const today=[...s.reserveQueue];
  s.history.push(record("2026-10-24",{captain:"M1"})); plans.refresh(s,"2026-10-24",options);
  assert.deepEqual(s.reserveQueue,today); assert.throws(()=>plans.refresh(s,"2026-10-25",options),/今日與明日/u);
});
test("small pools return unique available members without looping indefinitely", () => {
  const s=state({guildMembers:["M1","M2"],presidentName:"",reserveQueue:[]}); plans.ensure(s,options);
  assert.equal(s.reserveQueue.length,2); assert.equal(new Set(s.reserveQueue).size,2);
});
test("periodic reconciliation never rerolls unfillable vacancies without a context change", () => {
  const s=state({guildMembers:["M1","M2"],reserveQueue:[]}); let rolls=0;
  const opt={now:NOW,pick:max=>{rolls++;return max-1;}};
  plans.ensure(s,opt); const before=rolls;
  plans.ensure(s,opt); plans.ensure(s,opt);
  assert.equal(rolls,before);
});
test("catching up after missed midnight runs preserves history and creates current dated plans", () => {
  const s=state({history:[record("2026-10-23"),record("2026-10-27")]}); plans.ensure(s,options);
  const oldRecord=clone(s.history[0]);
  plans.ensure(s,{...options,now:new Date("2026-10-27T00:01:00+08:00")});
  assert.equal(s.reservePlanDate,"2026-10-27"); assert.equal(s.tomorrowReserveDate,"2026-10-28");
  assert.deepEqual(s.history[0],oldRecord);
});
test("stale #1 and invalid replacement are rejected without removing a member", () => {
  const s=state(); plans.ensure(s,options);
  assert.throws(()=>plans.consume(s,{...options,expected:"M2"}),/變更/u);
  assert.throws(()=>plans.consume(s,{...options,replaced:"absent"}),/第四船艙/u);
  assert.equal(s.reserveQueue.length,5);
});
test("server initializes old draws atomically and performs no writes on repeated current plans", async () => {
  let current=state({history:[record("2026-10-24")]}); let writes=0;
  const ref={transaction:async update=>{const next=update(clone(current));if(next){current=next;writes++;}return {committed:Boolean(next)};}};
  await syncReservePlans(ref,NOW); await syncReservePlans(ref,NOW);
  assert.equal(writes,1); assert.equal(current.history[0].reserves.length,5);
});
test("queued LINE message uses latest tomorrow plan while historical rendering stays frozen", () => {
  const r=record("2026-10-24",{reserves:["New - Current"],lineReserves:["Old - Frozen"]});
  const rendered=renderPendingDraw(r,{type:"draw",message:{type:"textV2",text:"Tomorrow title\n\nOld reserve"}},{},"group");
  assert.match(rendered.message.text,/^Tomorrow title\n\n/u); assert.match(rendered.message.text,/1\. @New/u);
  assert.doesNotMatch(rendered.message.text,/@Old/u); assert.deepEqual(rendered.reserveSnapshot.names,["New - Current"]);
  assert.match(buildDrawLineMessage(r,{},"group").message.text,/1\. @Old/u);
});
test("cold Firebase cache keeps reconciliation alive until the server supplies current data", async () => {
  let current=state({history:[record("2026-10-24")]});
  const ref={transaction:async update=>{
    assert.equal(update(null),null);
    const next=update(clone(current));
    if(next) current=next;
    return {committed:Boolean(next)};
  }};
  await syncReservePlans(ref,NOW);
  assert.equal(current.reservePlanDate,"2026-10-23");
  assert.equal(current.tomorrowReserveDate,"2026-10-24");
  assert.equal(current.history.length,1);
  assert.equal(current.history[0].reserves.length,5);
});
test("frontend loads shared planner and parses with both dated reserve panels", () => {
  const html=fs.readFileSync(path.join(__dirname,"../../index.html"),"utf8");
  new vm.Script(html.slice(html.lastIndexOf("<script>")+8,html.lastIndexOf("</script>")));
  assert.match(html,/id="tomorrowReservePanel"/u); assert.match(html,/reservePlans\.js\?v=/u);
});
