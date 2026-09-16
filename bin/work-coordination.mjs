#!/usr/bin/env node
import { execFileSync } from "node:child_process";

process.on("uncaughtException", (error) => {
  process.stdout.write(`error · ${error?.message ?? error}\n`);
  process.exitCode = 1;
});
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readRoadmapItem, renderRoadmapView, roadmapView } from "../src/roadmap.mjs";
import { removeGroup, saveStoreConfig } from "../src/state.mjs";
import {
  createGroupOp,
  gitToplevel,
  groupMessagesOp,
  joinGroupOp,
  listGroups,
  listSessions,
  listSubscriptionsOp,
  observe,
  sendAdvisory,
  showWork,
  storeForTree,
  subscribeOp,
  unsubscribeOp,
} from "../src/operations.mjs";

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

function hideLocalState() {
  try {
    const path = join(process.cwd(), execFileSync("git", ["rev-parse", "--git-path", "info/exclude"], { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
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
const explicitRoot = explicitState ?? (command === "init" ? join(gitToplevel(process.cwd()) ?? process.cwd(), ".work-coordination") : null);
const store = storeForTree(process.cwd(), explicitRoot);

if (command === "init") {
  hideLocalState();
  // Decay is opt-in per store and defaults to off (audit keeps everything).
  // Plain `init` never touches an existing setting.
  const decayFlag = takeFlag(args, "--decay-ms");
  let suffix = "";
  if (decayFlag !== null) {
    const decayMs = Number(decayFlag);
    saveStoreConfig(store.directory, { decayMs: decayMs > 0 ? decayMs : null });
    suffix = decayMs > 0 ? ` · decay ${decayMs}ms` : " · decay off";
  }
  process.stdout.write(`initialized · ${store.directory}${suffix}\n`);
} else if (command === "message") {
  const workRef = takeFlag(args, "--work");
  const sender = takeFlag(args, "--from");
  const groupRef = takeFlag(args, "--group");
  const status = takeFlag(args, "--status");
  const session = takeFlag(args, "--session");
  const deliver = takeBoolean(args, "--deliver");
  const target = takeFlag(args, "--to");
  const idleTimeout = takeFlag(args, "--idle-timeout-ms");
  process.stdout.write(`${await sendAdvisory(store, { body: args.join(" "), workRef, sender, sessionRef: session, groupRef, status, deliver, target, idleTimeoutMs: idleTimeout })}\n`);
} else if (command === "group") {
  const action = args.shift();
  if (action === "create") {
    process.stdout.write(`${createGroupOp(store, args.join(" "))}\n`);
  } else if (action === "join") {
    process.stdout.write(`${joinGroupOp(store, args.shift(), args.join(" "))}\n`);
  } else if (action === "messages") {
    process.stdout.write(`${groupMessagesOp(store, args.join(" "))}\n`);
  } else {
    process.stdout.write("nothing to do — try: group create [name] | group join <group> <session> | group messages <group>\n");
  }
} else if (command === "ungroup") {
  process.stdout.write(removeGroup(store, args.join(" ")) ? "group removed\n" : "group unavailable\n");
} else if (command === "subscribe") {
  const session = takeFlag(args, "--session");
  const work = takeFlag(args, "--work");
  const target = takeFlag(args, "--to");
  process.stdout.write(`${subscribeOp(store, { sessionRef: session, workRef: work, target })}\n`);
} else if (command === "unsubscribe") {
  process.stdout.write(`${unsubscribeOp(store, args.join(" "))}\n`);
} else if (command === "subscriptions") {
  process.stdout.write(`${listSubscriptionsOp(store)}\n`);
} else if (command === "groups") {
  process.stdout.write(`${listGroups(store)}\n`);
} else if (command === "sessions") {
  process.stdout.write(`${listSessions(store)}\n`);
} else if (command === "observe") {
  const workRef = takeFlag(args, "--work");
  const sessionRef = takeFlag(args, "--session");
  const harness = takeFlag(args, "--harness");
  const directory = takeFlag(args, "--directory") ?? process.cwd();
  process.stdout.write(`${observe(store, { workRef, sessionRef, harness, directory, worktree: gitToplevel(process.cwd()) })}\n`);
} else if (command === "roadmap") {
  const roadmapKey = args.join(" ");
  try {
    const item = readRoadmapItem(roadmapKey);
    process.stdout.write(`${renderRoadmapView(roadmapView(store, item))}\n`);
  } catch {
    process.stdout.write("roadmap unavailable — local read failed; coordination remains advisory-only.\n");
  }
} else if (command === "work") {
  process.stdout.write(`${showWork(store, args.join(" "))}\n`);
} else {
  process.stdout.write("nothing to do — try: message <text> [--work <ref>] [--from <session>] | work <ref> | roadmap <roadmap-key>\n");
}
