import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { activeGroups, createGroup, createState, listSubscriptions, messagesForWork, saveStoreConfig, sendMessage, subscribe, unsubscribe } from "../src/state.mjs";
import { observeParticipation, observedSessions, workView } from "../src/work-index.mjs";
import { groupMessagesOp, joinGroupOp, sendAdvisory, showWork, unsubscribeOp } from "../src/operations.mjs";

const EXPIRY = 900_000;
const OLD = Date.now() - 3_600_000;

function makeStore(t, expiryMs) {
  const root = mkdtempSync(join(tmpdir(), "work-coordination-expiry-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, ".work-coordination");
  createState(dir);
  if (expiryMs !== undefined) saveStoreConfig(dir, { expiryMs });
  return createState(dir);
}

function messageFiles(store) {
  return readdirSync(store.messages).filter((name) => name.endsWith(".json"));
}

test("expired messages are invisible and pruned from disk", (t) => {
  const store = makeStore(t, EXPIRY);
  const stale = sendMessage(store, { workRef: "Ticket T-9", sessionRef: "s", body: "Old." }, { now: OLD });
  const fresh = sendMessage(store, { workRef: "Ticket T-9", sessionRef: "s", body: "New." });

  assert.deepEqual(messagesForWork(store, "Ticket T-9").map((message) => message.body), ["New."]);
  assert.equal(existsSync(join(store.messages, `${stale.ref}.json`)), false);
  assert.equal(existsSync(join(store.messages, `${fresh.ref}.json`)), true);
});

test("expired observations vanish from sessions and work", (t) => {
  const store = makeStore(t, EXPIRY);
  observeParticipation(store, { workRef: "Ticket T-1", sessionRef: "gone", harness: "t" }, { now: OLD });
  observeParticipation(store, { workRef: "Ticket T-9", sessionRef: "here", harness: "t" });

  assert.deepEqual(observedSessions(store).map((session) => session.sessionRef), ["here"]);
  assert.equal(workView(store, "Ticket T-1"), null);
  assert.equal(workView(store, "Ticket T-9").participants.length, 1);
});

test("expired subscriptions are skipped and re-subscribing starts fresh", (t) => {
  const store = makeStore(t, EXPIRY);
  const stale = subscribe(store, { sessionRef: "lane-1", target: "codex:x" }, { now: OLD, random: () => "old" });
  subscribe(store, { sessionRef: "lane-1", target: "codex:y" }, { random: () => "new" });

  assert.deepEqual(listSubscriptions(store).map((sub) => sub.id), ["s_new"]);
  assert.equal(unsubscribe(store, stale.id), false);
});

test("expired groups stay hidden despite their TTL", (t) => {
  const store = makeStore(t, EXPIRY);
  // 30 minutes old: still inside the 1h group TTL, outside the 15m window.
  createGroup(store, { name: "old" }, { now: Date.now() - 1_800_000 });
  createGroup(store, { name: "new" });

  assert.deepEqual(activeGroups(store).map((group) => group.name), ["new"]);
});

test("expiry off keeps everything for audit", (t) => {
  const store = makeStore(t);
  sendMessage(store, { workRef: "Ticket T-9", sessionRef: "s", body: "Old." }, { now: OLD });
  observeParticipation(store, { workRef: "Ticket T-9", sessionRef: "s", harness: "t" }, { now: OLD });

  assert.equal(messagesForWork(store, "Ticket T-9").length, 1);
  assert.equal(observedSessions(store).length, 1);
});

test("addressing a expired record says expired; a missing one says unavailable", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "work-coordination-expiry-words-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, ".work-coordination");
  let store = createState(dir);
  // Accumulate while expiry is off, then enable it: stale files predate the
  // window without any send pruning them first.
  sendMessage(store, { workRef: "Ticket T-old", sessionRef: "s", body: "Old." }, { now: OLD });
  const group = createGroup(store, { name: "g" }, { now: Date.now() - 1_800_000 });
  const sub = subscribe(store, { sessionRef: "lane-1", target: "codex:x" }, { now: OLD, random: () => "s" });
  saveStoreConfig(dir, { expiryMs: EXPIRY });
  store = createState(dir);

  assert.equal(showWork(store, "Ticket T-old"), "work expired");
  assert.equal(showWork(store, "Ticket T-missing"), "no work context observed");
  assert.equal(joinGroupOp(store, group.id, "s"), "group expired");
  assert.equal(joinGroupOp(store, "g_missing", "s"), "group unavailable");
  assert.equal(groupMessagesOp(store, group.id), "group expired");
  assert.equal(groupMessagesOp(store, "g_missing"), "no messages observed");
  assert.equal(await sendAdvisory(store, { body: "Hi.", groupRef: group.id, sessionRef: "s" }), "group expired");
  assert.equal(unsubscribeOp(store, sub.id), "subscription expired");
  assert.equal(unsubscribeOp(store, "s_missing"), "subscription unavailable");

  // New activity revives a expired work with just the fresh record.
  await sendAdvisory(store, { body: "Back.", workRef: "Ticket T-old", sessionRef: "s" });
  assert.match(showWork(store, "Ticket T-old"), /Back\./);
});

test("observations-only expired work says expired", (t) => {
  const store = makeStore(t, EXPIRY);
  observeParticipation(store, { workRef: "Ticket T-1", sessionRef: "gone", harness: "t" }, { now: OLD });

  assert.equal(showWork(store, "Ticket T-1"), "work expired");
});

test("the pre-rename decayMs key still loads", (t) => {
  const root = mkdtempSync(join(tmpdir(), "work-coordination-expiry-legacy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, ".work-coordination");
  createState(dir);
  writeFileSync(join(dir, "config.json"), JSON.stringify({ decayMs: EXPIRY }));
  const store = createState(dir);

  observeParticipation(store, { workRef: "Ticket T-9", sessionRef: "s", harness: "t" }, { now: OLD });
  assert.deepEqual(observedSessions(store), []);
});

test("init --expiry-ms writes the store setting; plain init leaves it alone", (t) => {
  const root = mkdtempSync(join(tmpdir(), "work-coordination-expiry-init-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const script = fileURLToPath(new URL("../bin/work-coordination.mjs", import.meta.url));

  const output = execFileSync(process.execPath, [script, "init", "--expiry-ms", "900000"], { cwd: root, encoding: "utf8" });
  assert.match(output, /expiry 900000ms/);
  assert.deepEqual(JSON.parse(readFileSync(join(root, ".work-coordination", "config.json"), "utf8")), { expiryMs: 900000 });

  execFileSync(process.execPath, [script, "init"], { cwd: root, encoding: "utf8" });
  assert.deepEqual(JSON.parse(readFileSync(join(root, ".work-coordination", "config.json"), "utf8")), { expiryMs: 900000 });
});
