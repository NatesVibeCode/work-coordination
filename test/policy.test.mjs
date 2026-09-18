import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replaceJsonFile } from "../src/atomic-json.mjs";
import { createState } from "../src/state.mjs";
import { observeParticipation } from "../src/work-index.mjs";
import { policyDecide, refSubject, sessionSubject } from "../src/policy.mjs";
import { renderUnread } from "../src/mailbox.mjs";
import {
  listSessions,
  policyAddOp,
  policyDefaultsOp,
  policyListOp,
  policyRemoveOp,
  sendAdvisory,
  showWork,
  subscribeOp,
} from "../src/operations.mjs";

function store(t, name = "policy-") {
  const root = mkdtempSync(join(tmpdir(), name));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return createState(root);
}

function run(root, ...args) {
  return execFileSync(process.execPath, ["bin/work-coordination.mjs", "--state", root, ...args], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });
}

test("no matching rule allows every action", (t) => {
  const s = store(t);
  const subject = sessionSubject({ sessionRef: "opencode:free", worktree: "/repos/Praxis Active Core" });
  for (const action of ["read", "message", "list"]) {
    assert.deepEqual(policyDecide(s, subject, action), { allowed: true, rule: null });
  }
  observeParticipation(s, { sessionRef: "opencode:free", worktree: "/repos/Praxis Active Core" }, { now: 1_000 });
  assert.match(listSessions(s), /opencode:free/);
});

test("first matching rule wins", (t) => {
  const s = store(t);
  replaceJsonFile(join(s.directory, "state.policy.json"), {
    rules: [
      { id: "p_first", match: { ref: "opencode" }, allow: ["read", "list"] },
      { id: "p_second", match: { ref: "opencode" }, allow: [] },
    ],
  });
  // The first rule decides even though the second would deny.
  assert.deepEqual(policyDecide(s, refSubject("opencode:free"), "list"), { allowed: true, rule: "p_first" });
  assert.deepEqual(policyDecide(s, refSubject("opencode:free"), "message"), { allowed: false, rule: "p_first" });
  // A subject the rules do not match stays open.
  assert.deepEqual(policyDecide(s, refSubject("codex:one"), "read"), { allowed: true, rule: null });
});

test("a deny rule hides the session from the listing", (t) => {
  const s = store(t);
  observeParticipation(s, { sessionRef: "codex:keeper", worktree: "/repos/Praxis Active Ledger" }, { now: 1_000 });
  observeParticipation(s, { sessionRef: "opencode:free", worktree: "/repos/work-coordination" }, { now: 2_000 });
  assert.match(listSessions(s), /codex:keeper/);
  policyAddOp(s, { repo: "Praxis Active", note: "baseline" });
  const listed = listSessions(s);
  assert.doesNotMatch(listed, /codex:keeper/);
  assert.match(listed, /opencode:free/);
});

test("policy-defaults installs the operator baseline once, by tree or title", (t) => {
  const s = store(t);
  observeParticipation(s, { sessionRef: "codex:keeper", worktree: "/repos/Praxis Active Ledger" }, { now: 1_000 });
  observeParticipation(s, { sessionRef: "codex:titled", title: "Praxis Active Ledger" }, { now: 1_500 });
  observeParticipation(s, { sessionRef: "codex:other", worktree: "/repos/work-coordination" }, { now: 2_000 });
  const installed = policyDefaultsOp(s);
  assert.match(installed, /deny · repo~ Praxis Active/);
  // Installing twice does not duplicate the rule: the first match already decides.
  assert.equal(policyDefaultsOp(s), installed);
  assert.equal(policyListOp(s).split("\n").length, 1);
  const listed = listSessions(s);
  assert.doesNotMatch(listed, /codex:keeper/);
  assert.doesNotMatch(listed, /codex:titled/);
  assert.match(listed, /codex:other/);
});

