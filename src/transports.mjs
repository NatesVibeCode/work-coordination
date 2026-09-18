// The transport registry: harness-agnostic delivery dispatch. A transport
// knows how to push a message into one harness's live session; the registry
// knows which transport answers for which session ref. A ref is
// "<harness>:<session>", so lookup is by prefix — "codex:one" answers to the
// codex transport, "muse:..." to muse, "opencode:..." to opencode. A prefix
// nobody registered is not an error: the mailbox is the universal pull floor,
// so an unknown ref simply means "no push transport; mailbox only".
import { spawn as systemSpawn } from "node:child_process";
import { oneLine } from "./coordination.mjs";

function text(value) {
  return String(value ?? "").trim();
}

const registry = new Map();

// A transport is { name, prefixes?/matches?, deliver(sessionRef, message,
// options) → { delivered, transport, warning } }. `prefixes` is the usual
// case (matched as "<prefix>:" at the front of the ref); a `matches(ref)`
// function is the escape hatch for routing that a flat prefix cannot express.
export function registerTransport(transport) {
  if (!transport || typeof transport.deliver !== "function") {
    throw new TypeError("a transport must provide deliver(sessionRef, message, options)");
  }
  const name = text(transport.name);
  if (!name) throw new TypeError("a transport must provide a name");
  const hasPrefixes = Array.isArray(transport.prefixes) && transport.prefixes.length > 0;
  if (!hasPrefixes && typeof transport.matches !== "function") {
    throw new TypeError(`transport ${name} must declare prefixes or a matches(sessionRef) function`);
  }
  registry.set(name, transport);
}

export function transportForSessionRef(sessionRef) {
  const ref = text(sessionRef).toLowerCase();
  for (const transport of registry.values()) {
    if (typeof transport.matches === "function") {
      if (transport.matches(ref)) return transport;
      continue;
    }
    if (transport.prefixes.some((prefix) => ref.startsWith(`${text(prefix).toLowerCase()}:`))) {
      return transport;
    }
  }
  return null;
}

export function registeredTransports() {
  return [...registry.values()];
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

// The shared child-process runner underneath every spawn-based transport.
// A fan-out must never turn one unreachable target into a wall the others
// wait behind, so the caller keeps its own idle timeout per delivery; a
// throwing delivery becomes a reported failure instead of a fatal one.
// `input`, when given, is written to the child's stdin (a pipe replaces the
// ignored stdin); otherwise stdin is "ignore" as before.
export async function spawnDelivery({ cmd, argv, transport, input = null }, { spawnFn = systemSpawn, idleTimeoutMs = 60_000 } = {}) {
  const timeout = usableTimeout(idleTimeoutMs, 60_000);
  if (!timeout.ok) {
    return {
      delivered: false,
      transport: null,
      warning: `message not sent · idleTimeoutMs must be a finite number >= 1 (got ${String(idleTimeoutMs)})`,
    };
  }
  return new Promise((resolve) => {
    let child;
    try {
      const stdio = input === null ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"];
      child = spawnFn(cmd, argv, { stdio });
    } catch (error) {
      resolve({ delivered: false, transport: null, warning: error?.message ?? String(error) });
      return;
    }
    if (input !== null) {
      try {
        child.stdin?.on("error", () => {});
        child.stdin?.write(input);
        child.stdin?.end();
      } catch {}
    }
    let done = false;
    let timer = null;
    // A harness says why it failed on stderr — "401 Unauthorized", "429 Too
    // Many Requests", "connection reset". Reporting only the exit code makes
    // every cause look identical, so the tail of that output is kept and
    // reported. Bounded and folded to one line: this becomes user-facing text.
    let complaint = "";
    const remember = (chunk) => {
      complaint = `${complaint}${String(chunk)}`.slice(-400);
    };
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
      child.stderr?.on("data", (chunk) => { remember(chunk); poke(); });
    } catch {}
    child.on("error", (error) => {
      finish({ delivered: false, transport: null, warning: error?.message ?? String(error) });
      release();
    });
    // `exit`, not `close`: close waits for every inherited pipe to shut, and a
    // harness that left a grandchild holding one would stall the report.
    child.on("exit", (code) => {
      if (code === 0) {
        finish({ delivered: true, transport: transport ?? cmd, warning: null });
      } else {
        // The harness's own words are the actionable part; the exit code alone
        // cannot tell a dead key from a rate limit from a dropped connection.
        const said = oneLine(complaint).slice(0, 300);
        finish({
          delivered: false,
          transport: null,
          warning: said ? `transport exited with code ${code} · ${said}` : `transport exited with code ${code}`,
        });
      }
      release();
    });
  });
}

