import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { oneLine } from "../src/coordination.mjs";
import { createGroup, createState, joinGroup, removeGroup, saveStoreConfig, sendMessage, subscribe } from "../src/state.mjs";

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

test("an unusable idle timeout is refused, not clamped to an instant", async (t) => {
  const { deliverMessage } = await import("../src/delivery.mjs");
  let spawned = 0;
  const spawnFn = () => { spawned += 1; throw new Error("must not spawn"); };

  // Infinity reads as "wait forever" but setTimeout clamps it to 1ms, which
  // turned an unbounded wait into an instant failure.
  for (const value of [Infinity, -Infinity, 0, -5, NaN]) {
    const result = await deliverMessage(
      { harness: "codex", sessionRef: "x", message: "m" },
      { idleTimeoutMs: value, spawnFn },
    );
    assert.equal(result.delivered, false, `expected refusal for ${String(value)}`);
    assert.match(result.warning, /idleTimeoutMs must be a finite number >= 1/, `wrong warning for ${String(value)}`);
  }
  assert.equal(spawned, 0, "a refused timeout must not start a transport");

  // Not supplied means the default, and a usable value still spawns.
  const hung = () => {
    const child = new EventEmitter();
    child.stdout = Object.assign(new EventEmitter(), { destroy() {} });
    child.stderr = Object.assign(new EventEmitter(), { destroy() {} });
    child.unref = () => {};
    child.kill = () => child.emit("exit", null);
    return child;
  };
  const ok = await deliverMessage({ harness: "codex", sessionRef: "x", message: "m" }, { idleTimeoutMs: 25, spawnFn: () => hung() });
  assert.match(ok.warning, /idle timeout after 25ms/);
  assert.equal(ok.warning.includes("Infinity"), false);
});

test("a repeated observation does not grow the log, but recency still advances", async (t) => {
  const { observeParticipation, observedSessions, workView } = await import("../src/work-index.mjs");
  const root = mkdtempSync(join(tmpdir(), "work-coordination-observe-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = createState(root);
  const log = join(store.directory, "participation.jsonl");
  const lines = () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).length;

  for (let index = 0; index < 50; index++) {
    observeParticipation(store, { workRef: "T", sessionRef: "s1", harness: "t" }, { now: 1_000 + index });
  }
  assert.equal(lines(), 1, "50 identical observations in one window said the same thing once");
  assert.equal(observedSessions(store).length, 1);

  // Outside the refresh window the observation is re-declared, and the
  // session's recency must move — `sessions` sorts on it.
  observeParticipation(store, { workRef: "T", sessionRef: "s1", harness: "t" }, { now: 1_000 + 16 * 60 * 1000 });
  assert.equal(lines(), 2);
  assert.equal(observedSessions(store)[0].observedAt, 1_000 + 16 * 60 * 1000);

  // A changed payload appends immediately.
  observeParticipation(store, { workRef: "T", sessionRef: "s1", harness: "t", directory: "/elsewhere" });
  assert.equal(lines(), 3);
  assert.equal(workView(store, "T").participants.length, 1);
});

test("re-joining as an existing member does not grow the member log", (t) => {
  const root = mkdtempSync(join(tmpdir(), "work-coordination-rejoin-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = createState(root);
  const group = createGroup(state, { id: "lane" }, { now: 1_000 });
  for (let index = 0; index < 10; index++) joinGroup(state, group.id, "codex:one", { now: 1_000 + index });

  const logged = readFileSync(join(state.directory, "members.jsonl"), "utf8").trim().split("\n").filter(Boolean);
  assert.equal(logged.length, 1);
  assert.deepEqual(joinGroup(state, group.id, "codex:one", { now: 2_000 }).members, ["codex:one"]);
});

test("a dash-led flag value is refused, and numeric flags keep their own message", (t) => {
  const state = emptyStore(t, "dash-values");
  const dashed = run(repo, "--state", state, "message", "hi", "--work", "-x");
  assert.equal(dashed.status, 1);
  assert.match(dashed.output, /--work needs a value/);

  // "-5" is a number someone meant to supply: the numeric validator's message
  // is the useful one there, not "needs a value".
  for (const args of [["--idle-timeout-ms", "-5"], ["--idle-timeout-ms=-5"]]) {
    const result = run(repo, "--state", state, "message", "hi", ...args);
    assert.equal(result.status, 1, `expected refusal for ${args.join(" ")}`);
    assert.match(result.output, /--idle-timeout-ms needs a number/);
  }
  assert.equal(run(repo, "--state", state, "message", "hi", "--idle-timeout-ms", "500").status, 0);
});

test("every write path uses a unique scratch name and cleans up", (t) => {
  const root = mkdtempSync(join(tmpdir(), "work-coordination-scratch-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = createState(root);

  // Exercise each writer: message, config, group, subscription, membership,
  // observation. Nothing may leave a temp file, and none may be pid-named.
  sendMessage(state, { workRef: "T", body: "one" });
  saveStoreConfig(state.directory, { expiryMs: 900_000 });
  const group = createGroup(state, { id: "lane" }, { now: 1_000 });
  joinGroup(state, group.id, "codex:one", { now: 1_000 });
  subscribe(createState(root), { sessionRef: "lane-1", target: "codex:x" });
  removeGroup(createState(root), group.id);

  const walk = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [entry.name];
  });
  const files = walk(state.directory);
  assert.deepEqual(files.filter((name) => name.endsWith(".tmp")), [], "a store holds state records and nothing else");
  for (const name of files) {
    assert.equal(/\.\d+\.tmp$/.test(name), false, `pid-named scratch file survived: ${name}`);
  }
});
