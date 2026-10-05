import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { threadId } from "node:worker_threads";

// Durable mutations are immutable JSON state records. A mutation is a small
// three-way patch, not a replacement snapshot: readers merge independent
// entity updates and retain divergent same-entity revisions as conflicts.
// This is deliberately not called compare-and-swap. A read and an append
// cannot be one atomic operation without a lock; the journal is the source of
// truth and makes a race observable instead of allowing rename-last-wins.
export const NO_WRITE = Symbol("no-write");
export const STATE_MUTATION_SCHEMA = "work-coordination.json-mutation.v1";
const MAX_SNAPSHOT_ATTEMPTS = 8;
const MAX_MUTATIONS_PER_JOURNAL = 16_384;

function stable(value) {
  if (value === undefined) return '"<undefined>"';
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return createHash("sha256").update(stable(value)).digest("hex");
}

export function identityHash(...parts) {
  return digest(parts);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readRaw(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function namesAt(path) {
  try {
    return readdirSync(path, { withFileTypes: true })
      .map((entry) => ({ name: entry.name, file: entry.isFile(), directory: entry.isDirectory(), symlink: entry.isSymbolicLink() }))
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function journalPath(path) {
  return `${path}.journal`;
}

function sameNames(left, right) {
  return left.length === right.length && left.every((entry, index) => entry.name === right[index].name
    && entry.file === right[index].file && entry.directory === right[index].directory && entry.symlink === right[index].symlink);
}

function itemKey(value) {
  if (!isObject(value)) return null;
  if ((typeof value.id === "string" || typeof value.id === "number") && String(value.id) !== "") {
    return `id:${stable(value.id)}`;
  }
  if (typeof value.messageRef === "string" && typeof value.target === "string") {
    return `delivery:${stable([value.messageRef, value.target])}`;
  }
  return null;
}

function keyedArray(value) {
  if (!Array.isArray(value)) return null;
  const result = new Map();
  for (const item of value) {
    const key = itemKey(item);
    if (key === null || result.has(key)) return null;
    result.set(key, item);
  }
  return result;
}

function equalPresence(leftPresent, left, rightPresent, right) {
  return leftPresent === rightPresent && (!leftPresent || stable(left) === stable(right));
}

function diff(beforePresent, before, afterPresent, after, path, changes) {
  if (equalPresence(beforePresent, before, afterPresent, after)) return;
  if (beforePresent && afterPresent && isObject(before) && isObject(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    for (const key of keys) {
      diff(Object.hasOwn(before, key), before[key], Object.hasOwn(after, key), after[key], [...path, key], changes);
    }
    return;
  }
  if (beforePresent && afterPresent && Array.isArray(before) && Array.isArray(after)) {
    const beforeItems = keyedArray(before);
    const afterItems = keyedArray(after);
    if (beforeItems && afterItems) {
      const keys = [...new Set([...beforeItems.keys(), ...afterItems.keys()])].sort();
      for (const key of keys) {
        diff(beforeItems.has(key), beforeItems.get(key), afterItems.has(key), afterItems.get(key), [...path, { itemKey: key }], changes);
      }
      return;
    }
  }
  changes.push({ path, beforePresent, ...(beforePresent ? { before: clone(before) } : {}), afterPresent, ...(afterPresent ? { after: clone(after) } : {}) });
}

const MISSING = Symbol("missing");

function getAt(root, path) {
  let value = root;
  for (const segment of path) {
    if (typeof segment === "string") {
      if (!isObject(value) || !Object.hasOwn(value, segment)) return { present: false, value: MISSING };
      value = value[segment];
      continue;
    }
    if (!Array.isArray(value)) return { present: false, value: MISSING, ambiguous: true };
    const matches = [];
    for (let index = 0; index < value.length; index++) if (itemKey(value[index]) === segment.itemKey) matches.push(index);
    if (matches.length > 1) return { present: false, value: MISSING, ambiguous: true };
    if (matches.length === 0) return { present: false, value: MISSING, array: value, segment };
    value = value[matches[0]];
  }
  return { present: true, value };
}

function setAt(root, path, present, value) {
  if (path.length === 0) return present ? clone(value) : undefined;
  let parent = root;
  for (const segment of path.slice(0, -1)) {
    if (typeof segment === "string") {
      if (!isObject(parent)) return { failed: true };
      parent = parent[segment];
      continue;
    }
    if (!Array.isArray(parent)) return { failed: true };
    const index = parent.findIndex((item) => itemKey(item) === segment.itemKey);
    if (index < 0) return { failed: true };
    parent = parent[index];
  }
  const last = path[path.length - 1];
  if (typeof last === "string") {
    if (!isObject(parent)) return { failed: true };
    if (present) Object.defineProperty(parent, last, {value: clone(value), enumerable: true, writable: true, configurable: true});
    else delete parent[last];
    return root;
  }
  if (!Array.isArray(parent)) return { failed: true };
  const indexes = [];
  for (let index = 0; index < parent.length; index++) if (itemKey(parent[index]) === last.itemKey) indexes.push(index);
  if (indexes.length > 1) return { failed: true };
  if (present) {
    if (indexes.length) parent[indexes[0]] = clone(value);
    else parent.push(clone(value));
  } else if (indexes.length) {
    parent.splice(indexes[0], 1);
  }
  return root;
}

function displayPath(path) {
  return path.map((segment) => typeof segment === "string" ? segment : `{${segment.itemKey}}`).join("/") || "<root>";
}

function applyChanges(current, event) {
  let value = clone(current);
  const conflicts = [];
  for (const change of event.changes) {
    const actual = getAt(value, change.path);
    const expected = { present: change.beforePresent, value: change.beforePresent ? change.before : MISSING };
    const proposed = { present: change.afterPresent, value: change.afterPresent ? change.after : MISSING };
    const actualValue = actual.value === MISSING ? undefined : actual.value;
    const expectedValue = expected.value === MISSING ? undefined : expected.value;
    const proposedValue = proposed.value === MISSING ? undefined : proposed.value;
    if (!actual.ambiguous && equalPresence(actual.present, actualValue, proposed.present, proposedValue)) continue;
    if (!actual.ambiguous && equalPresence(actual.present, actualValue, expected.present, expectedValue)) {
      const next = setAt(value, change.path, proposed.present, proposed.value);
      if (next?.failed) {
        conflicts.push({ eventId: event.id, path: displayPath(change.path), expectedDigest: digest(expectedValue), proposedDigest: digest(proposedValue), actualDigest: "unaddressable" });
      } else {
        value = next;
      }
      continue;
    }
    conflicts.push({
      eventId: event.id,
      path: displayPath(change.path),
      expectedDigest: expected.present ? digest(expected.value) : "missing",
      proposedDigest: proposed.present ? digest(proposed.value) : "missing",
      actualDigest: actual.ambiguous ? "ambiguous" : actual.present ? digest(actual.value) : "missing",
    });
  }
  return { value, conflicts };
}

function validMutation(event, filename) {
  if (!isObject(event) || event.schema !== STATE_MUTATION_SCHEMA || typeof event.id !== "string"
    || filename !== `${event.id}.json` || !Number.isSafeInteger(event.createdAt) || event.createdAt < 0
    || !Array.isArray(event.parents) || event.parents.some((parent) => typeof parent !== "string")
    || !Array.isArray(event.changes) || !/^[a-f0-9]{64}$/.test(event.baseDigest ?? "")
    || !/^[a-f0-9]{64}$/.test(event.resultDigest ?? "") || !/^[a-f0-9]{64}$/.test(event.mutationDigest ?? "")) return false;
  if (typeof event.genesisPresent !== "boolean") return false;
  if (event.genesisPresent && event.genesisDigest !== digest(event.genesisValue)) return false;
  const payload = { id: event.id, createdAt: event.createdAt, parents: event.parents, baseDigest: event.baseDigest,
    resultDigest: event.resultDigest, changes: event.changes, genesisPresent: event.genesisPresent,
    ...(event.genesisPresent ? { genesisDigest: event.genesisDigest, genesisValue: event.genesisValue } : {}) };
  return digest(payload) === event.mutationDigest && event.changes.every((change) => change && Array.isArray(change.path)
    && typeof change.beforePresent === "boolean" && typeof change.afterPresent === "boolean"
    && change.path.every((segment) => typeof segment === "string" || (isObject(segment) && Object.keys(segment).length === 1 && typeof segment.itemKey === "string")));
}

function readBase(path, fallback) {
  const raw = readRaw(path);
  if (raw === null) return { raw: null, value: clone(fallback), gap: null };
  try {
    return { raw, value: JSON.parse(raw), gap: null };
  } catch {
    return { raw, value: clone(fallback), gap: { file: path, reason: "invalid or truncated JSON state record" } };
  }
}

function readSnapshot(path, fallback, maxAttempts = MAX_SNAPSHOT_ATTEMPTS) {
  const eventsDir = journalPath(path);
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const namesBefore = namesAt(eventsDir);
    const baseBefore = readBase(path, fallback);
    const events = [];
    const gaps = baseBefore.gap ? [baseBefore.gap] : [];
    let changedDuringRead = false;
    for (const entry of namesBefore) {
      const eventPath = join(eventsDir, entry.name);
      // A unique scratch file is not a mutation until its completed JSON file
      // is atomically published under the final .json name. Store diagnostics
      // still report a crash-left scratch artifact as a gap.
      if (entry.file && entry.name.endsWith(".tmp")) continue;
      if (!entry.file || entry.symlink || !entry.name.endsWith(".json")) {
        gaps.push({ file: eventPath, reason: "journal contains a non-JSON state artifact" });
        continue;
      }
      const raw = readRaw(eventPath);
      if (raw === null) {
        changedDuringRead = true;
        continue;
      }
      let event;
      try { event = JSON.parse(raw); } catch {
        gaps.push({ file: eventPath, reason: "invalid or truncated JSON mutation record" });
        continue;
      }
      if (!validMutation(event, entry.name)) {
        gaps.push({ file: eventPath, reason: "unknown or invalid JSON mutation record" });
        continue;
      }
      events.push(event);
    }
    const baseAfter = readRaw(path);
    const namesAfter = namesAt(eventsDir);
    if (changedDuringRead || baseBefore.raw !== baseAfter || !sameNames(namesBefore, namesAfter)) continue;
    const eventById = new Map(events.map((event) => [event.id, event]));
    for (const event of events) {
      for (const parent of event.parents) {
        if (!eventById.has(parent)) gaps.push({ file: join(eventsDir, `${event.id}.json`), reason: `mutation parent ${parent} is missing` });
      }
    }
    const pending = new Map(events.map((event) => [event.id, new Set(event.parents.filter((parent) => eventById.has(parent)))]));
    const ordered = [];
    const remaining = new Set(pending.keys());
    while (remaining.size) {
      const ready = [...remaining].filter((id) => [...pending.get(id)].every((parent) => !remaining.has(parent)))
        .map((id) => eventById.get(id))
        .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
      if (!ready.length) {
        gaps.push({ file: eventsDir, reason: "mutation parent graph contains a cycle" });
        break;
      }
      for (const event of ready) {
        ordered.push(event);
        remaining.delete(event.id);
      }
    }
    events.length = 0;
    events.push(...ordered);
    let value = baseBefore.value;
    if (baseBefore.raw === null) {
      const genesis = events.find((event) => event.genesisPresent === true);
      if (genesis) value = clone(genesis.genesisValue);
    }
    const conflicts = [];
    for (const event of events) {
      const applied = applyChanges(value, event);
      value = applied.value;
      conflicts.push(...applied.conflicts);
    }
    const revisionToken = digest({ base: baseBefore.raw, events: events.map((event) => [event.id, digest(event)]) });
    const referenced = new Set(events.flatMap((event) => event.parents));
    const heads = events.map((event) => event.id).filter((id) => !referenced.has(id)).sort();
    return { value, revisionToken, conflicts, gaps, eventCount: namesBefore.filter((entry) => entry.name.endsWith(".json")).length,
      eventIds: events.map((event) => event.id), heads, baseRaw: baseBefore.raw };
  }
  return {
    value: clone(fallback),
    revisionToken: "unstable",
    conflicts: [],
    gaps: [{ file: path, reason: "state changed during every bounded read; snapshot is unknown" }],
    eventCount: 0,
    eventIds: [],
    heads: [],
    baseRaw: null,
  };
}

export class StateConflictError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "StateConflictError";
    this.code = "STATE_CONFLICT";
    this.details = details;
  }
}

export class StateUnknownError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "StateUnknownError";
    this.code = "STATE_UNKNOWN";
    this.details = details;
  }
}

