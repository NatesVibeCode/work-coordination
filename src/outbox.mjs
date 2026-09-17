import { readFileSync } from "node:fs";
import { join } from "node:path";
import { oneLine } from "./coordination.mjs";
import { NO_WRITE, replaceJsonFile, reviseJsonFile } from "./atomic-json.mjs";
import { expiryCutoff } from "./state.mjs";

// Deliveries that did not land.
//
// A failed send is reported and the advisory record is still stored, but the
// recipient never hears about it — and a harness that is out of credit, rate
// limited, or disconnected at that moment is exactly when you most want the
// message to survive. So a failure is remembered as work still to do: a small
// queue of "this text was meant for that destination". `retry` drains it.
//
// Nothing runs in the background. There is no daemon, no timer, no wake-up:
// the queue is state you can read and act on, which keeps the tool's promise
// that nothing ever waits on anything.
const OUTBOX_LIMIT = 200;

export function outboxPath(store) {
  return join(store.directory, "outbox.json");
}

function readOutbox(store) {
  try {
    const value = JSON.parse(readFileSync(outboxPath(store), "utf8"));
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function keyOf(entry) {
  return `${entry?.messageRef ?? ""}\u0000${entry?.target ?? ""}`;
}

// Oldest first: a queue you can read top-down, and the order to drain it in.
export function listOutbox(store) {
  return readOutbox(store).sort((left, right) => Number(left?.createdAt ?? 0) - Number(right?.createdAt ?? 0));
}

export function outboxCount(store) {
  return readOutbox(store).length;
}

// Remember a delivery that did not land. Keyed by (message, destination), so
// the same failure twice is one queue entry, not two. Nothing here deletes a
// pending delivery for a different message: each queued text is a thing
// somebody meant to send, and only a successful delivery to that destination
// (or the retention window) retires it. Growth is bounded by the cap.
export function recordFailure(store, { messageRef, target, message, workRef, warning, now = Date.now() }) {
  const entry = {
    messageRef: oneLine(messageRef),
    target: oneLine(target),
    message: String(message ?? ""),
    workRef: oneLine(workRef) || null,
    attempts: 1,
    createdAt: Number(now),
    lastAttemptAt: Number(now),
    lastWarning: oneLine(warning) || null,
  };
  if (!entry.messageRef || !entry.target || !entry.message) return null;
  reviseJsonFile(outboxPath(store), [], (value) => {
    const entries = Array.isArray(value) ? value : [];
    const existing = entries.find((candidate) => keyOf(candidate) === keyOf(entry));
    if (existing) {
      // Same intent, another attempt: count it, do not duplicate it.
      const updated = {
        ...existing,
        attempts: Number(existing.attempts ?? 0) + 1,
        lastAttemptAt: Number(now),
        lastWarning: entry.lastWarning,
      };
      return entries.map((candidate) => (keyOf(candidate) === keyOf(entry) ? updated : candidate));
    }
    return [...entries, entry].slice(-OUTBOX_LIMIT);
  });
  return entry;
}

// A destination that finally accepted the text is no longer pending. This
// clears by destination, not by message: while older work is queued for a
// target, every new failure there supersedes it, so there is at most one entry
// per destination — and a success proves that destination works, which retires
// whatever text it did not receive earlier.
export function clearFailure(store, { target }) {
  const wanted = oneLine(target);
  if (!wanted) return;
  reviseJsonFile(outboxPath(store), [], (value) => {
    const entries = Array.isArray(value) ? value : [];
    const kept = entries.filter((candidate) => candidate?.target !== wanted);
    return kept.length === entries.length ? NO_WRITE : kept;
  });
}

export function bumpAttempt(store, { messageRef, target, warning, now = Date.now() }) {
  const wanted = keyOf({ messageRef, target });
  reviseJsonFile(outboxPath(store), [], (value) => {
    const entries = Array.isArray(value) ? value : [];
    let changed = false;
    const kept = entries.map((candidate) => {
      if (keyOf(candidate) !== wanted) return candidate;
      changed = true;
      return {
        ...candidate,
        attempts: Number(candidate.attempts ?? 0) + 1,
        lastAttemptAt: Number(now),
        lastWarning: oneLine(warning) || null,
      };
    });
    return changed ? kept : NO_WRITE;
  });
}

// A queued delivery is meaningless once its record has aged out of the store:
// there is nothing left to explain what it was for.
export function pruneOutbox(store, { now = Date.now() } = {}) {
  const cutoff = expiryCutoff(store, now);
  if (cutoff === null) return;
  reviseJsonFile(outboxPath(store), [], (value) => {
    const entries = Array.isArray(value) ? value : [];
    const kept = entries.filter((entry) => Number(entry?.createdAt ?? 0) >= cutoff);
    return kept.length === entries.length ? NO_WRITE : kept;
  });
}

export function writeOutbox(store, entries) {
  replaceJsonFile(outboxPath(store), entries);
}

// One delivery outcome, recorded: a success retires what was pending for that
// destination, a failure queues the text. Both frontends and both delivery
// paths (a fan-out and an explicit --to) go through this, so "it did not land"
// means the same thing everywhere.
export function settle(store, { messageRef, target, message, workRef, result, now = Date.now() }) {
  if (!messageRef || !target) return;
  if (result?.delivered) {
    clearFailure(store, { target });
    return;
  }
  recordFailure(store, { messageRef, target, message, workRef, warning: result?.warning, now });
}
