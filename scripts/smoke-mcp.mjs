/**
 * Smoke test: boot the built server (dist/index.js) over real stdio,
 * list tools, and exercise two tools (one live-API, one file-based).
 * Run from repo root after `npm run build`:  node scripts/smoke-mcp.mjs
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
});
const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(transport);

const tools = await client.listTools();
console.log("TOOLS:", tools.tools.map((t) => t.name).join(", "));

const res = await client.callTool({
  name: "search_parts",
  arguments: { query: "AMS1117-3.3", limit: 3 },
});
console.log("--- search_parts result (first 600 chars) ---");
console.log(res.content[0].text.slice(0, 600));

const kicad = await client.callTool({
  name: "analyze_kicad",
  arguments: { path: "examples/esp32c3-sensor/esp32c3-sensor.kicad_sch" },
});
console.log("--- analyze_kicad summary line ---");
console.log(kicad.content[0].text.split("\n")[0]);

await client.close();
