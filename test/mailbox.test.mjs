import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createState } from "../src/state.mjs";
import { sendAdvisory } from "../src/operations.mjs";
import { renderUnread } from "../src/mailbox.mjs";

function store() {
  return createState(mkdtempSync(join(tmpdir(), "mailbox-")));
}

test("mail addressed to a session attaches once, then never again", async () => {
  const s = store();
  await sendAdvisory(s, {
    body: "handover signal: port your atoms when stable",
    sender: "platform",
    sessionRef: "opencode:platform",
    to: "opencode:fleetsession",
  });
  // The recipient's poll attaches the mail.
  const first = renderUnread(s, "opencode:fleetsession");
  assert.match(first, /mailbox \(1\)/);
  assert.match(first, /handover signal/);
  assert.match(first, /\[funnel.rung\]|platform/);
  // Attachment is delivery: no double-attach.
  assert.equal(renderUnread(s, "opencode:fleetsession"), "");
});

test("mail for other recipients does not attach", async () => {
  const s = store();
  await sendAdvisory(s, {
    body: "for the fleet session only",
    sender: "platform",
    to: "opencode:fleetsession",
  });
  assert.equal(renderUnread(s, "opencode:othersession"), "");
  assert.match(renderUnread(s, "opencode:fleetsession"), /for the fleet session only/);
});

test("unaddressed mail attaches to nobody", async () => {
  const s = store();
  await sendAdvisory(s, { body: "broadcast", sender: "platform" });
  assert.equal(renderUnread(s, "opencode:fleetsession"), "");
});
