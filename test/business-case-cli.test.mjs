import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("business advisory commands round-trip through the actual CLI", (t) => {
  const root = mkdtempSync(join(tmpdir(), "work-coordination-business-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const run = (...args) => execFileSync(process.execPath, ["bin/work-coordination.mjs", "--state", root, ...args], { cwd: new URL("..", import.meta.url), encoding: "utf8" });
  const view = { schema: "praxis.business_case_advisory_view.v1", case: { id: "case:one", revision: 2, disposition: "partial" } };
  assert.match(run("business-case-record", "--view", JSON.stringify(view), "--to", "Codex:One"), /advisory · nonexclusive observation · codex:one/);
  assert.match(run("business-case-read", "case:one", "--revision", "2"), /revision 2 · disposition partial/);
  assert.match(run("business-cases"), /case:one/);
  assert.throws(() => run("business-case-read", "case:one", "--revision", "0"));
});
