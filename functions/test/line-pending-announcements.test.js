"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildPendingAnnouncement,
  claimPendingBatch,
  eligiblePendingItems,
  enqueuePendingAnnouncement,
  pendingAnnouncementId,
  pendingGroupKey,
  pendingGroupRef,
} = require("../lib/linePendingAnnouncements");
const {consumePendingAnnouncements} = require("../lib/linePendingRuntime");
const {
  isDrawPublishedToLine,
  planPublishedDrawQuery,
  resolvePublishedDrawKnowledge,
} = require("../lib/drawKnowledge");

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

class MemoryRef {
  constructor(db, path = []) {
    this.db = db;
    this.path = path;
  }

  child(path) {
    return new MemoryRef(this.db, [...this.path, ...String(path).split("/").filter(Boolean)]);
  }

  value() {
    return this.path.reduce((value, key) => value && value[key], this.db.value);
  }

  write(value) {
    if (!this.path.length) {
      this.db.value = clone(value);
      return;
    }
    let parent = this.db.value;
    if (!parent || typeof parent !== "object") parent = this.db.value = {};
    for (const key of this.path.slice(0, -1)) {
      if (!parent[key] || typeof parent[key] !== "object") parent[key] = {};
      parent = parent[key];
    }
    parent[this.path.at(-1)] = clone(value);
  }

  async get() {
    return {val: () => clone(this.value())};
  }

  async set(value) {
    this.write(value);
  }

  async update(values) {
    this.write({...this.value(), ...clone(values)});
  }

  async transaction(update) {
    const key = this.path.join("/") || "/";
    const previous = this.db.queues.get(key) || Promise.resolve();
    const operation = previous.then(() => {
      const next = update(clone(this.value()));
      if (next === undefined) {
        return {committed: false, snapshot: {val: () => clone(this.value())}};
      }
      this.write(next);
      return {committed: true, snapshot: {val: () => clone(this.value())}};
    });
    this.db.queues.set(key, operation.catch(() => {}));
    return operation;
  }
}

class MemoryDb {
  constructor(value = {}) {
    this.value = clone(value);
    this.queues = new Map();
  }

  ref(path) {
    return new MemoryRef(this, String(path || "").split("/").filter(Boolean));
  }
}

const GROUP_ID = "C_FORMAL_GROUP";
const OTHER_GROUP = "C_OTHER_GROUP";
const SCHEDULED_AT = "2026-08-14T13:00:00.000Z";

function event(overrides = {}) {
  return {
    type: "message",
    replyToken: "reply-secret-not-logged",
    webhookEventId: "evt-1",
    timestamp: Date.parse("2026-08-14T13:07:00.000Z"),
    source: {type: "group", groupId: GROUP_ID, userId: "U_MEMBER"},
    message: {type: "text", id: "msg-1", text: "晚安"},
    ...overrides,
  };
}

function fixedPending(id, scheduledFor = SCHEDULED_AT, text = `公告 ${id}`) {
  return buildPendingAnnouncement({
    id,
    type: "fixed",
    scheduledFor,
    occurrenceDate: "2026-08-14",
    scheduleId: `schedule-${id}`,
    runKey: `run-${id}`,
    runPath: `guildDraw/lineSchedules/runs/schedule-${id}/run-${id}`,
    message: {type: "text", text},
    renderedCore: text,
    createdAt: scheduledFor,
  });
}

function drawRecord(overrides = {}) {
  return {
    id: "draw-15",
    date: "2026-08-15",
    captain: "Rain - 流鬼",
    guardian: "@Hank - 挖系小嗨",
    cabin4: ["Chia - 嘻嘻不嘻嘻"],
    ...overrides,
  };
}

function drawPending() {
  return buildPendingAnnouncement({
    id: pendingAnnouncementId("draw", "tomorrow-2026-08-14"),
    type: "draw",
    scheduledFor: SCHEDULED_AT,
    occurrenceDate: "2026-08-14",
    drawRecordId: "draw-15",
    runKey: "tomorrow-2026-08-14",
    runPath: "guildDraw/lineSchedules/tomorrowRuns/tomorrow-2026-08-14",
    message: {type: "textV2", text: "明日船長：Rain"},
    createdAt: SCHEDULED_AT,
  });
}

async function addPending(db, pending) {
  return enqueuePendingAnnouncement(pendingGroupRef(db, GROUP_ID), pending);
}

