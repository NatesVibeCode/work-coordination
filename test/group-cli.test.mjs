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

test("CLI creates a temporary group and shows its member", (t) => {
  const root = mkdtempSync(join(tmpdir(), "work-coordination-group-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const created = run(root, "group", "create", "parser-work");
  const id = created.match(/(g_[A-Za-z0-9]+)/)?.[1];
  assert.ok(id);

  const joined = run(root, "group", "join", id, "codex:one");
  assert.match(joined, /codex:one/);
  assert.match(run(root, "message", "Parser interface changed.", "--group", id), /Session message/);
  assert.match(run(root, "group", "messages", id), /Parser interface changed\./);
  assert.match(run(root, "groups"), /parser-work/);
  assert.match(run(root, "ungroup", id), /group removed/);
  assert.match(run(root, "groups"), /no active groups/);
});
