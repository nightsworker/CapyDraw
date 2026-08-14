"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {isDrawPublishedToLine} = require("../lib/drawKnowledge");
const {selectDrawRecordByDate, sendDrawLineRecord} = require("../lib/drawLineDelivery");
const {
  dispatchFixedOccurrence,
  dispatchTomorrowDraw,
} = require("../lib/lineScheduleRuntime");
const {fixedRunKey, latestTomorrowOccurrence} = require("../lib/lineSchedule");

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

class MemoryRef {
  constructor(box, path = []) {
    this.box = box;
    this.path = path;
  }

  child(key) {
    return new MemoryRef(this.box, [...this.path, String(key)]);
  }

  value() {
    return this.path.reduce((value, key) => value && value[key], this.box.value);
  }

  write(value) {
    if (!this.path.length) {
      this.box.value = clone(value);
      return;
    }
    let parent = this.box.value;
    if (!parent || typeof parent !== "object") parent = this.box.value = {};
    for (const key of this.path.slice(0, -1)) {
      if (!parent[key] || typeof parent[key] !== "object") parent[key] = {};
      parent = parent[key];
    }
    parent[this.path.at(-1)] = clone(value);
  }

  async get() {
    const value = clone(this.value());
    return {val: () => value};
  }

  async set(value) {
    this.write(value);
  }

  async update(values) {
    this.write({...this.value(), ...clone(values)});
  }

  async remove() {
    if (!this.path.length) this.box.value = null;
    else {
      const parent = new MemoryRef(this.box, this.path.slice(0, -1)).value();
      if (parent) delete parent[this.path.at(-1)];
    }
  }

  transaction(update) {
    const key = this.path.join("/") || "/";
    const previous = this.box.queues.get(key) || Promise.resolve();
    const operation = previous.then(() => {
      const next = update(clone(this.value()));
      if (next === undefined) return {committed: false, snapshot: {val: () => clone(this.value())}};
      this.write(next);
      return {committed: true, snapshot: {val: () => clone(this.value())}};
    });
    this.box.queues.set(key, operation.catch(() => {}));
    return operation;
  }
}

function memoryRef(value) {
  return new MemoryRef({value: clone(value), queues: new Map()});
}

function drawRecord(overrides = {}) {
  return {
    id: "draw-2026-08-15",
    date: "2026-08-15",
    captain: "Rain - 流鬼",
    guardian: "@Hank - 挖系小嗨",
    cabin4: ["Chia - 嘻嘻不嘻嘻"],
    ...overrides,
  };
}

function fixedSchedule(overrides = {}) {
  return {
    id: "s_runtime1",
    name: "固定公告",
    enabled: true,
    messageTemplate: [{type: "all"}, {type: "text", text: " 明天記得三張船票"}],
    startDate: "2026-08-14",
    endDate: null,
    recurrence: {type: "daily", weekdays: [], dayOfMonth: null},
    time: "20:30",
    ...overrides,
  };
}

function occurrence(date = "2026-08-14", time = "20:30") {
  return {
    occurrenceDate: date,
    scheduledFor: `${date}T12:30:00.000Z`,
    timestamp: Date.parse(`${date}T12:30:00.000Z`),
    runKey: fixedRunKey("s_runtime1", date, time),
  };
}

test("same-date multiple draw records fail closed as ambiguous", () => {
  assert.equal(selectDrawRecordByDate([drawRecord(), drawRecord({id: "other"})], "2026-08-15").status,
    "ambiguous-draw-records");
});

test("manual draw delivery uses canonical formatter and writes publication only after push", async () => {
  const historyRef = memoryRef([drawRecord()]);
  const claimsRef = memoryRef({});
  const order = [];
  const result = await sendDrawLineRecord({
    historyRef, claimsRef, recordId: "draw-2026-08-15", groupId: "G",
    bindings: {}, owner: "manual", retryNamespace: "manual-one", allowRepublish: true,
    pushMessage: async ({messages}) => { order.push("push"); assert.equal(messages[0].type, "textV2"); },
  });
  order.push("returned");
  assert.equal(result.status, "sent");
  assert.deepEqual(order, ["push", "returned"]);
  assert.equal(isDrawPublishedToLine(historyRef.value()[0]), true);
  assert.equal(historyRef.value()[0].lastLineSendStatus, "sent");
});

