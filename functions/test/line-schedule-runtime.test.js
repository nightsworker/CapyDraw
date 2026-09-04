"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {isDrawPublishedToLine} = require("../lib/drawKnowledge");
const {selectDrawRecordByDate, sendDrawLineRecord} = require("../lib/drawLineDelivery");
const {
  TERMINAL_RUN_STATUSES,
  dispatchFixedOccurrence,
  dispatchTomorrowDraw,
  nextOccurrenceAfter,
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
    this.box.gets += 1;
    const value = clone(this.value());
    return {val: () => value};
  }

  async set(value) {
    this.write(value);
  }

  async update(values) {
    this.write({...this.value(), ...clone(values)});
  }

  transaction(update) {
    const key = this.path.join("/") || "/";
    const previous = this.box.queues.get(key) || Promise.resolve();
    const operation = previous.then(() => {
      const next = update(clone(this.value()));
      if (next === undefined) {
        return {committed: false, snapshot: {val: () => clone(this.value())}};
      }
      this.write(next);
      return {committed: true, snapshot: {val: () => clone(this.value())}};
    });
    this.box.queues.set(key, operation.catch(() => {}));
    return operation;
  }
}

function memoryRef(value) {
  return new MemoryRef({value: clone(value), queues: new Map(), gets: 0});
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
    messageTemplate: [
      {type: "all"},
      {type: "text", text: " 明天 "},
      {type: "date", offsetDays: 1, format: "M/D"},
      {type: "text", text: " 記得三張船票"},
    ],
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

function pendingCollector() {
  const items = [];
  return {
    items,
    enqueue: async (item) => {
      if (!items.some((existing) => existing.id === item.id)) items.push(clone(item));
      return {created: true, announcement: item};
    },
  };
}

test("same-date multiple draw records fail closed as ambiguous", () => {
  assert.equal(selectDrawRecordByDate([drawRecord(), drawRecord({id: "other"})], "2026-08-15").status,
    "ambiguous-draw-records");
});

test("manual draw delivery remains an explicit push and publishes only after success", async () => {
  const historyRef = memoryRef([drawRecord()]);
  const order = [];
  const result = await sendDrawLineRecord({
    historyRef,
    claimsRef: memoryRef({}),
    recordId: "draw-2026-08-15",
    groupId: "G",
    bindings: {},
    owner: "manual",
    retryNamespace: "manual-one",
    allowRepublish: true,
    pushMessage: async ({messages}) => {
      order.push("push");
      assert.equal(messages[0].type, "textV2");
    },
  });
  order.push("returned");
  assert.equal(result.status, "sent");
  assert.deepEqual(order, ["push", "returned"]);
  assert.equal(isDrawPublishedToLine(historyRef.value()[0]), true);
});

test("manual LINE failure never writes publication success", async () => {
  const historyRef = memoryRef([drawRecord()]);
  await assert.rejects(sendDrawLineRecord({
    historyRef,
    claimsRef: memoryRef({}),
    recordId: "draw-2026-08-15",
    groupId: "G",
    bindings: {},
    owner: "manual",
    retryNamespace: "manual-run",
    allowRepublish: true,
    pushMessage: async () => {
      throw Object.assign(new Error("LINE down"), {lineStatus: 503});
    },
  }), /LINE down/u);
  assert.equal(isDrawPublishedToLine(historyRef.value()[0]), false);
});

test("tomorrow automation disabled does nothing", async () => {
  const result = await dispatchTomorrowDraw({settings: {enabled: false}, now: new Date()});
  assert.equal(result.status, "disabled");
});

test("tomorrow draw due creates one pending without publishing", async () => {
  const historyRef = memoryRef([drawRecord()]);
  const pending = pendingCollector();
  const result = await dispatchTomorrowDraw({
    settings: {enabled: true, time: "21:00"},
    runRef: memoryRef(null),
    historyRef,
    bindings: {},
    defaultGroupId: "G",
    enqueueAnnouncement: pending.enqueue,
    now: new Date("2026-08-14T13:00:30.000Z"),
  });
  assert.equal(result.status, "queued-for-reply");
  assert.equal(pending.items.length, 1);
  assert.equal(pending.items[0].type, "draw");
  assert.equal(pending.items[0].drawRecordId, "draw-2026-08-15");
  assert.equal(pending.items[0].expiresAt, null);
  assert.equal(isDrawPublishedToLine(historyRef.value()[0]), false);
});

test("editing tomorrow automation time on the same day queues only once", async () => {
  const historyRef = memoryRef([drawRecord()]);
  const runRef = memoryRef(null);
  const pending = pendingCollector();
  const common = {runRef, historyRef, bindings: {}, defaultGroupId: "G",
    enqueueAnnouncement: pending.enqueue};
  const first = await dispatchTomorrowDraw({...common,
    settings: {enabled: true, time: "13:00"},
    now: new Date("2026-08-14T05:00:30.000Z")});
  const edited = await dispatchTomorrowDraw({...common,
    settings: {enabled: true, time: "15:19"},
    now: new Date("2026-08-14T07:19:30.000Z")});
  assert.equal(first.status, "queued-for-reply");
  assert.equal(edited.status, "queued-for-reply");
  assert.equal(pending.items.length, 1);
  assert.equal(runRef.value().checkCount, 1);
  assert.equal(isDrawPublishedToLine(historyRef.value()[0]), false);
});

test("concurrent same-day dispatchers with different configured times still queue once", async () => {
  const historyRef = memoryRef([drawRecord()]);
  const runRef = memoryRef(null);
  const pending = pendingCollector();
  const common = {runRef, historyRef, bindings: {}, defaultGroupId: "G",
    enqueueAnnouncement: pending.enqueue, now: new Date("2026-08-14T07:20:00.000Z")};
  await Promise.all([
    dispatchTomorrowDraw({...common, settings: {enabled: true, time: "13:00"}}),
    dispatchTomorrowDraw({...common, settings: {enabled: true, time: "15:19"}}),
  ]);
  assert.equal(pending.items.length, 1);
  assert.equal(runRef.value().checkCount, 1);
});

test("array and object histories both find tomorrow record by record.date", async () => {
  for (const history of [[null, drawRecord()], {unrelatedFirebaseKey: drawRecord()}]) {
    const pending = pendingCollector();
    const result = await dispatchTomorrowDraw({
      settings: {enabled: true, time: "10:37"},
      runRef: memoryRef(null),
      historyRef: memoryRef(history),
      bindings: {},
      defaultGroupId: "G",
      enqueueAnnouncement: pending.enqueue,
      now: new Date("2026-08-14T02:40:00.000Z"),
    });
    assert.equal(result.status, "queued-for-reply");
    assert.equal(result.lookup.matchedRecordCount, 1);
    assert.equal(pending.items.length, 1);
  }
});

test("already published tomorrow draw is skipped before enqueue", async () => {
  const pending = pendingCollector();
  const result = await dispatchTomorrowDraw({
    settings: {enabled: true, time: "21:00"},
    runRef: memoryRef(null),
    historyRef: memoryRef([drawRecord({lineSentAt: "2026-08-14T10:00:00.000Z", lineSendCount: 1})]),
    bindings: {},
    defaultGroupId: "G",
    enqueueAnnouncement: pending.enqueue,
    now: new Date("2026-08-14T13:00:30.000Z"),
  });
  assert.equal(result.status, "skipped-already-published");
  assert.equal(pending.items.length, 0);
});

test("missing tomorrow draw waits five minutes then queues after creation", async () => {
  const settings = {enabled: true, time: "21:00"};
  const runRef = memoryRef(null);
  const historyRef = memoryRef([]);
  const pending = pendingCollector();
  const options = {settings, runRef, historyRef, bindings: {}, defaultGroupId: "G",
    enqueueAnnouncement: pending.enqueue};
  const at2100 = await dispatchTomorrowDraw({...options,
    now: new Date("2026-08-14T13:00:00.000Z")});
  assert.equal(at2100.status, "waiting-for-draw");
  assert.equal(at2100.nextCheckAt, "2026-08-14T13:05:00.000Z");
  assert.equal(TERMINAL_RUN_STATUSES.has("waiting-for-draw"), false);
  assert.equal((await dispatchTomorrowDraw({...options,
    now: new Date("2026-08-14T13:04:00.000Z")})).status, "not-due");
  historyRef.write([drawRecord()]);
  assert.equal((await dispatchTomorrowDraw({...options,
    now: new Date("2026-08-14T13:05:00.000Z")})).status, "queued-for-reply");
  assert.equal(pending.items.length, 1);
});

test("23:59 without a draw expires, but an already-created pending has no expiry", async () => {
  const settings = {enabled: true, time: "21:00"};
  const runRef = memoryRef(null);
  const result = await dispatchTomorrowDraw({
    settings,
    runRef,
    historyRef: memoryRef([]),
    bindings: {},
    defaultGroupId: "G",
    enqueueAnnouncement: async () => { throw new Error("must not enqueue"); },
    now: new Date("2026-08-14T15:59:00.000Z"),
  });
  assert.equal(result.status, "expired-no-draw");
  const first = latestTomorrowOccurrence(settings, new Date("2026-08-14T15:59:00.000Z"));
  const next = latestTomorrowOccurrence(settings, new Date("2026-08-15T13:00:00.000Z"));
  assert.notEqual(first.runKey, next.runKey);
});

test("ambiguous tomorrow draws never enqueue", async () => {
  const pending = pendingCollector();
  const result = await dispatchTomorrowDraw({
    settings: {enabled: true, time: "21:00"},
    runRef: memoryRef(null),
    historyRef: memoryRef([drawRecord(), drawRecord({id: "two"})]),
    bindings: {},
    defaultGroupId: "G",
    enqueueAnnouncement: pending.enqueue,
    now: new Date("2026-08-14T13:00:00.000Z"),
  });
  assert.equal(result.status, "ambiguous-draw-records");
  assert.equal(pending.items.length, 0);
});

test("fixed due prepares wrapper and queues immutable occurrence-based core", async () => {
  const pending = pendingCollector();
  let wrapperCalls = 0;
  const runRef = memoryRef(null);
  const result = await dispatchFixedOccurrence({
    schedule: fixedSchedule(),
    occurrence: occurrence(),
    runRef,
    bindings: {},
    defaultGroupId: "G",
    now: new Date("2026-08-14T12:31:00.000Z"),
    createWrapper: async () => {
      wrapperCalls += 1;
      return {intro: "先提醒。", outro: "", reason: "success"};
    },
    enqueueAnnouncement: pending.enqueue,
  });
  assert.equal(result.status, "queued-for-reply");
  assert.equal(wrapperCalls, 1);
  assert.equal(pending.items.length, 1);
  assert.match(pending.items[0].message.text, /8\/15/u);
  assert.match(pending.items[0].message.text, /三張船票/u);
  assert.equal(pending.items[0].occurrenceDate, "2026-08-14");
  assert.equal(pending.items[0].aiIntro, "先提醒。");
  assert.equal(runRef.value().deliveryPayload, undefined);
});

test("editing a fixed schedule time on the same day does not queue a second announcement", async () => {
  const pending = pendingCollector();
  const runRef = memoryRef(null);
  let wrapperCalls = 0;
  const common = {runRef, bindings: {}, defaultGroupId: "G", enqueueAnnouncement: pending.enqueue,
    createWrapper: async () => {
      wrapperCalls += 1;
      return {intro: "", outro: "", reason: "success"};
    }};
  const first = await dispatchFixedOccurrence({...common,
    schedule: fixedSchedule({time: "15:56"}), occurrence: occurrence("2026-08-14", "15:56"),
    now: new Date("2026-08-14T12:31:00.000Z")});
  const edited = await dispatchFixedOccurrence({...common,
    schedule: fixedSchedule({time: "17:53"}), occurrence: occurrence("2026-08-14", "17:53"),
    now: new Date("2026-08-14T12:32:00.000Z")});
  assert.equal(first.status, "queued-for-reply");
  assert.equal(edited.status, "queued-for-reply");
  assert.equal(pending.items.length, 1);
  assert.equal(wrapperCalls, 1);
  assert.equal(runRef.value().retryCount, 1);
});

test("dispatcher next occurrence follows normalized every-two-week calendar cadence", () => {
  const next = nextOccurrenceAfter(fixedSchedule({
    startDate: "2026-08-10",
    recurrence: {type: "every_n_weeks", weekInterval: 2, weekdays: [2, 5]},
  }), occurrence("2026-08-14"));
  assert.equal(next.occurrenceDate, "2026-08-25");
  assert.equal(next.runKey, fixedRunKey("s_runtime1", "2026-08-25", "20:30"));
});

test("an unexpected AI wrapper failure still queues the immutable core", async () => {
  const pending = pendingCollector();
  const result = await dispatchFixedOccurrence({
    schedule: fixedSchedule(),
    occurrence: occurrence(),
    runRef: memoryRef(null),
    bindings: {},
    defaultGroupId: "G",
    now: new Date("2026-08-14T12:31:00.000Z"),
    createWrapper: async () => { throw new Error("OpenAI unavailable"); },
    enqueueAnnouncement: pending.enqueue,
  });
  assert.equal(result.status, "queued-for-reply");
  assert.match(pending.items[0].message.text, /三張船票/u);
  assert.equal(pending.items[0].wrapperReason, "wrapper-error");
  assert.match(pending.items[0].warning, /wrapper-error/u);
});

test("concurrent fixed dispatchers claim one occurrence and enqueue once", async () => {
  const runRef = memoryRef(null);
  let enqueues = 0;
  let release;
  const options = {
    schedule: fixedSchedule(),
    occurrence: occurrence(),
    runRef,
    bindings: {},
    defaultGroupId: "G",
    now: new Date("2026-08-14T12:31:00.000Z"),
    createWrapper: async () => ({intro: "提醒。", outro: "", reason: "success"}),
    enqueueAnnouncement: async () => {
      enqueues += 1;
      await new Promise((resolve) => { release = resolve; });
    },
  };
  const first = dispatchFixedOccurrence(options);
  await new Promise((resolve) => setImmediate(resolve));
  const second = await dispatchFixedOccurrence(options);
  assert.equal(second.status, "busy");
  release();
  assert.equal((await first).status, "queued-for-reply");
  assert.equal(enqueues, 1);
});

test("fixed enqueue retry reuses prepared payload without a second AI call", async () => {
  const runRef = memoryRef(null);
  let attempts = 0;
  let wrapperCalls = 0;
  const payloads = [];
  const options = {
    schedule: fixedSchedule(),
    occurrence: occurrence(),
    runRef,
    bindings: {},
    defaultGroupId: "G",
    createWrapper: async () => {
      wrapperCalls += 1;
      return {intro: "提醒。", outro: "", reason: "success"};
    },
    enqueueAnnouncement: async (pending) => {
      attempts += 1;
      payloads.push(JSON.stringify(pending.message));
      if (attempts === 1) throw Object.assign(new Error("temporary"), {code: "db-unavailable"});
    },
  };
  assert.equal((await dispatchFixedOccurrence({...options,
    now: new Date("2026-08-14T12:31:00.000Z")})).status, "failed-retryable");
  assert.equal((await dispatchFixedOccurrence({...options,
    now: new Date("2026-08-14T12:32:00.000Z")})).status, "queued-for-reply");
  assert.equal(wrapperCalls, 1);
  assert.equal(new Set(payloads).size, 1);
});
