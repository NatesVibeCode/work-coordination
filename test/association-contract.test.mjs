import test from "node:test";
import assert from "node:assert/strict";
import {
  compareHandoffBinding,
  validateHandoffAssociation,
  validateHandoffBinding,
} from "../src/association-contract.mjs";

const hash = (digit = "a") => digit.repeat(64);

function binding(overrides = {}) {
  return {
    contract: "mdview.handoff-binding",
    schemaVersion: 1,
    source: {
      index: "/workspace/plan/sections.json",
      section: "execution-plan",
      record: "record.json",
      taskId: "T1",
      taskSha256: hash("1"),
      expectedReadSet: {
        "@index": hash("2"),
        "record.json": hash("3"),
      },
      expectedEdition: hash("4"),
    },
    scope: "selected source/task binding only",
    ...overrides,
  };
}

function observation(overrides = {}) {
  return {
    id: "O1",
    origin: { surface: "opencode", sessionId: "ses-Exact-A", attemptId: "try-1" },
    observedAt: "2026-10-08T15:41:00.125Z",
    nativeKind: "todo.updated",
    nativeValue: { status: "completed", title: "Keep native meaning" },
    ...overrides,
  };
}

function association(overrides = {}) {
  return {
    contract: "work-coordination.handoff-association",
    schemaVersion: 1,
    handoffBinding: binding(),
    destination: {
      selection: "operator-explicit",
      surface: "opencode",
      sessionId: "ses-Exact-A",
    },
    attempt: { id: "try-1" },
    observations: [observation()],
    ...overrides,
  };
}

test("validates the Mdviewer v1 binding and an explicit native association without rewriting it", () => {
  const record = association();
  const before = structuredClone(record);

  assert.deepEqual(validateHandoffBinding(record.handoffBinding), { valid: true, errors: [] });
  assert.deepEqual(validateHandoffAssociation(record), { valid: true, errors: [] });
  assert.deepEqual(record, before);
  assert.equal(record.destination.sessionId, "ses-Exact-A");
  assert.equal(record.observations[0].observedAt, "2026-10-08T15:41:00.125Z");
  assert.deepEqual(record.observations[0].nativeValue, { status: "completed", title: "Keep native meaning" });
});

test("allows an association before the first returned observation", () => {
  assert.equal(validateHandoffAssociation(association({ observations: [] })).valid, true);
});

test("supports each explicitly selected native surface with its exact session identity", () => {
  for (const surface of ["codex", "opencode", "aoa"]) {
    const record = association();
    record.destination.surface = surface;
    record.observations[0].origin.surface = surface;
    assert.equal(validateHandoffAssociation(record).valid, true, surface);
  }
});

test("rejects missing and unknown association, destination, and binding fields", () => {
  const missingAttempt = association();
  delete missingAttempt.attempt.id;
  assert.match(validateHandoffAssociation(missingAttempt).errors.join("\n"), /attempt\.id is required/);

  const unknownAssociationField = association({ readiness: "done" });
  assert.match(validateHandoffAssociation(unknownAssociationField).errors.join("\n"), /record\.readiness is unknown/);

  const unknownDestinationField = association();
  unknownDestinationField.destination.defaulted = true;
  assert.match(validateHandoffAssociation(unknownDestinationField).errors.join("\n"), /destination\.defaulted is unknown/);

  const unknownBindingField = binding();
  unknownBindingField.source.current = true;
  assert.match(validateHandoffBinding(unknownBindingField).errors.join("\n"), /source\.current is unknown/);

  const unknownObservationField = association();
  unknownObservationField.observations[0].completed = true;
  assert.match(validateHandoffAssociation(unknownObservationField).errors.join("\n"), /observations\[0\]\.completed is unknown/);
  assert.equal(validateHandoffAssociation(association(), { inferredSession: true }).valid, false);
  assert.equal(validateHandoffAssociation(association(), null).valid, false);
});

