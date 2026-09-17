import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { destinationOf, oneLine, renderMessage } from "./coordination.mjs";
import { deliverMessage } from "./delivery.mjs";
import { deliverGroupMessage } from "./group-delivery.mjs";
import { allObservations, observeParticipation, observedSessions, workView } from "./work-index.mjs";
import {
  activeGroups,
  createGroup,
  createState,
  groupState,
  joinGroup,
  listSubscriptions,
  loadState,
  messagesForGroup,
  messagesForWork,
  notifySubscribers,
  rawMessagesForWork,
  sendMessage,
  subscribe,
  subscriptionState,
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

// Store resolution, in priority order: an explicit --state directory, the
// nearest .work-coordination walking up from the tree, then a tree-local
// fallback. The fallback is deliberately INSIDE the tree: a home-directory
// store made every uninitialized directory on the machine share one pool, so
// two unrelated repos saw each other's sessions and messages. Coordination
// stays where the work is.
export function storeDirectoryForTree(treeRoot, explicitStateDir = null, fallbackDir = null) {
  return explicitStateDir ?? localState(treeRoot) ?? fallbackDir ?? join(resolve(treeRoot), ".work-coordination");
}

// `create` decides whether resolving a store may bring it into existence.
// A read-only command resolves the same way but must not create anything —
// not a missing store, and not a directory a typo named.
export function storeForTree(treeRoot, explicitStateDir = null, fallbackDir = null, { create = true } = {}) {
  const root = storeDirectoryForTree(treeRoot, explicitStateDir, fallbackDir);
  return create ? createState(root) : loadState(root);
}

export function observe(store, { workRef, sessionRef, harness, directory, worktree } = {}) {
  const record = observeParticipation(store, { workRef, sessionRef, harness, directory, worktree });
  return `${record.sessionRef}`;
}

export async function sendAdvisory(store, { body, workRef, sender, sessionRef, groupRef, status, deliver, target, idleTimeoutMs } = {}, { spawnFn } = {}) {
  const message = sendMessage(store, { workRef, sender, sessionRef, groupRef, status, body });
  if (message === false) return "message body unavailable";
  if (!message) return groupState(store, groupRef) === "expired" ? "group expired" : "group unavailable";
  const lines = [renderMessage(message)];
  const deliveryOptions = { ...(idleTimeoutMs === undefined || idleTimeoutMs === null ? {} : { idleTimeoutMs }), ...(spawnFn ? { spawnFn } : {}) };
  for (const result of await notifySubscribers(store, message, deliveryOptions)) {
    lines.push(result.delivered ? `notified ${result.target} · delivery accepted · ${result.transport}` : `notified ${result.target} · delivery unavailable · ${result.warning}`);
  }
  if (deliver) {
    const rendered = renderMessage(message);
    if (target) {
      const result = await deliverMessage({ ...destinationOf(target), message: rendered }, deliveryOptions);
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
  return sessions.length ? sessions.map((value) => `${oneLine(value.sessionRef)}${value.workRef ? ` · ${oneLine(value.workRef)}` : ""}`).join("\n") : "no sessions observed";
}

export function showWork(store, workRef) {
  const view = workView(store, workRef);
  const messages = messagesForWork(store, workRef);
  const participants = view?.participants ?? [];
  if (participants.length || messages.length) {
    const header = `Work · ${oneLine(workRef) || "unknown"}`;
    const people = participants.length ? participants.map((value) => oneLine(value.sessionRef)).join(", ") : "none observed";
    const rendered = messages.length ? messages.map(renderMessage).join("\n\n") : "no messages observed";
    return `${header}\nparticipants · ${people}\n\n${rendered}`;
  }
  // Records are stored normalized, so the expired-vs-missing lookup has to ask
  // with the same normalized ref — otherwise a padded ref reports "no context"
  // for a work whose records merely aged out.
  const ref = oneLine(workRef);
  const expired = rawMessagesForWork(store, ref).length > 0 || allObservations(store).some((record) => record.workRef === ref);
  return expired ? "work expired" : "no work context observed";
}

export function listGroups(store) {
  const groups = activeGroups(store);
  return groups.length ? groups.map((group) => `${oneLine(group.id)}${group.name ? ` · ${oneLine(group.name)}` : ""} · ${group.members.map(oneLine).join(", ")}`).join("\n") : "no active groups";
}

export function createGroupOp(store, name) {
  const group = createGroup(store, { name });
  return `${oneLine(group.id)}${group.name ? ` · ${oneLine(group.name)}` : ""}`;
}

export function joinGroupOp(store, groupId, sessionRef) {
  if (groupState(store, groupId) === "expired") return "group expired";
  const group = joinGroup(store, groupId, sessionRef);
  return group ? `${oneLine(group.id)} · ${group.members.map(oneLine).join(", ")}` : "group unavailable";
}

export function groupMessagesOp(store, groupRef) {
  if (groupState(store, groupRef) === "expired") return "group expired";
  const messages = messagesForGroup(store, groupRef);
  return messages.length ? messages.map(renderMessage).join("\n\n") : "no messages observed";
}

export function subscribeOp(store, { sessionRef, workRef, target } = {}) {
  const subscription = subscribe(store, { sessionRef, workRef, target });
  return subscription ? `subscribed · ${oneLine(subscription.id)}` : "subscription unavailable";
}

export function unsubscribeOp(store, subscriptionId) {
  if (subscriptionState(store, subscriptionId) === "expired") return "subscription expired";
  return unsubscribe(store, subscriptionId) ? "unsubscribed" : "subscription unavailable";
}

export function listSubscriptionsOp(store) {
  const subscriptions = listSubscriptions(store);
  return subscriptions.length ? subscriptions.map((value) => `${oneLine(value.id)} · ${oneLine(value.sessionRef)}${value.workRef ? ` · ${oneLine(value.workRef)}` : ""} → ${oneLine(value.targetHarness)}:${oneLine(value.targetSession)}`).join("\n") : "no subscriptions";
}