test("LINE draw failure never writes publication success", async () => {
  const historyRef = memoryRef([drawRecord()]);
  await assert.rejects(sendDrawLineRecord({
    historyRef, claimsRef: memoryRef({}), recordId: "draw-2026-08-15", groupId: "G",
    bindings: {}, owner: "scheduler", retryNamespace: "draw-run", skipPublished: true,
    pushMessage: async () => { throw Object.assign(new Error("LINE down"), {lineStatus: 503}); },
  }), /LINE down/u);
  assert.equal(isDrawPublishedToLine(historyRef.value()[0]), false);
  assert.equal(historyRef.value()[0].lineSentAt, undefined);
});

test("manual and scheduler race can push at most once", async () => {
  const historyRef = memoryRef([drawRecord()]);
  const claimsRef = memoryRef({});
  let pushes = 0;
  let release;
  const pushMessage = async () => {
    pushes += 1;
    await new Promise((resolve) => { release = resolve; });
  };
  const first = sendDrawLineRecord({historyRef, claimsRef, recordId: "draw-2026-08-15",
    groupId: "G", bindings: {}, owner: "scheduler", retryNamespace: "draw-run",
    skipPublished: true, pushMessage});
  await new Promise((resolve) => setImmediate(resolve));
  const second = await sendDrawLineRecord({historyRef, claimsRef, recordId: "draw-2026-08-15",
    groupId: "G", bindings: {}, owner: "manual", retryNamespace: "manual-run",
    allowRepublish: true, pushMessage});
  assert.equal(second.status, "busy");
  release();
  assert.equal((await first).status, "sent");
  assert.equal(pushes, 1);
});

test("tomorrow automation disabled does nothing", async () => {
  const result = await dispatchTomorrowDraw({settings: {enabled: false}, now: new Date()});
  assert.equal(result.status, "disabled");
});

test("21:00 tomorrow draw exists and unpublished then sends and publishes", async () => {
  const now = new Date("2026-08-14T13:00:30.000Z");
  const result = await dispatchTomorrowDraw({
    settings: {enabled: true, time: "21:00"},
    runRef: memoryRef(null), historyRef: memoryRef([drawRecord()]),
    bindings: {}, defaultGroupId: "G", drawClaimsRef: memoryRef({}), now,
    pushMessage: async () => {},
  });
  assert.equal(result.status, "sent");
  assert.equal(isDrawPublishedToLine(result.record), true);
});

test("manually or backfill-published tomorrow draw is skipped", async () => {
  for (const source of ["manual", "backfill"]) {
    const published = drawRecord({lineSentAt: "2026-08-14T10:00:00.000Z", lineSendCount: 1,
      lastLineSendStatus: source === "manual" ? "failed" : "sent"});
    let pushes = 0;
    const result = await dispatchTomorrowDraw({
      settings: {enabled: true, time: "21:00"}, runRef: memoryRef(null),
      historyRef: memoryRef([published]), bindings: {}, defaultGroupId: "G",
      drawClaimsRef: memoryRef({}), now: new Date("2026-08-14T13:00:30.000Z"),
      pushMessage: async () => { pushes += 1; },
    });
    assert.equal(result.status, "skipped-already-published");
    assert.equal(pushes, 0);
  }
});

test("missing tomorrow draw waits in five-minute intervals then sends after creation", async () => {
  const settings = {enabled: true, time: "21:00"};
  const runRef = memoryRef(null);
  const historyRef = memoryRef([]);
  const claimsRef = memoryRef({});
  const at2100 = await dispatchTomorrowDraw({settings, runRef, historyRef, bindings: {},
    defaultGroupId: "G", drawClaimsRef: claimsRef, pushMessage: async () => {},
    now: new Date("2026-08-14T13:00:00.000Z")});
  assert.equal(at2100.status, "waiting-for-draw");
  assert.equal(at2100.nextCheckAt, "2026-08-14T13:05:00.000Z");
  const at2104 = await dispatchTomorrowDraw({settings, runRef, historyRef, bindings: {},
    defaultGroupId: "G", drawClaimsRef: claimsRef, pushMessage: async () => {},
    now: new Date("2026-08-14T13:04:00.000Z")});
  assert.equal(at2104.status, "not-due");
  historyRef.write([drawRecord()]);
  let pushes = 0;
  const at2105 = await dispatchTomorrowDraw({settings, runRef, historyRef, bindings: {},
    defaultGroupId: "G", drawClaimsRef: claimsRef, pushMessage: async () => { pushes += 1; },
    now: new Date("2026-08-14T13:05:00.000Z")});
  assert.equal(at2105.status, "sent");
  assert.equal(pushes, 1);
});

