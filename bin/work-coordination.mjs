#!/usr/bin/env node
import { execFileSync } from "node:child_process";

process.on("uncaughtException", (error) => {
  process.stdout.write(`error · ${error?.message ?? error}\n`);
  process.exitCode = 1;
});
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MESSAGE_STATUSES } from "../src/coordination.mjs";
import { roadmapViewFor } from "../src/roadmap.mjs";
import { removeGroup, saveStoreConfig } from "../src/state.mjs";
import {
  createGroupOp,
  gitToplevel,
  groupMessagesOp,
  joinGroupOp,
  listGroups,
  listSessions,
  listSubscriptionsOp,
  observe,
  sendAdvisory,
  showWork,
  storeDirectoryForTree,
  storeForTree,
  subscribeOp,
  unsubscribeOp,
} from "../src/operations.mjs";

// One table per command: what it accepts, and whether it writes. A flag that
// is not in the table is a usage error, not text — a typo'd flag used to be
// folded silently into the message body and certified as success.
const WRITE = "write";
const READ = "read";

const HELP = "try: message <text> [--work <ref>] [--from <session>] | work <ref> | roadmap <roadmap-key>";

function valueFlag(name) {
  return { name, kind: "value" };
}

function booleanFlag(name) {
  return { name, kind: "boolean" };
}

const COMMANDS = {
  init: { mode: WRITE, flags: [valueFlag("--expiry-ms"), valueFlag("--decay-ms")] },
  message: {
    mode: WRITE,
    flags: [
      valueFlag("--work"),
      valueFlag("--from"),
      valueFlag("--group"),
      valueFlag("--status"),
      valueFlag("--session"),
      valueFlag("--to"),
      valueFlag("--idle-timeout-ms"),
      booleanFlag("--deliver"),
    ],
  },
  observe: {
    mode: WRITE,
    flags: [valueFlag("--work"), valueFlag("--session"), valueFlag("--harness"), valueFlag("--directory")],
  },
  group: {
    mode: WRITE,
    flags: [],
    subcommands: {
      create: { help: "group create [name]" },
      join: { help: "group join <group> <session>" },
      messages: { help: "group messages <group>" },
    },
  },
  ungroup: { mode: WRITE, flags: [] },
  subscribe: { mode: WRITE, flags: [valueFlag("--session"), valueFlag("--work"), valueFlag("--to")] },
  unsubscribe: { mode: WRITE, flags: [] },
  subscriptions: { mode: READ, flags: [] },
  groups: { mode: READ, flags: [] },
  sessions: { mode: READ, flags: [] },
  roadmap: { mode: READ, flags: [] },
  work: { mode: READ, flags: [] },
};

// "-5" is a value someone meant to supply, and the numeric validator gives a
// far better message for it than "needs a value" does. "-x" is not.
function looksNumeric(token) {
  return /^-\d/.test(token) || /^-\.\d/.test(token);
}

class UsageError extends Error {}

function usage(...lines) {
  throw new UsageError(lines.join("\n"));
}

// `--flag value` and `--flag=value` both work; a bare `--` ends flags so a
// body may legitimately begin with a dash. Repeated flags are a usage error
// rather than a silent first-wins with the extra token leaking into text.
function parseArgs(args, command) {
  const accepted = new Map(command.flags.map((flag) => [flag.name, flag]));
  const values = new Map();
  const positional = [];
  let flagsDone = false;
  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    if (flagsDone || token === "-" || !token.startsWith("-")) {
      positional.push(token);
      continue;
    }
    if (token === "--") {
      flagsDone = true;
      continue;
    }
    const separator = token.indexOf("=");
    const name = separator > 0 ? token.slice(0, separator) : token;
    const inline = separator > 0 ? token.slice(separator + 1) : undefined;
    const flag = accepted.get(name);
    if (!flag) {
      const known = [...accepted.keys()].join(", ") || "none";
      usage(`unknown flag · ${name}`, `${command.help}`, `flags: ${known}`);
    }
    if (values.has(name)) usage(`repeated flag · ${name}`, `${command.help}`);
    if (flag.kind === "boolean") {
      if (inline !== undefined) usage(`${name} takes no value`, `${command.help}`);
      values.set(name, true);
      continue;
    }
    const value = inline !== undefined ? inline : args[index + 1];
    // A missing value must not swallow the next flag, and a dash-led token is
    // far more likely a typo'd flag than a work ref named "-x". A body that
    // genuinely starts with a dash belongs after `--`.
    if (value === undefined || (inline === undefined && value.startsWith("-") && !looksNumeric(value))) {
      usage(`${name} needs a value`, `${command.help}`);
    }
    if (inline === undefined) index++;
    values.set(name, value);
  }
  return { values, positional };
}

// A number the caller can trust: "abc", "0ms", and "Infinity" are refused
// instead of reaching a timer as NaN or a zero-length silence.
function numericFlag(values, name, { minimum, help }) {
  if (!values.has(name)) return null;
  const raw = String(values.get(name)).trim();
  const number = Number(raw);
  if (raw === "" || !Number.isFinite(number) || number < minimum) {
    usage(`${name} needs a number >= ${minimum}`, `${help}`);
  }
  return number;
}

