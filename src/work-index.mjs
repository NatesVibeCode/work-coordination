import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { textField } from "./coordination.mjs";
import { expiryCutoff } from "./state.mjs";

function text(value) {
  return String(value ?? "").trim() || null;
}

function logPath(store) {
  return join(store.directory, "participation.jsonl");
}

function recordKey(record) {
  return JSON.stringify([record?.sessionRef ?? null, record?.workRef ?? null]);
}

function validRecord(value) {
  return value && typeof value === "object" && typeof value.sessionRef === "string" ? value : null;
}

// Observations are append-only: one atomic append per observe, never a
// read-modify-write, so concurrent observers cannot lose each other and
// nothing ever waits. Readers fold the log with last-write-wins per
// (session, work) — the same upsert the rewrite used to do — over the
// legacy participation.json base, which keeps old stores working.
// Every observation ever recorded, retention window ignored. For the
// expired-vs-missing distinction only — normal reads go through load().
export function allObservations(store) {
  const folded = new Map();
  const consider = (record) => {
    const valid = validRecord(record);
    if (valid) folded.set(recordKey(valid), valid);
  };
  try {
    const base = JSON.parse(readFileSync(join(store.directory, "participation.json"), "utf8"));
    if (Array.isArray(base)) {
      for (const record of base) consider(record);
    }
  } catch {}
  try {
    const raw = readFileSync(logPath(store), "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        consider(JSON.parse(line));
      } catch {}
    }
  } catch {}
  return [...folded.values()];
}

function load(store) {
  const cutoff = expiryCutoff(store);
  if (cutoff === null) return allObservations(store);
  return allObservations(store).filter((record) => Number(record.observedAt ?? 0) >= cutoff);
}

const PAYLOAD_FIELDS = ["workRef", "sessionRef", "harness", "directory", "worktree", "title"];

function samePayload(left, right) {
  return PAYLOAD_FIELDS.every((field) => (left?.[field] ?? null) === (right?.[field] ?? null));
}

// How long a repeat observation of the same thing is considered already said.
// `observedAt` is a recency signal — `sessions` sorts by it and expiry filters
// on it — so aging it out would freeze a busy session as "last seen" at its
// first call. Within the window a duplicate says nothing new and is not
// appended; past it, the observation is re-declared and does append.
const OBSERVATION_REFRESH_MS = 15 * 60 * 1000;

// Observations are append-only: one atomic append per observe, never a
// read-modify-write, so concurrent observers cannot lose each other and
// nothing ever waits. (Nothing prunes this log: an aged-out record is the
// evidence that tells "expired" apart from "never observed", so compaction
// would destroy a distinction the CLI promises.)
export function observeParticipation(store, input = {}, { now = Date.now(), random = Math.random } = {}) {
  const sessionRef = textField(input.sessionRef) ?? `session_${String(random()).replace(/[^a-zA-Z0-9]/g, "").slice(0, 12) || "local"}`;
  const at = Number(now);
  const record = {
    workRef: textField(input.workRef),
    sessionRef,
    harness: textField(input.harness),
    directory: textField(input.directory),
    worktree: textField(input.worktree),
    title: textField(input.title),
    observedAt: at,
  };
  const alreadySaid = allObservations(store).some((existing) => samePayload(existing, record)
    && at - Number(existing.observedAt ?? 0) < OBSERVATION_REFRESH_MS);
  if (!alreadySaid) appendFileSync(logPath(store), `${JSON.stringify(record)}\n`, { mode: 0o600 });
  return record;
}

export function observedSessions(store) {
  return load(store).sort((left, right) => right.observedAt - left.observedAt);
}

export function workView(store, workRef) {
  const value = text(workRef);
  if (!value) return null;
  const participants = load(store).filter((record) => record.workRef === value);
  return participants.length ? { workRef: value, participants } : null;
}
