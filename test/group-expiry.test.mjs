import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGroup, createState, joinGroup } from "../src/state.mjs";

test("joining a group preserves its original expiry", () => {
  const root = mkdtempSync(join(tmpdir(), "work-coordination-"));
  try {
    const store = createState(root);
    const group = createGroup(store, { id: "short-lived" }, { now: 1_000, ttlMs: 100 });
    const joined = joinGroup(store, group.id, "codex:one", { now: 1_010 });
    assert.equal(joined.expiresAt, 1_100);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("joining with no session does not rewrite a group", () => {
  const root = mkdtempSync(join(tmpdir(), "work-coordination-"));
  try {
    const store = createState(root);
    const group = createGroup(store, { id: "short-lived" }, { now: 1_000, ttlMs: 100 });
    const joined = joinGroup(store, group.id, "", { now: 1_010 });
    assert.deepEqual(joined, group);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