export class StateLimitError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "StateLimitError";
    this.code = "STATE_LIMIT";
    this.details = details;
  }
}

export function readJsonStateFile(path, fallback, { maxAttempts = MAX_SNAPSHOT_ATTEMPTS } = {}) {
  return readSnapshot(path, fallback, maxAttempts);
}

export function readJsonFile(path, fallback) {
  const snapshot = readSnapshot(path, fallback);
  if (snapshot.gaps.length) throw new StateUnknownError(`state unknown: ${snapshot.gaps[0].reason}`, { path, gaps: snapshot.gaps });
  return snapshot.value;
}

let scratchCounter = 0;

function scratchPath(path) {
  scratchCounter += 1;
  return `${path}.${process.pid}-${threadId}-${scratchCounter}-${randomUUID()}.tmp`;
}

// Atomic replacement remains for non-journal files and legacy migration only.
// It does not provide inter-process conditional update semantics.
export function replaceFile(path, content) {
  const temporary = scratchPath(path);
  writeFileSync(temporary, content, { mode: 0o600 });
  try {
    renameSync(temporary, path);
  } catch (error) {
    try { unlinkSync(temporary); } catch {}
    throw error;
  }
}

export function writeJsonRecord(path, value) {
  const encoded = `${JSON.stringify(value, null, 2)}\n`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = scratchPath(path);
  let published = false;
  try {
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(fd, encoded, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // Publish a complete, closed JSON file in one exclusive directory entry
    // operation. Readers never mistake an in-progress write for a torn
    // accepted mutation, and EEXIST cannot replace another writer's record.
    linkSync(temporary, path);
    published = true;
    // Flush the published directory entry before acknowledging its record.
    const directoryFD = openSync(dirname(path), "r");
    try { fsyncSync(directoryFD); } finally { closeSync(directoryFD); }
    unlinkSync(temporary);
    return { created: true, record: value };
  } catch (error) {
    try { unlinkSync(temporary); } catch {}
    if (published) {
      const unknown = new Error("immutable JSON record was published but durability acknowledgement failed", {cause:error});
      unknown.code = "STATE_DURABILITY_UNKNOWN";
      unknown.details = {path};
      throw unknown;
    }
    if (error?.code !== "EEXIST") throw error;
    const raw = readRaw(path);
    let existing;
    try { existing = raw === null ? null : JSON.parse(raw); } catch {
      throw new StateUnknownError("existing JSON state record is incomplete", { path });
    }
    if (stable(existing) === stable(value)) return { created: false, record: existing };
    throw new StateConflictError("immutable state identity already contains a different record", { path, expectedDigest: digest(value), actualDigest: digest(existing) });
  }
}

function appendMutation(path, before, after, createdAt, parents, genesisPresent) {
  const changes = [];
  diff(true, before, true, after, [], changes);
  if (changes.length === 0) return { created: false, event: null };
  const id = randomUUID();
  const baseDigest = digest(before);
  const resultDigest = digest(after);
  const genesisDigest = genesisPresent ? digest(before) : undefined;
  const payload = { id, createdAt, parents, baseDigest, resultDigest, changes, genesisPresent,
    ...(genesisPresent ? { genesisDigest, genesisValue: before } : {}) };
  const event = { schema: STATE_MUTATION_SCHEMA, ...payload, mutationDigest: digest(payload) };
  const pathToEvent = join(journalPath(path), `${id}.json`);
  writeJsonRecord(pathToEvent, event);
  return { created: true, event };
}

export function replaceJsonFile(path, value) {
  reviseJsonFile(path, null, () => value);
}

export function reviseJsonFile(path, fallback, revise, { maxAttempts = 50, now = Date.now(), expectedRevisionToken = null } = {}) {
  const attempts = Math.max(1, Math.min(128, Number(maxAttempts) || 1));
  let firstToken = expectedRevisionToken;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const snapshot = readSnapshot(path, fallback);
    if (snapshot.gaps.length) throw new StateUnknownError(`state unknown: ${snapshot.gaps[0].reason}`, { path, gaps: snapshot.gaps });
    if (firstToken !== null && snapshot.revisionToken !== firstToken) {
      throw new StateConflictError("expected state revision is stale", { path, expectedRevisionToken: firstToken, actualRevisionToken: snapshot.revisionToken });
    }
    const next = revise(clone(snapshot.value));
    if (next === NO_WRITE) return { updated: false, conflicts: snapshot.conflicts, revisionToken: snapshot.revisionToken };
    const current = readSnapshot(path, fallback);
    if (current.gaps.length) throw new StateUnknownError(`state unknown: ${current.gaps[0].reason}`, { path, gaps: current.gaps });
    if (current.revisionToken !== snapshot.revisionToken) {
      if (firstToken !== null) throw new StateConflictError("expected state revision changed before mutation append", { path, expectedRevisionToken: firstToken, actualRevisionToken: current.revisionToken });
      continue;
    }
    if (snapshot.eventCount >= MAX_MUTATIONS_PER_JOURNAL) {
      throw new StateLimitError("state mutation journal reached its bounded 16384-record capacity", { path, limit: MAX_MUTATIONS_PER_JOURNAL });
    }
    const appended = appendMutation(path, snapshot.value, next, Number.isSafeInteger(Number(now)) && Number(now) >= 0 ? Number(now) : Date.now(), snapshot.heads,
      snapshot.eventCount === 0 && snapshot.baseRaw === null);
    if (!appended.created) return { updated: false, conflicts: snapshot.conflicts, revisionToken: snapshot.revisionToken };
    const after = readSnapshot(path, fallback);
    const ownConflicts = after.conflicts.filter((conflict) => conflict.eventId === appended.event.id);
    if (ownConflicts.length) {
      throw new StateConflictError("state mutation was retained but conflicts with another revision", {
        path,
        eventId: appended.event.id,
        conflicts: ownConflicts,
        revisionToken: after.revisionToken,
      });
    }
    return { updated: true, eventId: appended.event.id, revisionToken: after.revisionToken, conflicts: after.conflicts };
  }
  throw new StateConflictError("concurrent state changed during the bounded mutation attempt", { path, attempts });
}

