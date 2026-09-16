import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createState } from "../src/state.mjs";
import { workView } from "../src/work-index.mjs";

function observe(root, sessionRef) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["bin/work-coordination.mjs", "--state", root, "observe", "--work", "T-123", "--session", sessionRef], {
      cwd: new URL("..", import.meta.url),
      stdio: "ignore",
    });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`observe exited ${code}`)));
  });
}

test("concurrent participation observations retain every session", async () => {
  const root = mkdtempSync(join(tmpdir(), "work-coordination-"));
  try {
    const store = createState(root);
    const sessions = Array.from({ length: 12 }, (_, index) => `codex:${index}`);
    await Promise.all(sessions.map((sessionRef) => observe(root, sessionRef)));
    const view = workView(store, "T-123");
    assert.deepEqual(view.participants.map((value) => value.sessionRef).sort(), sessions.sort());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