function pendingItem(db, id) {
  return db.ref(`guildDraw/linePendingAnnouncements/${pendingGroupKey(GROUP_ID)}/items/${id}`)
    .value();
}

test("pending schema uses a safe group hash and deterministic occurrence id", async () => {
  const db = new MemoryDb();
  const pending = fixedPending(pendingAnnouncementId("fixed", "run-one"));
  await addPending(db, pending);
  const serialized = JSON.stringify(db.value);
  assert.equal(serialized.includes(GROUP_ID), false);
  assert.equal(pending.status, "pending");
  assert.equal(pending.expiresAt, null);
  assert.equal(pending.claim, null);
  assert.equal(pending.sentVia, null);
  const duplicate = await addPending(db, pending);
  assert.equal(duplicate.created, false);
});

test("eligible queue is oldest scheduledFor then createdAt", () => {
  const items = {
    later: fixedPending("later", "2026-08-14T14:00:00.000Z"),
    oldB: fixedPending("oldB", "2026-08-14T13:00:00.000Z"),
    oldA: {...fixedPending("oldA", "2026-08-14T13:00:00.000Z"),
      createdAt: "2026-08-14T12:59:00.000Z"},
  };
  assert.deepEqual(eligiblePendingItems(items, new Date("2026-08-14T15:00:00.000Z"))
    .map((item) => item.id), ["oldA", "oldB", "later"]);
});

test("no webhook leaves pending untouched; wrong group and private DM cannot consume", async () => {
  const db = new MemoryDb();
  await addPending(db, fixedPending("one"));
  assert.equal(pendingItem(db, "one").status, "pending");
  let replies = 0;
  const sendReply = async () => { replies += 1; };
  const wrong = await consumePendingAnnouncements({db, defaultGroupId: GROUP_ID,
    event: event({source: {type: "group", groupId: OTHER_GROUP, userId: "U"}}), sendReply});
  const dm = await consumePendingAnnouncements({db, defaultGroupId: GROUP_ID,
    event: event({source: {type: "user", userId: "U"}, webhookEventId: "evt-dm"}), sendReply});
  assert.equal(wrong.status, "ineligible");
  assert.equal(dm.status, "ineligible");
  assert.equal(replies, 0);
  assert.equal(pendingItem(db, "one").status, "pending");
});

test("next formal-group text sends pending through one Reply call", async () => {
  const db = new MemoryDb();
  await addPending(db, fixedPending("one"));
  const calls = [];
  const outcome = await consumePendingAnnouncements({
    db,
    event: event(),
    defaultGroupId: GROUP_ID,
    sendReply: async (messages) => calls.push(messages),
    now: new Date("2026-08-14T13:07:00.000Z"),
  });
  assert.equal(outcome.status, "sent-via-reply");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].map((message) => message.text), ["公告 one"]);
  assert.equal(pendingItem(db, "one").status, "sent");
  assert.equal(pendingItem(db, "one").sentVia, "reply");
});

test("normal reply and pending share one call and never reuse replyToken", async () => {
  const db = new MemoryDb();
  await addPending(db, fixedPending("one"));
  const calls = [];
  const outcome = await consumePendingAnnouncements({
    db,
    event: event(),
    defaultGroupId: GROUP_ID,
    normalMessages: [{type: "text", text: "晚安，船員。"}],
    sendReply: async (messages) => calls.push(messages),
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].map((message) => message.text), ["晚安，船員。", "公告 one"]);
  assert.equal(outcome.messages.length, 2);
});

test("five-message limit reserves one slot for oldest pending and leaves the rest queued", async () => {
  const db = new MemoryDb();
  for (let index = 1; index <= 6; index += 1) {
    await addPending(db, fixedPending(`p${index}`,
      `2026-08-14T13:0${index}:00.000Z`, `pending-${index}`));
  }
  const normal = Array.from({length: 5}, (_, index) => ({type: "text", text: `normal-${index + 1}`}));
  const firstCalls = [];
  await consumePendingAnnouncements({db, event: event(), defaultGroupId: GROUP_ID,
    normalMessages: normal, sendReply: async (messages) => firstCalls.push(messages)});
  assert.equal(firstCalls.length, 1);
  assert.equal(firstCalls[0].length, 5);
  assert.deepEqual(firstCalls[0].map((message) => message.text),
    ["normal-1", "normal-2", "normal-3", "normal-4", "pending-1"]);
  assert.equal(pendingItem(db, "p1").status, "sent");
  assert.equal(pendingItem(db, "p2").status, "pending");

  const secondCalls = [];
  await consumePendingAnnouncements({db,
    event: event({webhookEventId: "evt-2", message: {type: "text", id: "msg-2", text: "hi"}}),
    defaultGroupId: GROUP_ID, sendReply: async (messages) => secondCalls.push(messages)});
  assert.equal(secondCalls[0].length, 5);
  assert.deepEqual(secondCalls[0].map((message) => message.text),
    ["pending-2", "pending-3", "pending-4", "pending-5", "pending-6"]);
});

