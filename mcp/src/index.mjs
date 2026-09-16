#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "./config.mjs";
import { flag, runCli, treeNames } from "./runner.mjs";

const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"));
const configPath = process.env.WORK_COORDINATION_MCP_CONFIG ?? join(dirname(fileURLToPath(import.meta.url)), "..", "config.json");
const config = loadConfig(configPath);

const server = new McpServer({ name: "work-coordination", version: pkg.version });

const Tree = z.string().describe("Visible filetree to operate in (see trees_list). Never a path.");

function text(result) {
  return { content: [{ type: "text", text: result.output }] };
}

server.registerTool("trees_list", { description: "List filetrees this server may operate in.", inputSchema: {} }, async () => text({ output: treeNames(config).join("\n") || "no visible trees" }));

server.registerTool("observe", {
  description: "Declare a session's presence under typed work. Passive and advisory-only.",
  inputSchema: {
    tree: Tree,
    work: z.string().optional(),
    session: z.string().optional(),
    harness: z.string().optional(),
    directory: z.string().optional(),
  },
}, async ({ tree, work, session, harness, directory }) => {
  const argv = ["observe"];
  flag(flag(flag(flag(argv, "--work", work), "--session", session), "--harness", harness), "--directory", directory);
  return text(await runCli(config, tree, argv));
});

server.registerTool("message", {
  description: "Send an advisory message scoped to work. Optional progress status; blocked and done fan out to subscribers.",
  inputSchema: {
    tree: Tree,
    body: z.string(),
    work: z.string().optional(),
    from: z.string().optional(),
    session: z.string().optional(),
    group: z.string().optional(),
    status: z.enum(["started", "milestone", "blocked", "done"]).optional(),
    to: z.string().optional(),
    deliver: z.boolean().optional(),
    idle_timeout_ms: z.number().optional(),
  },
}, async ({ tree, body, work, from, session, group, status, to, deliver, idle_timeout_ms }) => {
  const argv = ["message", body];
  flag(flag(flag(flag(argv, "--work", work), "--from", from), "--session", session), "--group", group);
  flag(argv, "--status", status);
  if (to) { argv.push("--to", to); }
  if (deliver) { argv.push("--deliver"); }
  if (idle_timeout_ms !== undefined) { argv.push("--idle-timeout-ms", String(idle_timeout_ms)); }
  return text(await runCli(config, tree, argv));
});

server.registerTool("sessions", {
  description: "List observed sessions in one filetree.",
  inputSchema: { tree: Tree },
}, async ({ tree }) => text(await runCli(config, tree, ["sessions"])));

server.registerTool("work", {
  description: "Show one typed work with its participants and messages.",
  inputSchema: { tree: Tree, ref: z.string() },
}, async ({ tree, ref }) => text(await runCli(config, tree, ["work", ref])));

server.registerTool("groups", {
  description: "List active ephemeral groups in one filetree.",
  inputSchema: { tree: Tree },
}, async ({ tree }) => text(await runCli(config, tree, ["groups"])));

// group_create gives a lane a private coordination address with a delivery
// route the spawner can reach; it never routes through the spawner, so a
// thread ban on the spawner does not silence the lane.
server.registerTool("group_create", {
  description: "Create an ephemeral coordination group with an expiry.",
  inputSchema: {
    tree: Tree,
    name: z.string().optional(),
  },
}, async ({ tree, name }) => {
  const argv = ["group", "create"];
  if (name) argv.push(name);
  return text(await runCli(config, tree, argv));
});

server.registerTool("group_join", {
  description: "Join a session to an ephemeral group.",
  inputSchema: {
    tree: Tree,
    group: z.string(),
    session: z.string(),
  },
}, async ({ tree, group, session }) => text(await runCli(config, tree, ["group", "join", group, session])));

server.registerTool("group_messages", {
  description: "Read messages addressed to an ephemeral group.",
  inputSchema: {
    tree: Tree,
    group: z.string(),
  },
}, async ({ tree, group }) => text(await runCli(config, tree, ["group", "messages", group])));

server.registerTool("subscribe", {
  description: "Subscribe to a lane: blocked and done reports fan out to the target. Anyone may subscribe.",
  inputSchema: {
    tree: Tree,
    session: z.string(),
    work: z.string().optional(),
    to: z.string(),
  },
}, async ({ tree, session, work, to }) => {
  const argv = ["subscribe", "--session", session, "--to", to];
  if (work) argv.push("--work", work);
  return text(await runCli(config, tree, argv));
});

server.registerTool("unsubscribe", {
  description: "Remove a lane subscription.",
  inputSchema: {
    tree: Tree,
    id: z.string(),
  },
}, async ({ tree, id }) => text(await runCli(config, tree, ["unsubscribe", id])));

server.registerTool("subscriptions", {
  description: "List lane subscriptions in one filetree.",
  inputSchema: { tree: Tree },
}, async ({ tree }) => text(await runCli(config, tree, ["subscriptions"])));

await server.connect(new StdioServerTransport());
