import { spawn as systemSpawn } from "node:child_process";

function text(value) {
  return String(value ?? "").trim();
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

export async function deliverMessage(input = {}, { spawnFn = systemSpawn, idleTimeoutMs = 60_000 } = {}) {
  const harness = text(input.harness).toLowerCase();
  const sessionRef = text(input.sessionRef);
  const message = String(input.message ?? "");
  if (!harness || !sessionRef || !message) {
    return { delivered: false, transport: null, warning: "message destination unavailable" };
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
    const finish = (result) => {
      if (done) return;
      done = true;
      if (timer !== null) clearTimeout(timer);
      resolve(result);
    };
    const arm = () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        finish({ delivered: false, transport: null, warning: `transport idle timeout after ${idleTimeoutMs}ms without activity` });
        try { child.kill(); } catch {}
      }, Math.max(0, Number(idleTimeoutMs) || 0));
    };
    arm();
    const poke = () => { if (!done) arm(); };
    try {
      child.stdout?.on("data", poke);
      child.stderr?.on("data", poke);
    } catch {}
    child.on("error", (error) => finish({ delivered: false, transport: null, warning: error?.message ?? String(error) }));
    child.on("close", (code) => finish(code === 0
      ? { delivered: true, transport: route.transport, warning: null }
      : { delivered: false, transport: null, warning: `transport exited with code ${code}` }));
  });
}
