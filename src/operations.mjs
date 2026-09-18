import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { destinationOf, oneLine, renderMessage, withoutBoilerplate } from "./coordination.mjs";
import { bumpAttempt, clearFailure, listOutbox, settle } from "./outbox.mjs";
import { deliverMessage, mapBounded } from "./delivery.mjs";
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
import {
  addPolicyRule,
  installPolicyDefaults,
  listPolicyRules,
  messageVisible,
  policyDecide,
  removePolicyRule,
  renderPolicyRule,
  sessionSubject,
} from "./policy.mjs";

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

export async function sendAdvisory(store, { body, workRef, sender, sessionRef, to, groupRef, status, deliver, target, idleTimeoutMs } = {}, { spawnFn } = {}) {
  const message = sendMessage(store, { workRef, sender, sessionRef, to, groupRef, status, body });
  if (message === false) return "message body unavailable";
  if (!message) return groupState(store, groupRef) === "expired" ? "group expired" : "group unavailable";
  const lines = [renderMessage(message)];
  const deliveryOptions = { ...(idleTimeoutMs === undefined || idleTimeoutMs === null ? {} : { idleTimeoutMs }), ...(spawnFn ? { spawnFn } : {}), store };
  for (const result of await notifySubscribers(store, message, deliveryOptions)) {
    lines.push(result.delivered ? `notified ${result.target} · delivery accepted · ${result.transport}` : `notified ${result.target} · delivery unavailable · ${result.warning}`);
  }
  if (deliver) {
    const rendered = renderMessage(message);
    if (target) {
      const destination = destinationOf(target);
      const result = await deliverMessage({ ...destination, message: rendered }, deliveryOptions);
      // An explicit send deserves the same durability as a fan-out: a message
      // that did not land goes in the queue rather than vanishing into a
      // warning line.
      settle(store, {
        messageRef: message.ref,
        target: `${destination.harness}:${destination.sessionRef}`,
        message: rendered,
        workRef: message.workRef,
        result,
      });
      lines.push(result.delivered ? `delivery accepted · ${result.transport}` : `delivery unavailable · ${result.warning}`);
    } else {
      const group = activeGroups(store).find((value) => value.id === groupRef);
      const results = await deliverGroupMessage(group, rendered, deliveryOptions);
      const members = Array.isArray(group?.members) ? group.members : [];
      results.forEach((result, index) => {
        settle(store, { messageRef: message.ref, target: oneLine(members[index]), message: rendered, workRef: message.workRef, result });
      });
      lines.push(results.length ? results.map((result) => result.delivered ? `delivery accepted · ${result.transport}` : `delivery unavailable · ${result.warning}`).join("\n") : "delivery unavailable · no active group members");
    }
  }
  return lines.join("\n");
}

// The listing is visibility-filtered: a session whose record a policy rule
// denies is not shown at all, not shown redacted.
export function listSessions(store) {
  const sessions = observedSessions(store)
    .filter((record) => policyDecide(store, sessionSubject(record), "list").allowed);
  return sessions.length ? sessions.map((value) => `${oneLine(value.sessionRef)}${value.workRef ? ` · ${oneLine(value.workRef)}` : ""}`).join("\n") : "no sessions observed";
}

export function showWork(store, workRef) {
  const view = workView(store, workRef);
  const messages = messagesForWork(store, workRef);
  // A policy deny on a participant or on either end of a message withholds
  // that record from the read, the same way it is withheld from a listing
  // and a mailbox.
  const participants = (view?.participants ?? []).filter((record) => policyDecide(store, sessionSubject(record), "read").allowed);
  const visible = messages.filter((message) => messageVisible(store, message));
  if (participants.length || visible.length) {
    const header = `Work · ${oneLine(workRef) || "unknown"}`;
    const people = participants.length ? participants.map((value) => oneLine(value.sessionRef)).join(", ") : "none observed";
    const rendered = visible.length ? withoutBoilerplate(visible.map(renderMessage).join("\n\n")) : "no messages observed";
    return `${header}\nparticipants · ${people}\n\n${rendered}`;
  }
  // Records are stored normalized, so the expired-vs-missing lookup has to ask
  // with the same normalized ref — otherwise a padded ref reports "no context"
  // for a work whose records merely aged out.
  const ref = oneLine(workRef);
  const rawMessages = rawMessagesForWork(store, ref);
  const rawParticipants = allObservations(store).filter((record) => record.workRef === ref);
  const expired = rawMessages.length > 0 || rawParticipants.length > 0;
  const withheld = expired
    && (rawMessages.some((message) => !messageVisible(store, message))
      || rawParticipants.some((record) => !policyDecide(store, sessionSubject(record), "read").allowed));
  return expired ? (withheld ? "work context withheld by policy" : "work expired") : "no work context observed";
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
  // A group with no members yet renders an empty field rather than a trailing
  // separator with nothing after it.
  return group ? [oneLine(group.id), group.members.map(oneLine).join(", ")].filter(Boolean).join(" · ") : "group unavailable";
}