function hideLocalState() {
  try {
    const path = join(process.cwd(), execFileSync("git", ["rev-parse", "--git-path", "info/exclude"], { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
    const pattern = ".work-coordination/";
    const current = existsSync(path) ? readFileSync(path, "utf8") : "";
    if (current.split(/\r?\n/).includes(pattern)) return;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${current}${current && !current.endsWith("\n") ? "\n" : ""}${pattern}\n`, { mode: 0o600 });
  } catch {}
}

// `--state` is the one flag every command shares, so it is taken before the
// command is known.
function takeState(args) {
  const index = args.indexOf("--state");
  const inlineIndex = args.findIndex((token) => token.startsWith("--state="));
  const at = index >= 0 ? index : inlineIndex;
  if (at < 0) return { state: null, args };
  const rest = [...args];
  if (at === index && index >= 0) {
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) usage("--state needs a value", HELP);
    rest.splice(index, 2);
    return { state: value, args: rest };
  }
  const [token] = rest.splice(inlineIndex, 1);
  const value = token.slice("--state=".length);
  if (!value) usage("--state needs a value", HELP);
  return { state: value, args: rest };
}

// A command's mode can depend on its subcommand: `group messages` only reads,
// while `group create` and `group join` write.
function modeFor(commandName, args) {
  const command = COMMANDS[commandName];
  if (!command) return READ;
  if (command.subcommands) {
    const action = args.find((token) => !token.startsWith("-"));
    return action && action !== "messages" ? WRITE : READ;
  }
  return command.mode;
}

async function run(commandName, args, explicitState) {
  const command = COMMANDS[commandName];
  const help = command.help ?? `work-coordination ${commandName}`;
  const { values, positional } = parseArgs(args, { ...command, help });
  const mode = modeFor(commandName, positional);

  // Read-only commands resolve the store without creating it: a typo'd
  // --state path must not become a directory, and a question must not
  // conjure a store.
  const store = storeForTree(process.cwd(), explicitState ?? (commandName === "init" ? join(gitToplevel(process.cwd()) ?? process.cwd(), ".work-coordination") : null), null, { create: mode === WRITE });

  const value = (name) => (values.has(name) ? values.get(name) : null);

  if (commandName === "init") {
    hideLocalState();
    // Expiry is opt-in per store and defaults to off (audit keeps
    // everything). Plain `init` never touches an existing setting.
    // --decay-ms is the pre-rename spelling and still works.
    const expiryFlag = values.has("--expiry-ms") ? "--expiry-ms" : (values.has("--decay-ms") ? "--decay-ms" : null);
    let suffix = "";
    if (expiryFlag) {
      const expiryMs = numericFlag(values, expiryFlag, { minimum: 0, help });
      saveStoreConfig(store.directory, { expiryMs: expiryMs > 0 ? expiryMs : null });
      suffix = expiryMs > 0 ? ` · expiry ${expiryMs}ms` : " · expiry off";
    }
    return `initialized · ${store.directory}${suffix}`;
  }

  if (commandName === "message") {
    const idleTimeout = values.has("--idle-timeout-ms")
      ? numericFlag(values, "--idle-timeout-ms", { minimum: 1, help })
      : undefined;
    // A record with no body carries nothing, so it is a malformed call rather
    // than an empty message: same exit code as a typo'd flag.
    const body = positional.join(" ").trim();
    if (!body) usage("message needs a body", help);
    // A typo'd status used to be dropped on the floor: the message stored
    // fine with status null and nothing said so, which reads exactly like
    // "no status given".
    const status = values.has("--status") ? String(values.get("--status")).trim().toLowerCase() : null;
    if (status !== null && !MESSAGE_STATUSES.includes(status)) {
      usage(`unknown status · ${values.get("--status")}`, `statuses: ${MESSAGE_STATUSES.join(", ")}`, help);
    }
    return await sendAdvisory(store, {
      body,
      workRef: value("--work"),
      sender: value("--from"),
      sessionRef: value("--session"),
      groupRef: value("--group"),
      status,
      deliver: values.get("--deliver") ?? false,
      target: value("--to"),
      idleTimeoutMs: idleTimeout,
    });
  }

  if (commandName === "group") {
    const action = positional.shift();
    if (action === "create") return createGroupOp(store, positional.join(" "));
    if (action === "join") return joinGroupOp(store, positional.shift(), positional.join(" "));
    if (action === "messages") return groupMessagesOp(store, positional.join(" "));
    return "nothing to do — try: group create [name] | group join <group> <session> | group messages <group>";
  }

  if (commandName === "ungroup") {
    return removeGroup(store, positional.join(" ")) ? "group removed" : "group unavailable";
  }

  if (commandName === "subscribe") {
    return subscribeOp(store, { sessionRef: value("--session"), workRef: value("--work"), target: value("--to") });
  }

  if (commandName === "unsubscribe") return unsubscribeOp(store, positional.join(" "));
  if (commandName === "subscriptions") return listSubscriptionsOp(store);
  if (commandName === "groups") return listGroups(store);
  if (commandName === "sessions") return listSessions(store);
  if (commandName === "observe") {
    return observe(store, {
      workRef: value("--work"),
      sessionRef: value("--session"),
      harness: value("--harness"),
      directory: value("--directory") ?? process.cwd(),
      worktree: gitToplevel(process.cwd()),
    });
  }
  if (commandName === "roadmap") return roadmapViewFor(store, positional.join(" "));
  if (commandName === "work") return showWork(store, positional.join(" "));
  return `nothing to do — ${HELP}`;
}

const argv = process.argv.slice(2);
const { state, args: withoutState } = takeState(argv);
const commandName = withoutState[0];
try {
  if (!commandName || !COMMANDS[commandName]) {
    if (commandName && commandName.startsWith("-")) usage(`unknown flag · ${commandName}`, HELP);
    process.stdout.write(`nothing to do — ${HELP}\n`);
  } else {
    process.stdout.write(`${await run(commandName, withoutState.slice(1), state)}\n`);
  }
} catch (error) {
  if (error instanceof UsageError) {
    process.stdout.write(`${error.message}\n`);
  } else {
    process.stdout.write(`error · ${error?.message ?? error}\n`);
  }
  process.exitCode = 1;
}
