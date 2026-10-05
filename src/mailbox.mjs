// The mailbox: per-recipient unread advisory messages. Acknowledgements are
// immutable receipts keyed by the complete normalized recipient identity and
// exact message ID. Equal timestamps and reordered deliveries therefore do
// not collapse distinct messages into one watermark.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { identityHash, writeJsonRecord } from "./atomic-json.mjs";
import { oneLine } from "./coordination.mjs";
import { messagesMatching } from "./state.mjs";
import { messageVisible, policyDecide, refSubject } from "./policy.mjs";

const RECEIPT_SCHEMA = "work-coordination.mailbox_receipt.v1";

function recipientDirectory(store, sessionRef) {
  return join(store.directory, "mailbox", identityHash("recipient", sessionRef));
}

function receiptPath(store, sessionRef, messageRef) {
  return join(recipientDirectory(store, sessionRef), `${identityHash("message", messageRef)}.json`);
}

function receiptsFor(store, sessionRef) {
  const directory = recipientDirectory(store, sessionRef);
  const acknowledged = new Set();
  const gaps = [];
  let entries;
  try { entries = readdirSync(directory, { withFileTypes: true }); } catch (error) {
    if (error?.code === "ENOENT") return { acknowledged, gaps };
    return { acknowledged, gaps: [{ file: directory, reason: "mailbox receipt directory could not be read" }] };
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".json")) {
      gaps.push({ file: path, reason: "mailbox contains an unknown receipt artifact" });
      continue;
    }
    let receipt;
    try { receipt = JSON.parse(readFileSync(path, "utf8")); } catch {
      gaps.push({ file: path, reason: "invalid or truncated mailbox receipt" });
      continue;
    }
    if (receipt?.schema !== RECEIPT_SCHEMA || receipt.recipient !== sessionRef || typeof receipt.messageRef !== "string"
      || entry.name !== `${identityHash("message", receipt.messageRef)}.json`) {
      gaps.push({ file: path, reason: "mailbox receipt identity does not match its address" });
      continue;
    }
    acknowledged.add(receipt.messageRef);
  }
  return { acknowledged, gaps };
}

function unreadSnapshot(store, sessionRef) {
  const recipient = oneLine(sessionRef);
  if (!recipient || !policyDecide(store, refSubject(recipient), "read").allowed) {
    return { status: "clear", messages: [], gaps: [] };
  }
  const receipts = receiptsFor(store, recipient);
  if (receipts.gaps.length) return { status: "unknown", messages: [], gaps: receipts.gaps };
  const messages = messagesMatching(store, "to", recipient)
    .filter((message) => messageVisible(store, message) && !receipts.acknowledged.has(String(message.ref ?? "")))
    .sort((left, right) => Number(left.createdAt ?? 0) - Number(right.createdAt ?? 0)
      || String(left.ref ?? "").localeCompare(String(right.ref ?? "")));
  return { status: "clear", messages, gaps: [] };
}

export function unreadFor(store, sessionRef) {
  return unreadSnapshot(store, sessionRef).messages;
}

export function mailboxState(store, sessionRef) {
  return unreadSnapshot(store, sessionRef);
}

// Recording a receipt does not acquire a recipient lock. Concurrent polls can
// both render the same message, but both write the same immutable receipt; a
// later poll will observe that exact message ID as acknowledged.
function markDelivered(store, sessionRef, messages) {
  if (!sessionRef || messages.length === 0) return;
  for (const message of messages) {
    const messageRef = String(message.ref ?? "");
    if (!messageRef) continue;
    writeJsonRecord(receiptPath(store, sessionRef, messageRef), {
      schema: RECEIPT_SCHEMA,
      recipient: sessionRef,
      messageRef,
    });
  }
}

export function renderUnread(store, sessionRef) {
  const recipient = oneLine(sessionRef);
  const snapshot = unreadSnapshot(store, recipient);
  if (snapshot.status === "unknown") {
    return `\nⓘ mailbox · state unknown · ${snapshot.gaps.length} incomplete or unknown receipt record${snapshot.gaps.length === 1 ? "" : "s"}; unread mail withheld`;
  }
  const unread = snapshot.messages;
  if (unread.length === 0) return "";
  const lines = unread.map((message) => {
    const sender = message.sender || message.sessionRef || "unknown";
    const work = message.workRef ? ` [${message.workRef}]` : "";
    return `  mailbox · ${sender}${work}: ${message.body}`;
  });
  markDelivered(store, recipient, unread);
  return `\nⓘ mailbox (${unread.length}):\n${lines.join("\n")}`;
}
