import { execFileSync } from "node:child_process";
import { oneLine } from "./coordination.mjs";
import { workView } from "./work-index.mjs";

function text(value) {
  return oneLine(value) || null;
}

// Reading a roadmap item is optional local infrastructure: it runs whatever
// `psql` command the operator has, against their own database. Nothing here
// is required for coordination, and a missing command degrades to a clean
// one-liner rather than a raw spawn error.
export function roadmapCommand() {
  const configured = String(process.env.WORK_COORDINATION_ROADMAP_PSQL ?? "").trim();
  return configured || "psql";
}

// roadmapView is deliberately read-only. It projects observed participation
// beside a roadmap row; it neither changes roadmap authority nor controls a
// participating session.
export function roadmapView(store, item = {}) {
  const roadmapKey = text(item.roadmapKey);
  if (!roadmapKey) return null;
  const participation = workView(store, roadmapKey);
  return {
    roadmapKey,
    title: text(item.title),
    priority: text(item.priority),
    lifecycle: text(item.lifecycle),
    status: text(item.status),
    participants: participation?.participants ?? [],
  };
}

export function readRoadmapItem(roadmapKey, { run = null, command = roadmapCommand() } = {}) {
  const key = text(roadmapKey);
  if (!key) return null;
  const literal = key.replaceAll("'", "''");
  const args = [
    ...(/[\\/\s]/.test(command) ? command.split(/\s+/) : [command]),
    "-At", "-F", "\t", "-c",
    `select roadmap_key, title, priority, lifecycle, status from roadmap_items where roadmap_key = '${literal}' limit 1;`,
  ];
  const execute = run ?? ((argv) => execFileSync(argv[0], argv.slice(1), { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  const output = String(execute(args) ?? "").trim();
  if (!output) return null;
  const [roadmapKeyValue, title, priority, lifecycle, status] = output.split("\t");
  if (!text(roadmapKeyValue)) return null;
  return {
    roadmapKey: text(roadmapKeyValue),
    title: text(title),
    priority: text(priority),
    lifecycle: text(lifecycle),
    status: text(status),
  };
}

export function renderRoadmapView(view) {
  if (!view) return "roadmap item unavailable";
  const summary = [
    `Roadmap · ${oneLine(view.roadmapKey) || "unknown"}`,
    oneLine(view.title) || "title unavailable",
    [view.priority, view.lifecycle, view.status].map(oneLine).filter(Boolean).join(" · ") || "roadmap state unavailable",
    `participants · ${view.participants.length ? view.participants.map((value) => oneLine(value.sessionRef)).join(", ") : "none observed"}`,
    "advisory — presence only; no assignment, lock, or completion state.",
  ];
  return summary.join("\n");
}

// The CLI and the MCP tool both read one item then render it; the roadmap
// source is optional, so a failure is a line of text, never a throw.
export function roadmapViewFor(store, roadmapKey) {
  try {
    return renderRoadmapView(roadmapView(store, readRoadmapItem(roadmapKey)));
  } catch {
    return "roadmap unavailable — local read failed; coordination remains advisory-only.";
  }
}
