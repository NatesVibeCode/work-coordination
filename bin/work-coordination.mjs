#!/usr/bin/env node
import { execFileSync } from "node:child_process";

process.on("uncaughtException", (error) => {
  process.stdout.write(`error · ${error?.message ?? error}\n`);
  process.exitCode = 1;
});
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { renderMessage } from "../src/coordination.mjs";
import { deliverMessage } from "../src/delivery.mjs";
import { deliverGroupMessage } from "../src/group-delivery.mjs";
import { observeParticipation, observedSessions, workView } from "../src/work-index.mjs";
import { readRoadmapItem, renderRoadmapView, roadmapView } from "../src/roadmap.mjs";
import { createState, activeGroups, createGroup, joinGroup, listSubscriptions, messagesForGroup, messagesForWork, notifySubscribers, removeGroup, sendMessage, subscribe, unsubscribe } from "../src/state.mjs";

function takeFlag(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return null;
  const value = args[index + 1];
  args.splice(index, value === undefined ? 1 : 2);
  return value ?? null;
}

function takeBoolean(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

function localState(start) {
  for (let directory = resolve(start);;) {
    const candidate = join(directory, ".work-coordination");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

function gitWorktreeRoot() {
  try {
    return resolve(process.cwd(), execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
  } catch {
    return null;
  }
}

function hideLocalState() {
  try {
    const path = resolve(process.cwd(), execFileSync("git", ["rev-parse", "--git-path", "info/exclude"], { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
    const pattern = ".work-coordination/";
    const current = existsSync(path) ? readFileSync(path, "utf8") : "";
    if (current.split(/\r?\n/).includes(pattern)) return;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${current}${current && !current.endsWith("\n") ? "\n" : ""}${pattern}\n`, { mode: 0o600 });
  } catch {}
}

const args = process.argv.slice(2);
const explicitState = takeFlag(args, "--state");
const command = args.shift();
const root = explicitState ?? (command === "init" ? join(gitWorktreeRoot() ?? process.cwd(), ".work-coordination") : localState(process.cwd()) ?? join(homedir(), ".work-coordination"));
const store = createState(root);

if (command === "init") {
  hideLocalState();
  process.stdout.write(`initialized · ${root}\n`);
} else if (command === "message") {
  const workRef = takeFlag(args, "--work");
  const sender = takeFlag(args, "--from");
  const groupRef = takeFlag(args, "--group");
  const status = takeFlag(args, "--status");
  const session = takeFlag(args, "--session");
  const deliver = takeBoolean(args, "--deliver");
  const target = takeFlag(args, "--to");
  const idleTimeout = takeFlag(args, "--idle-timeout-ms");
  const deliveryOptions = idleTimeout === null ? {} : { idleTimeoutMs: idleTimeout };
  const message = sendMessage(store, { workRef, sender, sessionRef: session, groupRef, status, body: args.join(" ") });
  if (!message) {
    process.stdout.write("group unavailable\n");
  } else {
    process.stdout.write(`${renderMessage(message)}\n`);
    for (const result of await notifySubscribers(store, message, deliveryOptions)) {
      process.stdout.write(result.delivered ? `notified ${result.target} · delivery accepted · ${result.transport}\n` : `notified ${result.target} · delivery unavailable · ${result.warning}\n`);
    }
    if (deliver) {
      const rendered = renderMessage(message);
      if (target) {
        const [harness, ...rest] = String(target).split(":");
        const result = await deliverMessage({ harness, sessionRef: rest.join(":"), message: rendered }, deliveryOptions);
        process.stdout.write(result.delivered ? `delivery accepted · ${result.transport}\n` : `delivery unavailable · ${result.warning}\n`);
      } else {
        const group = activeGroups(store).find((value) => value.id === groupRef);
        const results = await deliverGroupMessage(group, rendered, deliveryOptions);
        process.stdout.write(results.length ? `${results.map((result) => result.delivered ? `delivery accepted · ${result.transport}` : `delivery unavailable · ${result.warning}`).join("\n")}\n` : "delivery unavailable · no active group members\n");
      }
    }
  }
} else if (command === "group") {
  const action = args.shift();
  if (action === "create") {
    const group = createGroup(store, { name: args.join(" ") });
    process.stdout.write(`${group.id}${group.name ? ` · ${group.name}` : ""}\n`);
  } else if (action === "join") {
    const group = joinGroup(store, args.shift(), args.join(" "));
    process.stdout.write(group ? `${group.id} · ${group.members.join(", ")}\n` : "group unavailable\n");
  } else if (action === "messages") {
    const messages = messagesForGroup(store, args.join(" "));
    process.stdout.write(messages.length ? `${messages.map(renderMessage).join("\n\n")}\n` : "no messages observed\n");
  } else {
    process.stdout.write("nothing to do — try: group create [name] | group join <group> <session> | group messages <group>\n");
  }
} else if (command === "ungroup") {
  process.stdout.write(removeGroup(store, args.join(" ")) ? "group removed\n" : "group unavailable\n");
} else if (command === "subscribe") {
  const session = takeFlag(args, "--session");
  const work = takeFlag(args, "--work");
  const target = takeFlag(args, "--to");
  const subscription = subscribe(store, { sessionRef: session, workRef: work, target });
  process.stdout.write(subscription ? `subscribed · ${subscription.id}\n` : "subscription unavailable\n");
} else if (command === "unsubscribe") {
  process.stdout.write(unsubscribe(store, args.join(" ")) ? "unsubscribed\n" : "subscription unavailable\n");
} else if (command === "subscriptions") {
  const subscriptions = listSubscriptions(store);
  process.stdout.write(subscriptions.length ? `${subscriptions.map((value) => `${value.id} · ${value.sessionRef}${value.workRef ? ` · ${value.workRef}` : ""} → ${value.targetHarness}:${value.targetSession}`).join("\n")}\n` : "no subscriptions\n");
} else if (command === "groups") {
  const groups = activeGroups(store);
  process.stdout.write(groups.length ? `${groups.map((group) => `${group.id}${group.name ? ` · ${group.name}` : ""} · ${group.members.join(", ")}`).join("\n")}\n` : "no active groups\n");
} else if (command === "sessions") {
  const sessions = observedSessions(store);
  process.stdout.write(sessions.length ? `${sessions.map((value) => `${value.sessionRef}${value.workRef ? ` · ${value.workRef}` : ""}`).join("\n")}\n` : "no sessions observed\n");
} else if (command === "observe") {
  const workRef = takeFlag(args, "--work");
  const sessionRef = takeFlag(args, "--session");
  const harness = takeFlag(args, "--harness");
  const directory = takeFlag(args, "--directory") ?? process.cwd();
  const record = observeParticipation(store, { workRef, sessionRef, harness, directory, worktree: gitWorktreeRoot() });
  process.stdout.write(`${record.sessionRef}\n`);
} else if (command === "roadmap") {
  const roadmapKey = args.join(" ");
  try {
    const item = readRoadmapItem(roadmapKey);
    process.stdout.write(`${renderRoadmapView(roadmapView(store, item))}\n`);
  } catch {
    process.stdout.write("roadmap unavailable — local read failed; coordination remains advisory-only.\n");
  }
} else if (command === "work") {
  const workRef = args.join(" ");
  const view = workView(store, workRef);
  const messages = messagesForWork(store, workRef);
  const participants = view?.participants ?? [];
  if (!participants.length && !messages.length) {
    process.stdout.write("no work context observed\n");
  } else {
    const header = `Work · ${workRef || "unknown"}`;
    const people = participants.length ? participants.map((value) => value.sessionRef).join(", ") : "none observed";
    const rendered = messages.length ? messages.map(renderMessage).join("\n\n") : "no messages observed";
    process.stdout.write(`${header}\nparticipants · ${people}\n\n${rendered}\n`);
  }
} else {
  process.stdout.write("nothing to do — try: message <text> [--work <ref>] [--from <session>] | work <ref> | roadmap <roadmap-key>\n");
}
