import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { activeGroups, createGroup, createState } from "../src/state.mjs";

function runJoin(root, member) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["bin/work-coordination.mjs", "--state", root, "group", "join", "shared", member], {
      cwd: new URL("..", import.meta.url),
      stdio: "ignore",
    });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`join exited ${code}`)));
  });
}

test("concurrent group joins retain every participant", async () => {
  const root = mkdtempSync(join(tmpdir(), "work-coordination-"));
  try {
    const store = createState(root);
    createGroup(store, { id: "shared" });
    const members = Array.from({ length: 12 }, (_, index) => `codex:${index}`);
    await Promise.all(members.map((member) => runJoin(root, member)));
    const group = activeGroups(store).find((value) => value.id === "shared");
    assert.deepEqual([...group.members].sort(), members.sort());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent joins safely recover a dead prior group writer", async () => {
  const root = mkdtempSync(join(tmpdir(), "work-coordination-"));
  try {
    const store = createState(root);
    createGroup(store, { id: "shared" });
    const stale = join(root, ".lock-groups");
    mkdirSync(stale);
    writeFileSync(join(stale, "owner.json"), JSON.stringify({ pid: 999_999_999 }));
    const members = Array.from({ length: 12 }, (_, index) => `codex:${index}`);
    await Promise.all(members.map((member) => runJoin(root, member)));
    const group = activeGroups(store).find((value) => value.id === "shared");
    assert.deepEqual([...group.members].sort(), members.sort());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
