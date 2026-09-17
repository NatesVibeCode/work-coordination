#!/usr/bin/env node
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.mjs";
import { buildServer } from "./server.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const configPath = process.env.WORK_COORDINATION_MCP_CONFIG ?? join(here, "..", "config.json");

// Stdout is the protocol. A startup failure belongs on stderr as one line a
// human can act on — never a stack trace, and never anything on stdout.
let config;
try {
  config = loadConfig(configPath);
} catch (error) {
  const reason = error?.code === "ENOENT" ? "no such file" : (error?.message ?? String(error));
  process.stderr.write(`work-coordination-mcp · cannot read config · ${configPath} · ${reason}\n`);
  process.stderr.write("set WORK_COORDINATION_MCP_CONFIG to a readable config.json (see mcp/README.md)\n");
  process.exit(1);
}

const server = buildServer(config);

await server.connect(new StdioServerTransport());