function parseLegacyLines(path) {
  let raw;
  try { raw = readFileSync(path, "utf8"); } catch (error) {
    if (error?.code === "ENOENT") return { records: 0, gaps: [] };
    return { records: 0, gaps: [{ file: path, reason: "legacy state log could not be read" }] };
  }
  let records = 0;
  const gaps = [];
  for (const [index, line] of raw.split("\n").entries()) {
    if (!line.trim()) continue;
    try { JSON.parse(line); records++; } catch {
      gaps.push({ file: path, reason: `invalid or truncated legacy JSON record at line ${index + 1}` });
    }
  }
  return { records, gaps };
}

export function inspectJsonStateDirectory(root) {
  const gaps = [];
  const conflicts = [];
  const legacy = [];
  const visit = (directory) => {
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch (error) {
      if (error?.code === "ENOENT") return;
      gaps.push({ file: directory, reason: "state directory could not be read" });
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        gaps.push({ file: path, reason: "symbolic link is not a JSON state record" });
      } else if (entry.isDirectory()) {
        if (entry.name.endsWith(".journal")) {
          const basePath = path.slice(0, -".journal".length);
          const snapshot = readSnapshot(basePath, null);
          gaps.push(...snapshot.gaps);
          conflicts.push(...snapshot.conflicts.map((conflict) => ({ base: basePath, ...conflict })));
          for (const nested of namesAt(path)) {
            if (nested.file && nested.name.endsWith(".tmp")) gaps.push({file: join(path,nested.name), reason: "unpublished JSON state record remains"});
            if (nested.directory) visit(join(path,nested.name));
          }
        } else {
          visit(path);
        }
      } else if (entry.isFile() && entry.name.endsWith(".json")) {
        try { JSON.parse(readFileSync(path, "utf8")); } catch {
          gaps.push({ file: path, reason: "invalid or truncated JSON state record" });
        }
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const result = parseLegacyLines(path);
        legacy.push({ file: path, records: result.records });
        gaps.push(...result.gaps);
      } else {
        gaps.push({ file: path, reason: "non-JSON file found in a state store" });
      }
    }
  };
  visit(root);
  return { status: gaps.length || conflicts.length ? "unknown" : "consistent", gaps, conflicts, legacy };
}
