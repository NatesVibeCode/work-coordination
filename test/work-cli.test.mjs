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

test("CLI shows observed participants and messages under the same work", (t) => {
  const root = mkdtempSync(join(tmpdir(), "work-coordination-work-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  run(root, "observe", "--work", "Ticket T-123", "--session", "codex:one", "--harness", "codex");
  run(root, "message", "Parser changed.", "--work", "Ticket T-123");

  const output = run(root, "work", "Ticket T-123");
  assert.match(output, /Ticket T-123/);
  assert.match(output, /codex:one/);
  assert.match(output, /Parser changed\./);
  assert.match(run(root, "sessions"), /codex:one/);
});
