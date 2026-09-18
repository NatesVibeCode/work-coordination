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
  listOutboxOp,
  listSessions,
  listSubscriptionsOp,
  observe as observeOp,
  policyAddOp,
  policyDefaultsOp,
  policyListOp,
  policyRemoveOp,
  retryOutboxOp,
  sendAdvisory,
  showWork,
  subscribeOp,
  unsubscribeOp,
} from "../../src/operations.mjs";
import { roadmapViewFor } from "../../src/roadmap.mjs";
import { removeGroup } from "../../src/state.mjs";
import { renderUnread } from "../../src/mailbox.mjs";
import { runOp, treeNames } from "./runner.mjs";

export function buildServer(config) {
const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
const server = new McpServer({ name: "work-coordination", version: pkg.version });

const Tree = z.string().describe("Visible filetree to operate in (see trees_list). Never a path.");

function text(result) {
  return { content: [{ type: "text", text: result.output }] };
}
// mboxOutput appends the caller's unread mail to an operation's
// output, inside the run callback where the store lives. The
// recipient self-identifies with the optional `session` argument —
// the same declared-presence identity used everywhere else.
// Rendering is delivery: attached mail does not attach twice.
function mboxOutput(output, store, sessionRef) {
  const attached = renderUnread(store, sessionRef);
  return attached ? output + attached : output;
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
}, async ({ tree, work, session, harness, directory }) => text(await run(tree, async (store, resolved) => {
  const output = await observeOp(store, {
    workRef: work,
    sessionRef: session,
    harness,
    directory: directory ?? resolved.root,
    worktree: gitToplevel(resolved.root),
  });
  return mboxOutput(output, store, session);
})));
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
}, async ({ tree, body, work, from, session, group, status, to, deliver, idle_timeout_ms }) => text(await run(tree, async (store) => {
  const output = await sendAdvisory(store, {
    body,
    workRef: work,
    sender: from,
    sessionRef: session,
    to,
    groupRef: group,
    status,
    deliver,
    target: to,
    idleTimeoutMs: idle_timeout_ms,
  });
  return mboxOutput(output, store, session);
})));

server.registerTool("sessions", {
  description: "List observed sessions in one filetree. Pass your session ref to receive your unread mailbox with the response.",
  inputSchema: { tree: Tree, session: z.string().optional() },
}, async ({ tree, session }) => text(await run(tree, async (store) => {
  const output = await listSessions(store);
  return mboxOutput(output, store, session);
})));

server.registerTool("work", {
  description: "Show one typed work with its participants and messages.",
  inputSchema: { tree: Tree, ref: z.string() },
}, async ({ tree, ref }) => text(await run(tree, (store) => showWork(store, ref))));

server.registerTool("groups", {
  description: "List active ephemeral groups in one filetree.",
  inputSchema: { tree: Tree },
}, async ({ tree }) => text(await run(tree, (store) => listGroups(store))));

// group_create gives a set of sessions a private coordination address with a
// delivery route the spawner can reach; it never routes through the spawner,
// so a thread ban on the spawner does not silence them.
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
  description: "Send this session's blocked and done reports to a destination. Anyone may subscribe.",
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
  description: "Remove a subscription.",
  inputSchema: {
    tree: Tree,
    id: z.string(),
  },
}, async ({ tree, id }) => text(await run(tree, (store) => unsubscribeOp(store, id))));

server.registerTool("subscriptions", {
  description: "List subscriptions in one filetree.",
  inputSchema: { tree: Tree },
}, async ({ tree }) => text(await run(tree, (store) => listSubscriptionsOp(store))));

// One tool for the visibility rules: deny rules only (the default posture is
// allow), first matching rule wins. `add` needs at least one of repo/ref/session
// as a prefix; `remove` needs the rule id; `defaults` installs the operator's
// baseline; `list` shows what a refusal will name.
server.registerTool("policy", {
  description: "Manage session visibility rules. Deny rules only; first match wins; no match allows. Deny hides sessions from listings, withholds messages from mailboxes in both directions, and refuses deliveries.",
  inputSchema: {
    tree: Tree,
    action: z.enum(["add", "remove", "list", "defaults"]),
    repo: z.string().optional(),
    ref: z.string().optional(),
    session: z.string().optional(),
    note: z.string().optional(),
    id: z.string().optional(),
  },
}, async ({ tree, action, repo, ref, session, note, id }) => text(await run(tree, (store) => {
  if (action === "add") {
    const rule = policyAddOp(store, { repo, ref, session, note });
    return rule ?? "policy-add needs at least one of repo, ref, session";
  }
  if (action === "remove") return policyRemoveOp(store, id);
  if (action === "defaults") return policyDefaultsOp(store);
  return policyListOp(store);
})));

// The queue a failed delivery goes into. Without these two, an MCP client
// could cause a pending delivery and never see or drain it.
server.registerTool("pending", {
  description: "List deliveries that have not landed, oldest first, with the provider's last explanation.",
  inputSchema: { tree: Tree },
}, async ({ tree }) => text(await run(tree, (store) => listOutboxOp(store))));

server.registerTool("retry", {
  description: "Try every pending delivery again and report which landed. Nothing retries on its own.",
  inputSchema: {
    tree: Tree,
    idle_timeout_ms: z.number().optional(),
  },
}, async ({ tree, idle_timeout_ms }) => text(await run(tree, (store) => retryOutboxOp(store, { idleTimeoutMs: idle_timeout_ms }))));

// ungroup is the other half of group_create: an ephemeral group ends when
// someone says so, not only when its TTL runs out.
server.registerTool("ungroup", {
  description: "Remove an ephemeral group; its member log is pruned with it.",
  inputSchema: {
    tree: Tree,
    group: z.string(),
  },
}, async ({ tree, group }) => text(await run(tree, (store) => (removeGroup(store, group) ? "group removed" : "group unavailable"))));

// roadmap is read-only and optional: it overlays observed local participation
// beside one roadmap row when the operator has a roadmap database configured,
// and degrades to a line of text when they do not.
server.registerTool("roadmap", {
  description: "Read one roadmap item and overlay observed local participation. Read-only; optional local infrastructure.",
  inputSchema: {
    tree: Tree,
    ref: z.string(),
  },
}, async ({ tree, ref }) => text(await run(tree, (store) => roadmapViewFor(store, ref))));

  return server;
}
