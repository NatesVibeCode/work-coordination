import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { destinationOf, oneLine, renderMessage, withoutBoilerplate } from "./coordination.mjs";
import { inspectJsonStateDirectory } from "./atomic-json.mjs";
import { bumpAttempt, clearFailure, listOutbox, settle } from "./outbox.mjs";
import { deliverMessage, mapBounded } from "./delivery.mjs";
import { deliverGroupMessage } from "./group-delivery.mjs";
import { allObservations, observeParticipation, observedSessions, workView } from "./work-index.mjs";
import {
  activeGroups,
  associationsForSource,
  feedbackForAssociation,
  createGroup,
  createState,
  groupState,
  joinGroup,
  listSubscriptions,
  loadState,
  messagesForGroup,
  messagesForWork,
  notifySubscribers,
  readHandoffAssociation,
  readAssociationFeedback,
  recordAssociationFeedback,
  recordAssociationDelivery,
  recordReturnedAssociationDelivery,
  recordHandoffAssociation,
  rawMessagesForWork,
  sendMessage,
  subscribe,
  subscriptionState,
  unsubscribe,
} from "./state.mjs";
import { identityHash, writeJsonRecord, StateConflictError } from "./atomic-json.mjs";
import { validateHandoffBinding, compareHandoffBinding } from "./association-contract.mjs";
import { associationFromIdentity, bindingFreshness, deliverNative, exactObject, observeNative, selectedWorkspace, validateNativeDelivery } from "./native-connections.mjs";
import {
  addPolicyRule,
  installPolicyDefaults,
  listPolicyRules,
  messageVisible,
  policyDecide,
  removePolicyRule,
  renderPolicyRule,
  sessionSubject,
  refSubject,
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

// Journal conflicts and damaged records remain visible as uncertainty. This
// is a read-only diagnostic; it does not elect a writer, repair state, or
// authorize delivery.
export function stateStatus(store) {
  const report = inspectJsonStateDirectory(store.directory);
  const lines = [];
  for (const conflict of report.conflicts) {
    const relative = String(conflict.base ?? "").startsWith(store.directory)
      ? String(conflict.base).slice(store.directory.length).replace(/^\//, "")
      : conflict.base;
    lines.push(`state · conflict · ${oneLine(relative)} · ${oneLine(conflict.path)} · event ${oneLine(conflict.eventId)}`);
  }
  for (const gap of report.gaps) {
    const relative = String(gap.file ?? "").startsWith(store.directory)
      ? String(gap.file).slice(store.directory.length).replace(/^\//, "")
      : gap.file;
    lines.push(`state · gap · ${oneLine(relative)} · ${oneLine(gap.reason)}`);
  }
  for (const old of report.legacy) {
    if (old.records) lines.push(`state · legacy · ${oneLine(String(old.file).slice(store.directory.length).replace(/^\//, ""))} · ${old.records} readable JSONL records`);
  }
  return lines.length ? lines.slice(0, 32).join("\n") : "state · consistent";
}

function exactInputObject(value, keys, label) {
  const valid = value !== null && typeof value === "object" && !Array.isArray(value);
  if (!valid) throw new TypeError(`${label} must be an object`);
  const missing = keys.filter((key) => !Object.hasOwn(value, key));
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  if (missing.length || unknown.length) {
    const details = [
      ...missing.map((key) => `${key} is required`),
      ...unknown.map((key) => `${key} is unknown`),
    ];
    const error = new TypeError(`${label} refused · ${details.join("; ")}`);
    error.code = "INVALID_ASSOCIATION";
    error.details = { missing, unknown };
    throw error;
  }
}

// These two explicit operations keep the record contract intact across the
// CLI and MCP surfaces. JSON.stringify produces one compact protocol line and
// leaves native observation values and timestamps uninterpreted.
export function saveHandoffAssociationOp(store, association) {
  return JSON.stringify(recordHandoffAssociation(store, association));
}

export function readHandoffAssociationOp(store, identity) {
  exactInputObject(identity, ["handoffBinding", "destination", "attempt"], "handoff identity");
  const record = readHandoffAssociation(store, {
    contract: "work-coordination.handoff-association",
    schemaVersion: 1,
    handoffBinding: identity.handoffBinding,
    destination: identity.destination,
    attempt: identity.attempt,
    observations: [],
  });
  return JSON.stringify(record);
}

export async function nativeObserveOp(store, request, options = {}) {
  exactObject(request, ["identity", "workspace"], ["native"]);
  selectedWorkspace(request.workspace, options.treeRoot);
  const record = associationFromIdentity(request.identity);
  if (!policyDecide(store, sessionSubject({ sessionRef: `${record.destination.surface}:${record.destination.sessionId}`, worktree: request.workspace }), "read").allowed) return JSON.stringify({ status: "unavailable", reason: "native session withheld by policy" });
  const freshness = bindingFreshness(record.handoffBinding, request.workspace);
  if (freshness.status !== "current") return JSON.stringify({ status: "stale", freshness });
  // Byte freshness does not establish publication selection or task semantics.
  const prior = readHandoffAssociation(store, record);
  const nativeValue = await observeNative(request.identity, request.workspace, request.native ?? {}, options);
  const nativeKind = `${record.destination.surface}.session-observation`;
  const id = `native-${identityHash("native-observation.v1", request.identity, nativeKind, nativeValue)}`;
  let observation = prior?.observations.find((o) => o.id === id);
  if (!observation) {
    observation = { id, origin: { surface: record.destination.surface, sessionId: record.destination.sessionId, attemptId: record.attempt.id },
      observedAt: options.observedAt ?? new Date().toISOString(), nativeKind, nativeValue };
    // Equal simultaneous snapshots converge to the first published timestamp.
    try { recordHandoffAssociation(store, { ...record, observations: [observation] }); }
    catch (error) {
      if (error.code !== "STATE_CONFLICT") throw error;
      const accepted = readHandoffAssociation(store, record)?.observations.find((o) => o.id === id);
      if (!accepted || identityHash(accepted.nativeValue) !== identityHash(nativeValue)) throw error;
      observation = accepted;
    }
  }
  return JSON.stringify({ status: nativeValue.status, freshness, association: readHandoffAssociation(store, record) });
}

export function associationSnapshotOp(store, request, options = {}) {
  exactObject(request, ["handoffBinding", "workspace"]);
  selectedWorkspace(request.workspace, options.treeRoot);
  const validation = validateHandoffBinding(request.handoffBinding);
  if (!validation.valid) throw new TypeError(validation.errors.join("; "));
  const associations = associationsForSource(store, request.handoffBinding)
    .filter((a) => policyDecide(store, sessionSubject({sessionRef:`${a.destination.surface}:${a.destination.sessionId}`, worktree:request.workspace}), "read").allowed)
    .map((association) => ({
    association, freshness: compareHandoffBinding(association.handoffBinding, request.handoffBinding),
    feedback: feedbackForAssociation(store, association),
  }));
  return JSON.stringify({ contract: "work-coordination.association-snapshot", schemaVersion: 1,
    handoffBinding: request.handoffBinding, observedAt: new Date().toISOString(),
    freshness: bindingFreshness(request.handoffBinding, request.workspace), associations,
    limitation: "Native progress and results are observations. Source-byte freshness does not validate publication selection, task completion or Mdviewer execution evidence." });
}

export async function associationFeedbackOp(store, request, options = {}) {
  exactObject(request, ["identity", "workspace", "requestId", "body"], ["native"]);
  selectedWorkspace(request.workspace, options.treeRoot);
  const record = associationFromIdentity(request.identity);
  if (!policyDecide(store, sessionSubject({ sessionRef: `${record.destination.surface}:${record.destination.sessionId}`, worktree: request.workspace }), "message").allowed) return JSON.stringify({ status: "unavailable", reason: "native delivery withheld by policy" });
  if (typeof request.requestId !== "string" || !/^[A-Za-z0-9._-]+$/.test(request.requestId)
      || typeof request.body !== "string" || !request.body.trim()) throw new TypeError("stable requestId and nonblank body required");
  const freshness = bindingFreshness(record.handoffBinding, request.workspace);
  if (freshness.status !== "current") return JSON.stringify({ status: "stale", freshness });
  if (!readHandoffAssociation(store, record)) return JSON.stringify({ status: "unavailable", reason: "selected association is absent" });
  const nativeId = `feedback-${identityHash(request.identity, request.requestId)}`;
  validateNativeDelivery(request.identity, request.body, nativeId, request.native ?? {});
  const prior = readAssociationFeedback(store, record, request.requestId);
  if (prior) {
    if (prior.request.body !== request.body) throw new StateConflictError("feedback request ID reused with another body", {});
    if (request.native?.receipt) {
      const returned = await deliverNative(request.identity, request.body, nativeId, request.workspace, request.native, options);
      return JSON.stringify(recordReturnedAssociationDelivery(store, record, request.requestId, returned));
    }
    return JSON.stringify(prior);
  }
  const saved = recordAssociationFeedback(store, record, request.requestId, request.body, nativeId);
  if (!saved.created) return JSON.stringify(readAssociationFeedback(store, record, request.requestId));
  // Namespace the native idempotency key by the exact association too.
  let delivery;
  try { delivery = await deliverNative(request.identity, request.body, nativeId, request.workspace, request.native ?? {}, options); }
  catch { delivery = { status: "ambiguous", reason: "native admission acknowledgement unavailable" }; }
  if (delivery.status === "unavailable") {
    // Reuse the existing mailbox store, preserving exact recipient casing.
    // Structured feedback remains intact in its JSON request even when the
    // mailbox's one-line presentation collapses newlines.
    const recipient = `${record.destination.surface}:${record.destination.sessionId}`;
    const message = { ref: nativeId, workRef: record.handoffBinding.source.taskId, sender: "Mdviewer feedback", sessionRef: null,
      to: recipient, groupRef: null, status: null, body: oneLine(request.body), createdAt: Date.now(), advisory: true };
    writeJsonRecord(join(store.messages, `${identityHash("message", nativeId)}.json`), message);
    delivery = { ...delivery, status: "mailbox", messageRef: nativeId, recipient };
  }
  return JSON.stringify(recordAssociationDelivery(store, record, request.requestId, delivery));
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
