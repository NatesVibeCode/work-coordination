import { spawn as systemSpawn } from "node:child_process";

function text(value) {
  return String(value ?? "").trim();
}

// A fan-out must never turn one unreachable target into a wall the others
// wait behind: each delivery keeps its own idle timeout, and they run
// together (bounded) instead of end to end. Results stay in input order so
// callers render a stable list, and a throwing delivery becomes a reported
// failure instead of a fatal one.
export async function mapBounded(items, limit, operation) {
  const values = [...items];
  const results = new Array(values.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, Number(limit) || 1), values.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= values.length) return;
      try {
        results[index] = await operation(values[index], index);
      } catch (error) {
        results[index] = { delivered: false, transport: null, warning: String(error?.message ?? error) };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

function transportFor(harness) {
  if (harness === "codex") {
    return {
      cmd: "codex",
      argv: (sessionRef, message) => ["queue", "--thread", sessionRef, "--message", message],
      transport: "codex-queue",
    };
  }
  if (harness === "pi") {
    return {
      cmd: "pi",
      argv: (sessionRef, message) => [
        "--control-session", sessionRef,
        "--send-session-message", message,
        "--send-session-mode", "steer",
        "--send-session-wait", "turn_end",
      ],
      transport: "pi-session-control",
    };
  }
  if (harness === "hermes") {
    return {
      cmd: "hermes",
      argv: (sessionRef, message) => ["peer", "dm", sessionRef, message],
      transport: "hermes-peer-dm",
    };
  }
  return null;
}

// The idle timeout is the one number a caller can get catastrophically wrong:
// `Infinity` reads as "wait forever" but reaches setTimeout as 1ms (Node clamps
// it), so an unbounded wait becomes an instant failure with a nonsense
// message. Validate once here so the CLI, the MCP tool, and the library all
// behave the same; `undefined` means "not supplied" and takes the default.
function usableTimeout(value, fallback) {
  if (value === undefined || value === null) return { ok: true, ms: fallback };
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms < 1) return { ok: false, ms: fallback };
  return { ok: true, ms };
}

export async function deliverMessage(input = {}, { spawnFn = systemSpawn, idleTimeoutMs = 60_000 } = {}) {
  const harness = text(input.harness).toLowerCase();
  const sessionRef = text(input.sessionRef);
  const message = String(input.message ?? "");
  if (!harness || !sessionRef || !message) {
    return { delivered: false, transport: null, warning: "message destination unavailable" };
  }
  const timeout = usableTimeout(idleTimeoutMs, 60_000);
  if (!timeout.ok) {
    return {
      delivered: false,
      transport: null,
      warning: `message not sent · idleTimeoutMs must be a finite number >= 1 (got ${String(idleTimeoutMs)})`,
    };
  }
  const route = transportFor(harness);
  if (!route) {
    return { delivered: false, transport: null, warning: `no verified local message transport for ${harness}` };
  }
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnFn(route.cmd, route.argv(sessionRef, message), { stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({ delivered: false, transport: null, warning: error?.message ?? String(error) });
      return;
    }
    let done = false;
    let timer = null;
    // The child is never allowed to hold the process open. A harness CLI can
    // leave a grandchild behind holding these pipes; if that outlived us, a
    // finished send would keep the whole command alive with nothing left to
    // report. Reporting ends, then the process ends.
    const release = () => {
      try { child.stdout?.destroy(); } catch {}
      try { child.stderr?.destroy(); } catch {}
      try { child.unref?.(); } catch {}
    };
    const finish = (result) => {
      if (done) return;
      done = true;
      if (timer !== null) clearTimeout(timer);
      resolve(result);
    };
    const arm = () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        finish({ delivered: false, transport: null, warning: `transport idle timeout after ${timeout.ms}ms without activity` });
        try { child.kill("SIGKILL"); } catch {}
        release();
      }, timeout.ms);
    };
    arm();
    const poke = () => { if (!done) arm(); };
    try {
      child.stdout?.on("data", poke);
      child.stderr?.on("data", poke);
    } catch {}
    child.on("error", (error) => {
      finish({ delivered: false, transport: null, warning: error?.message ?? String(error) });
      release();
    });
    // `exit`, not `close`: close waits for every inherited pipe to shut, and a
    // harness that left a grandchild holding one would stall the report.
    child.on("exit", (code) => {
      finish(code === 0
        ? { delivered: true, transport: route.transport, warning: null }
        : { delivered: false, transport: null, warning: `transport exited with code ${code}` });
      release();
    });
  });
}
