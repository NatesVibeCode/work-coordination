import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { withLocalLock } from "../src/locking.mjs";

test("reclaims a lock abandoned by a dead process", () => {
  const root = mkdtempSync(join(tmpdir(), "work-coordination-lock-"));
  try {
    const lock = join(root, ".lock-groups");
    mkdirSync(lock);
    writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: 999_999_999 }));
    assert.equal(withLocalLock(root, "groups", () => "reclaimed", { timeoutMs: 20 }), "reclaimed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reclaims an ownerless lock only after its stale threshold", () => {
  const root = mkdtempSync(join(tmpdir(), "work-coordination-lock-"));
  try {
    const lock = join(root, ".lock-groups");
    mkdirSync(lock);
    utimesSync(lock, new Date(0), new Date(0));
    assert.equal(withLocalLock(root, "groups", () => "reclaimed", { timeoutMs: 20, staleMs: 1 }), "reclaimed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
