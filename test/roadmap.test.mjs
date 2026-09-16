import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { roadmapView, readRoadmapItem } from "../src/roadmap.mjs";
import { createState } from "../src/state.mjs";
import { observeParticipation } from "../src/work-index.mjs";

test("projects observed participation onto a read-only roadmap item without creating control state", (t) => {
  const root = mkdtempSync(join(tmpdir(), "work-coordination-roadmap-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = createState(root);
  observeParticipation(store, {
    workRef: "roadmap.engine.identity",
    sessionRef: "hermes:local",
    harness: "hermes",
  }, { now: 1_000 });

  const view = roadmapView(store, {
    roadmapKey: "roadmap.engine.identity",
    title: "Separate host and sandbox identity",
    priority: "p1",
    lifecycle: "planned",
    status: "active",
  });

  assert.equal(view.roadmapKey, "roadmap.engine.identity");
  assert.equal(view.participants.length, 1);
  assert.equal(view.participants[0].sessionRef, "hermes:local");
  assert.equal(view.disposition, undefined);
  assert.equal(view.owner, undefined);
});

test("reads one roadmap row without mutating roadmap authority", () => {
  const item = readRoadmapItem("roadmap.engine.identity", {
    run: () => "roadmap.engine.identity\tSeparate host and sandbox identity\tp1\tplanned\tactive\n",
  });
  assert.deepEqual(item, {
    roadmapKey: "roadmap.engine.identity",
    title: "Separate host and sandbox identity",
    priority: "p1",
    lifecycle: "planned",
    status: "active",
  });
});
