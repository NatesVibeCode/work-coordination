import { resolveTree, visibleTrees } from "./config.mjs";
import { storeForTree } from "../../src/operations.mjs";

// Runs an operation against a tree's store in-process: no CLI on PATH, no
// spawned process, no timeout to tune. The store resolves exactly the way
// the CLI resolves it from the tree directory, so both frontends see the
// same state. Unknown and hidden trees never reach the operation.
export async function runOp(config, treeName, operation) {
  const tree = resolveTree(config, treeName);
  if (!tree) return { ok: false, output: "tree unavailable" };
  try {
    const output = String(await operation(storeForTree(tree.root), tree) ?? "").trimEnd();
    return { ok: true, output: output || "(no output)" };
  } catch (error) {
    const detail = String(error?.message ?? error).trim();
    return { ok: false, output: `unavailable · ${detail || "transport failed"}` };
  }
}

export function treeNames(config) {
  return visibleTrees(config);
}
