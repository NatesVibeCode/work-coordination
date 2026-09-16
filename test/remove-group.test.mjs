import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createState, createGroup, removeGroup, activeGroups } from "../src/state.mjs";

test("removing a group only removes its temporary message address", (t) => {
  const root = mkdtempSync(join(tmpdir(), "work-coordination-remove-group-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = createState(root);
  const group = createGroup(store, { name: "parser-work" }, { now: 1_000, random: () => "parser" });

  assert.equal(removeGroup(store, group.id), true);
  assert.deepEqual(activeGroups(store, { now: 1_001 }), []);
});
