import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
function load(store) {
  const folded = new Map();
  try {
    const base = JSON.parse(readFileSync(join(store.directory, "participation.json"), "utf8"));
    if (Array.isArray(base)) {
      for (const record of base) {
        const valid = validRecord(record);
        if (valid) folded.set(recordKey(valid), valid);
      }
    }
  } catch {}
  try {
    const raw = readFileSync(logPath(store), "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const valid = validRecord(JSON.parse(line));
        if (valid) folded.set(recordKey(valid), valid);
      } catch {}
    }
  } catch {}
  return [...folded.values()];
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
