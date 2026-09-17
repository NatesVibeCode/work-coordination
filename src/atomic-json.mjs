import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { threadId } from "node:worker_threads";

// Lock-free concurrent writes. There is no lock to hold, no one to wait
// for, and nothing that can deadlock: read the file, compute the next
// value, and rename it into place only if nobody else wrote in between.
// On a race the whole attempt repeats; attempts are microseconds of local
// file IO, never a wait on another process. Exhaustion throws instead of
// hanging — the caller reports it, exactly once.
//
// Every scratch name is unique to its writer (pid, thread, counter), so two
// writers can never share one temporary file. No lock, lease, or claim file
// is ever created; another process sees only the compare-and-swap.
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

let scratchCounter = 0;

function scratchPath(path) {
  scratchCounter += 1;
  return `${path}.${process.pid}-${threadId}-${scratchCounter}-${Math.random().toString(36).slice(2, 8)}.tmp`;
}

// Replace a file with `content` in one step: write a scratch file nobody else
// can be using, then rename it into place. The scratch file is removed if the
// rename fails, so a store holds state records and nothing else.
export function replaceFile(path, content) {
  const temporary = scratchPath(path);
  writeFileSync(temporary, content, { mode: 0o600 });
  try {
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {}
    throw error;
  }
}

export function replaceJsonFile(path, value) {
  replaceFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function reviseJsonFile(path, fallback, revise, { maxAttempts = 50 } = {}) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const raw = readRaw(path);
    const next = revise(parse(raw, fallback));
    if (next === NO_WRITE) return { updated: false };
    const temporary = scratchPath(path);
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    if (readRaw(path) === raw) {
      try {
        renameSync(temporary, path);
      } catch (error) {
        // A failed install must not leave its scratch file behind either.
        try {
          unlinkSync(temporary);
        } catch {}
        throw error;
      }
      return { updated: true };
    }
    try {
      unlinkSync(temporary);
    } catch {}
  }
  throw new Error(`concurrent update conflict: ${path}`);
}
