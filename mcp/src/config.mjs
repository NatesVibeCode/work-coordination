import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export function loadConfig(path) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const trees = Array.isArray(raw.trees) ? raw.trees : [];
  return {
    cliPath: typeof raw.cliPath === "string" && raw.cliPath ? raw.cliPath : "work-coordination",
    timeoutMs: Number(raw.timeoutMs) > 0 ? Number(raw.timeoutMs) : 120_000,
    trees: trees
      .filter((entry) => entry && typeof entry.name === "string" && typeof entry.root === "string")
      .map((entry) => ({
        name: entry.name,
        root: resolve(entry.root),
        visible: entry.visible !== false,
      })),
  };
}

export function visibleTrees(config) {
  return config.trees.filter((entry) => entry.visible).map((entry) => entry.name);
}

export function resolveTree(config, name) {
  const entry = config.trees.find((value) => value.name === String(name ?? ""));
  if (!entry || !entry.visible) return null;
  return entry;
}
