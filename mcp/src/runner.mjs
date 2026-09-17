import { join } from "node:path";
import { missingTree, resolveTree, visibleTrees } from "./config.mjs";
import { storeForTree } from "../../src/operations.mjs";

// Runs an operation against a tree's store in-process: no CLI on PATH, no
// spawned process, no timeout to tune. The store resolves the way the CLI
// resolves it from the tree directory — same store when the tree has one —
// but the fallback stays inside the tree root, so the server never reads or
// writes outside a declared tree. Unknown and hidden trees never reach the
// operation.
export async function runOp(config, treeName, operation) {
  const tree = resolveTree(config, treeName);
  if (!tree) {
    // A declared tree whose root is gone says why, instead of looking like a
    // misspelled tree name.
    const absent = missingTree(config, treeName);
    if (absent) return { ok: false, output: `unavailable · root missing · ${absent.root}` };
    return { ok: false, output: "tree unavailable" };
  }
  try {
    const fallback = tree.state ?? join(tree.root, ".work-coordination");
    const output = String(await operation(storeForTree(tree.root, tree.state, fallback), tree) ?? "").trimEnd();
    return { ok: true, output: output || "(no output)" };
  } catch (error) {
    const detail = String(error?.message ?? error).trim();
    return { ok: false, output: `unavailable · ${detail || "transport failed"}` };
  }
}

export function treeNames(config) {
  const visible = visibleTrees(config);
  const absent = (config.missing ?? [])
    .filter((entry) => entry.visible !== false)
    .map((entry) => `${entry.name} · unavailable · root missing · ${entry.root}`);
  return [...visible, ...absent];
}
