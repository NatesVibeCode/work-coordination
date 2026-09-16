import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

// Lock-free concurrent writes. There is no lock to hold, no one to wait
// for, and nothing that can deadlock: read the file, compute the next
// value, and rename it into place only if nobody else wrote in between.
// On a race the whole attempt repeats; attempts are microseconds of local
// file IO, never a wait on another process. Exhaustion throws instead of
// hanging — the caller reports it, exactly once.
export const NO_WRITE = Symbol("no-write");

function readRaw(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function parse(raw, fallback) {
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function reviseJsonFile(path, fallback, revise, { maxAttempts = 50 } = {}) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const raw = readRaw(path);
    const next = revise(parse(raw, fallback));
    if (next === NO_WRITE) return { updated: false };
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    if (readRaw(path) === raw) {
      renameSync(temporary, path);
      return { updated: true };
    }
    try {
      unlinkSync(temporary);
    } catch {}
  }
  throw new Error(`concurrent update conflict: ${path}`);
}
