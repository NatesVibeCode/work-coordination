import { appendFileSync, chmodSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { activeGroup, createMessage, renderMessage } from "./coordination.mjs";
import { NO_WRITE, reviseJsonFile } from "./atomic-json.mjs";
import { deliverMessage } from "./delivery.mjs";

function ensure(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { chmodSync(directory, 0o700); } catch {}
}

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}

function writeJson(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function id(prefix, random) {
  const suffix = String(random()).replace(/[^a-zA-Z0-9]/g, "").slice(0, 12) || "local";
  return `${prefix}_${suffix}`;
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

export function createState(root) {
  const directory = String(root);
  const messages = join(directory, "messages");
  ensure(directory);
  ensure(messages);
  return { directory, messages, groups: join(directory, "groups.json"), subscriptions: join(directory, "subscriptions.json"), config: loadStoreConfig(directory) };
}

export function sendMessage(store, input = {}, options = {}) {
  const persist = () => {
    const message = createMessage(input, options);
    writeJson(join(store.messages, `${message.ref}.json`), message);
    pruneExpiredMessages(store);
    return message;
  };
  const groupRef = String(input.groupRef ?? "").trim();
  if (!groupRef) return persist();
  if (!activeGroups(store, options).some((group) => group.id === groupRef)) return null;
  return persist();
}

function messagesMatching(store, field, value, cutoff = expiryCutoff(store)) {
  const needle = String(value ?? "");
  const kept = [];
  for (const entry of readdirSync(store.messages, { withFileTypes: true })) {
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
  for (const entry of readdirSync(store.messages, { withFileTypes: true })) {
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

export function createGroup(store, input = {}, { now = Date.now(), random = Math.random, ttlMs = 60 * 60 * 1000 } = {}) {
  const group = {
    id: String(input.id ?? "").trim() || id("g", random),
    name: String(input.name ?? "").trim() || null,
    members: [],
    createdAt: Number(now),
    expiresAt: Number(now) + Math.max(0, Number(ttlMs) || 0),
  };
  reviseJsonFile(store.groups, [], (value) => {
    const groups = Array.isArray(value) ? value : [];
    return [...groups, group];
  });
  return group;
}

export function joinGroup(store, groupId, sessionRef, options = {}) {
  const record = loadGroups(store).find((group) => group.id === String(groupId ?? ""));
  if (!record) return null;
  const member = String(sessionRef ?? "").trim();
  if (member) {
    appendFileSync(memberLogPath(store), `${JSON.stringify({ group: record.id, member, at: Number(options?.now ?? Date.now()) })}\n`, { mode: 0o600 });
  }
  return { ...record, members: foldMembers(store, record) };
}

export function removeGroup(store, groupId) {
  const id = String(groupId ?? "");
  let removed = false;
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
  const path = memberLogPath(store);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, kept.length ? `${kept.join("\n")}\n` : "", { mode: 0o600 });
  renameSync(temporary, path);
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
  const sessionRef = String(input.sessionRef ?? "").trim() || null;
  const target = String(input.target ?? "").trim();
  const [harness, ...rest] = target.split(":");
  const targetHarness = harness.trim().toLowerCase() || null;
  const targetSession = rest.join(":").trim() || null;
  if (!sessionRef || !targetHarness || !targetSession) return null;
  const workRef = String(input.workRef ?? "").trim() || null;
  let result;
  reviseJsonFile(store.subscriptions, [], (value) => {
    const subscriptions = Array.isArray(value) ? value : [];
    const existing = subscriptions.find((value) => value.sessionRef === sessionRef && (value.workRef ?? null) === workRef && value.targetHarness === targetHarness && value.targetSession === targetSession);
    if (existing) {
      result = existing;
      return NO_WRITE;
    }
    const subscription = {
      id: String(input.id ?? "").trim() || id("s", random),
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

export async function notifySubscribers(store, message = {}, { spawnFn, idleTimeoutMs } = {}) {
  const status = String(message.status ?? "").trim().toLowerCase();
  const sessionRef = String(message.sessionRef ?? "").trim();
  if (!FANOUT_STATUSES.includes(status) || !sessionRef) return [];
  const rendered = renderMessage(message);
  const workRef = String(message.workRef ?? "").trim();
  const options = {};
  if (spawnFn !== undefined) options.spawnFn = spawnFn;
  if (idleTimeoutMs !== undefined) options.idleTimeoutMs = idleTimeoutMs;
  const results = [];
  const notified = new Set();
  for (const value of loadSubscriptions(store)) {
    if (value.sessionRef !== sessionRef) continue;
    if (value.workRef && value.workRef !== workRef) continue;
    const target = `${value.targetHarness}:${value.targetSession}`;
    if (notified.has(target)) continue;
    notified.add(target);
    const result = await deliverMessage({ harness: value.targetHarness, sessionRef: value.targetSession, message: rendered }, options);
    results.push({ subscriptionId: value.id, target, ...result });
  }
  return results;
}
