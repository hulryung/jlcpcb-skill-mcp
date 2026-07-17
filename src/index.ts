#!/usr/bin/env node
/**
 * jlcpcb-parts MCP server entry point (stdio transport).
 * stdout carries the MCP protocol — diagnostics go to stderr only.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./server.js";

async function main(): Promise<void> {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("jlcpcb-parts MCP server running on stdio");
}

main().catch((e) => {
  console.error("jlcpcb-parts fatal:", e);
  process.exit(1);
});
