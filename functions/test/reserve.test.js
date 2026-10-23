"use strict";
const {readFileSync} = require("node:fs");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const test = require("node:test");
const {webcrypto} = require("node:crypto");
const path = require("node:path");
const {buildDrawLineMessage} = require("../lib/line");
const html = readFileSync(path.join(__dirname, "../../index.html"), "utf8");
const source = html.slice(html.lastIndexOf("<script>") + 8, html.lastIndexOf("</script>"));
function run(code) {
  const context = {localStorage: {getItem: () => null}, window: {
    addEventListener: () => {}, crypto: webcrypto,
    CapyDrawHistoryPublicationUi: require("../../history-publication-ui"),
    CapyDrawLineSchedulesUi: require("../../line-schedules-ui"),
    CapyDrawRoleExclusions: require("../../draw-role-exclusions"),
    CapyDrawMemberIdentity: require("../lib/memberIdentity"),
  }};
  return vm.runInNewContext(source.slice(0, source.indexOf("    try { bootstrap();")) + code, context);
}
test("reserve queue excludes aboard players, preserves order, and consumes its own pool", () => {
  const result = JSON.parse(run(`
    const w = normalizeState({guildMembers: ['A','B','C','D','E','F','G','H','I'], presidentName:'P', reserveQueue:['D','A'], reservePool:['D','E','F','G','H','I']});
    randomIndex = n => n - 1;
    const r = {id:'r', date:'2026-10-23', captain:'A', guardian:'B', cabin4:['C'], warnings:[]};
    fillReserves(w,r);
    JSON.stringify({queue:w.reserveQueue,pool:w.reservePool});
  `));
  assert.equal(result.queue.length, 5);
  assert.equal(result.queue[0], "D");
  assert.equal(new Set(result.queue).size, 5);
  assert.ok(result.queue.every(name => !["A", "B", "C"].includes(name)));
  assert.ok(result.queue.slice(1).every(name => !result.pool.includes(name)));
});
test("president enters at most once and cannot enter when aboard or cabin-excluded", () => {
  for (const blocked of ["none", "aboard", "excluded"]) {
    const queue = JSON.parse(run(`
      randomIndex = () => 0;
      const w = normalizeState({guildMembers:['A','B','C','D','E','F','G','H','P'],presidentName:'P',cabin4ExcludedMembers:${blocked === "excluded" ? "['P']" : "[]"}});
      fillReserves(w,{id:'r',date:'2026-10-23',captain:'A',guardian:${blocked === "aboard" ? "'P'" : "'B'"},cabin4:['C']});
      JSON.stringify(w.reserveQueue);
    `));
    assert.equal(queue.filter(n => n === "P").length, blocked === "none" ? 1 : 0);
  }
});
test("president probability is 30 percent per vacant position", () => {
  for (const [roll, expected] of [[29, true], [30, false]]) {
    const queue = JSON.parse(run(`
      randomIndex = n => n === 100 ? ${roll} : 0;
      const w = normalizeState({guildMembers:['A','B','C','D','E','F','G','H'],presidentName:'P',reserveQueue:['D','E','F','G']});
      fillReserves(w,{id:'r',date:'2026-10-23',captain:'A',guardian:'B',cabin4:['C']});
      JSON.stringify(w.reserveQueue);
    `));
    assert.equal(queue.includes("P"), expected);
  }
});
test("exclusion cleans live queue but preserves history", () => {
  const result = JSON.parse(run(`JSON.stringify(normalizeState({guildMembers:['A','B'],cabin4ExcludedMembers:['A'],reserveQueue:['A','B'],reservePool:['A','B'],history:[{reserves:['A']}] }));`));
  assert.deepEqual(result.reserveQueue, ["B"]);
  assert.deepEqual(result.reservePool, ["B"]);
  assert.deepEqual(result.history[0].reserves, ["A"]);
});
test("LINE retains notified reserve order", () => {
  const {message} = buildDrawLineMessage({date:"2026-10-23",captain:"A",guardian:"B",cabin4:["C"],reserves:["E"],lineReserves:["D"]}, {}, "group");
  assert.match(message.text, /1\. @D/);
  assert.doesNotMatch(message.text, /1\. @E/);
});
test("using first reserve records optional replacement without refilling or altering notification", () => {
  const result = JSON.parse(run(`
    const w = normalizeState({guildMembers:['D','E','F','G','H'], reserveQueue:['D','E','F','G','H'], reserveRecordId:'r'});
    const r = {id:'r', cabin4:['C'], reserves:['D','E','F','G','H']};
    consumeReserve(w,r,'C');
    consumeReserve(w,r);
    JSON.stringify({queue:w.reserveQueue,record:r});
  `));
  assert.deepEqual(result.queue, ["F", "G", "H"]);
  assert.equal(result.record.reserves[0], "D");
  assert.equal(result.record.reserveUses[0].member, "D");
  assert.equal(result.record.reserveUses[0].replaced, "C");
  assert.equal(result.record.reserveUses[1].replaced, "");
});
test("Member ID mode preserves references, snapshots, and weekly cabin restrictions", () => {
  const result = JSON.parse(run(`
    randomIndex = () => 0;
    const members = Object.fromEntries(Array.from({length:12}, (_,i) => [String(i+1), {memberId:String(i+1),gameName:'Player'+(i+1),lineNameHint:'Line'+(i+1),active:true}]));
    const w = normalizeState({members,memberIdentityVersion:1,presidentMemberId:'12',reserveQueue:['4','5'],roleWeekdayRestrictions:{friday:{memberId:'4',roles:['cabin4'],blockedWeekdays:[5]}}});
    const snap = ref => createHistoryMemberSnapshot(w.members[ref]);
    const r = {id:'r',date:'2026-10-23',captain:'Line1 - Player1',guardian:'Line2 - Player2',cabin4:['Line3 - Player3'], memberIdentity:{captain:snap('1'),guardian:snap('2'),cabin4:[snap('3')]}};
    fillReserves(w,r);
    consumeReserve(w,r);
    JSON.stringify({queue:w.reserveQueue,record:r});
  `));
  assert.ok(result.queue.every(id => /^\d+$/.test(id)));
  assert.ok(!result.queue.includes("4"));
  assert.equal(result.record.reserveUses[0].memberId, "5");
  assert.equal(result.record.memberIdentity.reserves[0].memberId, "5");
  assert.equal(result.queue.length, 4);
});
test("next date preserves pending order and never repeats a player who already filled in", () => {
  const result = JSON.parse(run(`
    randomIndex = n => n - 1;
    const w = normalizeState({guildMembers:['A','B','C','D','E','F','G','H','I','J'],presidentName:'P',reserveQueue:['D','E','F','G']});
    const r = {id:'next',date:'2026-10-24',captain:'A',guardian:'B',cabin4:['C'],reserveUses:[{member:'I'}]};
    fillReserves(w,r);
    JSON.stringify(w.reserveQueue);
  `));
  assert.deepEqual(result.slice(0, 4), ["D", "E", "F", "G"]);
  assert.equal(result.length, 5);
  assert.ok(!result.includes("I"));
});

