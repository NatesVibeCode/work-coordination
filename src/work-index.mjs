import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { identityHash, readJsonFile, writeJsonRecord } from "./atomic-json.mjs";
import { textField } from "./coordination.mjs";
import { expiryCutoff } from "./state.mjs";

const OBSERVATION_SCHEMA = "work-coordination.participation_observation.v1";

function text(value) {
  return String(value ?? "").trim() || null;
}

function recordsPath(store) {
  return join(store.directory, "participation");
}

function legacyLogPath(store) {
  return join(store.directory, "participation.jsonl");
}

function recordKey(record) {
  return JSON.stringify([record?.sessionRef ?? null, record?.workRef ?? null]);
}

function validRecord(value) {
  return value && typeof value === "object" && typeof value.sessionRef === "string" ? value : null;
}

function shouldReplace(existing, candidate) {
  if (!existing) return true;
  const left = Number(existing.record?.observedAt ?? existing.observedAt ?? 0);
  const right = Number(candidate.record?.observedAt ?? candidate.observedAt ?? 0);
  return right > left || (right === left && String(candidate.id ?? "") > String(existing.id ?? ""));
}

// Presence is an append-only observation stream. Each new observation is an
// immutable JSON state record with a unique identity; readers fold by exact
// (session, work) identity and retain the newest recency. No participant can
// claim another session or block an overlapping observer.
export function allObservations(store) {
  const folded = new Map();
  const consider = (record, id = identityHash("legacy-observation", record)) => {
    const valid = validRecord(record);
    if (!valid) return;
    const key = recordKey(valid);
    const candidate = { id, record: valid };
    if (shouldReplace(folded.get(key), candidate)) folded.set(key, candidate);
  };
  const base = readJsonFile(join(store.directory, "participation.json"), []);
  if (Array.isArray(base)) for (const record of base) consider(record);
  try {
    for (const entry of readdirSync(recordsPath(store), { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        const record = JSON.parse(readFileSync(join(recordsPath(store), entry.name), "utf8"));
        if (record?.schema === OBSERVATION_SCHEMA && typeof record.id === "string") consider(record.observation, record.id);
      } catch {}
    }
  } catch {}
  // Old stores remain readable. New writers never append to JSONL.
  try {
    const raw = readFileSync(legacyLogPath(store), "utf8");
    for (const [index, line] of raw.split("\n").entries()) {
      if (!line.trim()) continue;
      try { consider(JSON.parse(line), `legacy:${index}:${identityHash(line)}`); } catch {}
    }
  } catch {}
  return [...folded.values()].map((entry) => entry.record);
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

const OBSERVATION_REFRESH_MS = 15 * 60 * 1000;

export function observeParticipation(store, input = {}, { now = Date.now(), random = Math.random } = {}) {
  const suppliedSession = textField(input.sessionRef);
  const generated = suppliedSession ? null : (random === Math.random
    ? randomUUID().replace(/-/g, "")
    : String(random()).replace(/[^a-zA-Z0-9]/g, "").slice(0, 12) || "local");
  const sessionRef = suppliedSession ?? `session_${generated}`;
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
  if (!alreadySaid) {
    const id = randomUUID();
    writeJsonRecord(join(recordsPath(store), `${id}.json`), { schema: OBSERVATION_SCHEMA, id, observation: record });
  }
  return record;
}

export function observedSessions(store) {
  return load(store).sort((left, right) => Number(right.observedAt) - Number(left.observedAt)
    || left.sessionRef.localeCompare(right.sessionRef)
    || String(left.workRef ?? "").localeCompare(String(right.workRef ?? "")));
}

export function workView(store, workRef) {
  const value = text(workRef);
  if (!value) return null;
  const participants = load(store).filter((record) => record.workRef === value);
  return participants.length ? { workRef: value, participants } : null;
}
