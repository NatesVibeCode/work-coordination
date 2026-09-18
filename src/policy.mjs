import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { oneLine, textField } from "./coordination.mjs";
import { NO_WRITE, reviseJsonFile } from "./atomic-json.mjs";

// Visibility policy. A small rules file in the store decides which sessions
// are visible to which operations: a `sessions` listing hides denied records,
// a mailbox read hides messages whose either end is denied, and a delivery to
// a denied target is refused with a warning instead of attempted.
//
// The posture is open by default: no file, or a rule list that matches
// nothing, allows everything, so the operator only ever writes deny rules.
// Rules are matched in file order and the first match wins; a rule matches
// when every match field it declares is a case-insensitive prefix of the
// subject's value for that field.

const MATCH_FIELDS = ["repo", "ref", "session"];

export function policyPath(store) {
  return join(store.directory, "state.policy.json");
}

function readRules(store) {
  try {
    const value = JSON.parse(readFileSync(policyPath(store), "utf8"));
    return Array.isArray(value?.rules) ? value.rules : [];
  } catch {
    return [];
  }
}

export function listPolicyRules(store) {
  return readRules(store);
}

function prefixMatches(pattern, value) {
  if (pattern === null || pattern === undefined || pattern === "") return true;
  if (value === null || value === undefined || value === "") return false;
  return String(value).toLowerCase().startsWith(String(pattern).toLowerCase());
}

// One access question: is this subject allowed this action? Returns the
// decision and the rule that decided it, so refusals can name their rule.
export function policyDecide(store, subject = {}, action = "read") {
  for (const rule of readRules(store)) {
    const match = rule?.match ?? {};
    if (!MATCH_FIELDS.every((field) => prefixMatches(match[field], subject?.[field]))) continue;
    return { allowed: Array.isArray(rule?.allow) && rule.allow.includes(action), rule: oneLine(rule?.id) || null };
  }
  return { allowed: true, rule: null };
}

// The warning line a refused call reports, or null when the access is allowed.
export function policyRefusal(store, subject, action) {
  const decision = policyDecide(store, subject, action);
  return decision.allowed ? null : `refused by policy rule ${decision.rule ?? "unknown"}`;
}

// A session record's visibility subject. The repo is the name the session
// worked under — the basename of its recorded tree or cwd when state has one,
// else its title, else its ref — because rules are written against repo
// names ("Praxis Active"), not absolute paths.
export function sessionSubject(record = {}) {
  const ref = oneLine(record?.sessionRef) || null;
  const place = oneLine(record?.worktree) || oneLine(record?.directory) || null;
  const repo = place ? basename(place) : oneLine(record?.title) || ref;
  const session = ref && ref.includes(":") ? ref.slice(ref.indexOf(":") + 1) : ref;
  return { repo, ref, session };
}

// A session-ref's subject: the ref itself, its id half, and no repo — an
// address known only by name cannot confirm a repo match, so a repo rule
// never refuses one.
export function refSubject(value) {
  const ref = oneLine(value) || null;
  const session = ref && ref.includes(":") ? ref.slice(ref.indexOf(":") + 1) : ref;
  return { repo: null, ref, session };
}

// A message is visible only when both of its ends are: a deny on one side
// hides the message from every mailbox that would otherwise show it.
export function messageVisible(store, message, action = "read") {
  for (const field of ["sessionRef", "to"]) {
    if (!policyDecide(store, refSubject(message?.[field]), action).allowed) return false;
  }
  return true;
}

let ruleCounter = 0;

// Same shape as the store's record ids: a test seam keeps its short values
// byte-identical, the default gains a uniqueness tail.
function newRuleId(random) {
  const suffix = String(random()).replace(/[^a-zA-Z0-9]/g, "").slice(0, 12) || "local";
  if (random !== Math.random) return `p_${suffix}`;
  ruleCounter = (ruleCounter + 1) % Number.MAX_SAFE_INTEGER;
  return `p_${suffix.slice(0, 8)}${Date.now().toString(36)}${ruleCounter.toString(36)}`;
}

// Only deny rules are written: the default posture is already allow, so a
// rule with no match field at all is refused rather than stored as a
// deny-everything accident.
export function addPolicyRule(store, input = {}, { random = Math.random } = {}) {
  const match = {};
  for (const field of MATCH_FIELDS) {
    const value = textField(input[field]);
    if (value) match[field] = value;
  }
  if (!MATCH_FIELDS.some((field) => field in match)) return null;
  const note = textField(input.note);
  const rule = { id: newRuleId(random), match, allow: [] };
  if (note) rule.note = note;
  reviseJsonFile(policyPath(store), { rules: [] }, (value) => {
    const rules = Array.isArray(value?.rules) ? value.rules : [];
    return { rules: [...rules, rule] };
  });
  return rule;
}

export function removePolicyRule(store, ruleId) {
  const wanted = oneLine(ruleId);
  if (!wanted) return false;
  let removed = false;
  reviseJsonFile(policyPath(store), { rules: [] }, (value) => {
    const rules = Array.isArray(value?.rules) ? value.rules : [];
    const kept = rules.filter((rule) => rule?.id !== wanted);
    if (kept.length === rules.length) return NO_WRITE;
    removed = true;
    return { rules: kept };
  });
  return removed;
}

// One line per rule, match fields shown as prefix patterns.
export function renderPolicyRule(rule) {
  const match = MATCH_FIELDS
    .map((field) => [field, rule?.match?.[field]])
    .filter(([, value]) => value)
    .map(([field, value]) => `${field}~ ${oneLine(value)}`)
    .join(", ");
  return `${oneLine(rule?.id)} · deny · ${match || "everything"}${rule?.note ? ` · ${oneLine(rule.note)}` : ""}`;
}

// The operator's stated baseline: sessions worked under a "Praxis Active"
// repo are hidden, unread, and undeliverable, which is what keeps free-model
// sessions from seeing Praxis work. Installing twice does not duplicate the
// rule — the first match already decides, so an identical match returns the
// rule that owns it.
const DEFAULTS_MATCH = { repo: "Praxis Active" };
const DEFAULTS_NOTE = "free-model sessions must not see Praxis Active work";

export function installPolicyDefaults(store) {
  const installed = readRules(store).find((rule) => JSON.stringify(rule?.match ?? {}) === JSON.stringify(DEFAULTS_MATCH));
  if (installed) return renderPolicyRule(installed);
  return renderPolicyRule(addPolicyRule(store, { ...DEFAULTS_MATCH, note: DEFAULTS_NOTE }));
}