test("draw created at 22:17 is sent at the next eligible check around 22:20", async () => {
  const settings = {enabled: true, time: "21:00"};
  const runRef = memoryRef(null);
  const historyRef = memoryRef([]);
  const options = {settings, runRef, historyRef, bindings: {}, defaultGroupId: "G",
    drawClaimsRef: memoryRef({}), pushMessage: async () => {}};
  await dispatchTomorrowDraw({...options, now: new Date("2026-08-14T14:15:00.000Z")});
  historyRef.write([drawRecord()]);
  assert.equal((await dispatchTomorrowDraw({...options,
    now: new Date("2026-08-14T14:19:00.000Z")})).status, "not-due");
  assert.equal((await dispatchTomorrowDraw({...options,
    now: new Date("2026-08-14T14:20:00.000Z")})).status, "sent");
});

test("manual publication during waiting causes the next check to skip", async () => {
  const settings = {enabled: true, time: "21:00"};
  const runRef = memoryRef(null);
  const historyRef = memoryRef([]);
  const options = {settings, runRef, historyRef, bindings: {}, defaultGroupId: "G",
    drawClaimsRef: memoryRef({}), pushMessage: async () => { throw new Error("must not push"); }};
  await dispatchTomorrowDraw({...options, now: new Date("2026-08-14T13:00:00.000Z")});
  historyRef.write([drawRecord({lineSentAt: "2026-08-14T13:02:00.000Z", lineSendCount: 1})]);
  assert.equal((await dispatchTomorrowDraw({...options,
    now: new Date("2026-08-14T13:05:00.000Z")})).status, "skipped-already-published");
});

test("23:59 without a draw expires and the next date uses a new run key", async () => {
  const settings = {enabled: true, time: "21:00"};
  const first = latestTomorrowOccurrence(settings, new Date("2026-08-14T15:59:00.000Z"));
  const runRef = memoryRef(null);
  const result = await dispatchTomorrowDraw({settings, runRef, historyRef: memoryRef([]),
    bindings: {}, defaultGroupId: "G", drawClaimsRef: memoryRef({}), pushMessage: async () => {},
    now: new Date("2026-08-14T15:59:00.000Z")});
  assert.equal(result.status, "expired-no-draw");
  const next = latestTomorrowOccurrence(settings, new Date("2026-08-15T13:00:00.000Z"));
  assert.notEqual(first.runKey, next.runKey);
  assert.equal(next.targetDrawDate, "2026-08-16");
});

test("23:59 forces the final expiry check even when the 23:55 wait points to midnight", async () => {
  const settings = {enabled: true, time: "21:00"};
  const runRef = memoryRef(null);
  const options = {settings, runRef, historyRef: memoryRef([]), bindings: {},
    defaultGroupId: "G", drawClaimsRef: memoryRef({}), pushMessage: async () => {}};
  assert.equal((await dispatchTomorrowDraw({...options,
    now: new Date("2026-08-14T15:55:00.000Z")})).status, "waiting-for-draw");
  assert.equal(runRef.value().nextCheckAt, "2026-08-14T16:00:00.000Z");
  assert.equal((await dispatchTomorrowDraw({...options,
    now: new Date("2026-08-14T15:59:00.000Z")})).status, "expired-no-draw");
});

