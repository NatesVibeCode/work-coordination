import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createState, listSubscriptions, notifySubscribers, subscribe, unsubscribe } from "../src/state.mjs";

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), "work-coordination-subscriptions-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return createState(root);
}

function fakeChild() {
  const child = new EventEmitter();
  // Delivery finishes on `exit` and destroys the pipes it listened to.
  child.stdout = Object.assign(new EventEmitter(), { destroy() {} });
  child.stderr = Object.assign(new EventEmitter(), { destroy() {} });
  child.unref = () => {};
  child.kill = () => {};
  queueMicrotask(() => child.emit("exit", 0));
  return child;
}

function stubSpawn(calls) {
  return (cmd, argv) => { calls.push([cmd, argv]); return fakeChild(); };
}

async function notify(store, message, calls) {
  return notifySubscribers(store, message, { spawnFn: stubSpawn(calls) });
}

test("anyone can subscribe to a lane with a delivery target", (t) => {
  const store = setup(t);
  const subscription = subscribe(store, { sessionRef: "lane-1", target: "codex:spawner" }, { now: 1_000, random: () => "sub1" });

  assert.equal(subscription.id, "s_sub1");
  assert.equal(subscription.sessionRef, "lane-1");
  assert.equal(subscription.workRef, null);
  assert.deepEqual(listSubscriptions(store).map((value) => value.id), ["s_sub1"]);
});

test("a subscription can scope itself to one work ref", (t) => {
  const store = setup(t);
  const subscription = subscribe(store, { sessionRef: "lane-1", workRef: "Ticket T-123", target: "hermes:ops" }, { now: 1_000, random: () => "sub1" });

  assert.equal(subscription.workRef, "Ticket T-123");
});

test("a subscription without a lane or a target is unavailable", (t) => {
  const store = setup(t);

  assert.equal(subscribe(store, { target: "codex:spawner" }), null);
  assert.equal(subscribe(store, { sessionRef: "lane-1" }), null);
  assert.deepEqual(listSubscriptions(store), []);
});

test("subscribing twice to the same lane and target returns the same record", (t) => {
  const store = setup(t);
  const first = subscribe(store, { sessionRef: "lane-1", target: "codex:spawner" }, { now: 1_000, random: () => "one" });
  const second = subscribe(store, { sessionRef: "lane-1", target: "codex:spawner" }, { now: 2_000, random: () => "two" });

  assert.equal(first.id, second.id);
  assert.deepEqual(listSubscriptions(store).map((value) => value.id), [first.id]);
});

test("unsubscribing removes only that subscription", (t) => {
  const store = setup(t);
  subscribe(store, { sessionRef: "lane-1", target: "codex:a" }, { now: 1_000, random: () => "one" });
  subscribe(store, { sessionRef: "lane-2", target: "codex:b" }, { now: 1_000, random: () => "two" });

  assert.equal(unsubscribe(store, "s_one"), true);
  assert.equal(unsubscribe(store, "s_one"), false);
  assert.deepEqual(listSubscriptions(store).map((value) => value.id), ["s_two"]);
});

test("overlapping subscriptions to the same target notify once", async (t) => {
  const store = setup(t);
  subscribe(store, { sessionRef: "lane-1", target: "codex:spawner" }, { now: 1_000, random: () => "one" });
  subscribe(store, { sessionRef: "lane-1", workRef: "Ticket T-123", target: "codex:spawner" }, { now: 1_000, random: () => "two" });
  const calls = [];

  const results = await notify(store, { sessionRef: "lane-1", workRef: "Ticket T-123", status: "blocked", body: "Stuck." }, calls);

  assert.equal(results.length, 1);
  assert.equal(calls.length, 1);
});

test("a blocked report fans out to that lane's subscribers", async (t) => {
  const store = setup(t);
  subscribe(store, { sessionRef: "lane-1", target: "codex:spawner" }, { now: 1_000, random: () => "sub1" });
  subscribe(store, { sessionRef: "lane-9", target: "codex:other" }, { now: 1_000, random: () => "sub2" });
  const calls = [];

  const results = await notify(store, { sessionRef: "lane-1", status: "blocked", body: "Stuck on auth." }, calls);

  assert.equal(results.length, 1);
  assert.equal(results[0].subscriptionId, "s_sub1");
  assert.equal(results[0].delivered, true);
  assert.equal(results[0].transport, "codex-queue");
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "codex");
  assert.deepEqual(calls[0][1].slice(0, 3), ["queue", "--thread", "spawner"]);
  assert.match(calls[0][1][4], /Stuck on auth\./);
});

test("a done report fans out; milestones and starts do not", async (t) => {
  const store = setup(t);
  subscribe(store, { sessionRef: "lane-1", target: "hermes:ops" }, { now: 1_000, random: () => "sub1" });
  const calls = [];
  const notifyOne = (message) => notify(store, message, calls);

  assert.equal((await notifyOne({ sessionRef: "lane-1", status: "done", body: "Shipped." })).length, 1);
  assert.equal((await notifyOne({ sessionRef: "lane-1", status: "milestone", body: "Halfway." })).length, 0);
  assert.equal((await notifyOne({ sessionRef: "lane-1", status: "started", body: "Going." })).length, 0);
  assert.equal((await notifyOne({ sessionRef: "lane-1", body: "No status." })).length, 0);
  assert.equal(calls.length, 1);
});

test("a work-scoped subscription only hears its own work", async (t) => {
  const store = setup(t);
  subscribe(store, { sessionRef: "lane-1", workRef: "Ticket T-123", target: "codex:spawner" }, { now: 1_000, random: () => "sub1" });
  const calls = [];
  const notifyOne = (message) => notify(store, message, calls);

  assert.equal((await notifyOne({ sessionRef: "lane-1", workRef: "Ticket T-999", status: "blocked", body: "Stuck." })).length, 0);
  assert.equal((await notifyOne({ sessionRef: "lane-1", workRef: "Ticket T-123", status: "blocked", body: "Stuck." })).length, 1);
  assert.equal(calls.length, 1);
});

test("an unreachable subscriber is reported, never fatal", async (t) => {
  const store = setup(t);
  subscribe(store, { sessionRef: "lane-1", target: "claude:someone" }, { now: 1_000, random: () => "sub1" });

  const results = await notifySubscribers(store, { sessionRef: "lane-1", status: "done", body: "Shipped." });

  assert.equal(results.length, 1);
  assert.equal(results[0].delivered, false);
});
