import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createState } from "../src/state.mjs";
import { observeParticipation, observedSessions } from "../src/work-index.mjs";

test("lists observed sessions across typed work without making work mandatory", (t) => {
  const root = mkdtempSync(join(tmpdir(), "work-coordination-sessions-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = createState(root);
  observeParticipation(store, { workRef: "Ticket T-123", sessionRef: "codex:one", harness: "codex" }, { now: 1_000 });
  observeParticipation(store, { sessionRef: "hermes:two", harness: "hermes" }, { now: 2_000 });

  assert.deepEqual(observedSessions(store).map((value) => value.sessionRef), ["hermes:two", "codex:one"]);
});
