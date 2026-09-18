import { spawn as systemSpawn } from "node:child_process";
import { transportForSessionRef } from "./transports.mjs";
import { policyRefusal, refSubject } from "./policy.mjs";

function text(value) {
  return String(value ?? "").trim();
}

// A fan-out must never turn one unreachable target into a wall the others
// wait behind: each delivery keeps its own idle timeout, and they run
// together (bounded) instead of end to end. Results stay in input order so
// callers render a stable list, and a throwing delivery becomes a reported
// failure instead of a fatal one.
export async function mapBounded(items, limit, operation) {
  const values = [...items];
  const results = new Array(values.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, Number(limit) || 1), values.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= values.length) return;
      try {
        results[index] = await operation(values[index], index);
      } catch (error) {
        results[index] = { delivered: false, transport: null, warning: String(error?.message ?? error) };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

// Delivery dispatch is harness-agnostic: the transports themselves live in
// src/transports.mjs and register into the registry there; this module keeps
// the entry shape the frontends call — `{ harness, sessionRef, message }`,
// with the harness half already split off by `destinationOf()` — and hands
// the delivery to whatever transport answers for that harness. A harness
// nobody registered a transport for is the mailbox-only case: the message is
// still stored, so the report says no push transport exists.
//
// Callers that pass the store get the visibility policy enforced here, so
// every delivery path (explicit target, fan-out, group, retry) refuses a
// denied destination the same way, before any transport is consulted.
export async function deliverMessage(input = {}, { spawnFn = systemSpawn, idleTimeoutMs = 60_000, store = null, ...transportOptions } = {}) {
  const harness = text(input.harness).toLowerCase();
  const sessionRef = text(input.sessionRef);
  const message = String(input.message ?? "");
  if (!harness || !sessionRef || !message) {
    return { delivered: false, transport: null, warning: "message destination unavailable" };
  }
  if (store) {
    const refusal = policyRefusal(store, refSubject(`${harness}:${sessionRef}`), "message");
    if (refusal) return { delivered: false, transport: null, warning: refusal };
  }
  const route = transportForSessionRef(`${harness}:${sessionRef}`);
  if (!route) {
    return { delivered: false, transport: null, warning: `no verified local message transport for ${harness}` };
  }
  return route.deliver(sessionRef, message, { spawnFn, idleTimeoutMs, ...transportOptions });
}