export function groupMessagesOp(store, groupRef) {
  if (groupState(store, groupRef) === "expired") return "group expired";
  const messages = messagesForGroup(store, groupRef);
  return messages.length ? withoutBoilerplate(messages.map(renderMessage).join("\n\n")) : "no messages observed";
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

// Deliveries that did not land, oldest first, with what the provider said.
export function listOutboxOp(store) {
  const entries = listOutbox(store);
  if (!entries.length) return "no pending deliveries";
  return entries.map((entry) => {
    const age = Math.max(0, Date.now() - Number(entry.createdAt ?? 0));
    const attempts = Number(entry.attempts ?? 0);
    return `${entry.messageRef} → ${entry.target}${entry.workRef ? ` · ${entry.workRef}` : ""} · ${attempts} ${attempts === 1 ? "attempt" : "attempts"} · ${Math.round(age / 1000)}s ago${entry.lastWarning ? ` · ${entry.lastWarning}` : ""}`;
  }).join("\n");
}

// Drain the queue: try every pending delivery again, bound the same way the
// live fan-out is, and report which ones landed. This is the whole reason the
// queue exists — a provider that was down at send time does not mean the
// message is gone.
export async function retryOutboxOp(store, { spawnFn, idleTimeoutMs } = {}) {
  const entries = listOutbox(store);
  if (!entries.length) return "no pending deliveries";
  const options = { concurrency: 4, store };
  if (spawnFn !== undefined) options.spawnFn = spawnFn;
  if (idleTimeoutMs !== undefined && idleTimeoutMs !== null) options.idleTimeoutMs = idleTimeoutMs;

  const attempts = await mapBounded(entries, options.concurrency, async (entry) => {
    const { harness, sessionRef } = destinationOf(entry.target);
    if (!harness || !sessionRef) return { entry, delivered: false, warning: `unusable destination · ${entry.target}` };
    const result = await deliverMessage({ harness, sessionRef, message: entry.message }, options);
    return { entry, ...result };
  });

  const delivered = [];
  const failed = [];
  for (const attempt of attempts) {
    const address = { messageRef: attempt.entry.messageRef, target: attempt.entry.target };
    if (attempt.delivered) {
      clearFailure(store, address);
      delivered.push(attempt);
    } else {
      bumpAttempt(store, { ...address, warning: attempt.warning });
      failed.push(attempt);
    }
  }

  const lines = [...delivered.map((attempt) => `delivered · ${attempt.entry.target} · ${attempt.transport ?? "transport"}`),
    ...failed.map((attempt) => `still pending · ${attempt.entry.target} · ${attempt.warning ?? "unavailable"}`)];
  return lines.length ? lines.join("\n") : "no pending deliveries";
}

// Visibility rules. Writing is deny-only — the default posture is already
// allow — and reading lists what a refusal will name.
export function policyAddOp(store, { repo, ref, session, note } = {}) {
  const rule = addPolicyRule(store, { repo, ref, session, note });
  return rule ? renderPolicyRule(rule) : null;
}

export function policyRemoveOp(store, ruleId) {
  return removePolicyRule(store, ruleId) ? "policy rule removed" : "policy rule unavailable";
}

export function policyListOp(store) {
  const rules = listPolicyRules(store);
  return rules.length ? rules.map(renderPolicyRule).join("\n") : "no policy rules";
}

export function policyDefaultsOp(store) {
  return installPolicyDefaults(store);
}
