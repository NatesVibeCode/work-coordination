#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  createGroupOp,
  gitToplevel,
  groupMessagesOp,
  joinGroupOp,
  listGroups,
  listSessions,
  listSubscriptionsOp,
  observe as observeOp,
  sendAdvisory,
  showWork,
  subscribeOp,
  unsubscribeOp,
} from "../../src/operations.mjs";
import { runOp, treeNames } from "./runner.mjs";

export function buildServer(config) {
const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
const server = new McpServer({ name: "work-coordination", version: pkg.version });

const Tree = z.string().describe("Visible filetree to operate in (see trees_list). Never a path.");

function text(result) {
  return { content: [{ type: "text", text: result.output }] };
}

function run(tree, operation) {
  return runOp(config, tree, operation);
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
}, async ({ tree, work, session, harness, directory }) => text(await run(tree, (store, resolved) => observeOp(store, {
  workRef: work,
  sessionRef: session,
  harness,
  directory: directory ?? resolved.root,
  worktree: gitToplevel(resolved.root),
}))));

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
}, async ({ tree, body, work, from, session, group, status, to, deliver, idle_timeout_ms }) => text(await run(tree, (store) => sendAdvisory(store, {
  body,
  workRef: work,
  sender: from,
  sessionRef: session,
  groupRef: group,
  status,
  deliver,
  target: to,
  idleTimeoutMs: idle_timeout_ms,
}))));

server.registerTool("sessions", {
  description: "List observed sessions in one filetree.",
  inputSchema: { tree: Tree },
}, async ({ tree }) => text(await run(tree, (store) => listSessions(store))));

server.registerTool("work", {
  description: "Show one typed work with its participants and messages.",
  inputSchema: { tree: Tree, ref: z.string() },
}, async ({ tree, ref }) => text(await run(tree, (store) => showWork(store, ref))));

server.registerTool("groups", {
  description: "List active ephemeral groups in one filetree.",
  inputSchema: { tree: Tree },
}, async ({ tree }) => text(await run(tree, (store) => listGroups(store))));

// group_create gives a lane a private coordination address with a delivery
// route the spawner can reach; it never routes through the spawner, so a
// thread ban on the spawner does not silence the lane.
server.registerTool("group_create", {
  description: "Create an ephemeral coordination group with an expiry.",
  inputSchema: {
    tree: Tree,
    name: z.string().optional(),
  },
}, async ({ tree, name }) => text(await run(tree, (store) => createGroupOp(store, name))));

server.registerTool("group_join", {
  description: "Join a session to an ephemeral group.",
  inputSchema: {
    tree: Tree,
    group: z.string(),
    session: z.string(),
  },
}, async ({ tree, group, session }) => text(await run(tree, (store) => joinGroupOp(store, group, session))));

server.registerTool("group_messages", {
  description: "Read messages addressed to an ephemeral group.",
  inputSchema: {
    tree: Tree,
    group: z.string(),
  },
}, async ({ tree, group }) => text(await run(tree, (store) => groupMessagesOp(store, group))));

server.registerTool("subscribe", {
  description: "Subscribe to a lane: blocked and done reports fan out to the target. Anyone may subscribe.",
  inputSchema: {
    tree: Tree,
    session: z.string(),
    work: z.string().optional(),
    to: z.string(),
  },
}, async ({ tree, session, work, to }) => text(await run(tree, (store) => subscribeOp(store, {
  sessionRef: session,
  workRef: work,
  target: to,
}))));

server.registerTool("unsubscribe", {
  description: "Remove a lane subscription.",
  inputSchema: {
    tree: Tree,
    id: z.string(),
  },
}, async ({ tree, id }) => text(await run(tree, (store) => unsubscribeOp(store, id))));

server.registerTool("subscriptions", {
  description: "List lane subscriptions in one filetree.",
  inputSchema: { tree: Tree },
}, async ({ tree }) => text(await run(tree, (store) => listSubscriptionsOp(store))));

  return server;
}
