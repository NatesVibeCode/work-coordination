import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function run(root, ...args) {
  return execFileSync(process.execPath, ["bin/work-coordination.mjs", "--state", root, ...args], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });
}

test("CLI stores and renders a work message", (t) => {
  const root = mkdtempSync(join(tmpdir(), "work-coordination-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const sent = run(root, "message", "Tokenizer now returns spans.", "--work", "Ticket T-123", "--from", "Codex / parser-repair");
  assert.match(sent, /Work message · #m_/);
  assert.match(sent, /Ticket T-123 · from Codex \/ parser-repair/);

  const unavailable = run(root, "message", "Heads up.", "--deliver", "--to", "claude:one");
  assert.match(unavailable, /delivery unavailable/);

  const missingGroup = run(root, "message", "Heads up.", "--group", "gone");
  assert.match(missingGroup, /group unavailable/);

  const listed = run(root, "work", "Ticket T-123");
  assert.match(listed, /Tokenizer now returns spans\./);
});

test("CLI degrades to a no-op explanation when there is no command", (t) => {
  const root = mkdtempSync(join(tmpdir(), "work-coordination-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  assert.match(run(root), /nothing to do/);
});

test("CLI saves and reads one exact handoff association as compact JSON", (t) => {
  const root = mkdtempSync(join(tmpdir(), "work-coordination-cli-handoff-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const hash = (digit) => digit.repeat(64);
  const association = {
    contract: "work-coordination.handoff-association",
    schemaVersion: 1,
    handoffBinding: {
      contract: "mdview.handoff-binding",
      schemaVersion: 1,
      source: {
        index: "/workspace/plan/sections.json",
        section: "execution-plan",
        record: "record.json",
        taskId: "T1",
        taskSha256: hash("a"),
        expectedReadSet: { "@index": hash("b"), "record.json": hash("c") },
        expectedEdition: null,
      },
      scope: "selected source/task binding only",
    },
    destination: { selection: "operator-explicit", surface: "codex", sessionId: "thread-Exact" },
    attempt: { id: "attempt-1" },
    observations: [{
      id: "O1",
      origin: { surface: "codex", sessionId: "thread-Exact", attemptId: "attempt-1" },
      observedAt: "2026-10-08T15:41:00Z",
      nativeKind: "thread.event",
      nativeValue: { status: "completed", output: ["exact", "native", "value"] },
    }],
  };
  const identity = {
    handoffBinding: association.handoffBinding,
    destination: association.destination,
    attempt: association.attempt,
  };
  assert.equal(run(root, "handoff-association-read", "--identity", JSON.stringify(identity)), "null\n");

  const save = run(root, "handoff-association-save", "--association", JSON.stringify(association));
  assert.equal(save.trimEnd().includes("\n"), false);
  assert.deepEqual(JSON.parse(save), association);

  const read = run(root, "handoff-association-read", "--identity", JSON.stringify(identity));
  assert.equal(read.trimEnd().includes("\n"), false);
  assert.deepEqual(JSON.parse(read), association);
});
