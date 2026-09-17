import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

// A tree root may be absolute, config-relative, or `~/...`. Config-relative
// is the portable form: the same config file declares the same trees no
// matter which directory the client launched the server from.
export function resolveConfigPath(baseDir, value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const expanded = raw === "~" || raw.startsWith("~/") ? resolve(homedir(), `.${raw.slice(1)}`) : raw;
  return resolve(baseDir, expanded);
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function loadConfig(path, { warn = (message) => process.stderr.write(`${message}\n`) } = {}) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const baseDir = dirname(resolve(String(path)));
  const entries = Array.isArray(raw.trees) ? raw.trees : [];
  const trees = [];
  const missing = [];
  for (const entry of entries) {
    if (!entry || typeof entry.name !== "string" || typeof entry.root !== "string") continue;
    const root = resolveConfigPath(baseDir, entry.root);
    const state = typeof entry.state === "string" ? resolveConfigPath(baseDir, entry.state) : null;
    // A declared root that does not exist is a typo, not a tree. Creating it
    // would make the mistake permanent and invisible; reporting it keeps the
    // caller able to see what happened.
    if (!root || !isDirectory(root)) {
      const visible = entry.visible !== false;
      missing.push({ name: entry.name, root, visible });
      // A hidden tree stays hidden even when its root is gone.
      if (visible) warn(`tree unavailable · ${entry.name} · root does not exist · ${root}`);
      continue;
    }
    trees.push({ name: entry.name, root, state, visible: entry.visible !== false });
  }
  return { trees, missing, configPath: resolve(String(path)) };
}

export function visibleTrees(config) {
  return config.trees.filter((entry) => entry.visible).map((entry) => entry.name);
}

// Missing roots stay addressable so a call can explain itself instead of
// reading like a wrong tree name.
export function missingTree(config, name) {
  const wanted = String(name ?? "");
  return (config.missing ?? []).find((entry) => entry.name === wanted && entry.visible !== false) ?? null;
}

export function resolveTree(config, name) {
  const entry = config.trees.find((value) => value.name === String(name ?? ""));
  if (!entry || !entry.visible) return null;
  return entry;
}
