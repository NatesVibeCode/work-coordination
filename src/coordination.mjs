function text(value) {
  return String(value ?? "").trim();
}

// Every rendered record is one line per record, so a field carrying a newline
// (or any other control character) could forge a line that reads like a real
// record — a second session, a second message header. Anything user-supplied
// is folded to a single line before it is stored and before it is rendered,
// so identity fields, work refs, and bodies can never inject structure.
export function oneLine(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Values that can only ever be text. `String({})` is "[object Object]" and
// `String([1,2])` is "1,2": both would be stored and routed as if a caller had
// meant them, so a shape that is not text is named instead. Numbers and
// booleans still coerce, which is what a JSON caller expects.
export function textField(value) {
  if (value === null || value === undefined) return null;
  const type = typeof value;
  if (type !== "string" && type !== "number" && type !== "boolean") {
    throw new TypeError(`expected text, got ${Array.isArray(value) ? "array" : type}`);
  }
  return oneLine(value) || null;
}

// A delivery destination is "<harness>:<session>", and both halves are routing
// identifiers rather than display text: they are compared for equality when
// deciding whether two subscriptions address the same place, and case-folded
// by the transport. Splitting them in three places is how "Codex:A" and
// "codex:a" became two subscriptions delivering twice to one recipient, so
// there is one parser and it always normalizes.
export function destinationOf(value) {
  const [harness, ...rest] = oneLine(value).split(":");
  return {
    harness: harness.trim().toLowerCase(),
    sessionRef: rest.join(":").trim().toLowerCase(),
  };
}

function optionalText(value) {
  return textField(value);
}

export const MESSAGE_STATUSES = ["started", "milestone", "blocked", "done"];

function validStatus(value) {
  const candidate = text(value).toLowerCase();
  return MESSAGE_STATUSES.includes(candidate) ? candidate : null;
}

export function createMessage(input = {}, { now = Date.now(), random = Math.random } = {}) {
  const suppliedRef = optionalText(input.ref);
  const suffix = text(random()).replace(/[^a-zA-Z0-9]/g, "").slice(0, 12) || "local";
  return {
    ref: suppliedRef ?? `m_${suffix}`,
    createdAt: Number(now),
    workRef: optionalText(input.workRef),
    sender: optionalText(input.sender),
    sessionRef: optionalText(input.sessionRef),
    to: optionalText(input.to),
    groupRef: optionalText(input.groupRef),
    status: validStatus(input.status),
    body: oneLine(input.body),
    advisory: true,
  };
}

export function renderMessage(message = {}) {
  const ref = optionalText(message.ref);
  const workRef = optionalText(message.workRef);
  const sender = optionalText(message.sender);
  const sessionRef = optionalText(message.sessionRef);
  const status = validStatus(message.status);
  const heading = `${workRef ? "Work" : "Session"} message${ref ? ` · #${ref}` : ""}`;
  // `sender` is free text anyone can type; `sessionRef` is the identity that
  // also appears in a work's participant list. Both are shown when they
  // differ, because "from Codex / parser-repair" cannot be matched to
  // "participants · codex:parser" otherwise.
  const attribution = [sender, sessionRef && sessionRef !== sender ? sessionRef : null].filter(Boolean).join(" · ");
  const context = workRef
    ? `${workRef}${attribution ? ` · from ${attribution}` : ""}`
    : attribution ? `from ${attribution}` : "";
  // No work ref means the context line already names the session, so a
  // separate identity line would just repeat it.
  const identityLine = sessionRef && workRef && sessionRef !== sender ? `session · ${sessionRef}` : "";
  return [heading, context, identityLine, status ? `status · ${status}` : "", "advisory — use if relevant; otherwise continue.", oneLine(message.body)]
    .filter((line) => line !== "")
    .join("\n");
}

// The advisory line belongs in a one-off send, where it tells the agent what to
// do with the message. Repeating it under every message in a work view turns a
// scroll of records into a scroll of boilerplate, so grouped views drop it.
export function withoutBoilerplate(rendered) {
  return String(rendered ?? "")
    .split("\n\n")
    .map((record) => record.split("\n").filter((line) => !line.startsWith("advisory — ")).join("\n"))
    .join("\n\n");
}

export function addGroupMember(group = {}, groupRefOrMember, memberOrOptions, options = {}) {
  const creating = typeof memberOrOptions === "string";
  const groupRef = creating ? groupRefOrMember : undefined;
  const member = creating ? memberOrOptions : groupRefOrMember;
  const settings = creating ? options : (memberOrOptions ?? {});
  const now = settings.now ?? Date.now();
  const ttlMs = settings.ttlMs ?? 60 * 60 * 1000;
  const id = optionalText(group.id) ?? optionalText(group.ref) ?? optionalText(groupRef) ?? "group";
  const value = optionalText(member);
  const members = [...new Set([...(Array.isArray(group.members) ? group.members : []), value].filter(Boolean))];
  return {
    ...group,
    id,
    members,
    createdAt: Number(group.createdAt ?? now),
    expiresAt: Number(group.expiresAt ?? (Number(now) + Math.max(0, Number(ttlMs) || 0))),
  };
}

export function activeGroup(group, { now = Date.now() } = {}) {
  if (!group || Number(group.expiresAt ?? 0) <= Number(now)) return null;
  return group;
}
