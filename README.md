# jlcpcb-skill-mcp

**English** | [한국어](README.ko.md) | [📖 Docs site](https://hulryung.github.io/jlcpcb-skill-mcp/)

An MCP server + Claude skill that picks JLCPCB/LCSC parts for your KiCad circuit with **assembly cost in mind**.

> 📖 **Docs & install guide (Claude Code / Codex / other MCP clients):** https://hulryung.github.io/jlcpcb-skill-mcp/

Not just search — it automates part *selection*:

- **Basic > Preferred > Extended tier priority** — Extended parts carry a $3 loading fee per unique part (Basic is free; Preferred Extended is waived on Economic PCBA)
- **Stock risk checks** — verifies stock covers 5–10× your production need
- **Quantity-tiered pricing** — costs are computed at the price break your order quantity actually hits
- **KiCad integration** — parses `.kicad_sch` schematics / BOM CSVs directly and matches lines to LCSC part numbers
- **Package consolidation hints** — flags the same value scattered across 0603/0805 to save reel changes

Data comes from the public [jlcsearch](https://github.com/tscircuit/jlcsearch) API by tscircuit.

## Demo

One command takes the example ESP32-C3 board from schematic to a costed, tier-aware BOM (live data):

![Demo — suggesting JLCPCB parts for the example ESP32-C3 board](docs/demo.gif)

And the same thing inside a **real Claude Code session** — one natural-language request ("Search for parts and pick the right ones for this board, for a 20-board production run.") drives the skill + MCP tools end to end:

![Demo — a live Claude Code session picking parts via the plugin](docs/demo-claude.gif)

(Also available as MP4: [script demo](docs/demo.mp4) · [session demo](docs/demo-claude.mp4). Re-render with `vhs docs/demo.tape` / `vhs docs/demo-claude.tape`.)

## Quick start

```bash
npm install
npm run build
```

This repository ships a `.mcp.json`, so opening this directory in Claude Code registers the server automatically.

The part-selection skill (`.claude/skills/jlcpcb-parts/`) loads alongside it — ask "pick parts for this circuit" and the skill drives the tools in order, applying the tier/stock/price doctrine.

## Using it in other projects / globally

**Easiest path — install the plugin** (skill + MCP in one step, no clone or build):

```
/plugin marketplace add hulryung/jlcpcb-skill-mcp
/plugin install jlcpcb-parts@jlcpcb-tools
```

If you installed the plugin, skip the manual registration in 1) and 2) below — they only matter when developing against a local checkout.

**1) Register the MCP server at user scope** — applies to every project:

```bash
claude mcp add --scope user jlcpcb-parts -- node /path/to/jlcpcb-skill-mcp/dist/index.js
claude mcp list   # confirm "✔ Connected"
```

Remove with `claude mcp remove jlcpcb-parts -s user`. (Inside this repo the project-scope `.mcp.json` overlaps with it and prints a duplicate warning; it is the same server, so this is harmless.)

**2) Install the skill globally (personal scope)** — a symlink, so repo updates propagate automatically:

```bash
ln -sfn /path/to/jlcpcb-skill-mcp/.claude/skills/jlcpcb-parts ~/.claude/skills/jlcpcb-parts
```

**3) Workflow alongside KiCad** — KiCad itself is not an MCP client, so the integration is "a terminal next to KiCad":

```bash
cd ~/dev/my-board          # the project with your .kicad_sch
claude
> Pick parts for this circuit, for a 50-board run.
```

The skill triggers automatically and runs `analyze_kicad` → `suggest_bom_parts` → resolves review lines → estimates cost; ask it to fix LCSC fields/footprints and it edits the schematic for you. **After schematic edits, press F8 in KiCad (Update PCB from Schematic)** to propagate changes to the board. For hierarchical designs, pass the root sheet — sub-sheets are followed automatically.

**4) Claude Desktop / other MCP clients** — it is a plain stdio server, so it plugs in anywhere. For Claude Desktop, add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "jlcpcb-parts": {
      "command": "node",
      "args": ["/path/to/jlcpcb-skill-mcp/dist/index.js"]
    }
  }
}
```

Fully quit and restart the Desktop app to apply. (Skills are Claude Code-only; Desktop gets the tools.)

**Updating**: `git pull && npm install && npm run build` — registrations point at `dist/index.js`, so no re-registration is needed.

## Distributing to a team: GitHub, npm, or a remote server

Three ways to share without local paths.

**A) Claude Code plugin (recommended — ships skill + MCP together)**

This repo is structured as a plugin and its own marketplace (`.claude-plugin/plugin.json` + `marketplace.json`, with a dependency-inclusive single-file bundle `dist-plugin/index.mjs` committed). Teammates need no clone and no build:

```
/plugin marketplace add hulryung/jlcpcb-skill-mcp
/plugin install jlcpcb-parts@jlcpcb-tools
```

Skill and MCP server install together, with update/removal via the `/plugin` menu. After changing server code, run `npm run bundle` and commit the refreshed bundle. Direct single-plugin installs without a marketplace are not supported, hence the included `marketplace.json`.

**B) Publish to npm (MCP only)**

```bash
npm publish           # then users run:
claude mcp add jlcpcb-parts -- npx -y jlcpcb-parts-mcp
```

npx caches the package, so it does not reinstall every session. The skill must be distributed separately (option A covers that), so this fits MCP-only consumers. Note `npx github:owner/repo`-style direct GitHub execution is not supported.

**C) Hosted catalog API on Cloudflare D1 (zero download)**

A [Cloudflare Worker](worker/) serves the full in-stock JLCPCB catalog (~693k parts) from D1, so teammates get catalog search without the local DB download — they just point the local MCP server at the URL. A live instance runs at `https://jlcpcb-parts-api.dkkang7484.workers.dev`:

