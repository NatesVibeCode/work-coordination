import test from "node:test";
import assert from "node:assert/strict";
import { createMessage, renderMessage, addGroupMember, activeGroup } from "../src/coordination.mjs";

test("creates an advisory message without caller-supplied identity fields", () => {
  const message = createMessage({}, { now: 1_700_000_000_000, random: () => "7k3p" });

  assert.equal(message.ref, "m_7k3p");
  assert.equal(message.advisory, true);
  assert.equal(message.body, "");
  assert.equal(message.workRef, null);
  assert.equal(message.sender, null);
});

test("renders work context before the optional sender", () => {
  const text = renderMessage({
    ref: "m_7k3p",
    workRef: "Ticket T-123",
    sender: "Codex / parser-repair",
    advisory: true,
    body: "Tokenizer now returns spans.",
  });

  assert.equal(text, [
    "Work message · #m_7k3p",
    "Ticket T-123 · from Codex / parser-repair",
    "advisory — use if relevant; otherwise continue.",
    "Tokenizer now returns spans.",
  ].join("\n"));
});

test("stores an optional progress status and drops unknown values", () => {
  assert.equal(createMessage({ status: "blocked" }).status, "blocked");
  assert.equal(createMessage({ status: "DONE" }).status, "done");
  assert.equal(createMessage({}).status, null);
  assert.equal(createMessage({ status: "sailing" }).status, null);
});

test("renders the status line only when a known status is present", () => {
  const text = renderMessage({
    ref: "m_7k3p",
    workRef: "Ticket T-123",
    status: "milestone",
    advisory: true,
    body: "Tokenizer now returns spans.",
  });

  assert.equal(text, [
    "Work message · #m_7k3p",
    "Ticket T-123",
    "status · milestone",
    "advisory — use if relevant; otherwise continue.",
    "Tokenizer now returns spans.",
  ].join("\n"));
});

test("renders a session message when typed work is absent", () => {
  const text = renderMessage({ ref: "m_7k3p", sender: "Codex", body: "Heads up." });

  assert.equal(text, [
    "Session message · #m_7k3p",
    "from Codex",
    "advisory — use if relevant; otherwise continue.",
    "Heads up.",
  ].join("\n"));
});

test("groups are ephemeral and disappear after expiry without changing members", () => {
  const group = addGroupMember({}, "parser-work", "codex:one", { now: 1_000, ttlMs: 100 });

  assert.deepEqual(activeGroup(group, { now: 1_099 }).members, ["codex:one"]);
  assert.equal(activeGroup(group, { now: 1_100 }), null);
});