test("ambiguous tomorrow draws never push", async () => {
  let pushes = 0;
  const result = await dispatchTomorrowDraw({settings: {enabled: true, time: "21:00"},
    runRef: memoryRef(null), historyRef: memoryRef([drawRecord(), drawRecord({id: "two"})]),
    bindings: {}, defaultGroupId: "G", drawClaimsRef: memoryRef({}),
    pushMessage: async () => { pushes += 1; }, now: new Date("2026-08-14T13:00:00.000Z")});
  assert.equal(result.status, "ambiguous-draw-records");
  assert.equal(pushes, 0);
});

test("fixed schedule sends immutable core with one wrapper call", async () => {
  const runRef = memoryRef(null);
  let wrapperCalls = 0;
  let sent;
  const result = await dispatchFixedOccurrence({schedule: fixedSchedule(), occurrence: occurrence(),
    runRef, bindings: {}, defaultGroupId: "G", now: new Date("2026-08-14T12:31:00.000Z"),
    createWrapper: async () => { wrapperCalls += 1; return {intro: "先提醒。", outro: "", reason: "success"}; },
    pushMessage: async (request) => { sent = request; }});
  assert.equal(result.status, "sent");
  assert.equal(wrapperCalls, 1);
  assert.match(sent.messages[0].text, /\{mention0\} 明天記得三張船票/u);
  assert.equal(runRef.value().deliveryPayload, undefined);
});

test("AI wrapper failure fallback still sends the immutable core", async () => {
  let sent;
  const result = await dispatchFixedOccurrence({schedule: fixedSchedule(), occurrence: occurrence(),
    runRef: memoryRef(null), bindings: {}, defaultGroupId: "G",
    now: new Date("2026-08-14T12:31:00.000Z"),
    createWrapper: async () => ({intro: "固定安全提醒。", outro: "", reason: "openai-error"}),
    pushMessage: async (request) => { sent = request; }});
  assert.equal(result.status, "sent");
  assert.match(sent.messages[0].text, /固定安全提醒/u);
  assert.match(sent.messages[0].text, /三張船票/u);
});

test("concurrent fixed dispatchers claim one occurrence and push once", async () => {
  const runRef = memoryRef(null);
  let pushes = 0;
  let release;
  const options = {schedule: fixedSchedule(), occurrence: occurrence(), runRef,
    bindings: {}, defaultGroupId: "G", now: new Date("2026-08-14T12:31:00.000Z"),
    createWrapper: async () => ({intro: "提醒。", outro: "", reason: "success"}),
    pushMessage: async () => { pushes += 1; await new Promise((resolve) => { release = resolve; }); }};
  const first = dispatchFixedOccurrence(options);
  await new Promise((resolve) => setImmediate(resolve));
  const second = await dispatchFixedOccurrence(options);
  assert.equal(second.status, "busy");
  release();
  assert.equal((await first).status, "sent");
  assert.equal(pushes, 1);
});

test("fixed transient retries are bounded and reuse retry key and payload without a second AI call", async () => {
  const runRef = memoryRef(null);
  const retryKeys = [];
  const messages = [];
  let wrapperCalls = 0;
  const options = {schedule: fixedSchedule(), occurrence: occurrence(), runRef,
    bindings: {}, defaultGroupId: "G",
    createWrapper: async () => { wrapperCalls += 1; return {intro: "提醒。", outro: "", reason: "success"}; },
    pushMessage: async ({retryKey, messages: lineMessages}) => {
      retryKeys.push(retryKey); messages.push(JSON.stringify(lineMessages));
      if (retryKeys.length < 3) throw Object.assign(new Error("temporary"), {lineStatus: 503});
    }};
  assert.equal((await dispatchFixedOccurrence({...options,
    now: new Date("2026-08-14T12:31:00.000Z")})).status, "failed-retryable");
  assert.equal((await dispatchFixedOccurrence({...options,
    now: new Date("2026-08-14T12:32:00.000Z")})).status, "failed-retryable");
  assert.equal((await dispatchFixedOccurrence({...options,
    now: new Date("2026-08-14T12:37:00.000Z")})).status, "sent");
  assert.equal(new Set(retryKeys).size, 1);
  assert.equal(new Set(messages).size, 1);
  assert.equal(wrapperCalls, 1);
  assert.equal(runRef.value().retryCount, 3);
});
