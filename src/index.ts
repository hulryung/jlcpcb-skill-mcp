#!/usr/bin/env node
/**
 * jlcpcb-parts MCP server entry point (stdio transport).
 * stdout carries the MCP protocol — diagnostics go to stderr only.
 */
import { existsSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./server.js";
import { defaultDbPath } from "./jlc/db.js";

async function main(): Promise<void> {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const dbPath = process.env.JLCPCB_PARTS_DB || defaultDbPath();
  const mode = existsSync(dbPath)
    ? `local DB (${dbPath}) + live API verify`
    : "live jlcsearch API";
  console.error(`jlcpcb-parts MCP server running on stdio — parts data: ${mode}`);
}

main().catch((e) => {
  console.error("jlcpcb-parts fatal:", e);
  process.exit(1);
});
