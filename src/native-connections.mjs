// Read-only native observation and explicitly addressed advisory delivery.
// No launch, resume, latest-session selection, provider call or manager.
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { spawn } from "node:child_process";
import { validateHandoffAssociation } from "./association-contract.mjs";

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export function exactObject(value, required, optional = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || required.some((k) => !Object.hasOwn(value, k))
      || Object.keys(value).some((k) => ![...required, ...optional].includes(k))) {
    throw new TypeError(`expected fields: ${required.join(", ")}; optional: ${optional.join(", ")}`);
  }
}
export function associationFromIdentity(identity) {
  exactObject(identity, ["handoffBinding", "destination", "attempt"]);
  const record = { contract: "work-coordination.handoff-association", schemaVersion: 1, ...identity, observations: [] };
  const result = validateHandoffAssociation(record);
  if (!result.valid) throw new TypeError(result.errors.join("; "));
  if (["latest", "last", "newest", "continue"].includes(record.destination.sessionId.toLowerCase())) {
    throw new TypeError("an exact selected native session ID is required");
  }
  return record;
}
function within(path, root) {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}
// Source byte validation belongs here, before observing or delivering. Edition
// selection is subsequently checked by Mdview's existing publication owner.
export function bindingFreshness(binding, workspace) {
  if (!isAbsolute(workspace ?? "")) throw new TypeError("an explicit absolute workspace is required");
  try {
    realpathSync(workspace);
    const source = binding.source;
    const index = realpathSync(source.index);
    if (index !== source.index) return { status: "stale", reasons: ["source index is not canonical"] };
    const packageRoot = dirname(index);
    if (!Object.hasOwn(source.expectedReadSet, source.record)) return { status: "stale", reasons: ["record is missing from the source read set"] };
    const changed = [];
    for (const [name, digest] of Object.entries(source.expectedReadSet)) {
      const file = realpathSync(name === "@index" ? index : join(packageRoot, name));
      if (!within(file, packageRoot) || sha256(readFileSync(file)) !== digest) changed.push(name);
    }
    return { status: changed.length ? "stale" : "current", reasons: changed.map((name) => `source changed: ${name}`) };
  } catch { return { status: "stale", reasons: ["bound source is unavailable"] }; }
}
export function selectedWorkspace(workspace, treeRoot) {
  if (!isAbsolute(workspace ?? "")) throw new TypeError("explicit absolute workspace required");
  if (treeRoot && realpathSync(workspace) !== realpathSync(treeRoot)) throw new TypeError("native workspace must match the selected filetree");
}

// Capture unbounded native output without execFile's hidden maxBuffer ceiling.
// Cancellation belongs to the caller; no response-size or execution-time cap.
export function nativeCommand(program, argv, cwd, { spawnFn = spawn, signal, stdoutFD, env } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawnFn(program, argv, { cwd, signal, env, stdio: ["ignore", stdoutFD ?? "pipe", "pipe"] }); } catch (e) { reject(e); return; }
    const out = [], err = [];
    child.stdout?.on("data", (b) => out.push(b));
    child.stderr.on("data", (b) => err.push(b));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") }));
  });
}

async function sanitizedOpenCodeExport(sessionId, workspace, options) {
  // Real-use witness: this OpenCode build exits before a large pipe-backed
  // export drains (65536-byte invalid JSON). Regular-file stdout avoids that
  // native producer failure without imposing a byte cap. Scratch is private,
  // outside the state store, and removed after deterministic projection.
  const directory = mkdtempSync(join(tmpdir(), "native-opencode-export-"));
  const path = join(directory, "export.json");
  const fd = openSync(path, "wx", 0o600);
  try {
    const result = await nativeCommand("opencode", ["export", sessionId, "--sanitize", "--pure"], workspace, { ...options, stdoutFD: fd });
    if (result.code !== 0) return null;
    try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
  } catch { return null;
  } finally { closeSync(fd); rmSync(directory, { recursive: true, force: true }); }
}

