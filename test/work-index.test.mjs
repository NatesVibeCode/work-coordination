import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createState } from "../src/state.mjs";
import { observeParticipation, workView } from "../src/work-index.mjs";

function state(t) {
  const root = mkdtempSync(join(tmpdir(), "work-coordination-index-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return createState(root);
}

test("projects an observed harness session under typed work without self-report fields", (t) => {
  const store = state(t);
  const participant = observeParticipation(store, {
    workRef: "Ticket T-123",
    sessionRef: "codex:one",
    harness: "codex",
    directory: "/repo/parser",
  }, { now: 1_000 });

  assert.equal(participant.workRef, "Ticket T-123");
  assert.equal(participant.sessionRef, "codex:one");
  assert.equal(participant.title, null);
  assert.deepEqual(workView(store, "Ticket T-123"), {
    workRef: "Ticket T-123",
    participants: [participant],
  });
});

test("unknown work context remains viewable without inventing a workflow", (t) => {
  const store = state(t);
  observeParticipation(store, { harness: "hermes" }, { now: 1_000, random: () => "local" });

  assert.equal(workView(store, "Ticket T-123"), null);
});
