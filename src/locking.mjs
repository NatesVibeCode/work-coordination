import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const waitCell = new Int32Array(new SharedArrayBuffer(4));

function pause(ms) {
  Atomics.wait(waitCell, 0, 0, ms);
}

function ownerIsDead(path, staleMs) {
  try {
    const owner = JSON.parse(readFileSync(join(path, "owner.json"), "utf8"));
    const pid = Number(owner?.pid);
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        return false;
      } catch (error) {
        return error?.code === "ESRCH";
      }
    }
  } catch {}
  try {
    return Date.now() - statSync(path).mtimeMs >= staleMs;
  } catch {
    return false;
  }
}

function claim(path) {
  mkdirSync(path, { mode: 0o700 });
  try {
    writeFileSync(join(path, "owner.json"), JSON.stringify({ pid: process.pid, startedAt: Date.now() }), { mode: 0o600 });
  } catch (error) {
    rmSync(path, { recursive: true, force: true });
    throw error;
  }
}

function reclaim(path, guard, staleMs) {
  try {
    mkdirSync(guard, { mode: 0o700 });
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  }
  try {
    if (ownerIsDead(path, staleMs)) rmSync(path, { recursive: true, force: true });
  } finally {
    rmSync(guard, { recursive: true, force: true });
  }
  return true;
}

export function withLocalLock(directory, name, action, { timeoutMs = 10_000, staleMs = 30_000 } = {}) {
  const path = join(directory, `.lock-${String(name)}`);
  const reclaimGuard = join(directory, `.reclaim-${String(name)}`);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (existsSync(reclaimGuard)) {
      pause(10);
      continue;
    }
    try {
      claim(path);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (ownerIsDead(path, staleMs)) {
        reclaim(path, reclaimGuard, staleMs);
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`local lock unavailable: ${name}`);
      pause(10);
    }
  }
  try {
    return action();
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
}
