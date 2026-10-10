import { chmodSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { activeGroup, createMessage, destinationOf, oneLine, renderMessage, textField } from "./coordination.mjs";
import { identityHash, NO_WRITE, readJsonFile, readJsonStateFile, replaceJsonFile, reviseJsonFile, StateConflictError, StateUnknownError, writeJsonRecord } from "./atomic-json.mjs";
import { deliverMessage, mapBounded } from "./delivery.mjs";
import { clearFailure, pruneOutbox, recordFailure } from "./outbox.mjs";
import { validateHandoffAssociation } from "./association-contract.mjs";

function ensure(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { chmodSync(directory, 0o700); } catch {}
}

function readJson(path, fallback) {
  try { return readJsonFile(path, fallback); } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

// Mutable logical JSON goes through the immutable mutation journal in
// atomic-json.mjs; direct replacement remains only for compatibility.
function writeJson(path, value) {
  replaceJsonFile(path, value);
}

// A record's file name is its id, so an id that repeats silently overwrites a
// record. Injected random sources remain a deterministic test seam; native
// identities use a full process-safe UUID.
function id(prefix, random) {
  if (random === Math.random) return `${prefix}_${randomUUID().replace(/-/g, "")}`;
  const suffix = String(random()).replace(/[^a-zA-Z0-9]/g, "").slice(0, 12) || "local";
  return `${prefix}_${suffix}`;
}

export function loadStoreConfig(directory) {
  try {
    const raw = readJsonFile(join(String(directory), "config.json"), {});
    // decayMs is the pre-rename key; it still loads so early stores survive.
    const expiryMs = Number(raw?.expiryMs ?? raw?.decayMs);
    return { expiryMs: expiryMs > 0 ? expiryMs : null };
  } catch (error) {
    if (error?.code === "STATE_UNKNOWN") throw error;
    return { expiryMs: null };
  }
}

export function saveStoreConfig(directory, config = {}) {
  const expiryMs = Number(config?.expiryMs);
  writeJson(join(String(directory), "config.json"), { expiryMs: expiryMs > 0 ? expiryMs : null });
}

// Age cutoff for the expiry setting, or null to keep everything for audit.
// Expiry is a retention window on record age — not an activity timeout: a
// record older than the window is invisible even under a busy work.
export function expiryCutoff(store, now = Date.now()) {
  const expiryMs = store?.config?.expiryMs;
  return typeof expiryMs === "number" && expiryMs > 0 ? now - expiryMs : null;
}

// Two ways to name a store. `createState` is for writers and `init`: it
// brings the store into existence. `loadState` is for readers: it resolves
// the same paths and reads the same config, but creates nothing, so asking a
// question never leaves a directory behind.
function storeAt(directory) {
  return {
    directory,
    messages: join(directory, "messages"),
    associations: join(directory, "associations"),
    groups: join(directory, "groups.json"),
    subscriptions: join(directory, "subscriptions.json"),
    config: loadStoreConfig(directory),
  };
}

export function createState(root) {
  const directory = String(root);
  ensure(directory);
  ensure(join(directory, "messages"));
  return storeAt(directory);
}

export function loadState(root) {
  return storeAt(String(root));
}

const ASSOCIATION_HEADER_SCHEMA = "work-coordination.handoff_association_header.v1";
const ASSOCIATION_OBSERVATION_SCHEMA = "work-coordination.handoff_observation.v1";

export function associationId(record) {
  const source = record.handoffBinding.source;
  // The stable task/session/attempt tuple chooses one immutable header. The
  // task hash and edition stay in that header, so reusing the attempt after a
  // source change conflicts instead of silently creating a second identity.
  return identityHash(
    "handoff-association.v1",
    source.index,
    source.section,
    source.record,
    source.taskId,
    record.destination.surface,
    record.destination.sessionId,
    record.attempt.id,
  );
}

function associationHeaderPath(store, id) {
  return join(store.associations, "headers", `${id}.json`);
}

function associationObservationPath(store, observationId) {
  return join(store.associations, "observations", `${identityHash("handoff-observation.v1", observationId)}.json`);
}

function observationFiles(store) {
  try {
    return readdirSync(join(store.associations, "observations"), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function hasExactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && keys.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).length === keys.length
    && Object.keys(value).every((key) => keys.includes(key));
}

function invalidAssociation(errors) {
  const error = new TypeError(`invalid handoff association: ${errors.join("; ")}`);
  error.code = "INVALID_ASSOCIATION";
  error.details = { errors };
  return error;
}

function unknownAssociationRecord(path, reason) {
  return new StateUnknownError(`stored handoff association is invalid: ${reason}`, { path });
}

function readAssociationJsonRecord(path) {
  const snapshot = readJsonStateFile(path, null);
  if (snapshot.gaps.length) {
    throw new StateUnknownError(`stored handoff association is unreadable: ${snapshot.gaps[0].reason}`, {
      path,
      gaps: snapshot.gaps,
    });
  }
  return { present: snapshot.baseRaw !== null, value: snapshot.value };
}

function associationHeader(record, id = associationId(record)) {
  return {
    schema: ASSOCIATION_HEADER_SCHEMA,
    id,
    handoffBinding: record.handoffBinding,
    destination: record.destination,
    attempt: record.attempt,
  };
}

function observationRecord(association, observation, id = associationId(association)) {
  return {
    schema: ASSOCIATION_OBSERVATION_SCHEMA,
    associationId: id,
    id: observation.id,
    origin: observation.origin,
    observedAt: observation.observedAt,
    nativeKind: observation.nativeKind,
    nativeValue: observation.nativeValue,
  };
}

function validateStoredHeader(header, path) {
  if (!hasExactKeys(header, ["schema", "id", "handoffBinding", "destination", "attempt"])) {
    throw unknownAssociationRecord(path, "header fields do not match the schema");
  }
  if (header.schema !== ASSOCIATION_HEADER_SCHEMA || typeof header.id !== "string") {
    throw unknownAssociationRecord(path, "header schema or identity field is invalid");
  }
  const record = {
    contract: "work-coordination.handoff-association",
    schemaVersion: 1,
    handoffBinding: header.handoffBinding,
    destination: header.destination,
    attempt: header.attempt,
    observations: [],
  };
  const result = validateHandoffAssociation(record);
  if (!result.valid || associationId(record) !== header.id) {
    throw unknownAssociationRecord(path, result.errors.join("; ") || "header source identity does not match its key");
  }
  return record;
}

// Persist an optional association as one immutable source/session/attempt
// header and one immutable record per native observation. Replaying identical
// input is idempotent through writeJsonRecord; conflicting identity or
// observation reuse raises its visible STATE_CONFLICT.
export function recordHandoffAssociation(store, record) {
  const validation = validateHandoffAssociation(record);
  if (!validation.valid) throw invalidAssociation(validation.errors);

  const id = associationId(record);
  writeJsonRecord(associationHeaderPath(store, id), associationHeader(record, id));
  for (const observation of record.observations) {
    writeJsonRecord(
      associationObservationPath(store, observation.id),
      observationRecord(record, observation, id),
    );
  }
  return readHandoffAssociation(store, record);
}

// Read by the same task/session/attempt identity. Existing observations are
// returned as their original JSON values; their native kind and timestamp are
// never mapped into work-coordination status fields.
export function readHandoffAssociation(store, identity) {
  const validation = validateHandoffAssociation(identity);
  if (!validation.valid) throw invalidAssociation(validation.errors);

  const id = associationId(identity);
  const headerPath = associationHeaderPath(store, id);
  const headerRead = readAssociationJsonRecord(headerPath);
  if (!headerRead.present) return null;
  const storedHeader = headerRead.value;
  const record = validateStoredHeader(storedHeader, headerPath);
  const mismatchedFields = [
    ["handoffBinding", identity.handoffBinding, record.handoffBinding],
    ["destination", identity.destination, record.destination],
    ["attempt", identity.attempt, record.attempt],
  ]
    .filter(([, requested, stored]) => identityHash(requested) !== identityHash(stored))
    .map(([field]) => field);
  if (storedHeader.id !== id) mismatchedFields.push("identityKey");
  if (mismatchedFields.length) {
    throw new StateConflictError("stored handoff association conflicts with the requested binding or native attempt", {
      path: headerPath,
      requestedAssociationId: id,
      storedAssociationId: storedHeader.id,
      mismatchedFields,
    });
  }
  const observations = [];
  for (const entry of observationFiles(store)) {
    const path = join(store.associations, "observations", entry.name);
    const observationRead = readAssociationJsonRecord(path);
    if (!observationRead.present) continue;
    const stored = observationRead.value;
    if (!hasExactKeys(stored, ["schema", "associationId", "id", "origin", "observedAt", "nativeKind", "nativeValue"])) {
      throw unknownAssociationRecord(path, "observation fields do not match the schema");
    }
    if (stored.schema !== ASSOCIATION_OBSERVATION_SCHEMA
        || typeof stored.associationId !== "string"
        || typeof stored.id !== "string"
        || entry.name !== `${identityHash("handoff-observation.v1", stored.id)}.json`) {
      throw unknownAssociationRecord(path, "observation identity does not match its key");
    }
    if (stored.associationId !== id) continue;
    observations.push({
      id: stored.id,
      origin: stored.origin,
      observedAt: stored.observedAt,
      nativeKind: stored.nativeKind,
      nativeValue: stored.nativeValue,
    });
  }
  observations.sort((left, right) => left.id.localeCompare(right.id));
  record.observations = observations;
  const result = validateHandoffAssociation(record);
  if (!result.valid) throw unknownAssociationRecord(headerPath, result.errors.join("; "));
  return record;
}

// Explicit source/task selection includes historical attempts; it never
// guesses the current session or rewrites a stale header.
export function associationsForSource(store, binding) {
  let entries;
  const directory = join(store.associations, "headers");
  try { entries = readdirSync(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const records = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) throw unknownAssociationRecord(directory, "unknown header artifact");
    const path = join(directory, entry.name);
    const header = readAssociationJsonRecord(path);
    const identity = validateStoredHeader(header.value, path);
    if (entry.name !== `${associationId(identity)}.json`) throw unknownAssociationRecord(path, "header filename mismatch");
    const a = identity.handoffBinding.source, b = binding.source;
    if (["index", "section", "record", "taskId"].every((key) => a[key] === b[key])) records.push(readHandoffAssociation(store, identity));
  }
  return records;
}

function feedbackPath(store, identity, requestId, kind) {
  return join(store.associations, "feedback", `${identityHash("association-feedback.v1", associationId(identity), requestId)}.${kind}.json`);
}

export function readAssociationFeedback(store, identity, requestId) {
  const request = readAssociationJsonRecord(feedbackPath(store, identity, requestId, "request"));
  if (!request.present) return null;
  if (request.value?.schema !== "work-coordination.association-feedback.v1"
      || request.value.associationId !== associationId(identity) || request.value.requestId !== requestId) {
    throw unknownAssociationRecord(store.associations, "feedback identity mismatch");
  }
  const result = readAssociationJsonRecord(feedbackPath(store, identity, requestId, "result"));
  if (result.present && (result.value?.schema !== "work-coordination.association-delivery.v1"
      || result.value.requestId !== requestId || result.value.associationId !== associationId(identity))) {
    throw unknownAssociationRecord(store.associations, "feedback receipt identity mismatch");
  }
  const deliveryHistory = result.present ? [result.value.delivery] : [];
  const prefix = `${identityHash("association-feedback.v1", associationId(identity), requestId)}.receipt-`;
  for (const name of readdirSync(join(store.associations, "feedback")).filter((name) => name.startsWith(prefix)).sort()) {
    const receipt = readAssociationJsonRecord(join(store.associations, "feedback", name)).value;
    if (receipt?.schema !== "work-coordination.association-delivery.v1" || receipt.requestId !== requestId
        || receipt.associationId !== associationId(identity)) throw unknownAssociationRecord(store.associations, "returned feedback receipt identity mismatch");
    deliveryHistory.push(receipt.delivery);
  }
  const delivery = deliveryHistory.find((v) => v.status === "accepted") ?? deliveryHistory.at(-1)
    ?? { status: "ambiguous", reason: "request recorded; native admission acknowledgement absent" };
  return { request: request.value, delivery, deliveryHistory };
}

export function recordAssociationFeedback(store, identity, requestId, body, nativeRequestId) {
  // Immutable request identity is effect deduplication, never session custody.
  // A crashed dispatch remains ambiguous rather than being automatically rerun.
  return writeJsonRecord(feedbackPath(store, identity, requestId, "request"), {
    schema: "work-coordination.association-feedback.v1", associationId: associationId(identity),
    requestId, destination: identity.destination, body, nativeRequestId,
  });
}
export function recordReturnedAssociationDelivery(store, identity, requestId, delivery) {
  const base = feedbackPath(store, identity, requestId, "request").replace(/\.request\.json$/, "");
  writeJsonRecord(`${base}.receipt-${identityHash(delivery)}.json`, {
    schema: "work-coordination.association-delivery.v1", associationId: associationId(identity), requestId, delivery,
  });
  return readAssociationFeedback(store, identity, requestId);
}
export function recordAssociationDelivery(store, identity, requestId, delivery) {
  writeJsonRecord(feedbackPath(store, identity, requestId, "result"), {
    schema: "work-coordination.association-delivery.v1", associationId: associationId(identity), requestId, delivery,
  });
  return readAssociationFeedback(store, identity, requestId);
}
export function feedbackForAssociation(store, identity) {
  const directory = join(store.associations, "feedback");
  let entries;
  try { entries = readdirSync(directory); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const records = [];
  for (const name of entries.filter((name) => name.endsWith(".request.json")).sort()) {
    const value = readAssociationJsonRecord(join(directory, name)).value;
    if (value?.schema !== "work-coordination.association-feedback.v1") throw unknownAssociationRecord(directory, "malformed feedback request");
    if (value.associationId === associationId(identity)) records.push(readAssociationFeedback(store, identity, value.requestId));
  }
  return records;
}

// Three outcomes, and callers must tell them apart: a stored record, a refused
// address (null), and a refused body (false). A bodyless record carries
// nothing, renders as a blank line, and is stored by nobody.
export function sendMessage(store, input = {}, options = {}) {
  const groupRef = textField(input.groupRef);
  if (!oneLine(input.body)) return false;
  const persist = () => {
    const message = createMessage(input, options);
    writeJsonRecord(join(store.messages, `${identityHash("message", message.ref)}.json`), message);
    pruneExpiredMessages(store);
    return message;
  };
  if (!groupRef) return persist();
  if (!activeGroups(store, options).some((group) => group.id === groupRef)) return null;
  return persist();
}

// A store that was never created has no messages directory; reading it is an
// empty answer, not an error. Writers create the store before they get here.
function messageFiles(store) {
  try {
    return readdirSync(store.messages, { withFileTypes: true });
  } catch {
    return [];
  }
}

export function messagesMatching(store, field, value, cutoff = expiryCutoff(store)) {
  const needle = String(value ?? "");
  const kept = [];
  for (const entry of messageFiles(store)) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const message = readJson(join(store.messages, entry.name), null);
    if (!message) continue;
    if (cutoff !== null && Number(message.createdAt ?? 0) < cutoff) continue;
    if (message[field] === needle) kept.push(message);
  }
  return kept.sort((a, b) => a.createdAt - b.createdAt);
}

// Unfiltered scan for the expired-vs-missing distinction. Never prunes:
// the lookup that reports "expired" must not destroy its own evidence.
export function rawMessagesForWork(store, workRef) {
  return messagesMatching(store, "workRef", workRef, null);
}

// Stale message files are reclaimed when new messages arrive — per-file, so
// pruning can never disturb a concurrent writer. Backdated sends older than
// the window are dropped on arrival.
function pruneExpiredMessages(store) {
  const cutoff = expiryCutoff(store);
  if (cutoff === null) return;
  for (const entry of messageFiles(store)) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const path = join(store.messages, entry.name);
    const message = readJson(path, null);
    if (message && Number(message.createdAt ?? 0) < cutoff) {
      try {
        unlinkSync(path);
      } catch {}
    }
  }
}

export function messagesForWork(store, workRef) {
  return messagesMatching(store, "workRef", workRef);
}

export function messagesForGroup(store, groupRef) {
  return messagesMatching(store, "groupRef", groupRef);
}

function loadGroups(store) {
  const value = readJson(store.groups, []);
  return Array.isArray(value) ? value : [];
}

function memberDirectory(store) {
  return join(store.directory, "members");
}

function readMemberRecords(store) {
  const entries = [];
  try {
    for (const file of readdirSync(memberDirectory(store), { withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith(".json")) continue;
      try {
        const entry = JSON.parse(readFileSync(join(memberDirectory(store), file.name), "utf8"));
        if (entry?.schema === "work-coordination.group_member.v1" && typeof entry.group === "string" && typeof entry.member === "string") entries.push(entry);
      } catch {}
    }
  } catch {}
  // Read-only compatibility for stores created before membership records were
  // individual JSON state files. New writes never append to this legacy log.
  try {
    const legacy = readFileSync(join(store.directory, "members.jsonl"), "utf8");
    for (const line of legacy.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry && typeof entry.group === "string" && typeof entry.member === "string") entries.push(entry);
      } catch {}
    }
  } catch {}
  return entries;
}

function groupGeneration(group) {
  return String(group?.generation ?? identityHash("legacy-group", group?.id ?? "", group?.createdAt ?? 0, group?.expiresAt ?? 0, group?.name ?? null));
}

function memberRecordPath(store, group, member) {
  return join(memberDirectory(store), `${identityHash(group.id, groupGeneration(group), member)}.json`);
}

function memberEntriesFor(store, group) {
  return readMemberRecords(store).filter((entry) => entry.group === group?.id
    && (entry.generation === undefined
      ? Number(entry.at ?? 0) >= Number(group?.createdAt ?? 0)
      : entry.generation === groupGeneration(group)));
}

function unlinkRecord(path) {
  try { unlinkSync(path); } catch {}
}

function removeOrphanedMembers(store, liveGenerations) {
  try {
    for (const file of readdirSync(memberDirectory(store), { withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith(".json")) continue;
      const path = join(memberDirectory(store), file.name);
      let entry;
      try { entry = JSON.parse(readFileSync(path, "utf8")); } catch { continue; }
      if (!liveGenerations.has(`${entry?.group}\u0000${entry?.generation ?? ""}`)) unlinkRecord(path);
    }
  } catch {}
}

// Membership is append-only: one immutable JSON record per group generation
// and member. Repeated or overlapping joins do not replace another member.
function foldMembers(store, group) {
  const seen = new Set();
  const members = [];
  const push = (member) => {
    const value = String(member ?? "").trim();
    if (value && !seen.has(value)) {
      seen.add(value);
      members.push(value);
    }
  };
  for (const member of Array.isArray(group?.members) ? group.members : []) push(member);
  for (const entry of memberEntriesFor(store, group).sort((left, right) => Number(left.at ?? 0) - Number(right.at ?? 0)
    || String(left.member).localeCompare(String(right.member)))) push(entry.member);
  return members;
}

// Expiry removes groups/subscriptions from the current projection. Historical
// mutation records remain as the source of truth up to each journal's bounded
// capacity; orphaned member state is physically reclaimed by generation.
function pruneExpiredRecords(store, { now = Date.now() } = {}) {
  const cutoff = expiryCutoff(store, now);
  reviseJsonFile(store.groups, [], (value) => {
    const groups = Array.isArray(value) ? value : [];
    const live = groups.filter((group) => Number(group?.expiresAt ?? 0) > now
      && (cutoff === null || Number(group?.createdAt ?? 0) >= cutoff));
    return live.length === groups.length ? NO_WRITE : live;
  });
  reviseJsonFile(store.subscriptions, [], (value) => {
    const subscriptions = Array.isArray(value) ? value : [];
    if (cutoff === null) return NO_WRITE;
    const live = subscriptions.filter((subscription) => Number(subscription?.createdAt ?? 0) >= cutoff);
    return live.length === subscriptions.length ? NO_WRITE : live;
  });
  pruneOrphanedMembers(store);
}

// A member record whose exact group generation is gone can never be read.
// Reclaim it; a later group reusing its public id has a different generation.
function pruneOrphanedMembers(store) {
  const live = new Set((readJson(store.groups, []) ?? []).map((group) => `${group?.id}\u0000${groupGeneration(group)}`));
  removeOrphanedMembers(store, live);
}

export function createGroup(store, input = {}, { now = Date.now(), random = Math.random, ttlMs = 60 * 60 * 1000 } = {}) {
  const group = {
    id: textField(input.id) || id("g", random),
    generation: randomUUID(),
    name: textField(input.name) || null,
    members: [],
    createdAt: Number(now),
    expiresAt: Number(now) + Math.max(0, Number(ttlMs) || 0),
  };
  pruneExpiredRecords(store, { now });
  reviseJsonFile(store.groups, [], (value) => {
    const groups = Array.isArray(value) ? value : [];
    if (groups.some((existing) => existing?.id === group.id && activeGroup(existing, { now }))) {
      throw new StateConflictError("group identity already has an active revision", { entity: "group", id: group.id });
    }
    return [...groups, group];
  });
  return group;
}

// A join is refused for a group that is no longer addressable: missing, past
// its TTL, or past the retention window. Membership is an immutable JSON
// record keyed by group generation and session identity, so independent joins
// remain present and re-joining the same member writes no new record.
export function joinGroup(store, groupId, sessionRef, options = {}) {
  const current = groupState(store, groupId, options);
  if (current !== "active") return null;
  const record = loadGroups(store).find((group) => group.id === String(groupId ?? ""));
  if (!record) return null;
  const member = textField(sessionRef);
  const members = foldMembers(store, record);
  if (member && !members.includes(member)) writeJsonRecord(memberRecordPath(store, record, member), {
    schema: "work-coordination.group_member.v1",
    id: identityHash(record.id, groupGeneration(record), member),
    group: record.id,
    generation: groupGeneration(record),
    member,
    at: Number(options?.now ?? Date.now()),
  });
  return { ...record, members: foldMembers(store, record) };
}

export function removeGroup(store, groupId) {
  const id = String(groupId ?? "");
  let removed = false;
  // Deliberately no expiry sweep here: this removes exactly what it was asked
  // to remove. A sweep on the wall clock would also delete a group a caller
  // created against an injected clock, which is what this test seam is for.
  reviseJsonFile(store.groups, [], (value) => {
    const groups = Array.isArray(value) ? value : [];
    const retained = groups.filter((group) => group.id !== id);
    if (retained.length === groups.length) return NO_WRITE;
    removed = true;
    return retained;
  });
  if (!removed) return false;
  // Membership is tied to the removed generation; a late join from a stale
  // reader cannot attach to a later group that reuses the public id.
  pruneOrphanedMembers(store);
  return removed;
}

// One record's standing: active, expired (a live record cut by the
// retention window), or missing. The retention check comes first so an
// old group reads expired even past its TTL; with no window set,
// TTL-expired groups read as missing, exactly as before.
export function groupState(store, groupId, options = {}) {
  const record = loadGroups(store).find((group) => group.id === String(groupId ?? ""));
  if (!record) return "missing";
  const cutoff = expiryCutoff(store, Number(options?.now ?? Date.now()));
  if (cutoff !== null && Number(record.createdAt ?? 0) < cutoff) return "expired";
  if (!activeGroup(record, options)) return "missing";
  return "active";
}

export function subscriptionState(store, subscriptionId) {
  const raw = readJson(store.subscriptions, []);
  const list = Array.isArray(raw) ? raw : [];
  const record = list.find((subscription) => subscription?.id === String(subscriptionId ?? ""));
  if (!record) return "missing";
  const cutoff = expiryCutoff(store);
  if (cutoff !== null && Number(record.createdAt ?? 0) < cutoff) return "expired";
  return "active";
}

export function activeGroups(store, options = {}) {
  const cutoff = expiryCutoff(store, Number(options?.now ?? Date.now()));
  return loadGroups(store)
    .map((group) => activeGroup(group, options))
    .filter(Boolean)
    .filter((group) => cutoff === null || Number(group.createdAt ?? 0) >= cutoff)
    .map((group) => ({ ...group, members: foldMembers(store, group) }));
}

function loadSubscriptions(store) {
  const value = readJson(store.subscriptions, []);
  const list = Array.isArray(value) ? value : [];
  const cutoff = expiryCutoff(store);
  if (cutoff === null) return list;
  return list.filter((subscription) => Number(subscription?.createdAt ?? 0) >= cutoff);
}

export function subscribe(store, input = {}, { now = Date.now(), random = Math.random } = {}) {
  const sessionRef = textField(input.sessionRef);
  const { harness: targetHarness, sessionRef: targetSession } = destinationOf(input.target);
  if (!sessionRef || !targetHarness || !targetSession) return null;
  const workRef = textField(input.workRef);
  let result;
  pruneExpiredRecords(store, { now });
  reviseJsonFile(store.subscriptions, [], (value) => {
    const subscriptions = Array.isArray(value) ? value : [];
    const existing = subscriptions.find((value) => value.sessionRef === sessionRef && (value.workRef ?? null) === workRef && value.targetHarness === targetHarness && value.targetSession === targetSession);
    if (existing) {
      result = existing;
      return NO_WRITE;
    }
    const subscription = {
      id: textField(input.id) || id("s", random),
      sessionRef,
      workRef,
      targetHarness,
      targetSession,
      createdAt: Number(now),
    };
    result = subscription;
    return [...subscriptions, subscription];
  });
  return result;
}

export function unsubscribe(store, subscriptionId) {
  const id = String(subscriptionId ?? "");
  // Expired subscriptions are already gone: unsubscribing one reports
  // unavailable instead of reaching past the retention window.
  if (!loadSubscriptions(store).some((subscription) => subscription.id === id)) return false;
  let removed = false;
  reviseJsonFile(store.subscriptions, [], (value) => {
    const subscriptions = Array.isArray(value) ? value : [];
    const retained = subscriptions.filter((value) => value.id !== id);
    if (retained.length === subscriptions.length) return NO_WRITE;
    removed = true;
    return retained;
  });
  return removed;
}

export function listSubscriptions(store) {
  return loadSubscriptions(store);
}

const FANOUT_STATUSES = ["blocked", "done"];

// A fan-out must never turn one unreachable target into a wall the others
// wait behind: each delivery has its own idle timeout, and N of them run
// together instead of end to end. Results keep the order they were built in,
// so callers render a stable list.
export async function notifySubscribers(store, message = {}, { spawnFn, idleTimeoutMs, concurrency = 8, store: policyStore = null } = {}) {
  const status = String(message.status ?? "").trim().toLowerCase();
  const sessionRef = String(message.sessionRef ?? "").trim();
  if (!FANOUT_STATUSES.includes(status) || !sessionRef) return [];
  const rendered = renderMessage(message);
  const workRef = String(message.workRef ?? "").trim();
  const options = {};
  if (spawnFn !== undefined) options.spawnFn = spawnFn;
  if (idleTimeoutMs !== undefined) options.idleTimeoutMs = idleTimeoutMs;
  if (policyStore) options.store = policyStore;
  const pending = [];
  const notified = new Set();
  for (const value of loadSubscriptions(store)) {
    if (value.sessionRef !== sessionRef) continue;
    if (value.workRef && value.workRef !== workRef) continue;
    const target = `${value.targetHarness}:${value.targetSession}`;
    if (notified.has(target)) continue;
    notified.add(target);
    pending.push({ subscriptionId: value.id, target, harness: value.targetHarness, sessionRef: value.targetSession });
  }
  pruneOutbox(store);
  const results = await mapBounded(pending, concurrency, async (entry) => ({
    subscriptionId: entry.subscriptionId,
    target: entry.target,
    ...(await deliverMessage({ harness: entry.harness, sessionRef: entry.sessionRef, message: rendered }, options)),
  }));
  // A failure is remembered so `retry` can drain it later; a success clears
  // whatever was pending for that destination. Nothing waits here.
  for (const result of results) {
    const address = { messageRef: message.ref, target: result.target };
    if (result.delivered) clearFailure(store, address);
    else recordFailure(store, { ...address, message: rendered, workRef, warning: result.warning });
  }
  return results;
}
