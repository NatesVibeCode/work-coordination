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

export function textField(value) {
  return oneLine(value) || null;
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
  const context = workRef
    ? `${workRef}${sender ? ` · from ${sender}` : ""}`
    : sender ? `from ${sender}` : "";
  return [heading, context, sessionRef ? `session · ${sessionRef}` : "", status ? `status · ${status}` : "", "advisory — use if relevant; otherwise continue.", oneLine(message.body)]
    .filter((line) => line !== "")
    .join("\n");
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