async function codexObservation(sessionId, workspace, native) {
  exactObject(native, [], ["codexHome"]);
  const home = native.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
  if (!isAbsolute(home)) throw new TypeError("codexHome must be absolute");
  const { DatabaseSync } = await import("node:sqlite");
  const open = (name) => {
    const file = join(home, name);
    if (!existsSync(file)) throw new Error("native history database is unavailable");
    return new DatabaseSync(file, { readOnly: true });
  };
  const dbs = [];
  try {
    const state = open("state_5.sqlite"); dbs.push(state);
    const thread = state.prepare("SELECT id,cwd,rollout_path,history_mode,updated_at FROM threads WHERE id=?").get(sessionId);
    if (!thread) return { status: "unavailable", reason: "selected Codex thread is absent" };
    if (realpathSync(thread.cwd) !== realpathSync(workspace)) return { status: "unavailable", reason: "selected Codex workspace does not match" };
    const result = { status: "partial", threadId: thread.id, workspace: thread.cwd,
      historyMode: thread.history_mode, clientPresence: "unknown", latestTurn: null, goal: null, plan: null, resultRefs: [],
      source: { kind: "codex.local-history", state: join(home, "state_5.sqlite"), history: join(home, "thread_history_1.sqlite") },
      snapshotConsistency: "best_effort; native stores may change during observation", gaps: [] };
    try {
      const history = open("thread_history_1.sqlite"); dbs.push(history);
      history.exec("BEGIN");
      result.latestTurn = history.prepare("SELECT turn_id AS turnId,status,started_at AS startedAt,completed_at AS completedAt FROM thread_turns WHERE thread_id=? ORDER BY rollout_ordinal DESC LIMIT 1").get(sessionId) ?? null;
      // Restrict SQL to visible items. Hidden reasoning and harness instructions
      // are never retrieved, exported, or passed through the association.
      const items = history.prepare("SELECT item_id,turn_id,item_type,item_json FROM thread_items WHERE thread_id=? AND item_type IN ('agentMessage','plan') ORDER BY rollout_ordinal").all(sessionId);
      for (const item of items) {
        const value = JSON.parse(item.item_json);
        if (item.item_type === "plan") result.plan = value;
        else if (value.phase === "final_answer") result.resultRefs.push({ itemId: item.item_id, turnId: item.turn_id, phase: value.phase,
          sha256: sha256(value.text ?? ""), source: { kind: "codex.visible-item", threadId: sessionId, itemId: item.item_id } });
      }
      history.exec("COMMIT");
      result.status = "available";
    } catch { result.gaps.push("paginated native turn/history projection unavailable or unsupported; activity remains unknown"); }
    try {
      const goals = open("goals_1.sqlite"); dbs.push(goals);
      result.goal = goals.prepare("SELECT goal_id AS goalId,status,objective FROM thread_goals WHERE thread_id=?").get(sessionId) ?? null;
    } catch { result.gaps.push("native goal projection unavailable or unsupported"); result.status = "partial"; }
    return result;
  } catch { return { status: "unavailable", reason: "native Codex metadata unavailable or unsupported" }; }
  finally { for (const db of dbs) db.close(); }
}

