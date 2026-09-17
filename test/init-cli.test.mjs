import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../bin/work-coordination.mjs", import.meta.url));

// A machine without git is a supported machine: init works outside a
// repository, so the git-dependent cases say they were skipped instead of
// turning the suite red.
function gitAvailable() {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const GIT = gitAvailable() ? null : "git is not on PATH — this case needs a real repository";

test("init creates and selects a repository-local coordination state", (t) => {
  const root = mkdtempSync(join(tmpdir(), "work-coordination-init-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const output = execFileSync(process.execPath, [script, "init"], { cwd: root, encoding: "utf8" });
  assert.match(output, /initialized · .*\.work-coordination/);
  assert.equal(existsSync(join(root, ".work-coordination", "messages")), true);
  assert.match(execFileSync(process.execPath, [script, "sessions"], { cwd: root, encoding: "utf8" }), /no sessions observed/);
});

test("init from a subdirectory uses the Git worktree root", (t) => {
  if (GIT) return t.skip(GIT);
  const root = mkdtempSync(join(tmpdir(), "work-coordination-init-root-"));
  const nested = join(root, "nested", "deeper");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  mkdirSync(nested, { recursive: true });

  execFileSync(process.execPath, [script, "init"], { cwd: nested, encoding: "utf8" });
  assert.equal(existsSync(join(root, ".work-coordination", "messages")), true);
  assert.equal(existsSync(join(nested, ".work-coordination")), false);
});

test("init hides its private state in the local Git exclude file", (t) => {
  if (GIT) return t.skip(GIT);
  const root = mkdtempSync(join(tmpdir(), "work-coordination-init-git-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet"], { cwd: root });

  execFileSync(process.execPath, [script, "init"], { cwd: root, encoding: "utf8" });
  assert.match(readFileSync(join(root, ".git", "info", "exclude"), "utf8"), /^\.work-coordination\/$/m);
});

test("init still works outside a Git repository", (t) => {
  const root = mkdtempSync(join(tmpdir(), "work-coordination-init-nogit-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const output = execFileSync(process.execPath, [script, "init"], { cwd: root, encoding: "utf8" });
  assert.match(output, /initialized · .*\.work-coordination/);
  assert.equal(existsSync(join(root, ".work-coordination", "messages")), true);
});
