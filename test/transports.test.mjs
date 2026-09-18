import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deliverMessage } from "../src/delivery.mjs";
import {
  deliverBySessionRef,
  registeredTransports,
  registerTransport,
  transportForSessionRef,
} from "../src/transports.mjs";
import { createState, sendMessage } from "../src/state.mjs";
import { renderUnread } from "../src/mailbox.mjs";

const message = "Session message · #m_7k3p\nadvisory — use if relevant; otherwise continue.\nParser changed.";

function fakeChild({ hang = false, exitCode = 0 } = {}) {
  const killed = [];
  const child = new EventEmitter();
  child.stdin = Object.assign(new EventEmitter(), { write() {}, end() {}, destroy() {} });
  child.stdout = Object.assign(new EventEmitter(), { destroy() {} });
  child.stderr = Object.assign(new EventEmitter(), { destroy() {} });
  child.unref = () => {};
  child.kill = () => { killed.push(true); child.emit("exit", null); };
  child.killed = killed;
  if (!hang) queueMicrotask(() => child.emit("exit", exitCode));
  return child;
}

function stubSpawn(calls) {
  return (cmd, argv, options) => {
    calls.push([cmd, argv, options]);
    return fakeChild();
  };
}

test("the registry answers by session-ref prefix", () => {
  const names = new Set(registeredTransports().map((t) => t.name));
  for (const prefix of ["codex", "pi", "hermes", "muse", "opencode"]) {
    assert.equal(transportForSessionRef(`${prefix}:whatever`)?.name, prefix, `${prefix} must answer for its own refs`);
    assert.equal(names.has(prefix), true);
  }
  assert.equal(transportForSessionRef("smoke:whatever"), null);
  assert.equal(transportForSessionRef(""), null);
  assert.equal(transportForSessionRef("codex-but-not-a-prefix:one")?.name ?? null, null);
});

test("an unknown prefix falls back to mailbox-only without spawning", async () => {
  const calls = [];
  const result = await deliverBySessionRef("smoke:s1", message, { spawnFn: stubSpawn(calls) });
  assert.deepEqual(result, { delivered: false, transport: null, warning: "no transport for smoke · mailbox only" });
  assert.deepEqual(calls, []);
});

test("the codex transport keeps its native queue command", async () => {
  const calls = [];
  const result = await deliverBySessionRef("codex:thread-123", message, { spawnFn: stubSpawn(calls) });
  assert.deepEqual(calls, [[
    "codex",
    ["queue", "--thread", "thread-123", "--message", message],
    { stdio: ["ignore", "pipe", "pipe"] },
  ]]);
  assert.deepEqual(result, { delivered: true, transport: "codex-queue", warning: null });
});

test("the pi transport keeps its native control path and strips its ref prefix", async () => {
  const calls = [];
  const result = await deliverBySessionRef("pi:PI-123", message, { spawnFn: stubSpawn(calls) });
  assert.deepEqual(calls, [[
    "pi",
    [
      "--control-session", "PI-123",
      "--send-session-message", message,
      "--send-session-mode", "steer",
      "--send-session-wait", "turn_end",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  ]]);
  assert.deepEqual(result, { delivered: true, transport: "pi-session-control", warning: null });
});

test("the muse transport sends the body on stdin through session-message send", async () => {
  const calls = [];
  const written = [];
  const spawnFn = (cmd, argv, options) => {
    calls.push([cmd, argv, options]);
    const child = fakeChild();
    child.stdin.write = (chunk) => written.push(String(chunk));
    return child;
  };
  const result = await deliverBySessionRef("muse:muse-abc", message, { spawnFn });
  assert.deepEqual(calls, [[
    "muse",
    ["session-message", "send", "--target", "muse-abc", "--json"],
    { stdio: ["pipe", "pipe", "pipe"] },
  ]]);
  assert.deepEqual(written, [message]);
  assert.deepEqual(result, { delivered: true, transport: "muse-session-message", warning: null });
});

test("the opencode transport declines without a configured port and never spawns", async () => {
  const calls = [];
  const previous = process.env.OC_WORKCOORDINATE_PORT;
  delete process.env.OC_WORKCOORDINATE_PORT;
  try {
    const result = await deliverBySessionRef("opencode:s1", message, { spawnFn: stubSpawn(calls) });
    assert.deepEqual(result, { delivered: false, transport: null, warning: "no port; mailbox only" });
    assert.deepEqual(calls, []);
  } finally {
    if (previous === undefined) delete process.env.OC_WORKCOORDINATE_PORT;
    else process.env.OC_WORKCOORDINATE_PORT = previous;
  }
});

test("the opencode transport runs against the configured port and tree", async () => {
  const calls = [];
  const result = await deliverBySessionRef("opencode:s1", message, {
    spawnFn: stubSpawn(calls),
    portFor: () => "4091",
    dir: "/tmp/tree",
  });
  assert.deepEqual(calls, [[
    "opencode",
    ["run", "--session", "s1", "--dir", "/tmp/tree", "--port", "4091"],
    { stdio: ["ignore", "pipe", "pipe"] },
  ]]);
  assert.deepEqual(result, { delivered: true, transport: "opencode-run", warning: null });
});

test("deliverMessage routes through the registry without changing its entry shape", async () => {
  const calls = [];
  const result = await deliverMessage({ harness: "codex", sessionRef: "thread-123", message }, {
    spawnFn: stubSpawn(calls),
  });
  assert.deepEqual(result, { delivered: true, transport: "codex-queue", warning: null });
  assert.deepEqual(calls, [[
    "codex",
    ["queue", "--thread", "thread-123", "--message", message],
    { stdio: ["ignore", "pipe", "pipe"] },
  ]]);
});

test("a custom transport registers and answers its prefix", async () => {
  const delivered = [];
  registerTransport({
    name: "test-echo",
    prefixes: ["test-echo"],
    deliver(sessionRef, message) {
      delivered.push([sessionRef, message]);
      return Promise.resolve({ delivered: true, transport: "test-echo", warning: null });
    },
  });
  const result = await deliverBySessionRef("test-echo:s9", "hello");
  assert.deepEqual(result, { delivered: true, transport: "test-echo", warning: null });
  assert.deepEqual(delivered, [["test-echo:s9", "hello"]]);
});

test("mailbox delivery still works when every transport declines", async () => {
  const s = createState(mkdtempSync(join(tmpdir(), "transports-mailbox-")));
  // A transport that always refuses: reachable in principle, down in practice.
  registerTransport({
    name: "declining",
    prefixes: ["declining"],
    deliver() {
      return Promise.resolve({ delivered: false, transport: null, warning: "transport down" });
    },
  });
  const push = await deliverBySessionRef("declining:gone-1", message);
  assert.equal(push.delivered, false);
  // And a destination with no transport at all: deliverMessage declines too.
  const none = await deliverMessage({ harness: "smoke", sessionRef: "gone-2", message });
  assert.equal(none.delivered, false);

  // The message was stored either way, so the pull floor still hands it over.
  sendMessage(s, { body: "fallback holds", to: "declining:gone-1" });
  sendMessage(s, { body: "unknown harness holds", to: "smoke:gone-2" });
  const first = renderUnread(s, "declining:gone-1");
  assert.match(first, /mailbox \(1\)/);
  assert.match(first, /fallback holds/);
  const second = renderUnread(s, "smoke:gone-2");
  assert.match(second, /mailbox \(1\)/);
  assert.match(second, /unknown harness holds/);
  assert.equal(renderUnread(s, "declining:gone-1"), "");
});
