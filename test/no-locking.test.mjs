import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { storeForTree, observe, sendAdvisory, createGroupOp, joinGroupOp, subscribeOp } from "../src/operations.mjs";

// Locking is a bug, not a feature: nothing in this system ever waits.
// This pins the removal — the module is gone and no lock, reclaim, or
// owner artifact is ever produced inside a store, even under a full
// observe/message/group/subscribe cycle.
test("locking is gone and no lock artifacts are produced", async (t) => {
  assert.equal(existsSync(fileURLToPath(new URL("../src/locking.mjs", import.meta.url))), false);

  const tree = mkdtempSync(join(tmpdir(), "work-coordination-no-locking-"));
  t.after(() => rmSync(tree, { recursive: true, force: true }));
  const store = storeForTree(tree, join(tree, ".work-coordination"));

  observe(store, { workRef: "Ticket T-9", sessionRef: "s", harness: "t" });
  await sendAdvisory(store, { body: "Hello.", workRef: "Ticket T-9", sessionRef: "s", status: "started" });
  const gid = createGroupOp(store, "g").split(" ")[0];
  joinGroupOp(store, gid, "s");
  subscribeOp(store, { sessionRef: "s", target: "smoke:x" });

  const artifacts = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      if (entry.startsWith(".lock-") || entry.startsWith(".reclaim-") || entry === "owner.json") artifacts.push(path);
      else if (statSync(path).isDirectory()) walk(path);
    }
  };
  walk(store.directory);
  assert.deepEqual(artifacts, []);
});
