import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { oneLine } from "../src/coordination.mjs";
import { createGroup, createState, joinGroup, sendMessage } from "../src/state.mjs";

const script = fileURLToPath(new URL("../bin/work-coordination.mjs", import.meta.url));
const repo = dirname(dirname(script));

function run(cwd, ...args) {
  try {
    return { status: 0, output: execFileSync(process.execPath, [script, ...args], { cwd, encoding: "utf8" }) };
  } catch (error) {
    return { status: error.status ?? 1, output: String(error.stdout ?? "") };
  }
}

function emptyStore(t, label) {
  const root = mkdtempSync(join(tmpdir(), `work-coordination-${label}-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = join(root, "state");
  createState(state);
  return state;
}

test("a typo'd flag is refused instead of becoming message text", (t) => {
  const state = emptyStore(t, "strict-flags");
  const result = run(repo, "--state", state, "message", "hi", "--wrok", "Ticket T-1");

  assert.equal(result.status, 1);
  assert.match(result.output, /unknown flag · --wrok/);
  assert.match(result.output, /--work/);
  // Nothing stored, so the body did not absorb the flag either.
  assert.equal(run(repo, "--state", state, "work", "Ticket T-1").output, "no work context observed\n");
  assert.deepEqual(readdirSync(join(state, "messages")), []);
});

test("a repeated flag is refused rather than silently first-wins", (t) => {
  const state = emptyStore(t, "repeated-flags");
  const result = run(repo, "--state", state, "observe", "--work", "A", "--work", "B", "--session", "s1");

  assert.equal(result.status, 1);
  assert.match(result.output, /repeated flag · --work/);
});

test("a non-numeric idle timeout is refused, not handed to a timer", (t) => {
  const state = emptyStore(t, "timeout-flag");
  for (const value of ["abc", "0", "-5", "Infinity"]) {
    const result = run(repo, "--state", state, "message", "x", "--idle-timeout-ms", value);
    assert.equal(result.status, 1, `expected refusal for ${value}`);
    assert.match(result.output, /--idle-timeout-ms needs a number/);
  }
});

test("--flag=value works and a bare -- lets a body start with a dash", (t) => {
  const state = emptyStore(t, "flag-syntax");
  assert.equal(run(repo, "--state", state, "message", "hello", "--work=Ticket-9").status, 0);
  assert.match(run(repo, "--state", state, "work", "Ticket-9").output, /hello/);

  assert.equal(run(repo, "--state", state, "message", "--work", "Ticket-9", "--", "-dash body").status, 0);
  assert.match(run(repo, "--state", state, "work", "Ticket-9").output, /-dash body/);
});

test("read-only commands answer without creating the store they were pointed at", (t) => {
  const root = mkdtempSync(join(tmpdir(), "work-coordination-readonly-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const absent = join(root, "typoo");

  for (const args of [["sessions"], ["groups"], ["subscriptions"], ["work", "T"], ["group", "messages", "g"], ["roadmap", "k"]]) {
    const result = run(repo, "--state", absent, ...args);
    assert.equal(result.status, 0, `${args.join(" ")} should still answer`);
    assert.equal(existsSync(absent), false, `${args.join(" ")} must not create the store`);
  }

  // The write path does create it: that is exactly the difference.
  assert.equal(run(repo, "--state", absent, "message", "hello").status, 0);
  const files = readdirSync(join(absent, "messages"));
  assert.equal(files.length, 1);
  assert.match(readFileSync(join(absent, "messages", files[0]), "utf8"), /hello/);
});

test("no field can forge a record line", (t) => {
  const state = emptyStore(t, "escaping");
  const forged = "T-2\nforged · Codex";
  run(repo, "--state", state, "observe", "--work", forged, "--session", "s9");

  const listed = run(repo, "--state", state, "sessions").output;
  assert.equal(listed.trimEnd().split("\n").length, 1);
  assert.equal(listed.includes("\nforged"), false);
  assert.match(listed, /T-2 forged · Codex/);

  const body = run(repo, "--state", state, "message", "line1\nline2", "--work", "T-3").output;
  assert.equal(body.includes("\nline2"), false);
  assert.match(body, /line1 line2/);

  const group = run(repo, "--state", state, "group", "create", "my\nforged group").output;
  assert.equal(group.trimEnd().split("\n").length, 1);
  assert.match(group, /my forged group/);
});

test("oneLine collapses control characters and runs of whitespace", () => {
  assert.equal(oneLine("a\nb"), "a b");
  assert.equal(oneLine("a\r\nb"), "a b");
  assert.equal(oneLine("a\tb"), "a b");
  assert.equal(oneLine("a\u0000b"), "a b");
  assert.equal(oneLine("  spaced  out  "), "spaced out");
  assert.equal(oneLine(null), "");
});

test("a group past its TTL refuses a join and writes no member", (t) => {
  const root = mkdtempSync(join(tmpdir(), "work-coordination-dead-group-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = createState(root);
  const group = createGroup(state, { id: "short-lived" }, { now: 1_000, ttlMs: 100 });

  assert.equal(joinGroup(state, group.id, "codex:one", { now: 1_050 }).members.length, 1);
  assert.equal(joinGroup(state, group.id, "codex:two", { now: 2_000 }), null);
  const logged = readFileSync(join(state.directory, "members.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line).member);
  assert.deepEqual(logged, ["codex:one"]);
});

test("message ids do not collide onto one file", (t) => {
  const root = mkdtempSync(join(tmpdir(), "work-coordination-ids-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = createState(root);

  // The real path, in the tightest loop a caller can run: every record keeps
  // its own file, so nothing is silently overwritten. (An injected random
  // source is a deterministic test seam and is deliberately left as given.)
  const refs = Array.from({ length: 25 }, (_, index) => sendMessage(state, { workRef: "T", body: `body ${index}` }).ref);
  assert.equal(new Set(refs).size, refs.length);
  assert.equal(readdirSync(state.messages).length, 25);
  assert.equal(refs.every((ref) => ref.startsWith("m_")), true);
});
