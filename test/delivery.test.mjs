import test from "node:test";
import assert from "node:assert/strict";
import { deliverMessage } from "../src/delivery.mjs";

const message = "Session message · #m_7k3p\nadvisory — use if relevant; otherwise continue.\nParser changed.";

test("delivers an explicit message to a Codex thread through its native queue command", () => {
  const calls = [];
  const result = deliverMessage({ harness: "codex", sessionRef: "thread-123", message }, {
    execFileSync: (...args) => calls.push(args),
  });

  assert.deepEqual(calls, [["codex", ["queue", "--thread", "thread-123", "--message", message], { stdio: "ignore" }]]);
  assert.deepEqual(result, { delivered: true, transport: "codex-queue", warning: null });
});

test("delivers an explicit message to a Pi control session through its native control path", () => {
  const calls = [];
  const result = deliverMessage({ harness: "pi", sessionRef: "pi-123", message }, {
    execFileSync: (...args) => calls.push(args),
  });

  assert.deepEqual(calls, [["pi", [
    "--control-session", "pi-123",
    "--send-session-message", message,
    "--send-session-mode", "steer",
    "--send-session-wait", "turn_end",
  ], { stdio: "ignore" }]]);
  assert.deepEqual(result, { delivered: true, transport: "pi-session-control", warning: null });
});

test("delivers an explicit message to a Hermes peer through its documented peer DM command", () => {
  const calls = [];
  const result = deliverMessage({ harness: "hermes", sessionRef: "one", message }, {
    execFileSync: (...args) => calls.push(args),
  });

  assert.deepEqual(calls, [["hermes", ["peer", "dm", "one", message], { stdio: "ignore" }]]);
  assert.deepEqual(result, { delivered: true, transport: "hermes-peer-dm", warning: null });
});

test("missing optional destination data degrades to unavailable", () => {
  assert.equal(deliverMessage({}).delivered, false);
});