// Each spawn transport addresses the session part of the ref — the half after
// its own prefix. A ref arriving without the prefix (callers that split with
// destinationOf first) is already the session part, so stripping is a no-op.
function sessionPart(prefix, sessionRef) {
  const marked = `${prefix}:`;
  const ref = text(sessionRef);
  return ref.toLowerCase().startsWith(marked) ? ref.slice(marked.length) : ref;
}

function spawnTransport({ name, prefixes, cmd, transport: wireName, argv, input }) {
  return {
    name,
    prefixes,
    deliver(sessionRef, message, options = {}) {
      const ref = sessionPart(prefixes[0], sessionRef);
      return spawnDelivery(
        { cmd, transport: wireName, argv: argv(ref, message), input: input ? input(message) : null },
        options,
      );
    },
  };
}

registerTransport(spawnTransport({
  name: "codex",
  prefixes: ["codex"],
  cmd: "codex",
  transport: "codex-queue",
  argv: (sessionRef, message) => ["queue", "--thread", sessionRef, "--message", message],
}));

registerTransport(spawnTransport({
  name: "pi",
  prefixes: ["pi"],
  cmd: "pi",
  transport: "pi-session-control",
  argv: (sessionRef, message) => [
    "--control-session", sessionRef,
    "--send-session-message", message,
    "--send-session-mode", "steer",
    "--send-session-wait", "turn_end",
  ],
}));

registerTransport(spawnTransport({
  name: "hermes",
  prefixes: ["hermes"],
  cmd: "hermes",
  transport: "hermes-peer-dm",
  argv: (sessionRef, message) => ["peer", "dm", sessionRef, message],
}));

// Muse reads the message body on stdin (`muse session-message send --target
// <session-uuid-or-name> [--json] < body`, per `muse session-message send
// --help`).
registerTransport(spawnTransport({
  name: "muse",
  prefixes: ["muse"],
  cmd: "muse",
  transport: "muse-session-message",
  argv: (sessionRef) => ["session-message", "send", "--target", sessionRef, "--json"],
  input: (message) => message,
}));

// OpenCode is only ever pushed into when a server for the session already
// exists: a configured port (OC_WORKCOORDINATE_PORT, or a per-session port
// handed in by the caller through `portFor`). With no port there is nothing
// to deliver into — and a headless `opencode run` must never be spawned just
// to drop off a message — so the mailbox remains the way mail arrives.
registerTransport({
  name: "opencode",
  prefixes: ["opencode"],
  deliver(sessionRef, message, options = {}) {
    const ref = sessionPart("opencode", sessionRef);
    const port = options.portFor?.(ref) ?? text(process.env.OC_WORKCOORDINATE_PORT);
    if (!port) {
      return Promise.resolve({ delivered: false, transport: null, warning: "no port; mailbox only" });
    }
    const dir = text(options.dir ?? process.env.OC_WORKCOORDINATE_TREE) || process.cwd();
    return spawnDelivery(
      { cmd: "opencode", transport: "opencode-run", argv: ["run", "--session", ref, "--dir", dir, "--port", port] },
      options,
    );
  },
});

// Registry-level delivery by full session ref. An unknown prefix is not an
// error: the mailbox is the universal pull floor, so the report says the
// message waits there instead of pretending a push happened.
export async function deliverBySessionRef(sessionRef, message, options = {}) {
  const transport = transportForSessionRef(sessionRef);
  if (!transport) {
    const prefix = text(sessionRef).toLowerCase().split(":")[0] || "unprefixed";
    return { delivered: false, transport: null, warning: `no transport for ${prefix} · mailbox only` };
  }
  return transport.deliver(sessionRef, message, options);
}
