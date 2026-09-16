import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
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

export function observeParticipation(store, input = {}, { now = Date.now(), random = Math.random } = {}) {
  const sessionRef = text(input.sessionRef) ?? `session_${String(random()).replace(/[^a-zA-Z0-9]/g, "").slice(0, 12) || "local"}`;
  const record = {
    workRef: text(input.workRef),
    sessionRef,
    harness: text(input.harness),
    directory: text(input.directory),
    worktree: text(input.worktree),
    title: text(input.title),
    observedAt: Number(now),
  };
  appendFileSync(logPath(store), `${JSON.stringify(record)}\n`, { mode: 0o600 });
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
