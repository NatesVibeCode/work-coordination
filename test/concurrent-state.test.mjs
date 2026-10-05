import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { identityHash, readJsonFile, readJsonStateFile, reviseJsonFile, StateConflictError, writeJsonRecord } from "../src/atomic-json.mjs";
import { createState } from "../src/state.mjs";
import { readBusinessCases, BUSINESS_CASE_VIEW_SCHEMA } from "../src/business-cases.mjs";
import { renderUnread, unreadFor } from "../src/mailbox.mjs";
import { sendAdvisory, stateStatus } from "../src/operations.mjs";
import { sendMessage } from "../src/state.mjs";

const repo = fileURLToPath(new URL("..", import.meta.url));
const cli = join(repo, "bin", "work-coordination.mjs");

async function withStore(run) {
  const directory = mkdtempSync(join(tmpdir(), "work-coordination-concurrent-state-"));
  try { return await run(createState(directory), directory); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}

function businessView(id) {
  return { schema: BUSINESS_CASE_VIEW_SCHEMA, case: { id, revision: 1, disposition: "pending" } };
}

function spawnRecord(directory, index) {
  const view = businessView(`case:${index}`);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "--state", directory, "business-case-record", "--view", JSON.stringify(view)], {
      cwd: repo,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve(stdout) : reject(new Error(`writer ${index} exited ${code}: ${stdout}${stderr}`)));
  });
}

test("independent multiprocess business-case mutations survive deterministic fold", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "work-coordination-race-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const writers = Array.from({ length: 24 }, (_, index) => spawnRecord(directory, index));
  const outputs = await Promise.all(writers);
  assert.equal(outputs.length, 24);
  const records = readBusinessCases(createState(directory)).records;
  assert.equal(records.length, 24);
  assert.deepEqual(new Set(records.map((record) => record.case.id)), new Set(Array.from({ length: 24 }, (_, index) => `case:${index}`)));
  assert.equal(stateStatus(createState(directory)), "state · consistent");
});

test("a stale conditional revision returns a typed conflict and preserves the winner", () => withStore((_store, directory) => {
  const path = join(directory, "conditional.json");
  const fallback = [{ id: "resource:one", revision: 1, value: "base" }];
  const before = readJsonStateFile(path, fallback);
  reviseJsonFile(path, fallback, (rows) => rows.map((row) => ({ ...row, revision: 2, value: "accepted" })), { now: 10 });

  assert.throws(() => reviseJsonFile(path, fallback, (rows) => rows.map((row) => ({ ...row, revision: 2, value: "stale" })), {
    expectedRevisionToken: before.revisionToken,
  }), (error) => error instanceof StateConflictError && error.code === "STATE_CONFLICT");
  assert.deepEqual(readJsonFile(path, fallback), [{ id: "resource:one", revision: 2, value: "accepted" }]);
}));

test("equal-time mail is acknowledged by exact immutable message ID across restart", async () => withStore(async (store, directory) => {
  for (const ref of ["mail-a", "mail-b"]) sendMessage(store, { ref, to: "codex:recipient", body: ref }, { now: 100 });
  const first = renderUnread(store, "codex:recipient");
  assert.match(first, /mailbox \(2\)/);
  assert.match(first, /mail-a/);
  assert.match(first, /mail-b/);
  const restarted = createState(directory);
  assert.equal(renderUnread(restarted, "codex:recipient"), "");
  assert.deepEqual(unreadFor(restarted, "codex:recipient"), []);
}));

test("recipient identity filenames cannot collide through punctuation sanitization", async () => withStore(async (store) => {
  await sendAdvisory(store, { body: "slash recipient", to: "codex:one/a" });
  await sendAdvisory(store, { body: "question recipient", to: "codex:one?a" });
  assert.match(renderUnread(store, "codex:one/a"), /slash recipient/);
  assert.match(renderUnread(store, "codex:one?a"), /question recipient/);
}));

