import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { identityHash } from "../src/atomic-json.mjs";
import { createState, readHandoffAssociation, recordHandoffAssociation } from "../src/state.mjs";

function state(t) {
  const root = mkdtempSync(join(tmpdir(), "work-coordination-association-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return createState(root);
}

const hash = (digit) => digit.repeat(64);

function observation(id, { attemptId = "attempt-1", sessionId = "thread-Exact", surface = "codex", value = { status: "completed", output: ["α", 7] }, observedAt = "2026-10-08T08:41:00-07:00" } = {}) {
  return {
    id,
    origin: { surface, sessionId, attemptId },
    observedAt,
    nativeKind: "thread.event",
    nativeValue: value,
  };
}

function association({ taskId = "T1", taskSha256 = hash("a"), observations = [observation("O1")] } = {}) {
  return {
    contract: "work-coordination.handoff-association",
    schemaVersion: 1,
    handoffBinding: {
      contract: "mdview.handoff-binding",
      schemaVersion: 1,
      source: {
        index: "/workspace/plan/sections.json",
        section: "execution-plan",
        record: "record.json",
        taskId,
        taskSha256,
        expectedReadSet: { "@index": hash("b"), "record.json": hash("c") },
        expectedEdition: null,
      },
      scope: "selected source/task binding only",
    },
    destination: { selection: "operator-explicit", surface: "codex", sessionId: "thread-Exact" },
    attempt: { id: "attempt-1" },
    observations,
  };
}

function jsonFiles(path) {
  try {
    return readdirSync(path).filter((name) => name.endsWith(".json")).sort();
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function headerPath(store, record) {
  const source = record.handoffBinding.source;
  const id = identityHash(
    "handoff-association.v1",
    source.index,
    source.section,
    source.record,
    source.taskId,
    record.destination.surface,
    record.destination.sessionId,
    record.attempt.id,
  );
  return join(store.associations, "headers", `${id}.json`);
}

test("persists one immutable header and one record per observation, then reconstructs exact native data", (t) => {
  const store = state(t);
  const input = association();

  const saved = recordHandoffAssociation(store, input);
  assert.deepEqual(saved, input);
  assert.deepEqual(readHandoffAssociation(store, { ...input, observations: [] }), input);
  assert.equal(jsonFiles(join(store.associations, "headers")).length, 1);
  assert.equal(jsonFiles(join(store.associations, "observations")).length, 1);
  assert.equal(saved.observations[0].observedAt, "2026-10-08T08:41:00-07:00");
  assert.deepEqual(saved.observations[0].nativeValue, { status: "completed", output: ["α", 7] });
});

test("a missing exact identity reads as null without creating association records", (t) => {
  const store = state(t);
  assert.equal(readHandoffAssociation(store, association({ observations: [] })), null);
  assert.deepEqual(jsonFiles(join(store.associations, "headers")), []);
});

test("present null and malformed headers remain unknown state rather than looking absent", (t) => {
  const store = state(t);
  for (const [taskId, content] of [["T1", "null"], ["T2", "{truncated"]]) {
    const identity = association({ taskId, observations: [] });
    const path = headerPath(store, identity);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    assert.throws(
      () => readHandoffAssociation(store, identity),
      (error) => error.code === "STATE_UNKNOWN",
    );
  }
});

test("identical replay is idempotent and later observations append as separate immutable records", (t) => {
  const store = state(t);
  const input = association();
  recordHandoffAssociation(store, input);
  assert.deepEqual(recordHandoffAssociation(store, input), input);

  const later = association({ observations: [observation("O2", {
    value: { status: "blocked", detail: "native meaning stays intact" },
    observedAt: "2026-10-08T08:42:00-07:00",
  })] });
  const reconstructed = recordHandoffAssociation(store, later);
  assert.deepEqual(reconstructed.observations.map((item) => item.id), ["O1", "O2"]);
  assert.deepEqual(reconstructed.observations[1].nativeValue, { status: "blocked", detail: "native meaning stays intact" });
  assert.equal(jsonFiles(join(store.associations, "headers")).length, 1);
  assert.equal(jsonFiles(join(store.associations, "observations")).length, 2);
});

test("changed source binding under the same source/session/attempt identity conflicts visibly", (t) => {
  const store = state(t);
  const original = association({ observations: [] });
  recordHandoffAssociation(store, original);

  const changed = association({ taskSha256: hash("d"), observations: [] });
  assert.throws(
    () => recordHandoffAssociation(store, changed),
    (error) => error.code === "STATE_CONFLICT",
  );
  assert.deepEqual(readHandoffAssociation(store, original), original);
});

test("read refuses stale bindings and mismatched stored destinations or attempts, preserving the historical record", (t) => {
  const store = state(t);
  const original = association({ observations: [] });
  recordHandoffAssociation(store, original);

  const stale = association({ taskSha256: hash("d"), observations: [] });
  stale.handoffBinding.source.expectedReadSet["record.json"] = hash("e");
  stale.handoffBinding.source.expectedEdition = hash("f");
  assert.throws(
    () => readHandoffAssociation(store, stale),
    (error) => error.code === "STATE_CONFLICT"
      && error.details.mismatchedFields.includes("handoffBinding"),
  );

  const oldPath = headerPath(store, original);
  for (const field of ["destination", "attempt"]) {
    const mismatched = structuredClone(original);
    if (field === "destination") mismatched.destination.sessionId = "thread-Other";
    else mismatched.attempt.id = "attempt-Other";
    const mismatchedPath = headerPath(store, mismatched);
    copyFileSync(oldPath, mismatchedPath);
    assert.throws(
      () => readHandoffAssociation(store, mismatched),
      (error) => error.code === "STATE_CONFLICT"
        && error.details.mismatchedFields.includes(field),
    );
  }
  assert.deepEqual(readHandoffAssociation(store, original), original);
});

test("an observation ID cannot be reused for a different association or native value", (t) => {
  const store = state(t);
  recordHandoffAssociation(store, association());

  const otherTask = association({
    taskId: "T2",
    observations: [observation("O1", { value: { status: "failed" } })],
  });
  assert.throws(
    () => recordHandoffAssociation(store, otherTask),
    (error) => error.code === "STATE_CONFLICT",
  );

  const changedValue = association({
    observations: [observation("O1", { value: { status: "failed" } })],
  });
  assert.throws(
    () => recordHandoffAssociation(store, changedValue),
    (error) => error.code === "STATE_CONFLICT",
  );
});

test("invalid association records refuse before creating association state", (t) => {
  const store = state(t);
  const invalid = association();
  invalid.observations[0].origin.sessionId = "another-thread";

  assert.throws(
    () => recordHandoffAssociation(store, invalid),
    (error) => error.code === "INVALID_ASSOCIATION",
  );
  assert.deepEqual(jsonFiles(join(store.associations, "headers")), []);
  assert.deepEqual(jsonFiles(join(store.associations, "observations")), []);
});
