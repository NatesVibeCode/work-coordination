import test from "node:test";
import assert from "node:assert/strict";
import { deliverGroupMessage } from "../src/group-delivery.mjs";

test("fans an explicit group message out to each current member without changing membership", () => {
  const calls = [];
  const results = deliverGroupMessage({ members: ["codex:one", "pi:two"] }, "Heads up.", {
    deliver: (input) => { calls.push(input); return { delivered: true, transport: input.harness, warning: null }; },
  });

  assert.deepEqual(calls, [
    { harness: "codex", sessionRef: "one", message: "Heads up." },
    { harness: "pi", sessionRef: "two", message: "Heads up." },
  ]);
  assert.deepEqual(results.map((value) => value.delivered), [true, true]);
});

test("empty or expired group membership is a no-op", () => {
  assert.deepEqual(deliverGroupMessage(null, "Heads up."), []);
});
