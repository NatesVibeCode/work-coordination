import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig, missingTree, resolveConfigPath, resolveTree, visibleTrees } from "../src/config.mjs";
import { runOp, treeNames } from "../src/runner.mjs";

// loadConfig warns on stderr about a declared root that is gone; tests that
// declare one on purpose capture the warning instead of polluting output.
function quiet() {
  const warnings = [];
  return { warnings, warn: (message) => warnings.push(message) };
}

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

// Declared roots must exist: a tree whose root is gone is reported, not
// created, so every fixture makes its directories first.
function makeDirs(t) {
  const root = mkdtempSync(join(tmpdir(), "work-coordination-mcp-dirs-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function configFor(t, trees) {
  return loadConfig(writeConfig(t, { trees }), quiet());
}

test("invisible trees resolve to nothing and never leak names", (t) => {
  const dirs = makeDirs(t);
  const open = join(dirs, "open");
  const shut = join(dirs, "shut");
  const unlisted = join(dirs, "unlisted");
  for (const path of [open, shut, unlisted]) mkdirSync(path, { recursive: true });
  const config = configFor(t, [
    { name: "open", root: open, visible: true },
    { name: "shut", root: shut, visible: false },
    { name: "unlisted", root: unlisted },
  ]);

  assert.deepEqual(visibleTrees(config), ["open", "unlisted"]);
  assert.deepEqual(treeNames(config), ["open", "unlisted"]);
  assert.equal(resolveTree(config, "shut"), null);
  assert.equal(resolveTree(config, "missing"), null);
  assert.equal(resolveTree(config, "open").root, open);
});

test("relative roots resolve against the config file, not the process cwd", (t) => {
  const dirs = makeDirs(t);
  const first = join(dirs, "first");
  mkdirSync(join(first, "tree"), { recursive: true });
  const configPath = writeConfig(t, { trees: [{ name: "rel", root: "tree", visible: true }] });
  // writeConfig owns the config's directory; "tree" lives beside it.
  const configDir = dirname(configPath);
  mkdirSync(join(configDir, "tree"), { recursive: true });

  // Two configs with the same relative root, in different directories, must
  // resolve to their own tree — never to the cwd.
  const here = loadConfig(configPath, quiet());
  assert.equal(resolveTree(here, "rel").root, join(configDir, "tree"));
  const moved = mkdtempSync(join(tmpdir(), "work-coordination-mcp-cwd-"));
  t.after(() => rmSync(moved, { recursive: true, force: true }));
  const other = join(moved, "elsewhere");
  mkdirSync(other, { recursive: true });
  writeFileSync(join(moved, "config.json"), JSON.stringify({ trees: [{ name: "rel", root: "elsewhere", visible: true }] }));
  const there = loadConfig(join(moved, "config.json"), quiet());
  assert.equal(resolveTree(there, "rel").root, other);
  assert.notEqual(resolveTree(here, "rel").root, resolveTree(there, "rel").root);
});

test("a ~ root expands to the home directory", () => {
  const base = "/tmp/config-dir";
  assert.equal(resolveConfigPath(base, "~/trees/x"), join(homedir(), "trees/x"));
  assert.equal(resolveConfigPath(base, "~"), homedir());
  assert.equal(resolveConfigPath(base, "relative/tree"), join(base, "relative/tree"));
  assert.equal(resolveConfigPath(base, "/absolute/tree"), "/absolute/tree");
});

test("a declared root that is gone is reported, never created", (t) => {
  const dirs = makeDirs(t);
  const absent = join(dirs, "typoo");
  const log = quiet();
  const config = loadConfig(writeConfig(t, { trees: [{ name: "typo", root: absent }] }), log);

  assert.deepEqual(visibleTrees(config), []);
  assert.equal(missingTree(config, "typo").root, absent);
  assert.deepEqual(treeNames(config), [`typo · unavailable · root missing · ${absent}`]);
  assert.match(log.warnings.join("\n"), /root does not exist/);
  assert.equal(existsSync(absent), false);
});

test("a hidden tree with a missing root stays hidden", (t) => {
  const dirs = makeDirs(t);
  const absent = join(dirs, "gone");
  const log = quiet();
  const config = loadConfig(writeConfig(t, { trees: [{ name: "shut", root: absent, visible: false }] }), log);

  assert.deepEqual(treeNames(config), []);
  assert.equal(missingTree(config, "shut"), null);
  assert.deepEqual(log.warnings, []);
});

test("hidden and missing trees are rejected without running the operation", async (t) => {
  const dirs = makeDirs(t);
  const shut = join(dirs, "shut");
  mkdirSync(shut, { recursive: true });
  const config = configFor(t, [{ name: "shut", root: shut, visible: false }]);
  const calls = [];

  for (const name of ["shut", "nope"]) {
    assert.deepEqual(await runOp(config, name, (...args) => { calls.push(args); return "ran"; }), {
      ok: false,
      output: "tree unavailable",
    });
  }
  assert.deepEqual(calls, []);
});

test("addressing a missing root says why instead of pretending it is unlisted", async (t) => {
  const dirs = makeDirs(t);
  const absent = join(dirs, "typoo");
  const config = loadConfig(writeConfig(t, { trees: [{ name: "typo", root: absent }] }), quiet());
  const calls = [];

  const result = await runOp(config, "typo", (...args) => { calls.push(args); return "ran"; });
  assert.deepEqual(result, { ok: false, output: `unavailable · root missing · ${absent}` });
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
