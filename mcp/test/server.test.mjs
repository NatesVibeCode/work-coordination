import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, resolveTree, visibleTrees } from "../src/config.mjs";
import { flag, runCli } from "../src/runner.mjs";

function writeConfig(t, value) {
  const root = mkdtempSync(join(tmpdir(), "work-coordination-mcp-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "config.json");
  writeFileSync(path, JSON.stringify(value));
  return path;
}

test("invisible trees resolve to nothing and never leak names", (t) => {
  const config = loadConfig(writeConfig(t, {
    cliPath: "work-coordination",
    trees: [
      { name: "open", root: "/tmp/open", visible: true },
      { name: "shut", root: "/tmp/shut", visible: false },
      { name: "unlisted", root: "/tmp/unlisted" },
    ],
  }));

  assert.deepEqual(visibleTrees(config), ["open", "unlisted"]);
  assert.equal(resolveTree(config, "shut"), null);
  assert.equal(resolveTree(config, "missing"), null);
  assert.equal(resolveTree(config, "open").root, "/tmp/open");
});

test("hidden and missing trees are rejected without spawning anything", async (t) => {
  const config = loadConfig(writeConfig(t, {
    trees: [{ name: "shut", root: "/tmp/shut", visible: false }],
  }));
  const calls = [];

  assert.deepEqual(await runCli(config, "shut", ["sessions"], { execFn: (...args) => { calls.push(args); } }), {
    ok: false,
    output: "tree unavailable",
  });
  assert.deepEqual(await runCli(config, "nope", ["sessions"], { execFn: (...args) => { calls.push(args); } }), {
    ok: false,
    output: "tree unavailable",
  });
  assert.deepEqual(calls, []);
});

test("visible trees run the CLI in their own root", async (t) => {
  const config = loadConfig(writeConfig(t, {
    cliPath: "wc",
    timeoutMs: 5_000,
    trees: [{ name: "open", root: "/tmp/open" }],
  }));
  const calls = [];
  const result = await runCli(config, "open", ["sessions"], {
    execFn: async (...args) => { calls.push(args); return { stdout: "no sessions observed\n" }; },
  });

  assert.deepEqual(calls, [["wc", ["sessions"], { cwd: "/tmp/open", timeout: 5_000 }]]);
  assert.deepEqual(result, { ok: true, output: "no sessions observed" });
});

test("transport failures report unavailable instead of throwing", async (t) => {
  const config = loadConfig(writeConfig(t, { trees: [{ name: "open", root: "/tmp/open" }] }));
  const failure = new Error("spawn ENOENT");
  failure.stderr = "";
  const result = await runCli(config, "open", ["sessions"], {
    execFn: async () => { throw failure; },
  });

  assert.equal(result.ok, false);
  assert.match(result.output, /unavailable/);
});

test("flag helper skips absent values", () => {
  assert.deepEqual(flag(flag(["message", "hi"], "--work", undefined), "--status", null), ["message", "hi"]);
  assert.deepEqual(flag([], "--work", "Ticket T-123"), ["--work", "Ticket T-123"]);
});