test("truncated mailbox receipts stay unknown and are not treated as unread permission", async () => withStore(async (store, directory) => {
  await sendAdvisory(store, { body: "do not resend on damaged receipt", to: "codex:recipient" });
  const mailbox = join(directory, "mailbox", identityHash("recipient", "codex:recipient"));
  mkdirSync(mailbox, { recursive: true });
  writeFileSync(join(mailbox, "torn.json"), "{\"schema\":");
  const rendered = renderUnread(store, "codex:recipient");
  assert.match(rendered, /mailbox · state unknown/);
  assert.match(rendered, /unread mail withheld/);
  assert.deepEqual(unreadFor(store, "codex:recipient"), []);
  assert.match(stateStatus(store), /state · gap · mailbox\/.*\/torn\.json/);
}));

test("state-status reports an unknown mutation record and the read refuses it", () => withStore((_store, directory) => {
  const path = join(directory, "broken.json");
  const journal = `${path}.journal`;
  mkdirSync(journal, { recursive: true });
  writeFileSync(join(journal, "unknown.json"), "{\"schema\":");
  assert.throws(() => readJsonFile(path, []), (error) => error.code === "STATE_UNKNOWN");
  assert.match(stateStatus(createState(directory)), /state · gap · broken\.json\.journal\/unknown\.json/);
}));

test("the actual CLI exposes read-only state status without creating a store", () => {
  const root = mkdtempSync(join(tmpdir(), "work-coordination-state-status-cli-"));
  try {
    const run = () => execFileSync(process.execPath, [cli, "--state", join(root, ".work-coordination"), "state-status"], { cwd: repo, encoding: "utf8" });
    assert.equal(run(), "state · consistent\n");
    assert.equal(existsSync(join(root, ".work-coordination")), false);
    const journal = join(root, ".work-coordination", "messages.json.journal");
    mkdirSync(journal, { recursive: true });
    writeFileSync(join(journal, "partial.json"), "{\"schema\":");
    assert.match(run(), /state · gap · messages\.json\.journal\/partial\.json/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("immutable state identity refuses a different record instead of replacing it", () => withStore((_store, directory) => {
  const path = join(directory, "immutable", "entry.json");
  writeJsonRecord(path, { schema: "example.v1", id: "identity", value: "first" });
  assert.throws(() => writeJsonRecord(path, { schema: "example.v1", id: "identity", value: "second" }), (error) => error.code === "STATE_CONFLICT");
  assert.deepEqual(readJsonFile(path, null), { schema: "example.v1", id: "identity", value: "first" });
}));

test("unpublished mutation is diagnosed without gating independent writers", () => withStore((_store, directory) => {
  const path = join(directory, "pending.json");
  mkdirSync(`${path}.journal`, { recursive: true });
  writeFileSync(join(`${path}.journal`, "record.crash.tmp"), '{"schema":"work-coordination.json-mutation.v1"}');
  // Unpublished bytes have never become a state record; they cannot create
  // an implicit busy gate for independent writers.
  reviseJsonFile(path, [], () => [{id:"independent",value:"retained"}]);
  assert.deepEqual(readJsonFile(path, []), [{id:"independent",value:"retained"}]);
  assert.match(stateStatus(createState(directory)), /state · gap · .*unpublished JSON state record remains/);
}));

test("JSON prototype-named fields remain data during deterministic mutation folding", () => withStore((_store, directory) => {
  const path = join(directory, "prototype.json");
  const wanted = JSON.parse('{"__proto__":{"polluted":true},"ordinary":7}');
  reviseJsonFile(path, {}, () => wanted);
  const actual = readJsonFile(path, {});
  assert.deepEqual(actual, wanted);
  assert.equal(Object.hasOwn(actual, "__proto__"), true);
  assert.equal(Object.getPrototypeOf(actual), Object.prototype);
  assert.equal({}.polluted, undefined);
}));