test("requires an explicitly selected known surface, exact session ID, and caller-supplied attempt ID", () => {
  const inferred = association();
  inferred.destination.selection = "inferred";
  assert.match(validateHandoffAssociation(inferred).errors.join("\n"), /selection must be operator-explicit/);

  const unknownSurface = association();
  unknownSurface.destination.surface = "automatic";
  assert.match(validateHandoffAssociation(unknownSurface).errors.join("\n"), /surface must be codex, opencode, or aoa/);

  const noSession = association();
  noSession.destination.sessionId = " \n ";
  assert.match(validateHandoffAssociation(noSession).errors.join("\n"), /exact non-empty session ID/);

  const noAttempt = association();
  noAttempt.attempt.id = "";
  assert.match(validateHandoffAssociation(noAttempt).errors.join("\n"), /caller-supplied stable ID/);
});

test("rejects malformed source pins and unsafe source paths", () => {
  const malformed = binding();
  malformed.source.taskSha256 = hash("A");
  malformed.source.record = "../record.json";
  malformed.source.expectedEdition = "old-edition";
  delete malformed.source.expectedReadSet["@index"];
  const result = validateHandoffBinding(malformed);
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /taskSha256 must be a lowercase SHA-256/);
  assert.match(result.errors.join("\n"), /record must be a safe relative path/);
  assert.match(result.errors.join("\n"), /expectedEdition must be a lowercase SHA-256 or null/);
  assert.match(result.errors.join("\n"), /expectedReadSet\.@index is required/);
});

test("compares the complete source binding and reports changed fields as stale", () => {
  assert.deepEqual(compareHandoffBinding(binding(), binding()), {
    status: "current",
    changed: [],
    errors: [],
  });

  const changed = binding();
  changed.source.taskSha256 = hash("5");
  changed.source.expectedReadSet["record.json"] = hash("6");
  changed.source.expectedEdition = null;
  assert.deepEqual(compareHandoffBinding(binding(), changed), {
    status: "stale",
    changed: ["source.taskSha256", "source.expectedReadSet", "source.expectedEdition"],
    errors: [],
  });

  const malformed = binding({ typo: true });
  assert.equal(compareHandoffBinding(binding(), malformed).status, "invalid");
});

test("rejects duplicate observation IDs and observations from another source/session/attempt", () => {
  const duplicate = association();
  duplicate.observations.push(structuredClone(duplicate.observations[0]));
  assert.match(validateHandoffAssociation(duplicate).errors.join("\n"), /observations\[1\]\.id is duplicated/);

  const foreign = association();
  foreign.observations[0].origin.sessionId = "another-session";
  assert.match(validateHandoffAssociation(foreign).errors.join("\n"), /origin must match/);

  const badTime = association();
  badTime.observations[0].observedAt = "2026-02-30T15:41:00Z";
  assert.match(validateHandoffAssociation(badTime).errors.join("\n"), /RFC 3339 timestamp/);
});

test("rejects conflicting reuse of a source/session/attempt identity but permits appended observations", () => {
  const prior = association({ observations: [] });
  const appended = association({
    observations: [observation(), observation({ id: "O2", nativeKind: "session.message" })],
  });
  assert.equal(validateHandoffAssociation(association(), { existingRecords: [association()] }).valid, true);
  assert.equal(validateHandoffAssociation(appended, { existingRecords: [prior] }).valid, true);

  const changedBinding = association();
  changedBinding.handoffBinding.source.taskSha256 = hash("9");
  const conflict = validateHandoffAssociation(changedBinding, { existingRecords: [prior] });
  assert.equal(conflict.valid, false);
  assert.match(conflict.errors.join("\n"), /conflicts with the same source\/session\/attempt identity/);

  const changedObservation = association();
  changedObservation.observations[0].nativeValue.status = "failed";
  assert.equal(validateHandoffAssociation(changedObservation, { existingRecords: [association()] }).valid, false);
});