test("a deny rule blocks inbox reads in both directions", async (t) => {
  const s = store(t);
  await sendAdvisory(s, { body: "from the denied side", sender: "keeper", sessionRef: "codex:praxis-1", to: "opencode:free" });
  await sendAdvisory(s, { body: "towards the denied side", sender: "free", sessionRef: "opencode:free", to: "codex:praxis-1" });
  await sendAdvisory(s, { body: "ordinary mail", sender: "other", sessionRef: "codex:other", to: "opencode:free" });
  policyAddOp(s, { session: "praxis" });
  const inbox = renderUnread(s, "opencode:free");
  // From: a message sent by a denied session is withheld.
  assert.doesNotMatch(inbox, /from the denied side/);
  assert.match(inbox, /ordinary mail/);
  // To: a denied session reads nothing at all.
  assert.equal(renderUnread(s, "codex:praxis-1"), "");
});

test("delivery to a denied target is refused with a warning", async (t) => {
  const s = store(t);
  const rule = policyAddOp(s, { ref: "codex:praxis" });
  const ruleId = rule.split(" ")[0];
  // Explicit --deliver target.
  const sent = await sendAdvisory(s, { body: "crossing the line", to: "codex:praxis-1", target: "codex:praxis-1", deliver: true });
  assert.match(sent, new RegExp(`delivery unavailable · refused by policy rule ${ruleId}`));
  // Fan-out to a subscribed target.
  subscribeOp(s, { sessionRef: "opencode:free", target: "codex:praxis-2" });
  const fanned = await sendAdvisory(s, { body: "done", sessionRef: "opencode:free", status: "done" });
  assert.match(fanned, /notified codex:praxis-2 · delivery unavailable · refused by policy rule/);
  // An unrefused target still gets the ordinary transport answer.
  const allowed = await sendAdvisory(s, { body: "fine", to: "codex:other", target: "codex:other", deliver: true });
  assert.doesNotMatch(allowed, /refused by policy/);
  assert.match(allowed, /delivery unavailable/);
});

test("a work read withholds denied records", (t) => {
  const s = store(t);
  observeParticipation(s, { workRef: "Praxis task", sessionRef: "codex:keeper", worktree: "/repos/Praxis Active Ledger" }, { now: 1_000 });
  policyAddOp(s, { repo: "Praxis Active" });
  assert.equal(showWork(s, "Praxis task"), "work context withheld by policy");
});

test("policy add, list, and remove round-trip", (t) => {
  const s = store(t);
  assert.equal(policyListOp(s), "no policy rules");
  const added = policyAddOp(s, { repo: "Praxis Active", note: "baseline" });
  assert.match(added, /^p_\S+ · deny · repo~ Praxis Active · baseline$/);
  assert.equal(policyListOp(s), added);
  const id = added.split(" ")[0];
  assert.equal(policyRemoveOp(s, id), "policy rule removed");
  assert.equal(policyListOp(s), "no policy rules");
  assert.equal(policyRemoveOp(s, id), "policy rule unavailable");
});

test("both frontends expose the policy ops", (t) => {
  const s = store(t, "policy-cli-");
  const added = run(s.directory, "policy-add", "deny", "--repo", "Praxis Active", "--note", "baseline");
  assert.match(added, /deny · repo~ Praxis Active · baseline/);
  assert.equal(run(s.directory, "policy-list"), added);
  const id = added.split(" ")[0];
  assert.equal(run(s.directory, "policy-remove", id).trim(), "policy rule removed");
  assert.equal(run(s.directory, "policy-list").trim(), "no policy rules");
  // A rule with no match field is a malformed call, not an empty success.
  let failed = null;
  try {
    run(s.directory, "policy-add", "deny", "--note", "oops");
  } catch (error) {
    failed = error;
  }
  assert.equal(failed?.status, 1);
  assert.match(String(failed?.stdout ?? ""), /policy-add needs at least one of --repo, --ref, --session/);
});
