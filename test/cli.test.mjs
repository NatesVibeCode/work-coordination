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
