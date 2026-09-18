import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

// This is the only committed coverage of the tool wiring itself: it builds
// the real server and drives it with a real client over an in-memory
// transport. The unit suite covers operations; this covers names, schemas,
// and the bare temp roots prove the tree-local state fallback (no home
// store is touched — the server creates .work-coordination inside the
// declared root).
//
// The SDK is a dependency of mcp/, and mcp/node_modules is not committed, so
// a fresh clone has no MCP SDK. Rather than failing the whole root suite on a
// machine that has not run `cd mcp && npm install`, this file reports itself
// as skipped, with the reason and the command to fix it.

const require = createRequire(import.meta.url);
const MISSING =
  "mcp/node_modules is absent — run `cd mcp && npm install` to run the MCP protocol suite";

function sdkMissing() {
  try {
    require.resolve("@modelcontextprotocol/sdk/client/index.js");
    return false;
  } catch {
    return true;
  }
}

// Loaded lazily: importing these pulls in the SDK.
async function loadWiring() {
  const { loadConfig } = await import("../src/config.mjs");
  const { buildServer } = await import("../src/server.mjs");
  return { loadConfig, buildServer };
}

const EXPECTED_TOOLS = ["trees_list", "observe", "message", "sessions", "work", "groups", "group_create", "group_join", "group_messages", "ungroup", "subscribe", "unsubscribe", "subscriptions", "policy", "roadmap", "pending", "retry"];

async function linkedClient(t, trees, buildServer, loadConfig) {
  const root = mkdtempSync(join(tmpdir(), "work-coordination-protocol-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const configPath = join(root, "config.json");
  writeFileSync(configPath, JSON.stringify({ trees }));
  const server = buildServer(loadConfig(configPath));
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "protocol-test", version: "0" });
  t.after(() => Promise.allSettled([client.close(), server.close()]));
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, root };
}

function text(result) {
  return result.content[0].text;
}

async function call(client, name, args) {
  return text(await client.callTool({ name, arguments: args }));
}

test("protocol exposes the sixteen tools with the documented names", async (t) => {
  if (sdkMissing()) return t.skip(MISSING);
  const { loadConfig, buildServer } = await loadWiring();
  const tree = mkdtempSync(join(tmpdir(), "work-coordination-protocol-tree-"));
  t.after(() => rmSync(tree, { recursive: true, force: true }));
  const { client } = await linkedClient(t, [{ name: "open", root: tree }], buildServer, loadConfig);
  const listed = await client.listTools();

  assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [...EXPECTED_TOOLS].sort());
});

test("observe through unsubscribe round-trips over the protocol", async (t) => {
  if (sdkMissing()) return t.skip(MISSING);
  const { loadConfig, buildServer } = await loadWiring();
  const tree = mkdtempSync(join(tmpdir(), "work-coordination-protocol-tree-"));
  t.after(() => rmSync(tree, { recursive: true, force: true }));
  const { client } = await linkedClient(t, [
    { name: "open", root: tree },
    { name: "shut", root: join(tree, "shut"), visible: false },
  ], buildServer, loadConfig);

  assert.equal(await call(client, "trees_list", {}), "open");
  assert.equal(await call(client, "observe", { tree: "open", work: "Ticket T-9", session: "mcp:one", harness: "mcp" }), "mcp:one");
  const sent = await call(client, "message", { tree: "open", body: "Hello.", work: "Ticket T-9", session: "mcp:one", status: "started" });
  assert.match(sent, /status · started/);
  assert.match(await call(client, "work", { tree: "open", ref: "Ticket T-9" }), /participants · mcp:one/);

  const created = await call(client, "group_create", { tree: "open", name: "g" });
  const gid = created.split(" ")[0];
  assert.deepEqual(await call(client, "group_join", { tree: "open", group: gid, session: "mcp:one" }), `${gid} · mcp:one`);

  const sub = await call(client, "subscribe", { tree: "open", session: "mcp:one", to: "smoke:x" });
  const sid = sub.split("·")[1].trim();
  const done = await call(client, "message", { tree: "open", body: "Done.", work: "Ticket T-9", session: "mcp:one", status: "done" });
  assert.match(done, /notified smoke:x · delivery unavailable/);
  assert.equal(await call(client, "unsubscribe", { tree: "open", id: sid }), "unsubscribed");

  assert.equal(await call(client, "message", { tree: "shut", body: "Nope." }), "tree unavailable");

  // Bare declared root: the server created state inside it, not at home.
  assert.equal(existsSync(join(tree, ".work-coordination")), true);
});

test("ungroup ends a group and roadmap degrades without a roadmap database", async (t) => {
  if (sdkMissing()) return t.skip(MISSING);
  const { loadConfig, buildServer } = await loadWiring();
  const tree = mkdtempSync(join(tmpdir(), "work-coordination-protocol-tree-"));
  t.after(() => rmSync(tree, { recursive: true, force: true }));
  const { client } = await linkedClient(t, [{ name: "open", root: tree }], buildServer, loadConfig);

  const created = await call(client, "group_create", { tree: "open", name: "temp" });
  const gid = created.split(" ")[0];
  assert.equal(await call(client, "ungroup", { tree: "open", group: gid }), "group removed");
  assert.equal(await call(client, "ungroup", { tree: "open", group: gid }), "group unavailable");

  // Roadmap is optional infrastructure: absent, it says so instead of throwing.
  const view = await call(client, "roadmap", { tree: "open", ref: "roadmap.example.key" });
  assert.match(view, /roadmap item unavailable|roadmap unavailable/);

  // The delivery queue is reachable over the protocol too: a client that
  // causes a pending delivery must be able to see and drain it.
  assert.equal(await call(client, "pending", { tree: "open" }), "no pending deliveries");
  assert.equal(await call(client, "retry", { tree: "open" }), "no pending deliveries");
});

test("a declared root that does not exist is reported, never created", async (t) => {
  if (sdkMissing()) return t.skip(MISSING);
  const { loadConfig, buildServer } = await loadWiring();
  const root = mkdtempSync(join(tmpdir(), "work-coordination-protocol-missing-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const absent = join(root, "typoo");
  const { client } = await linkedClient(t, [{ name: "typo", root: absent }], buildServer, loadConfig);

  assert.match(await call(client, "trees_list", {}), /typo · unavailable · root missing/);
  assert.match(await call(client, "sessions", { tree: "typo" }), /root missing/);
  assert.equal(existsSync(absent), false);
});
