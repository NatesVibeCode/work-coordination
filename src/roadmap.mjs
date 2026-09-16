import { execFileSync } from "node:child_process";
import { workView } from "./work-index.mjs";

function text(value) {
  return String(value ?? "").trim() || null;
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

export function readRoadmapItem(roadmapKey, { run = (args) => execFileSync("psql", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }) } = {}) {
  const key = text(roadmapKey);
  if (!key) return null;
  const literal = key.replaceAll("'", "''");
  const output = String(run([
    "praxis", "-At", "-F", "\t", "-c",
    `select roadmap_key, title, priority, lifecycle, status from roadmap_items where roadmap_key = '${literal}' limit 1;`,
  ]) ?? "").trim();
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
    `Roadmap · ${view.roadmapKey}`,
    view.title ?? "title unavailable",
    [view.priority, view.lifecycle, view.status].filter(Boolean).join(" · ") || "roadmap state unavailable",
    `participants · ${view.participants.length ? view.participants.map((value) => value.sessionRef).join(", ") : "none observed"}`,
    "advisory — presence only; no assignment, lock, or completion state.",
  ];
  return summary.join("\n");
}