test("one normal reply plus six pending sends oldest four, then the remaining two", async () => {
  const db = new MemoryDb();
  for (let index = 1; index <= 6; index += 1) {
    await addPending(db, fixedPending(`q${index}`,
      `2026-08-14T13:0${index}:00.000Z`, `queue-${index}`));
  }
  const firstCalls = [];
  await consumePendingAnnouncements({
    db,
    event: event(),
    defaultGroupId: GROUP_ID,
    normalMessages: [{type: "text", text: "normal"}],
    sendReply: async (messages) => firstCalls.push(messages),
  });
  assert.deepEqual(firstCalls[0].map((message) => message.text),
    ["normal", "queue-1", "queue-2", "queue-3", "queue-4"]);
  assert.equal(pendingItem(db, "q4").status, "sent");
  assert.equal(pendingItem(db, "q5").status, "pending");

  const secondCalls = [];
  await consumePendingAnnouncements({
    db,
    event: event({webhookEventId: "evt-next",
      message: {type: "text", id: "msg-next", text: "下一則"}}),
    defaultGroupId: GROUP_ID,
    sendReply: async (messages) => secondCalls.push(messages),
  });
  assert.deepEqual(secondCalls[0].map((message) => message.text), ["queue-5", "queue-6"]);
});

test("two concurrent webhook events can claim a pending only once", async () => {
  const db = new MemoryDb();
  await addPending(db, fixedPending("one"));
  let replyCalls = 0;
  let release;
  const first = consumePendingAnnouncements({db, event: event(), defaultGroupId: GROUP_ID,
    sendReply: async () => {
      replyCalls += 1;
      await new Promise((resolve) => { release = resolve; });
    }});
  await new Promise((resolve) => setImmediate(resolve));
  const second = await consumePendingAnnouncements({db,
    event: event({webhookEventId: "evt-2", message: {type: "text", id: "msg-2", text: "hi"}}),
    defaultGroupId: GROUP_ID, sendReply: async () => { replyCalls += 1; }});
  assert.equal(second.status, "empty");
  release();
  await first;
  assert.equal(replyCalls, 1);
});

test("Reply failure releases pending; redelivery is blocked but a new event recovers", async () => {
  const db = new MemoryDb();
  await addPending(db, fixedPending("one"));
  await assert.rejects(consumePendingAnnouncements({
    db, event: event(), defaultGroupId: GROUP_ID,
    sendReply: async () => { throw Object.assign(new Error("LINE failed"), {lineStatus: 503}); },
  }), /LINE failed/u);
  assert.equal(pendingItem(db, "one").status, "pending");
  let calls = 0;
  const redelivery = await consumePendingAnnouncements({
    db,
    event: event({deliveryContext: {isRedelivery: true}}),
    defaultGroupId: GROUP_ID,
    sendReply: async () => { calls += 1; },
  });
  assert.equal(redelivery.status, "duplicate-event");
  assert.equal(calls, 0);
  await consumePendingAnnouncements({
    db,
    event: event({webhookEventId: "evt-recovery",
      message: {type: "sticker", id: "sticker-1", packageId: "1", stickerId: "1"}}),
    defaultGroupId: GROUP_ID,
    sendReply: async () => { calls += 1; },
  });
  assert.equal(calls, 1);
  assert.equal(pendingItem(db, "one").status, "sent");
});

test("expired lease is deterministically recoverable by another event", async () => {
  const db = new MemoryDb();
  await addPending(db, fixedPending("one"));
  const groupRef = pendingGroupRef(db, GROUP_ID);
  const first = await claimPendingBatch(groupRef, {eventId: "old-event", maxItems: 1,
    now: new Date("2026-08-14T13:00:00.000Z"), leaseMs: 1000});
  assert.equal(first.claimed, true);
  const recovered = await claimPendingBatch(groupRef, {eventId: "new-event", maxItems: 1,
    now: new Date("2026-08-14T13:00:02.000Z")});
  assert.equal(recovered.claimed, true);
  assert.equal(recovered.items[0].id, "one");
});

