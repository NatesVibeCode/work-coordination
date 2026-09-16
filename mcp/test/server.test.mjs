import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, resolveTree, visibleTrees } from "../src/config.mjs";
import { runOp, treeNames } from "../src/runner.mjs";

function writeConfig(t, value) {
  const root = mkdtempSync(join(tmpdir(), "work-coordination-mcp-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "config.json");
  writeFileSync(path, JSON.stringify(value));
  return path;
}

// A tree root with its own .work-coordination resolves locally, so tests
// never touch the home fallback.
function makeTree(t) {
  const root = mkdtempSync(join(tmpdir(), "work-coordination-tree-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".work-coordination"), { recursive: true });
  return root;
}

function configFor(t, trees) {
  return loadConfig(writeConfig(t, { trees }));
}

test("invisible trees resolve to nothing and never leak names", (t) => {
  const config = configFor(t, [
    { name: "open", root: "/tmp/open", visible: true },
    { name: "shut", root: "/tmp/shut", visible: false },
    { name: "unlisted", root: "/tmp/unlisted" },
  ]);

  assert.deepEqual(visibleTrees(config), ["open", "unlisted"]);
  assert.deepEqual(treeNames(config), ["open", "unlisted"]);
  assert.equal(resolveTree(config, "shut"), null);
  assert.equal(resolveTree(config, "missing"), null);
  assert.equal(resolveTree(config, "open").root, "/tmp/open");
});

test("hidden and missing trees are rejected without running the operation", async (t) => {
  const config = configFor(t, [{ name: "shut", root: "/tmp/shut", visible: false }]);
  const calls = [];

  for (const name of ["shut", "nope"]) {
    assert.deepEqual(await runOp(config, name, (...args) => { calls.push(args); return "ran"; }), {
      ok: false,
      output: "tree unavailable",
    });
  }
  assert.deepEqual(calls, []);
});

test("observe, message, sessions, and work run against the tree store", async (t) => {
  const { observe, sendAdvisory, listSessions, showWork } = await import("../../src/operations.mjs");
  const config = configFor(t, [{ name: "open", root: makeTree(t) }]);

  const seen = await runOp(config, "open", (store) => observe(store, { workRef: "Ticket T-9", sessionRef: "mcp:one", harness: "mcp", directory: "/tmp", worktree: null }));
  assert.deepEqual(seen, { ok: true, output: "mcp:one" });

  const sent = await runOp(config, "open", (store) => sendAdvisory(store, { body: "Hello.", workRef: "Ticket T-9", sessionRef: "mcp:one", status: "started" }));
  assert.equal(sent.ok, true);
  assert.match(sent.output, /Ticket T-9/);
  assert.match(sent.output, /status · started/);

  const sessions = await runOp(config, "open", (store) => listSessions(store));
  assert.deepEqual(sessions, { ok: true, output: "mcp:one · Ticket T-9" });

  const work = await runOp(config, "open", (store) => showWork(store, "Ticket T-9"));
  assert.equal(work.ok, true);
  assert.match(work.output, /participants · mcp:one/);
  assert.match(work.output, /Hello\./);
});

test("groups, subscriptions, and done fan-out report through the tree store", async (t) => {
  const { createGroupOp, joinGroupOp, groupMessagesOp, subscribeOp, listSubscriptionsOp, unsubscribeOp, sendAdvisory } = await import("../../src/operations.mjs");
  const config = configFor(t, [{ name: "open", root: makeTree(t) }]);

  const created = await runOp(config, "open", (store) => createGroupOp(store, "g"));
  assert.equal(created.ok, true);
  const gid = created.output.split(" ")[0];
  assert.match(gid, /^g_/);

  const joined = await runOp(config, "open", (store) => joinGroupOp(store, gid, "mcp:one"));
  assert.deepEqual(joined, { ok: true, output: `${gid} · mcp:one` });

  const empty = await runOp(config, "open", (store) => groupMessagesOp(store, gid));
  assert.deepEqual(empty, { ok: true, output: "no messages observed" });

  const sub = await runOp(config, "open", (store) => subscribeOp(store, { sessionRef: "mcp:one", target: "smoke:x" }));
  assert.equal(sub.ok, true);
  const sid = sub.output.split("·")[1].trim();

  const listed = await runOp(config, "open", (store) => listSubscriptionsOp(store));
  assert.deepEqual(listed, { ok: true, output: `${sid} · mcp:one → smoke:x` });

  const done = await runOp(config, "open", (store) => sendAdvisory(store, { body: "Done.", workRef: "Ticket T-9", sessionRef: "mcp:one", status: "done" }));
  assert.equal(done.ok, true);
  assert.match(done.output, /notified smoke:x · delivery unavailable/);

  const removed = await runOp(config, "open", (store) => unsubscribeOp(store, sid));
  assert.deepEqual(removed, { ok: true, output: "unsubscribed" });
});

test("messages to a missing group report unavailable without throwing", async (t) => {
  const { sendAdvisory } = await import("../../src/operations.mjs");
  const config = configFor(t, [{ name: "open", root: makeTree(t) }]);

  const result = await runOp(config, "open", (store) => sendAdvisory(store, { body: "Hello.", groupRef: "g_missing", sessionRef: "mcp:one" }));
  assert.deepEqual(result, { ok: true, output: "group unavailable" });
});

test("throwing operations report unavailable instead of throwing", async (t) => {
  const config = configFor(t, [{ name: "open", root: makeTree(t) }]);
  const result = await runOp(config, "open", () => { throw new Error("store gone"); });

  assert.equal(result.ok, false);
  assert.match(result.output, /unavailable/);
});
