import { appendFileSync, chmodSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { activeGroup, createMessage, destinationOf, oneLine, renderMessage, textField } from "./coordination.mjs";
import { NO_WRITE, replaceFile, replaceJsonFile, reviseJsonFile } from "./atomic-json.mjs";
import { deliverMessage, mapBounded } from "./delivery.mjs";

function ensure(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { chmodSync(directory, 0o700); } catch {}
}

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}

// Every replacement goes through the shared scratch helper: a temp file named
// only by process id is one two writers can share.
function writeJson(path, value) {
  replaceJsonFile(path, value);
}

let idCounter = 0;

// A record's file name is its id, so an id that repeats silently overwrites a
// record. The default source is a fresh Math.random float; a caller that
// injects its own source is a test seam whose short values must stay
// byte-identical, so only the default gains the uniqueness tail.
function id(prefix, random) {
  const suffix = String(random()).replace(/[^a-zA-Z0-9]/g, "").slice(0, 12) || "local";
  if (random !== Math.random) return `${prefix}_${suffix}`;
  idCounter = (idCounter + 1) % Number.MAX_SAFE_INTEGER;
  return `${prefix}_${suffix.slice(0, 8)}${Date.now().toString(36)}${idCounter.toString(36)}`;
}

export function loadStoreConfig(directory) {
  try {
    const raw = JSON.parse(readFileSync(join(String(directory), "config.json"), "utf8"));
    // decayMs is the pre-rename key; it still loads so early stores survive.
    const expiryMs = Number(raw?.expiryMs ?? raw?.decayMs);
    return { expiryMs: expiryMs > 0 ? expiryMs : null };
  } catch {
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

// Three outcomes, and callers must tell them apart: a stored record, a refused
// address (null), and a refused body (false). A bodyless record carries
// nothing, renders as a blank line, and is stored by nobody.
export function sendMessage(store, input = {}, options = {}) {
  const groupRef = textField(input.groupRef);
  if (!oneLine(input.body)) return false;
  const persist = () => {
    const message = createMessage(input, options);
    writeJson(join(store.messages, `${message.ref}.json`), message);
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

function messagesMatching(store, field, value, cutoff = expiryCutoff(store)) {
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

function memberLogPath(store) {
  return join(store.directory, "members.jsonl");
}

function readMemberLog(store) {
  let raw;
  try {
    raw = readFileSync(memberLogPath(store), "utf8");
  } catch {
    return [];
  }
  const entries = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry && typeof entry.group === "string" && typeof entry.member === "string") entries.push(entry);
    } catch {}
  }
  return entries;
}

// Membership is append-only: a join is one atomic append, never a
// read-modify-write, so concurrent joins cannot lose each other and nothing
// ever waits. Readers fold the log over the record's base members, which
// keeps legacy stores working — their members are simply the base.
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
  for (const entry of readMemberLog(store)) {
    if (entry.group === group?.id) push(entry.member);
  }
  return members;
}

// Dead records are reclaimed when a new one is written, exactly the way stale
// message files are reclaimed on arrival. Without this a store accumulated
// expired groups and subscriptions forever — hidden from every read, still on
// disk, and growing with each new record. Nothing a read can still see is
// removed, so the expiry wording ("group expired" for a record inside the
// retention window) is unaffected.
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
}

export function createGroup(store, input = {}, { now = Date.now(), random = Math.random, ttlMs = 60 * 60 * 1000 } = {}) {
  const group = {
    id: textField(input.id) || id("g", random),
    name: textField(input.name) || null,
    members: [],
    createdAt: Number(now),
    expiresAt: Number(now) + Math.max(0, Number(ttlMs) || 0),
  };
  pruneExpiredRecords(store, { now });
  reviseJsonFile(store.groups, [], (value) => {
    const groups = Array.isArray(value) ? value : [];
    return [...groups, group];
  });
  return group;
}

// A join is refused for a group that is no longer addressable: missing, past
// its TTL, or past the retention window. Membership is append-only and the
// append is one atomic write, never a read-modify-write, so concurrent joins
// cannot lose each other and nothing ever waits. Re-joining as a session that
// is already a member appends nothing — the folded member set is unchanged,
// so repeating a join must not grow the log.
export function joinGroup(store, groupId, sessionRef, options = {}) {
  const current = groupState(store, groupId, options);
  if (current !== "active") return null;
  const record = loadGroups(store).find((group) => group.id === String(groupId ?? ""));
  if (!record) return null;
  const member = textField(sessionRef);
  const members = foldMembers(store, record);
  if (member && !members.includes(member)) {
    appendFileSync(memberLogPath(store), `${JSON.stringify({ group: record.id, member, at: Number(options?.now ?? Date.now()) })}\n`, { mode: 0o600 });
  }
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
  // Prune the log so a later group reusing this id starts empty. A join
  // racing the prune may vanish from the log, but the record is gone either
  // way, so nothing visible changes.
  const kept = [];
  for (const entry of readMemberLog(store)) {
    if (entry.group !== id) kept.push(JSON.stringify(entry));
  }
  replaceFile(memberLogPath(store), kept.length ? `${kept.join("\n")}\n` : "");
  return removed;
}

// One record's standing: active, expired (a live record cut by the
// retention window), or missing. The retention check comes first so an
// old group reads expired even past its TTL; with no window set,
// TTL-expired groups read as missing, exactly as before.
export function groupState(store, groupId, options = {}) {
  const record = loadGroups(store).find((group) => group.id === String(groupId ?? ""));
  if (!record) return "missing";
  const cutoff = expiryCutoff(store);
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
  const cutoff = expiryCutoff(store);
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
export async function notifySubscribers(store, message = {}, { spawnFn, idleTimeoutMs, concurrency = 8 } = {}) {
  const status = String(message.status ?? "").trim().toLowerCase();
  const sessionRef = String(message.sessionRef ?? "").trim();
  if (!FANOUT_STATUSES.includes(status) || !sessionRef) return [];
  const rendered = renderMessage(message);
  const workRef = String(message.workRef ?? "").trim();
  const options = {};
  if (spawnFn !== undefined) options.spawnFn = spawnFn;
  if (idleTimeoutMs !== undefined) options.idleTimeoutMs = idleTimeoutMs;
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
  return mapBounded(pending, concurrency, async (entry) => ({
    subscriptionId: entry.subscriptionId,
    target: entry.target,
    ...(await deliverMessage({ harness: entry.harness, sessionRef: entry.sessionRef, message: rendered }, options)),
  }));
}
