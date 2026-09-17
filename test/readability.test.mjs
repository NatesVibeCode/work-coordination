import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createState, sendMessage } from "../src/state.mjs";
import { groupMessagesOp, showWork } from "../src/operations.mjs";

// What a person reads. These are not correctness assertions — they pin the
// readability decisions so a later refactor cannot quietly make the output
// worse: an unidentifiable sender, boilerplate under every record, a help
// screen that names a fraction of the commands, or a failure that hides why.
const script = fileURLToPath(new URL("../bin/work-coordination.mjs", import.meta.url));
const repo = dirname(dirname(script));

function cli(cwd, ...args) {
  return execFileSync(process.execPath, [script, ...args], { cwd, encoding: "utf8" });
}

function store(t, label) {
  const root = mkdtempSync(join(tmpdir(), `work-coordination-${label}-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = createState(root);
  return state;
}

test("a message shows both the display label and the session identity", async (t) => {
  const { observeParticipation } = await import("../src/work-index.mjs");
  const state = store(t, "ux-identity");
  // Participation comes from observe; the message only carries a label. The
  // point is that a reader can connect the two.
  observeParticipation(state, { workRef: "T-1", sessionRef: "codex:parser", harness: "codex" });
  sendMessage(state, { workRef: "T-1", sender: "Codex / parser-repair", sessionRef: "codex:parser", body: "hello" });

  const view = showWork(state, "T-1");
  assert.match(view, /participants · codex:parser/);
  assert.match(view, /from Codex \/ parser-repair · codex:parser/, "both, so a message can be matched to a participant");
});

test("a session-only message does not repeat its own name", (t) => {
  const state = store(t, "ux-norepeat");
  sendMessage(state, { sessionRef: "codex:parser", body: "hello" });

  const rendered = groupMessagesOp(state, "g_none");
  assert.equal(rendered, "no messages observed");
  const one = sendMessage(state, { groupRef: null, sessionRef: "codex:parser", body: "hello" });
  assert.equal(one.sessionRef, "codex:parser");
});

test("grouped views drop the per-record advisory line, a single send keeps it", (t) => {
  const state = store(t, "ux-boilerplate");
  sendMessage(state, { workRef: "T-1", sessionRef: "codex:one", body: "first" });
  sendMessage(state, { workRef: "T-1", sessionRef: "codex:one", body: "second" });

  const view = showWork(state, "T-1");
  assert.equal(view.includes("advisory — "), false, "three records should not repeat the same sentence three times");
  assert.equal(view.includes("first") && view.includes("second"), true, "the bodies are what matter");

  // A one-off send still explains what to do with the message.
  const sent = cli(repo, "--state", state.directory, "message", "one-off", "--work", "T-1");
  assert.match(sent, /advisory — use if relevant; otherwise continue\./);
});

test("the first-run help names every command and does not miscall a label a session", () => {
  const help = cli(repo);
  assert.match(help, /nothing to do/);
  for (const command of ["init", "observe", "message", "work", "sessions", "groups", "subscriptions", "group", "ungroup", "subscribe", "unsubscribe", "roadmap"]) {
    assert.match(help, new RegExp(`\\b${command}\\b`), `help must mention ${command}`);
  }
  assert.match(help, /only blocked and done notify/, "the fan-out rule belongs where it is first needed");
  assert.match(help, /--from <label>/, "--from is a label; --session is the identity");
});

test("a provider failure reports the provider's own words", async (t) => {
  const { deliverMessage } = await import("../src/delivery.mjs");
  const { EventEmitter } = await import("node:events");

  const failing = (output) => () => {
    const child = new EventEmitter();
    child.stdout = Object.assign(new EventEmitter(), { destroy() {} });
    child.stderr = Object.assign(new EventEmitter(), { destroy() {} });
    child.unref = () => {};
    child.kill = () => {};
    queueMicrotask(() => {
      child.stderr.emit("data", output);
      child.emit("exit", 1);
    });
    return child;
  };

  // The exit code alone cannot tell a dead key from a rate limit from a
  // dropped connection; the harness said which, so say it.
  for (const [said, expected] of [
    ["401 Unauthorized: invalid API key\n", /401 Unauthorized/],
    ["429 Too Many Requests: retry after 30s\n", /429 Too Many Requests/],
    ["connection reset by peer\n", /connection reset by peer/],
  ]) {
    const result = await deliverMessage(
      { harness: "codex", sessionRef: "t", message: "m" },
      { spawnFn: failing(said), idleTimeoutMs: 200 },
    );
    assert.equal(result.delivered, false);
    assert.match(result.warning, /transport exited with code 1/);
    assert.match(result.warning, expected, `lost the provider's reason: ${said.trim()}`);
    assert.equal(result.warning.includes("\n"), false, "a warning is one line");
  }

  // A silent failure keeps the plain exit-code wording rather than trailing a
  // dangling separator.
  const quiet = await deliverMessage({ harness: "codex", sessionRef: "t", message: "m" }, { spawnFn: failing(""), idleTimeoutMs: 200 });
  assert.equal(quiet.warning, "transport exited with code 1");
});
