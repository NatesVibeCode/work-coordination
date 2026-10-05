import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  canonicalDestination,
  findBusinessCase,
  listBusinessCasesOp,
  readBusinessCaseOp,
  readBusinessCases,
  recordBusinessCase,
  recordBusinessCaseOp,
  renderBusinessCase,
} from "../src/business-cases.mjs";
import { createState } from "../src/state.mjs";

function view({ id = "supplier:substitution", revision = 3, disposition = "partial", purpose = "replace one supplier" } = {}) {
  return {
    schema: "praxis.business_case_advisory_view.v1",
    notice: "snapshot is advisory",
    case: { id, revision, disposition, reported_disposition: disposition },
    outer_facts: { work_ref: "campaign:oct-04", input_fields: ["budget", "supplier"], input_fields_more: false },
    required_outcomes: [{
      id: "substitution", purpose,
      process: { name: "supplier_substitution.v1", digest: "a".repeat(64) },
      exposure: "replace_supplier", contract_digest: "b".repeat(64),
      disposition: "unknown", reported_disposition: "unknown", present: false, missing: true,
      input_fields: ["supplier", "quantity"], input_fields_more: false,
      invocation_id: "toolrun_original", input_digest: "sha256:" + "c".repeat(64),
      receipt_ref: "receipt:case-3/substitution", receipt_digest: "sha256:" + "d".repeat(64),
      verification_evidence: [], verification_reason: "",
    }],
    missing_outcomes: ["substitution"],
    execution_results: [{
      outcome_id: "substitution", case: { id, revision },
      process: { name: "supplier_substitution.v1", digest: "a".repeat(64) },
      invocation_id: "toolrun_original", input_digest: "sha256:" + "c".repeat(64),
      execution_state: "unknown", exit_code: null, output_digest: "", receipt_ref: "receipt:case-3/substitution",
      receipt_digest: "sha256:" + "d".repeat(64), capture_incomplete: true,
      handle_ref: "pph_123", binding_status: "matched",
    }],
    operator_choices: [{ id: "choice-1", selection: "wait for supplier confirmation", note: "explicit operator choice" }],
  };
}

function withStore(run) {
  const directory = mkdtempSync(join(tmpdir(), "work-coordination-business-case-"));
  try { return run(createState(directory), directory); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}

test("canonical destinations case-fold both halves with the shared parser", () => {
  assert.deepEqual(canonicalDestination("Codex:Case-7:Alpha"), { harness: "codex", session_ref: "case-7:alpha" });
  assert.throws(() => canonicalDestination("codex:"), /destination/);
});

test("records preserve exact SDK case revision and result references as nonexclusive observations", () => withStore((store, directory) => {
  const first = recordBusinessCase(store, view(), { destination: "Codex:Session-A", now: 10, recordId: "observation-a" });
  const sibling = recordBusinessCase(store, view(), { destination: "CLAUDE:Session-B", now: 11, recordId: "observation-b" });
  assert.deepEqual(first.destination, { harness: "codex", session_ref: "session-a" });
  assert.deepEqual(sibling.destination, { harness: "claude", session_ref: "session-b" });
  assert.deepEqual(first.case, { id: "supplier:substitution", revision: 3 });
  assert.equal(first.view.required_outcomes[0].invocation_id, "toolrun_original");
  assert.equal(first.view.required_outcomes[0].receipt_ref, "receipt:case-3/substitution");
  assert.equal(first.view.execution_results[0].input_digest, "sha256:" + "c".repeat(64));
  assert.equal(first.advisory, true);
  assert.equal(first.view.required_outcomes[0].disposition, "unknown");

  const records = readBusinessCases(store).records;
  assert.equal(records.length, 2, "a sibling presence declaration must not replace another observation");
  assert.equal(findBusinessCase(store, "supplier:substitution").id, "observation-b");
  assert.equal(findBusinessCase(store, "supplier:substitution", 3).case.revision, 3);
  assert.match(readBusinessCaseOp(store, "supplier:substitution"), /revision 3 · disposition partial/);
  assert.match(listBusinessCasesOp(store), /codex:session-a/);
  assert.match(listBusinessCasesOp(store), /claude:session-b/);

  const files = readdirSync(directory).sort();
  assert.deepEqual(files, ["business-cases.json", "messages"]);
  assert.doesNotThrow(() => JSON.parse(readFileSync(join(directory, "business-cases.json"), "utf8")));
}));

test("all stored and rendered user strings pass through oneLine and remain one field", () => withStore((store) => {
  const unsafe = view({ id: "supplier\nforged-record", purpose: "choice one\nchoice two\tstill one purpose" });
  unsafe.required_outcomes[0].verification_reason = "nope\nsecond line";
  const record = recordBusinessCase(store, unsafe, { destination: "Codex:Session\nFake", now: 17, recordId: "one-line" });
  assert.equal(record.case.id, "supplier forged-record");
  assert.equal(record.destination.session_ref, "session fake");
  assert.equal(record.view.required_outcomes[0].purpose, "choice one choice two still one purpose");
  const rendered = renderBusinessCase(record);
  assert.ok(rendered.includes("purpose · choice one choice two still one purpose"));
  assert.ok(!rendered.includes("forged-record\n"));
  assert.ok(!record.view.required_outcomes[0].purpose.includes("\n"));
}));

test("unknown, refused, partial, and superseded remain visible without a done state", () => withStore((store) => {
  for (const disposition of ["unknown", "refused", "partial", "superseded", "pending"]) {
    const record = recordBusinessCase(store, view({ id: `case:${disposition}`, disposition }), { now: 1, recordId: disposition });
    assert.equal(record.disposition, disposition);
    assert.match(renderBusinessCase(record), new RegExp(`disposition ${disposition}`));
    assert.ok(!renderBusinessCase(record).includes("done"));
  }
}));

test("operation functions share stored state and render status as advisory text", () => withStore((store) => {
  const output = recordBusinessCaseOp(store, view({ disposition: "refused" }), { destination: "Codex:cli", now: 8, recordId: "cli" });
  assert.match(output, /advisory · nonexclusive observation · codex:cli/);
  assert.match(readBusinessCaseOp(store, "supplier:substitution", 3), /required · substitution · unknown/);
  assert.match(listBusinessCasesOp(store), /supplier:substitution · revision 3 · refused/);
}));

test("invalid or oversized SDK views refuse before writing any state", () => withStore((store, directory) => {
  assert.throws(() => recordBusinessCase(store, { schema: "other" }), /SDK view schema/);
  assert.throws(() => recordBusinessCase(store, view({ revision: 0 })), /positive revision/);
  const tooMany = view();
  tooMany.required_outcomes = Array.from({ length: 129 }, (_, index) => ({ id: `outcome-${index}` }));
  assert.throws(() => recordBusinessCase(store, tooMany), /bounds/);
  assert.equal(readBusinessCases(store).records.length, 0);
  assert.ok(!readdirSync(directory).includes("business-cases.json"));
}));

test("a later SDK revision is discoverable without assigning any writer", () => withStore((store) => {
  recordBusinessCase(store, view({ revision: 4, disposition: "pending" }), { now: 20, recordId: "rev4" });
  recordBusinessCase(store, view({ revision: 5, disposition: "superseded" }), { now: 19, recordId: "rev5" });
  const chosen = findBusinessCase(store, "supplier:substitution");
  assert.equal(chosen.case.revision, 5, "case revision, not observation time, selects the displayed revision");
  assert.equal(chosen.disposition, "superseded");
}));
