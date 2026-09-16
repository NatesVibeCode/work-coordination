import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { renderMessage } from "./coordination.mjs";
import { deliverMessage } from "./delivery.mjs";
import { deliverGroupMessage } from "./group-delivery.mjs";
import { observeParticipation, observedSessions, workView } from "./work-index.mjs";
import {
  activeGroups,
  createGroup,
  createState,
  joinGroup,
  listSubscriptions,
  messagesForGroup,
  messagesForWork,
  notifySubscribers,
  sendMessage,
  subscribe,
  unsubscribe,
} from "./state.mjs";

// Every operation takes a store and returns the exact text the CLI prints
// (no trailing newline). bin/ writes it; the MCP server returns it. One
// implementation, two frontends — they cannot drift apart.

export function localState(start) {
  for (let directory = resolve(start);;) {
    const candidate = join(directory, ".work-coordination");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

export function gitToplevel(start) {
  try {
    return resolve(start, execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: start, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
  } catch {
    return null;
  }
}

// Same resolution the CLI uses from a tree directory: nearest
// .work-coordination walking up, else the fallback. An explicit state
// directory (the CLI --state flag) wins over both. The CLI keeps the home
// fallback; the MCP server passes a tree-local fallback so a tree without
// its own store still never reads or writes outside the declared root.
export function storeForTree(treeRoot, explicitStateDir = null, fallbackDir = null) {
  const root = explicitStateDir ?? localState(treeRoot) ?? fallbackDir ?? join(homedir(), ".work-coordination");
  return createState(root);
}

export function observe(store, { workRef, sessionRef, harness, directory, worktree } = {}) {
  const record = observeParticipation(store, { workRef, sessionRef, harness, directory, worktree });
  return `${record.sessionRef}`;
}

export async function sendAdvisory(store, { body, workRef, sender, sessionRef, groupRef, status, deliver, target, idleTimeoutMs } = {}, { spawnFn } = {}) {
  const message = sendMessage(store, { workRef, sender, sessionRef, groupRef, status, body });
  if (!message) return "group unavailable";
  const lines = [renderMessage(message)];
  const deliveryOptions = { ...(idleTimeoutMs === undefined || idleTimeoutMs === null ? {} : { idleTimeoutMs }), ...(spawnFn ? { spawnFn } : {}) };
  for (const result of await notifySubscribers(store, message, deliveryOptions)) {
    lines.push(result.delivered ? `notified ${result.target} · delivery accepted · ${result.transport}` : `notified ${result.target} · delivery unavailable · ${result.warning}`);
  }
  if (deliver) {
    const rendered = renderMessage(message);
    if (target) {
      const [harness, ...rest] = String(target).split(":");
      const result = await deliverMessage({ harness, sessionRef: rest.join(":"), message: rendered }, deliveryOptions);
      lines.push(result.delivered ? `delivery accepted · ${result.transport}` : `delivery unavailable · ${result.warning}`);
    } else {
      const group = activeGroups(store).find((value) => value.id === groupRef);
      const results = await deliverGroupMessage(group, rendered, deliveryOptions);
      lines.push(results.length ? results.map((result) => result.delivered ? `delivery accepted · ${result.transport}` : `delivery unavailable · ${result.warning}`).join("\n") : "delivery unavailable · no active group members");
    }
  }
  return lines.join("\n");
}

export function listSessions(store) {
  const sessions = observedSessions(store);
  return sessions.length ? sessions.map((value) => `${value.sessionRef}${value.workRef ? ` · ${value.workRef}` : ""}`).join("\n") : "no sessions observed";
}

export function showWork(store, workRef) {
  const view = workView(store, workRef);
  const messages = messagesForWork(store, workRef);
  const participants = view?.participants ?? [];
  if (!participants.length && !messages.length) return "no work context observed";
  const header = `Work · ${workRef || "unknown"}`;
  const people = participants.length ? participants.map((value) => value.sessionRef).join(", ") : "none observed";
  const rendered = messages.length ? messages.map(renderMessage).join("\n\n") : "no messages observed";
  return `${header}\nparticipants · ${people}\n\n${rendered}`;
}

export function listGroups(store) {
  const groups = activeGroups(store);
  return groups.length ? groups.map((group) => `${group.id}${group.name ? ` · ${group.name}` : ""} · ${group.members.join(", ")}`).join("\n") : "no active groups";
}

export function createGroupOp(store, name) {
  const group = createGroup(store, { name });
  return `${group.id}${group.name ? ` · ${group.name}` : ""}`;
}

export function joinGroupOp(store, groupId, sessionRef) {
  const group = joinGroup(store, groupId, sessionRef);
  return group ? `${group.id} · ${group.members.join(", ")}` : "group unavailable";
}

export function groupMessagesOp(store, groupRef) {
  const messages = messagesForGroup(store, groupRef);
  return messages.length ? messages.map(renderMessage).join("\n\n") : "no messages observed";
}

export function subscribeOp(store, { sessionRef, workRef, target } = {}) {
  const subscription = subscribe(store, { sessionRef, workRef, target });
  return subscription ? `subscribed · ${subscription.id}` : "subscription unavailable";
}

export function unsubscribeOp(store, subscriptionId) {
  return unsubscribe(store, subscriptionId) ? "unsubscribed" : "subscription unavailable";
}

export function listSubscriptionsOp(store) {
  const subscriptions = listSubscriptions(store);
  return subscriptions.length ? subscriptions.map((value) => `${value.id} · ${value.sessionRef}${value.workRef ? ` · ${value.workRef}` : ""} → ${value.targetHarness}:${value.targetSession}`).join("\n") : "no subscriptions";
}
