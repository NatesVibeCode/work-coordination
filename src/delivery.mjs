import { execFileSync as systemExecFileSync } from "node:child_process";

function text(value) {
  return String(value ?? "").trim();
}

export function deliverMessage(input = {}, { execFileSync = systemExecFileSync } = {}) {
  const harness = text(input.harness).toLowerCase();
  const sessionRef = text(input.sessionRef);
  const message = String(input.message ?? "");
  if (!harness || !sessionRef || !message) {
    return { delivered: false, transport: null, warning: "message destination unavailable" };
  }
  try {
    if (harness === "codex") {
      execFileSync("codex", ["queue", "--thread", sessionRef, "--message", message], { stdio: "ignore" });
      return { delivered: true, transport: "codex-queue", warning: null };
    }
    if (harness === "pi") {
      execFileSync("pi", [
        "--control-session", sessionRef,
        "--send-session-message", message,
        "--send-session-mode", "steer",
        "--send-session-wait", "turn_end",
      ], { stdio: "ignore" });
      return { delivered: true, transport: "pi-session-control", warning: null };
    }
    if (harness === "hermes") {
      // Hermes documents `peer dm` as its direct CLI send seam; use its exit
      // status for handoff instead of scraping TUI gateway or command output.
      execFileSync("hermes", ["peer", "dm", sessionRef, message], { stdio: "ignore" });
      return { delivered: true, transport: "hermes-peer-dm", warning: null };
    }
  } catch (error) {
    return { delivered: false, transport: null, warning: error.message };
  }
  return { delivered: false, transport: null, warning: `no verified local message transport for ${harness}` };
}
