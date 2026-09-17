import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MESSAGE_STATUSES } from "../src/coordination.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dagPath = join(root, "work-seam.dag.json");
// The handoff contract lives in a sibling checkout, or wherever the operator
// points this variable. Without either, the check is skipped — visibly, with
// the reason and the path it looked for, so a fresh clone never reads as
// "checked and green" when nothing was checked.
const contractPath = process.env.WORK_COORDINATION_HANDOFF_CONTRACT
  ?? join(root, "..", "harness-handoff", "skills-src", "contracts.json");

test("status vocabulary matches the handoff contract when checked out beside it", (t) => {
  if (!existsSync(contractPath)) {
    return t.skip(`handoff contract not found at ${contractPath} — check out harness-handoff beside this repo or set WORK_COORDINATION_HANDOFF_CONTRACT`);
  }
  const document = JSON.parse(readFileSync(contractPath, "utf8"));
  assert.deepEqual(document.advisory_vocabulary.status, MESSAGE_STATUSES);
  assert.deepEqual(document.advisory_vocabulary.fan_out, ["blocked", "done"]);
});

test("status vocabulary matches the seam DAG", (t) => {
  if (!existsSync(dagPath)) return t.skip(`seam DAG not found at ${dagPath}`);
  const document = JSON.parse(readFileSync(dagPath, "utf8"));
  const note = document.nodes.message.note;
  for (const status of MESSAGE_STATUSES) {
    assert.match(note, new RegExp(status));
  }
});
