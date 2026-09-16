import { chmodSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addGroupMember, activeGroup, createMessage } from "./coordination.mjs";
import { withLocalLock } from "./locking.mjs";

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

export function createState(root) {
  const directory = String(root);
  const messages = join(directory, "messages");
  ensure(directory);
  ensure(messages);
  return { directory, messages, groups: join(directory, "groups.json") };
}

export function sendMessage(store, input = {}, options = {}) {
  const persist = () => {
    const message = createMessage(input, options);
    writeJson(join(store.messages, `${message.ref}.json`), message);
    return message;
  };
  const groupRef = String(input.groupRef ?? "").trim();
  if (!groupRef) return persist();
  return withLocalLock(store.directory, "groups", () => {
    if (!activeGroups(store, options).some((group) => group.id === groupRef)) return null;
    return persist();
  });
}

function messagesMatching(store, field, value) {
  const needle = String(value ?? "");
  return readdirSync(store.messages, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => readJson(join(store.messages, entry.name), null))
    .filter((message) => message?.[field] === needle)
    .sort((a, b) => a.createdAt - b.createdAt);
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

function saveGroups(store, groups) {
  writeJson(store.groups, groups);
}

export function createGroup(store, input = {}, { now = Date.now(), random = Math.random, ttlMs = 60 * 60 * 1000 } = {}) {
  const group = {
    id: String(input.id ?? "").trim() || id("g", random),
    name: String(input.name ?? "").trim() || null,
    members: [],
    createdAt: Number(now),
    expiresAt: Number(now) + Math.max(0, Number(ttlMs) || 0),
  };
  return withLocalLock(store.directory, "groups", () => {
    saveGroups(store, [...loadGroups(store), group]);
    return group;
  });
}

export function joinGroup(store, groupId, sessionRef, options = {}) {
  return withLocalLock(store.directory, "groups", () => {
    const groups = loadGroups(store);
    const index = groups.findIndex((group) => group.id === String(groupId ?? ""));
    if (index < 0) return null;
    if (!String(sessionRef ?? "").trim()) return groups[index];
    const updated = addGroupMember(groups[index], sessionRef, options);
    groups[index] = updated;
    saveGroups(store, groups);
    return updated;
  });
}

export function removeGroup(store, groupId) {
  return withLocalLock(store.directory, "groups", () => {
    const groups = loadGroups(store);
    const retained = groups.filter((group) => group.id !== String(groupId ?? ""));
    if (retained.length === groups.length) return false;
    saveGroups(store, retained);
    return true;
  });
}

export function activeGroups(store, options = {}) {
  return loadGroups(store).map((group) => activeGroup(group, options)).filter(Boolean);
}