async function opencodeObservation(sessionId, workspace, native, options) {
  exactObject(native, [], ["endpoint", "opencodeDataHome"]);
  if (native.opencodeDataHome && !isAbsolute(native.opencodeDataHome)) throw new TypeError("opencodeDataHome must be absolute");
  const history = await sanitizedOpenCodeExport(sessionId, workspace, { ...options,
    ...(native.opencodeDataHome ? {env:{...process.env,XDG_DATA_HOME:native.opencodeDataHome}} : {}) });
  if (!history) return { status: "unavailable", reason: "selected sanitized OpenCode history export unavailable or incomplete" };
  const info = history.info;
  let selectedDirectory = info?.directory;
  let metadataSource = null;
  if (selectedDirectory === `[redacted:session-directory:${sessionId}]`) {
    // Sanitized export deliberately redacts its directory. Verify that field
    // against the exact native metadata row instead of weakening confinement
    // or exporting an unsanitized transcript.
    const database = join(native.opencodeDataHome ?? process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "opencode", "opencode.db");
    if (existsSync(database)) {
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(database, {readOnly:true});
      try { selectedDirectory = db.prepare("SELECT directory FROM session WHERE id=?").get(sessionId)?.directory; metadataSource=database; }
      catch { selectedDirectory = null; }
      finally { db.close(); }
    } else selectedDirectory = null;
  }
  let matches = false;
  try { matches = info?.id === sessionId && realpathSync(selectedDirectory) === realpathSync(workspace); } catch {}
  if (!matches) {
    return { status: "unavailable", reason: "OpenCode history identity or workspace mismatch" };
  }
  const result = { status: "available", sessionId, workspace: selectedDirectory, source: { kind: "opencode.sanitized-export", metadata:metadataSource },
    session: info, todos: null, activity: "unknown", resultRefs: [], gaps: [] };
  for (const message of history.messages ?? []) {
    if (message.info?.role !== "assistant") continue;
    const parts = (message.parts ?? []).filter((p) => p.type === "text");
    if (parts.length) result.resultRefs.push({ messageId: message.info.id, finish: message.info.finish ?? null,
      completedAt: message.info.time?.completed ?? null, sha256: sha256(JSON.stringify(parts)),
      source: { kind: "opencode.message", sessionId, messageId: message.info.id } });
  }
  if (native.endpoint) {
    const base = endpointURL(native.endpoint);
    try {
      const todos = await fetch(new URL(`session/${encodeURIComponent(sessionId)}/todo`, base), { signal: options.signal });
      if (!todos.ok) { result.status = "partial"; result.gaps.push("selected endpoint todo unavailable"); }
      else result.todos = await todos.json();
      const statuses = await fetch(new URL("session/status", base), { signal: options.signal });
      if (statuses.ok) result.activity = (await statuses.json())[sessionId] ?? "unknown";
      else { result.status = "partial"; result.gaps.push("selected endpoint activity unavailable"); }
    } catch { result.status = "partial"; result.gaps.push("selected endpoint unreachable or unsupported; live activity/todo unknown"); }
  } else { result.status = "partial"; result.gaps.push("no existing endpoint selected; live activity and todo unknown"); }
  return result;
}
function endpointURL(endpoint) {
  const value = new URL(endpoint);
  if (!["http:", "https:"].includes(value.protocol) || value.username || value.password || value.search || value.hash) throw new TypeError("endpoint must be an explicit HTTP(S) base URL without embedded credentials");
  if (!value.pathname.endsWith("/")) value.pathname += "/";
  return value;
}

export async function observeNative(identity, workspace, native = {}, options = {}) {
  const { destination } = associationFromIdentity(identity);
  if (destination.surface === "codex") return codexObservation(destination.sessionId, workspace, native);
  if (destination.surface === "opencode") return opencodeObservation(destination.sessionId, workspace, native, options);
  exactObject(native, ["snapshot"]);
  const snapshot = native.snapshot;
  exactObject(snapshot, ["contract", "schemaVersion", "sessionId", "workspace", "workspaceAuthority", "runRef", "session", "resultRefs", "source"]);
  if (snapshot?.contract !== "agenthost.connection-observation" || snapshot.schemaVersion !== 1
      || snapshot.sessionId !== destination.sessionId || realpathSync(snapshot.workspace) !== realpathSync(workspace)) {
    return { status: "unavailable", reason: "caller-owned AOA snapshot identity or workspace mismatch" };
  }
  // This is a caller-supplied native projection, never claimed as a host probe.
  return { status: "available", projection: snapshot, sessionId: snapshot.sessionId, resultRefs: snapshot.resultRefs,
    source: { kind: "aoa.caller-owned-snapshot", ledger: snapshot.source.ledger }, activity: snapshot.session.status ?? "unknown" };
}

