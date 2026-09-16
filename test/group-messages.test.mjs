import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createState, createGroup, messagesForGroup, sendMessage } from "../src/state.mjs";

function state(t) {
  const root = mkdtempSync(join(tmpdir(), "work-coordination-group-message-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return createState(root);
}

test("keeps an intra-group message in the group’s local readback", (t) => {
  const store = state(t);
  createGroup(store, { id: "g_parser" }, { now: 1_000 });
  const message = sendMessage(store, { groupRef: "g_parser", body: "Interface changed." }, { now: 1_000, random: () => "note" });

  assert.deepEqual(messagesForGroup(store, "g_parser"), [message]);
});

test("does not create a dangling group message", (t) => {
  const store = state(t);
  assert.equal(sendMessage(store, { groupRef: "gone", body: "Interface changed." }), null);
  assert.deepEqual(messagesForGroup(store, "gone"), []);
});