test("global reserves can be drawn and used without any draw date or history", () => {
  const result = JSON.parse(run(`
    randomIndex = n => n - 1;
    const w = normalizeState({guildMembers:['A','B','C','D','E','F','G'],presidentName:'P',reserveRecordId:'legacy-date'});
    fillReserves(w);
    const before = [...w.reserveQueue];
    consumeReserve(w);
    JSON.stringify({before,queue:w.reserveQueue,uses:w.reserveUses,history:w.history});
  `));
  assert.equal(result.before.length, 5);
  assert.deepEqual(result.queue, result.before.slice(1));
  assert.equal(result.uses[0].member, result.before[0]);
  assert.equal(result.uses[0].replaced, "");
  assert.deepEqual(result.history, []);
});

test("selected draw date never gates or chooses the global reserve operation", () => {
  const handler = source.slice(source.indexOf('      $("fillReservesBtn").addEventListener'), source.indexOf('      $("drawBtn").addEventListener'));
  assert.doesNotMatch(handler, /currentRecordId|reserveRecordId|drawDate/);
  assert.match(handler, /todayString\(\)/);
  assert.doesNotMatch(source, /請選擇目前補位所屬的抽籤日期/);
});

test("global FIFO ignores legacy date ownership and blocks same-day used members on refill", () => {
  const result = JSON.parse(run(`
    randomIndex = n => n - 1;
    const w = normalizeState({guildMembers:['A','B','C','D','E','F','G'],presidentName:'P',reserveQueue:['A','B','C','D','E'],reserveRecordId:'old'});
    consumeReserve(w);
    fillReserves(w);
    JSON.stringify({queue:w.reserveQueue,uses:w.reserveUses});
  `));
  assert.ok(!result.queue.includes("A"));
  assert.equal(result.queue.length, 5);
  assert.deepEqual(result.queue.slice(0, 4), ["B", "C", "D", "E"]);
});
