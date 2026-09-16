import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { activeGroups, createGroup, createState, listSubscriptions, messagesForWork, saveStoreConfig, sendMessage, subscribe, unsubscribe } from "../src/state.mjs";
import { observeParticipation, observedSessions, workView } from "../src/work-index.mjs";

const DECAY = 900_000;
const OLD = Date.now() - 3_600_000;

function makeStore(t, decayMs) {
  const root = mkdtempSync(join(tmpdir(), "work-coordination-decay-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, ".work-coordination");
  createState(dir);
  if (decayMs !== undefined) saveStoreConfig(dir, { decayMs });
  return createState(dir);
}

function messageFiles(store) {
  return readdirSync(store.messages).filter((name) => name.endsWith(".json"));
}

test("decayed messages are invisible and pruned from disk", (t) => {
  const store = makeStore(t, DECAY);
  const stale = sendMessage(store, { workRef: "Ticket T-9", sessionRef: "s", body: "Old." }, { now: OLD });
  const fresh = sendMessage(store, { workRef: "Ticket T-9", sessionRef: "s", body: "New." });

  assert.deepEqual(messagesForWork(store, "Ticket T-9").map((message) => message.body), ["New."]);
  assert.equal(existsSync(join(store.messages, `${stale.ref}.json`)), false);
  assert.equal(existsSync(join(store.messages, `${fresh.ref}.json`)), true);
});

test("decayed observations vanish from sessions and work", (t) => {
  const store = makeStore(t, DECAY);
  observeParticipation(store, { workRef: "Ticket T-1", sessionRef: "gone", harness: "t" }, { now: OLD });
  observeParticipation(store, { workRef: "Ticket T-9", sessionRef: "here", harness: "t" });

  assert.deepEqual(observedSessions(store).map((session) => session.sessionRef), ["here"]);
  assert.equal(workView(store, "Ticket T-1"), null);
  assert.equal(workView(store, "Ticket T-9").participants.length, 1);
});

test("decayed subscriptions are skipped and re-subscribing starts fresh", (t) => {
  const store = makeStore(t, DECAY);
  const stale = subscribe(store, { sessionRef: "lane-1", target: "codex:x" }, { now: OLD, random: () => "old" });
  subscribe(store, { sessionRef: "lane-1", target: "codex:y" }, { random: () => "new" });

  assert.deepEqual(listSubscriptions(store).map((sub) => sub.id), ["s_new"]);
  assert.equal(unsubscribe(store, stale.id), false);
});

test("decayed groups stay hidden despite their TTL", (t) => {
  const store = makeStore(t, DECAY);
  // 30 minutes old: still inside the 1h group TTL, outside the 15m decay.
  createGroup(store, { name: "old" }, { now: Date.now() - 1_800_000 });
  createGroup(store, { name: "new" });

  assert.deepEqual(activeGroups(store).map((group) => group.name), ["new"]);
});

test("decay off keeps everything for audit", (t) => {
  const store = makeStore(t);
  sendMessage(store, { workRef: "Ticket T-9", sessionRef: "s", body: "Old." }, { now: OLD });
  observeParticipation(store, { workRef: "Ticket T-9", sessionRef: "s", harness: "t" }, { now: OLD });

  assert.equal(messagesForWork(store, "Ticket T-9").length, 1);
  assert.equal(observedSessions(store).length, 1);
});

test("init --decay-ms writes the store setting; plain init leaves it alone", (t) => {
  const root = mkdtempSync(join(tmpdir(), "work-coordination-decay-init-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const script = fileURLToPath(new URL("../bin/work-coordination.mjs", import.meta.url));

  const output = execFileSync(process.execPath, [script, "init", "--decay-ms", "900000"], { cwd: root, encoding: "utf8" });
  assert.match(output, /decay 900000ms/);
  assert.deepEqual(JSON.parse(readFileSync(join(root, ".work-coordination", "config.json"), "utf8")), { decayMs: 900000 });

  execFileSync(process.execPath, [script, "init"], { cwd: root, encoding: "utf8" });
  assert.deepEqual(JSON.parse(readFileSync(join(root, ".work-coordination", "config.json"), "utf8")), { decayMs: 900000 });
});
