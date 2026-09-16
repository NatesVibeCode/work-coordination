import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MESSAGE_STATUSES } from "../src/coordination.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const contractPath = join(root, "..", "harness-handoff", "skills-src", "contracts.json");
const dagPath = join(root, "..", "work-seam.dag.json");

test("status vocabulary matches the handoff contract when checked out beside it", () => {
  if (!existsSync(contractPath)) return;
  const document = JSON.parse(readFileSync(contractPath, "utf8"));
  assert.deepEqual(document.advisory_vocabulary.status, MESSAGE_STATUSES);
  assert.deepEqual(document.advisory_vocabulary.fan_out, ["blocked", "done"]);
});

test("status vocabulary matches the seam DAG when checked out beside it", () => {
  if (!existsSync(dagPath)) return;
  const document = JSON.parse(readFileSync(dagPath, "utf8"));
  const note = document.nodes.message.note;
  for (const status of MESSAGE_STATUSES) {
    assert.match(note, new RegExp(status));
  }
});
