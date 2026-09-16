import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withLocalLock } from "./locking.mjs";

function text(value) {
  return String(value ?? "").trim() || null;
}

function load(store) {
  try {
    const value = JSON.parse(readFileSync(join(store.directory, "participation.json"), "utf8"));
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function save(store, records) {
  const path = join(store.directory, "participation.json");
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

export function observeParticipation(store, input = {}, { now = Date.now(), random = Math.random } = {}) {
  const sessionRef = text(input.sessionRef) ?? `session_${String(random()).replace(/[^a-zA-Z0-9]/g, "").slice(0, 12) || "local"}`;
  const record = {
    workRef: text(input.workRef),
    sessionRef,
    harness: text(input.harness),
    directory: text(input.directory),
    title: text(input.title),
    observedAt: Number(now),
  };
  return withLocalLock(store.directory, "participation", () => {
    const records = load(store);
    const index = records.findIndex((value) => value.sessionRef === record.sessionRef && value.workRef === record.workRef);
    if (index >= 0) records[index] = record;
    else records.push(record);
    save(store, records);
    return record;
  });
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
