import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../src/config.mjs";
import { buildServer } from "../src/server.mjs";

// This is the only committed coverage of the tool wiring itself: it builds
// the real server and drives it with a real client over an in-memory
// transport. The unit suite covers operations; this covers names, schemas,
// and the bare temp roots prove the tree-local state fallback (no home
// store is touched — the server auto-creates .work-coordination inside the
// declared root).

const EXPECTED_TOOLS = ["trees_list", "observe", "message", "sessions", "work", "groups", "group_create", "group_join", "group_messages", "subscribe", "unsubscribe", "subscriptions"];

async function linkedClient(t, trees) {
  const root = mkdtempSync(join(tmpdir(), "work-coordination-protocol-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const configPath = join(root, "config.json");
  writeFileSync(configPath, JSON.stringify({ trees }));
  const server = buildServer(loadConfig(configPath));
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

test("protocol exposes the twelve tools with the documented names", async (t) => {
  const tree = mkdtempSync(join(tmpdir(), "work-coordination-protocol-tree-"));
  t.after(() => rmSync(tree, { recursive: true, force: true }));
  const { client } = await linkedClient(t, [{ name: "open", root: tree }]);
  const listed = await client.listTools();

  assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [...EXPECTED_TOOLS].sort());
});

test("observe through unsubscribe round-trips over the protocol", async (t) => {
  const tree = mkdtempSync(join(tmpdir(), "work-coordination-protocol-tree-"));
  t.after(() => rmSync(tree, { recursive: true, force: true }));
  const { client } = await linkedClient(t, [
    { name: "open", root: tree },
    { name: "shut", root: join(tree, "shut"), visible: false },
  ]);

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
