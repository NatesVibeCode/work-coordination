#!/usr/bin/env node
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.mjs";
import { buildServer } from "./server.mjs";

const configPath = process.env.WORK_COORDINATION_MCP_CONFIG ?? join(dirname(fileURLToPath(import.meta.url)), "..", "config.json");
const server = buildServer(loadConfig(configPath));

await server.connect(new StdioServerTransport());