test("draw Reply success publishes for AI with reply delivery metadata", async () => {
  const db = new MemoryDb({guildDraw: {main: {history: [drawRecord()]}}});
  const pending = drawPending();
  await addPending(db, pending);
  const calls = [];
  const outcome = await consumePendingAnnouncements({
    db, event: event(), defaultGroupId: GROUP_ID,
    sendReply: async (messages) => calls.push(messages),
  });
  const updated = db.ref("guildDraw/main/history/0").value();
  assert.equal(outcome.status, "sent-via-reply");
  assert.equal(calls.length, 1);
  assert.equal(isDrawPublishedToLine(updated), true);
  assert.equal(updated.lineSendCount, 1);
  assert.equal(updated.lastLineSendMode, "reply");
  const knowledge = resolvePublishedDrawKnowledge(db.ref("guildDraw/main/history").value(),
    planPublishedDrawQuery("明天船長是誰？", new Date("2026-08-14T14:00:00.000Z")));
  assert.match(knowledge.context, /Rain/u);
  assert.equal(db.ref("guildDraw/lineSchedules/tomorrowRuns/tomorrow-2026-08-14").value().status,
    "sent-via-reply");
});

test("draw Reply failure remains unpublished and releases both claims", async () => {
  const db = new MemoryDb({guildDraw: {main: {history: [drawRecord()]}}});
  const pending = drawPending();
  await addPending(db, pending);
  await assert.rejects(consumePendingAnnouncements({
    db, event: event(), defaultGroupId: GROUP_ID,
    sendReply: async () => { throw new Error("reply failed"); },
  }), /reply failed/u);
  assert.equal(isDrawPublishedToLine(db.ref("guildDraw/main/history/0").value()), false);
  assert.equal(pendingItem(db, pending.id).status, "pending");
  const claims = db.ref("guildDraw/lineSchedules/drawClaims").value();
  assert.equal(Object.values(claims)[0].status, "failed");
});

test("manual publication while pending causes cancellation without Reply", async () => {
  const db = new MemoryDb({guildDraw: {main: {history: [drawRecord({
    lineSentAt: "2026-08-14T13:01:00.000Z",
    lineSendCount: 1,
  })]}}});
  const pending = drawPending();
  await addPending(db, pending);
  let replies = 0;
  const outcome = await consumePendingAnnouncements({
    db, event: event(), defaultGroupId: GROUP_ID,
    sendReply: async () => { replies += 1; },
  });
  assert.equal(outcome.status, "nothing-to-send");
  assert.equal(replies, 0);
  assert.equal(pendingItem(db, pending.id).status, "cancelled");
  assert.equal(db.ref("guildDraw/main/history/0").value().lineSendCount, 1);
});

test("an active manual draw claim prevents pending Reply and leaves it recoverable", async () => {
  const db = new MemoryDb({guildDraw: {main: {history: [drawRecord()]}}});
  const pending = drawPending();
  await addPending(db, pending);
  const claimsRef = db.ref("guildDraw/lineSchedules/drawClaims");
  const {drawClaimKey} = require("../lib/drawLineDelivery");
  await claimsRef.child(drawClaimKey("draw-15")).set({
    status: "sending",
    owner: "manual",
    leaseUntil: Date.now() + 60_000,
  });
  let replies = 0;
  const outcome = await consumePendingAnnouncements({
    db, event: event(), defaultGroupId: GROUP_ID,
    sendReply: async () => { replies += 1; },
  });
  assert.equal(outcome.status, "nothing-to-send");
  assert.equal(replies, 0);
  assert.equal(pendingItem(db, pending.id).status, "pending");
});

test("personality silence cannot block a system pending because consumption uses event eligibility only", async () => {
  const db = new MemoryDb({guildDraw: {linePersonality: {
    [GROUP_ID]: {enabled: false},
  }}});
  await addPending(db, fixedPending("system", SCHEDULED_AT, "只發系統公告"));
  const calls = [];
  await consumePendingAnnouncements({
    db,
    event: event(),
    defaultGroupId: GROUP_ID,
    normalMessages: [],
    sendReply: async (messages) => calls.push(messages),
  });
  assert.deepEqual(calls, [[{type: "text", text: "只發系統公告"}]]);
});
