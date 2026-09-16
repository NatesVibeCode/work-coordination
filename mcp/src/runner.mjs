import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveTree, visibleTrees } from "./config.mjs";

const execFileAsync = promisify(execFile);

export async function runCli(config, treeName, argv, { execFn = execFileAsync } = {}) {
  const tree = resolveTree(config, treeName);
  if (!tree) return { ok: false, output: "tree unavailable" };
  try {
    const { stdout } = await execFn(config.cliPath, argv, { cwd: tree.root, timeout: config.timeoutMs });
    return { ok: true, output: String(stdout ?? "").trimEnd() || "(no output)" };
  } catch (error) {
    const detail = String(error?.stderr ?? error?.message ?? error).trim();
    return { ok: false, output: `unavailable · ${detail || "transport failed"}` };
  }
}

export function treeNames(config) {
  return visibleTrees(config);
}

export function flag(argv, name, value) {
  if (value === undefined || value === null || value === "") return argv;
  argv.push(name, String(value));
  return argv;
}
