// The mailbox: per-recipient unread message tracking. A session's
// inbox is the messages addressed to its sessionRef that it has not
// been shown yet. Delivery is pull-based: the MCP server attaches
// unread mail to every tool response the recipient triggers, so a
// live session receives mail the next time it touches any tool —
// no ingress, no port, no spawn requirement.
//
// State is one small watermark file per recipient: everything before
// the watermark is considered delivered the moment it is attached.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { reviseJsonFile } from "./atomic-json.mjs";
import { messagesMatching } from "./state.mjs";
import { messageVisible, policyDecide, refSubject } from "./policy.mjs";

function mailboxFile(store, sessionRef) {
  const safe = String(sessionRef).replace(/[^a-zA-Z0-9:_-]/g, "_");
  return join(store.directory, "mailbox", `${safe}.json`);
}

function watermark(store, sessionRef) {
  const path = mailboxFile(store, sessionRef);
  if (!existsSync(path)) return 0;
  try {
    const record = JSON.parse(readFileSync(path, "utf8"));
    return Number(record.lastDeliveredAt ?? 0);
  } catch {
    return 0;
  }
}

// unreadFor returns the messages addressed to sessionRef that were
// created after the recipient's watermark, oldest first. The visibility
// policy applies twice: a reader whose own ref is denied sees nothing at
// all, and a message either of whose ends (sender or recipient) is denied
// is withheld — a deny hides the mail in both directions.
export function unreadFor(store, sessionRef) {
  if (!sessionRef) return [];
  if (!policyDecide(store, refSubject(sessionRef), "read").allowed) return [];
  return messagesMatching(store, "to", sessionRef).filter(
    (message) => messageVisible(store, message)
      && Number(message.createdAt ?? 0) > watermark(store, sessionRef),
  );
}

// markDelivered advances the recipient's watermark to the newest
// message handed over. Attachment is delivery: mail shown is mail read.
function markDelivered(store, sessionRef, messages) {
  if (!sessionRef || messages.length === 0) return;
  const newest = Math.max(...messages.map((m) => Number(m.createdAt ?? 0)));
  mkdirSync(join(store.directory, "mailbox"), { recursive: true });
  const path = mailboxFile(store, sessionRef);
  reviseJsonFile(path, { lastDeliveredAt: 0 }, (record) => {
    if (Number(record.lastDeliveredAt ?? 0) >= newest) return { lastDeliveredAt: Number(record.lastDeliveredAt ?? 0) };
    return { lastDeliveredAt: newest };
  });
}

// renderUnread renders the attach block for a recipient's unread mail,
// or "" when the inbox is empty. Rendering marks delivery: the mail
// will not attach twice.
export function renderUnread(store, sessionRef) {
  const unread = unreadFor(store, sessionRef);
  if (unread.length === 0) return "";
  const lines = unread.map((m) => {
    const sender = m.sender || m.sessionRef || "unknown";
    const work = m.workRef ? ` [${m.workRef}]` : "";
    return `  mailbox · ${sender}${work}: ${m.body}`;
  });
  markDelivered(store, sessionRef, unread);
  return `\nⓘ mailbox (${unread.length}):\n${lines.join("\n")}`;
}
