import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { deliverMessage } from "../src/delivery.mjs";

const message = "Session message · #m_7k3p\nadvisory — use if relevant; otherwise continue.\nParser changed.";

function fakeChild({ hang = false, exitCode = 0 } = {}) {
  const killed = [];
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => { killed.push(true); child.emit("close", null); };
  child.killed = killed;
  if (!hang) queueMicrotask(() => child.emit("close", exitCode));
  return child;
}

function stubSpawn(children, calls) {
  return (cmd, argv, options) => {
    calls.push([cmd, argv, options]);
    const child = children.length > 1 ? children.shift() : children[0];
    return child;
  };
}

test("delivers an explicit message to a Codex thread through its native queue command", async () => {
  const calls = [];
  const result = await deliverMessage({ harness: "codex", sessionRef: "thread-123", message }, {
    spawnFn: stubSpawn([fakeChild()], calls),
  });

  assert.deepEqual(calls, [[
    "codex",
    ["queue", "--thread", "thread-123", "--message", message],
    { stdio: ["ignore", "pipe", "pipe"] },
  ]]);
  assert.deepEqual(result, { delivered: true, transport: "codex-queue", warning: null });
});

test("delivers an explicit message to a Pi control session through its native control path", async () => {
  const calls = [];
  const result = await deliverMessage({ harness: "pi", sessionRef: "pi-123", message }, {
    spawnFn: stubSpawn([fakeChild()], calls),
  });

  assert.deepEqual(calls, [[
    "pi",
    [
      "--control-session", "pi-123",
      "--send-session-message", message,
      "--send-session-mode", "steer",
      "--send-session-wait", "turn_end",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  ]]);
  assert.deepEqual(result, { delivered: true, transport: "pi-session-control", warning: null });
});

test("delivers an explicit message to a Hermes peer through its documented peer DM command", async () => {
  const calls = [];
  const result = await deliverMessage({ harness: "hermes", sessionRef: "one", message }, {
    spawnFn: stubSpawn([fakeChild()], calls),
  });

  assert.deepEqual(calls, [[
    "hermes",
    ["peer", "dm", "one", message],
    { stdio: ["ignore", "pipe", "pipe"] },
  ]]);
  assert.deepEqual(result, { delivered: true, transport: "hermes-peer-dm", warning: null });
});

test("missing optional destination data degrades to unavailable without spawning", async () => {
  const calls = [];
  const result = await deliverMessage({}, { spawnFn: stubSpawn([fakeChild()], calls) });

  assert.equal(result.delivered, false);
  assert.deepEqual(calls, []);
});

test("an unknown harness degrades to unavailable without spawning", async () => {
  const calls = [];
  const result = await deliverMessage({ harness: "smoke", sessionRef: "s", message }, {
    spawnFn: stubSpawn([fakeChild()], calls),
  });

  assert.equal(result.delivered, false);
  assert.match(result.warning, /no verified local message transport/);
  assert.deepEqual(calls, []);
});

test("a nonzero transport exit degrades to unavailable", async () => {
  const result = await deliverMessage({ harness: "codex", sessionRef: "t", message }, {
    spawnFn: stubSpawn([fakeChild({ exitCode: 1 })], []),
  });

  assert.equal(result.delivered, false);
  assert.match(result.warning, /exited with code 1/);
});

test("a hung transport is reaped after the idle timeout without activity", async () => {
  const child = fakeChild({ hang: true });
  const result = await deliverMessage({ harness: "pi", sessionRef: "pi-123", message }, {
    spawnFn: () => child,
    idleTimeoutMs: 30,
  });

  assert.equal(result.delivered, false);
  assert.match(result.warning, /idle timeout after 30ms without activity/);
  assert.equal(child.killed.length, 1);
});

test("transport activity resets the idle timeout", async () => {
  const child = fakeChild({ hang: true });
  const pending = deliverMessage({ harness: "pi", sessionRef: "pi-123", message }, {
    spawnFn: () => child,
    idleTimeoutMs: 60,
  });
  const heartbeat = setInterval(() => child.stdout.emit("data", Buffer.from("tick")), 15);
  setTimeout(() => { clearInterval(heartbeat); child.emit("close", 0); }, 100);
  const result = await pending;

  assert.equal(result.delivered, true);
  assert.equal(result.transport, "pi-session-control");
  assert.equal(child.killed.length, 0);
});