```bash
claude mcp add --scope user jlcpcb-parts \
  -e JLCPCB_API_URL=https://jlcpcb-parts-api.dkkang7484.workers.dev \
  -- node /path/to/jlcpcb-skill-mcp/dist/index.js
```

The KiCad file tools still run locally (a remote server can't read your `.kicad_sch`); only the parts data comes from D1. `get_part` proxies live jlcsearch for fresh stock + preferred tier. Deploy your own with `npm run build:d1-db` + the runbook in [worker/README.md](worker/README.md) — it fits the D1 **free plan** (~330 MB < 500 MB).

## Local parts database (optional)

By default the server queries the live [jlcsearch](https://github.com/tscircuit/jlcsearch) API. You can instead run against a **local copy of the full JLCPCB catalog** — no rate limits, no dependency on a third-party mirror, and complete results (the live mirror caps some queries at 100 rows).

```bash
npm run db:update      # downloads ~830 MB, expands to ~4.9 GB at ~/.cache/jlcpcb-parts/
```

Requires the `unzip` CLI and Node ≥ 22 (built-in `node:sqlite`). The server auto-detects the DB on start and switches to **hybrid mode**: search runs offline over the full catalog, while `get_part` still hits the live API for fresh stock and the preferred-tier flag before you commit to a part. The download is a snapshot (from [bouni/kicad-jlcpcb-tools](https://github.com/bouni/kicad-jlcpcb-tools), rebuilt daily) so stock figures are approximate until that final live check — always re-verify before ordering.

- Refreshes when older than 7 days (`npm run db:update -- --force` to force).
- `JLCPCB_PARTS_DB=/path/to/parts-fts5.db` overrides the location.
- The catalog DB distinguishes only Basic vs Extended (not Preferred); preferred-extended detection still comes from the live API on `get_part`. Basic detection matches the live data (verified 13/13 on real boards).

## MCP tools (7)

| Tool | Purpose |
|---|---|
| `search_parts` | Free-text search (package / tier / min-stock filters) |
| `search_passives` | Parametric R/C search — understands `"10k"`, `"4k7"`, `"100nF"` notation |
| `get_part` | Detail lookup by LCSC number (price breaks, attributes) |
| `find_alternatives` | Same-spec substitutes, ranked by tier/stock/price |
| `analyze_kicad` | `.kicad_sch` / BOM CSV → grouped BOM lines (DNP and LCSC fields honored) |
| `suggest_bom_parts` | Whole-BOM matching + ranking + cost (the core tool) |
| `estimate_assembly_cost` | Component cost + loading fees for a chosen part list |

## Example run (real output)

The bundled example board `examples/esp32c3-sensor` (ESP32-C3 + AMS1117 + USB-C + 15 passives), for a 20-board run:

```bash
npm run demo
```

| Refs | Qty | Value | Pkg | LCSC | Tier | Stock | Unit | Status |
|---|---|---|---|---|---|---|---|---|
| J1 | 1 | USB-C | — | C165948 | extended | 336,394 | $0.16 | preassigned |
| U2 | 1 | AMS1117-3.3 | SOT-223 | C6186 | **basic** | 1,490,681 | $0.15 | preassigned |
| U1 | 1 | ESP32-C3 | QFN-32 | C2838500 | extended | 8,750 | $1.55 | needs_review |
| R1 R2 | 2 | 10k | 0603 | C25804 | **basic** | 37,165,617 | $0.0008 | matched |
| R3 R4 | 2 | 5.1k | 0603 | C23186 | **basic** | 7,571,904 | $0.0009 | matched |
| C1 C2 | 2 | 100nF | 0603 | C14663 | **basic** | 81,299,425 | $0.0022 | matched |
| … | | | | | | | | |

```
Components $39.05 + Loading fees $9.00 (3 extended parts × $3) = $48.05  ($2.40/board)
needs review: U1 (IC matched via text — verify footprint), SW1 (switch matched via text)
```

Passives all land on basic-tier parts with millions in stock; low-confidence matches (IC text search, package prefix match) are flagged `needs_review` instead of being silently accepted.

## Selection rules (encoded in the engine + skill)

1. **Hard filters**: out-of-stock dropped; resistance ±0.5% / capacitance ±5% value match; package match (exact for passives, prefix-tolerant for ICs with a review flag); tolerance at least as tight as requested
2. **Scoring**: tier (basic +100 / preferred +60 / extended +0) → stock adequacy (+25 plus depth bonus) → price (+15) → tolerance (+3)
3. **Cost**: the loading fee counts once per unique extended part (no double-charging a part reused across lines)

## Limitations & caveats

- jlcsearch is an **unofficial** mirror of JLCPCB data. Stock and prices are snapshots — **re-verify with `get_part` right before ordering**.
- Text matching for ICs/connectors is a convenience — always verify the MPN and datasheet (`needs_review` is that signal).
- Supports KiCad 6–9 `.kicad_sch` files and common BOM CSV exports.

## Development

```bash
npm test          # full test suite (vitest)
npm run demo      # live end-to-end demo
node scripts/smoke-mcp.mjs  # stdio smoke test of the built server
```

Layout: `src/kicad` (parsers) · `src/jlc` (API client) · `src/engine` (ranking/cost) · `src/tools` (MCP tools) — module contracts in `CONTRACTS.md`, live API findings in `docs/jlcsearch-api-notes.md`.

## Credits

- Data: [tscircuit/jlcsearch](https://github.com/tscircuit/jlcsearch), upstream data pipeline [yaqwsx/jlcparts](https://github.com/yaqwsx/jlcparts)
- Unofficial project, not affiliated with JLCPCB/LCSC.

MIT License
