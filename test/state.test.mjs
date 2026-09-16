import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createState, sendMessage, messagesForWork, createGroup, joinGroup, activeGroups } from "../src/state.mjs";

function state(t) {
  const root = mkdtempSync(join(tmpdir(), "work-coordination-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return createState(root);
}

test("stores a work message and retrieves it by typed work reference", (t) => {
  const store = state(t);
  const message = sendMessage(store, {
    workRef: "Ticket T-123",
    sender: "Codex / parser-repair",
    body: "Tokenizer now returns spans.",
  }, { now: 1_000, random: () => "7k3p" });

  assert.equal(message.ref, "m_7k3p");
  assert.deepEqual(messagesForWork(store, "Ticket T-123"), [message]);
});

test("creates an expiring communication group with no mandatory metadata", (t) => {
  const store = state(t);
  const group = createGroup(store, {}, { now: 1_000, random: () => "parser", ttlMs: 100 });
  const joined = joinGroup(store, group.id, "codex:one", { now: 1_010 });

  assert.equal(group.id, "g_parser");
  assert.deepEqual(joined.members, ["codex:one"]);
  assert.deepEqual(activeGroups(store, { now: 1_099 }), [joined]);
  assert.deepEqual(activeGroups(store, { now: 1_100 }), []);
});