export async function deliverNative(identity, body, requestId, workspace, native = {}, options = {}) {
  const { destination } = associationFromIdentity(identity);
  if (destination.surface === "codex") {
    exactObject(native, []);
    try {
      const r = await nativeCommand("codex", ["queue", "--thread", destination.sessionId, "--message", body], workspace, options);
      // A nonzero exit does not establish whether the recipient accepted input.
      return { status: r.code === 0 ? "accepted" : "ambiguous", transport: "codex.queue", receipt: { exitCode: r.code } };
    } catch (e) { return { status: ["ENOENT", "E2BIG"].includes(e.code) ? "unavailable" : "ambiguous", transport: "codex.queue" }; }
  }
  if (destination.surface === "opencode" && native.endpoint) {
    exactObject(native, ["endpoint"]);
    const base = endpointURL(native.endpoint);
    let admissionAttempted = false;
    try {
      const selected = await fetch(new URL(`api/session/${encodeURIComponent(destination.sessionId)}`, base), { signal: options.signal });
      if (!selected.ok) return { status: "unavailable", transport: "opencode.v2.input", reason: "selected native session unavailable" };
      const info = (await selected.json()).data;
      if (info?.id !== destination.sessionId || realpathSync(info.location?.directory) !== realpathSync(workspace)) return { status: "unavailable", transport: "opencode.v2.input", reason: "native endpoint identity or workspace mismatch" };
      admissionAttempted = true;
      const response = await fetch(new URL(`api/session/${encodeURIComponent(destination.sessionId)}/prompt`, base), {
        method: "POST", headers: { "content-type": "application/json" }, signal: options.signal,
        // Durable native input admission; observing/delivery never resumes work.
        body: JSON.stringify({ id: requestId, prompt: { text: body }, delivery: "queue", resume: false }),
      });
      const bytes = await response.text();
      const data = JSON.parse(bytes).data;
      const accepted = response.ok && data?.sessionID === destination.sessionId && data?.id === requestId;
      const receipt = { httpStatus: response.status, responseSha256: sha256(bytes) };
      if (accepted) for (const key of ["id", "sessionID", "admittedSeq", "delivery", "timeCreated", "promotedSeq"]) if (Object.hasOwn(data, key)) receipt[key] = data[key];
      return { status: accepted ? "accepted" : "ambiguous", transport: "opencode.v2.input", receipt };
    } catch { return { status: admissionAttempted ? "ambiguous" : "unavailable", transport: "opencode.v2.input" }; }
  }
  if (destination.surface === "aoa" && native.receipt) {
    exactObject(native, ["receipt"]);
    const receipt = native.receipt;
    exactObject(receipt, ["contract", "schemaVersion", "sessionId", "requestId", "bodySha256", "status", "transport"], ["inputId"]);
    if (receipt.contract !== "agenthost.connection-delivery" || receipt.schemaVersion !== 1
        || receipt.sessionId !== destination.sessionId || receipt.requestId !== requestId || receipt.bodySha256 !== sha256(body)
        || !["accepted", "unavailable", "ambiguous"].includes(receipt.status)) throw new TypeError("AOA caller-owned delivery receipt does not match exact request");
    return { status: receipt.status, transport: "aoa.caller-owned", source: "caller-returned native receipt", receipt };
  }
  if (destination.surface === "aoa" && options.aoaDeliver) {
    const receipt = await options.aoaDeliver({ sessionId: destination.sessionId, requestId, body });
    validateNativeDelivery(identity, body, requestId, {receipt});
    return {status:receipt.status,transport:"aoa.caller-owned",source:"caller-returned native receipt",receipt};
  }
  exactObject(native, []);
  return { status: "unavailable", transport: null, reason: "no existing native delivery handle selected" };
}

export function validateNativeDelivery(identity, body, requestId, native = {}) {
  const surface = identity.destination.surface;
  if (surface === "opencode") {
    exactObject(native, [], ["endpoint"]);
    if (native.endpoint) endpointURL(native.endpoint);
  } else if (surface === "aoa" && native.receipt) {
    exactObject(native, ["receipt"]);
    const r = native.receipt;
    exactObject(r, ["contract", "schemaVersion", "sessionId", "requestId", "bodySha256", "status", "transport"], ["inputId"]);
    if (r.contract !== "agenthost.connection-delivery" || r.schemaVersion !== 1 || r.sessionId !== identity.destination.sessionId
        || r.requestId !== requestId || r.bodySha256 !== sha256(body) || !["accepted", "unavailable", "ambiguous"].includes(r.status)) {
      throw new TypeError("AOA native receipt does not match the exact feedback request");
    }
  } else exactObject(native, []);
}
