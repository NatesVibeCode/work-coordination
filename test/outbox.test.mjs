import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createState, notifySubscribers, saveStoreConfig, sendMessage, subscribe } from "../src/state.mjs";
import { listOutboxOp, retryOutboxOp } from "../src/operations.mjs";
import { outboxCount, outboxPath, pruneOutbox, recordFailure } from "../src/outbox.mjs";

// A provider that is out of credit, rate limited, or disconnected is exactly
// when a message must not be lost. These pin the promise: the failure is
// reported, remembered, listable, and drainable.
function store(t, label) {
  const root = mkdtempSync(join(tmpdir(), `work-coordination-${label}-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return createState(root);
}

function transport({ output = "", code = 1, succeed = false } = {}) {
  return () => {
    const child = new EventEmitter();
    child.stdout = Object.assign(new EventEmitter(), { destroy() {} });
    child.stderr = Object.assign(new EventEmitter(), { destroy() {} });
    child.unref = () => {};
    child.kill = () => {};
    queueMicrotask(() => {
      if (output) child.stderr.emit("data", output);
      child.emit("exit", succeed ? 0 : code);
    });
    return child;
  };
}

async function announce(store_, status, spawnFn) {
  const message = sendMessage(store_, { workRef: "T-1", sessionRef: "lane-1", status, body: "Stuck on auth." });
  await notifySubscribers(store_, message, { spawnFn, idleTimeoutMs: 200, concurrency: 4 });
  return message;
}

test("a failed delivery is queued with the provider's own words", async (t) => {
  const state = store(t, "outbox-record");
  subscribe(state, { sessionRef: "lane-1", target: "codex:worker" });

  const message = await announce(state, "blocked", transport({ output: "402 Payment Required\n" }));
  const listed = listOutboxOp(state);
  assert.match(listed, new RegExp(message.ref));
  assert.match(listed, /codex:worker/);
  assert.match(listed, /1 attempt\b/);
  assert.match(listed, /402 Payment Required/, "the reason must survive into the queue");
});

test("retry drains what landed and keeps what did not", async (t) => {
  const state = store(t, "outbox-drain");
  subscribe(state, { sessionRef: "lane-1", target: "codex:worker" });
  await announce(state, "blocked", transport({ output: "429 Too Many Requests\n" }));
  assert.equal(outboxCount(state), 1);

  // Still down: it stays queued and the attempt is counted, not duplicated.
  const stillDown = await retryOutboxOp(state, { spawnFn: transport({ output: "429 Too Many Requests\n" }), idleTimeoutMs: 200 });
  assert.match(stillDown, /still pending · codex:worker/);
  assert.equal(outboxCount(state), 1);
  assert.match(listOutboxOp(state), /2 attempts/);

  // Recovered: it lands and the queue empties.
  const recovered = await retryOutboxOp(state, { spawnFn: transport({ succeed: true }), idleTimeoutMs: 200 });
  assert.match(recovered, /delivered · codex:worker/);
  assert.equal(outboxCount(state), 0);
  assert.equal(listOutboxOp(state), "no pending deliveries");
});

test("a later success clears the pending entry for that destination", async (t) => {
  const state = store(t, "outbox-clear");
  subscribe(state, { sessionRef: "lane-1", target: "codex:worker" });

  // Down: one entry.
  await announce(state, "blocked", transport({ output: "connection reset by peer\n" }));
  assert.equal(outboxCount(state), 1);

  // Down again with a newer message: each failed text is its own pending work,
  // so the queue grows by one rather than mutating the older entry.
  await announce(state, "done", transport({ output: "still down\n" }));
  assert.equal(outboxCount(state), 2, "a second failed message is a second thing to deliver");

  // The destination accepts one: nothing is pending for it any more.
  const message = sendMessage(state, { workRef: "T-1", sessionRef: "lane-1", status: "done", body: "Shipped." });
  await notifySubscribers(state, message, { spawnFn: transport({ succeed: true }), idleTimeoutMs: 200, concurrency: 4 });
  assert.equal(outboxCount(state), 0, "the destination works, so nothing is pending");
});

test("a healthy destination never enters the queue", async (t) => {
  const state = store(t, "outbox-healthy");
  subscribe(state, { sessionRef: "lane-1", target: "codex:fine" });
  subscribe(state, { sessionRef: "lane-1", target: "codex:broken" });

  await announce(state, "blocked", (cmd, argv) => transport(
    argv.includes("broken") ? { output: "down\n" } : { succeed: true },
  )(cmd, argv));

  assert.equal(outboxCount(state), 1, "only the destination that failed");
  assert.match(listOutboxOp(state), /codex:broken/);
  assert.equal(listOutboxOp(state).includes("codex:fine"), false);
});

test("the same failure twice is one entry, not two", async (t) => {
  const state = store(t, "outbox-dedupe");
  const address = { messageRef: "m_one", target: "codex:worker", message: "text", workRef: "T-1", warning: "down" };
  recordFailure(state, address);
  recordFailure(state, address);
  assert.equal(outboxCount(state), 1);
  assert.match(listOutboxOp(state), /2 attempts/);
});

test("the queue is capped, oldest first", (t) => {
  const state = store(t, "outbox-cap");
  // Distinct destinations, so each failure is genuinely separate pending work
  // rather than superseding the last.
  for (let index = 0; index < 260; index++) {
    recordFailure(state, { messageRef: `m_${index}`, target: `codex:w${index}`, message: "text", warning: "down", now: 1_000 + index });
  }
  const entries = JSON.parse(readFileSync(outboxPath(state), "utf8"));
  assert.equal(entries.length, 200, "bounded, so a dead provider cannot fill the disk");
  // The newest survived; the oldest were dropped.
  assert.equal(entries[entries.length - 1].messageRef, "m_259");
  assert.equal(entries.some((entry) => entry.messageRef === "m_0"), false);
});

test("a queued delivery is dropped when its record ages out", (t) => {
  const state = store(t, "outbox-expiry");
  saveStoreConfig(state.directory, { expiryMs: 900_000 });
  const expired = createState(state.directory);
  const old = Date.now() - 3_600_000;
  recordFailure(expired, { messageRef: "m_old", target: "codex:w", message: "text", warning: "down", now: old });
  recordFailure(expired, { messageRef: "m_new", target: "codex:w", message: "text", warning: "down" });
  assert.equal(outboxCount(expired), 2);

  pruneOutbox(expired);
  assert.equal(outboxCount(expired), 1, "a delivery for a record nobody can read is not work");
  assert.match(listOutboxOp(expired), /m_new/);
});

test("an explicit --to send is queued on failure just like a fan-out", async (t) => {
  const { sendAdvisory } = await import("../src/operations.mjs");
  const state = store(t, "outbox-explicit");

  const sent = await sendAdvisory(
    state,
    { workRef: "T-1", sessionRef: "lane-1", body: "direct send", deliver: true, target: "codex:one" },
    { spawnFn: transport({ output: "401 Unauthorized\n" }), idleTimeoutMs: 200 },
  );
  assert.match(sent, /delivery unavailable/);
  assert.equal(outboxCount(state), 1, "a message that did not land is pending work, however it was addressed");
  assert.match(listOutboxOp(state), /401 Unauthorized/);

  const retried = await retryOutboxOp(state, { spawnFn: transport({ succeed: true }), idleTimeoutMs: 200 });
  assert.match(retried, /delivered · codex:one/);
  assert.equal(outboxCount(state), 0);
});

test("an empty queue is an answer, not an error", async (t) => {
  const state = store(t, "outbox-empty");
  assert.equal(listOutboxOp(state), "no pending deliveries");
  assert.equal(await retryOutboxOp(state, { spawnFn: transport({ succeed: true }) }), "no pending deliveries");
});
