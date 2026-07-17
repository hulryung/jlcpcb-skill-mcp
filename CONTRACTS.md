# Module Contracts

Authoritative interface spec for jlcpcb-skill-mcp. Each module is owned by one
implementer and MUST export exactly these functions (plus any private helpers).
All shared types live in `src/types.ts` — import from there, never redefine.

TypeScript, ESM ("type": "module", moduleResolution NodeNext) — **relative
imports must use `.js` extensions** (`import { x } from "../types.js"`).
Tests live in `tests/<module>/*.test.ts` (vitest), fixtures in `tests/fixtures/`.
Tests must NOT hit the network — use recorded JSON fixtures.

## Verified facts (do not re-derive)

### jlcsearch API (base: https://jlcsearch.tscircuit.com)

- `GET /api/search?q=<text>&limit=<n>&full=true` → `{"components": [{lcsc: 25804 (number), mfr, package, is_basic, is_preferred, description, stock, price (single number, unit USD)}]}`
- `GET /components/list.json?search=<text>&full=true&limit=<n>` → `{"components": [{lcsc, mfr, package, description, stock, price: "<JSON string of [{qFrom,qTo,price}]>", category, subcategory, is_basic, is_preferred}]}`  ← price breaks come as a JSON **string**, parse it.
- `GET /resistors/list.json?resistance=<ohms>&package=0603&limit=<n>` → `{"resistors": [{lcsc, mfr, description, stock, price1 (number), in_stock, resistance (ohms), tolerance_fraction, power_watts (NOTE: appears to be milliwatt-scaled in samples — 100 for 100mW; treat as untrusted, prefer attributes), package, is_basic, is_preferred, attributes: "<JSON string of {Resistance:'10kΩ', Tolerance:'±1%', ...}>"}]}`
- `GET /capacitors/list.json?capacitance=<query>&package=0603&limit=<n>` → analogous; probe live to confirm param name/units before relying on it.
- `GET /categories/list.json` → `{"categories": [{category, subcategory}]}`
- Other category endpoints exist (`/microcontrollers/list.json`, `/voltage_regulators/list.json`, `/leds/list.json`, …) — probe before use.
- No auth. Be polite: sequential or ≤4 concurrent requests, timeout + 1 retry.

### JLCPCB assembly fee rules (encode in engine + skill)

- **Basic** parts (~700 common types): pre-loaded, **no loading fee**.
- **Preferred Extended** (`is_preferred`): loading fee **waived** (Economic PCBA).
- **Extended**: **$3 per unique part type** per order (loading fee).
- Tier mapping: `is_basic → "basic"`, else `is_preferred → "preferred"`, else `"extended"`.
- LCSC number formatting: `"C" + lcscId` (e.g. 25804 → "C25804").
- Product URL: `https://jlcpcb.com/partdetail/C<lcscId>`.

---

## Module A — `src/jlc/` (jlcsearch client)  [owner: agent-jlc]

Files: `src/jlc/client.ts`, `src/jlc/normalize.ts` (+ internal files as needed),
tests in `tests/jlc/`, live-API findings documented in `docs/jlcsearch-api-notes.md`.

```ts
// client.ts
export interface JlcClientOptions { baseUrl?: string; timeoutMs?: number; fetchFn?: typeof fetch }
export class JlcClient {
  constructor(opts?: JlcClientOptions)
  /** Free-text search via /api/search + /components/list.json (merged, deduped by lcsc). */
  searchComponents(opts: SearchOptions): Promise<Part[]>
  /** Parametric search. Falls back to searchComponents on API failure. */
  searchResistors(opts: ResistorSearchOptions): Promise<Part[]>
  searchCapacitors(opts: CapacitorSearchOptions): Promise<Part[]>
  /** Lookup by LCSC number ("C25804" | 25804 | "25804"). Null if not found. */
  getPart(lcsc: string | number): Promise<Part | null>
  /** Category-endpoint lookup returning the part WITH parsed attributes, or null. */
  getPassiveDetail(lcsc: string | number, kind: "resistor" | "capacitor"): Promise<Part | null>
  listCategories(): Promise<{ category: string; subcategory: string }[]>
}

// normalize.ts
export function normalizeComponent(raw: unknown): Part   // from /api/search or /components/list.json rows
export function normalizeResistor(raw: unknown): Part
export function normalizeCapacitor(raw: unknown): Part
export function parsePriceBreaks(price: unknown): PriceBreak[]  // handles number | JSON-string | array
export function toLcscId(lcsc: string | number): number  // "C25804"→25804, throws on garbage
```

Requirements:
- In-memory response cache (Map, keyed by URL, TTL 5 min) to spare the API.
- Client-side filtering for minStock/tier since the API lacks those params.
- Apply package filtering server-side when supported (`package=` param) AND
  defensively client-side (API behavior may drift).
- MUST probe the live API first (curl) for /capacitors and /components search-by-C-number
  behaviors; record what you find in docs/jlcsearch-api-notes.md.
- `attributes` JSON-string → parsed record on Part.attributes.

## Module B — `src/kicad/` (KiCad analysis)  [owner: agent-kicad]

Files: `src/kicad/sexpr.ts`, `src/kicad/schematic.ts`, `src/kicad/bom.ts`,
`src/kicad/value.ts`, `src/kicad/index.ts` (re-exports), tests in `tests/kicad/`,
fixtures in `tests/fixtures/kicad/`, demo project in `examples/esp32c3-sensor/`.

```ts
// sexpr.ts — minimal s-expression parser sufficient for .kicad_sch
export type SExpr = string | SExpr[]
export function parseSExpr(text: string): SExpr[]

// schematic.ts
/** Extract placed symbols from .kicad_sch text (KiCad 6/7/8/9 format). */
export function parseSchematic(text: string): KicadComponent[]
/** Sheetfile names of top-level (sheet ...) nodes — used by tools/common.ts to follow hierarchy. */
export function listSheetFiles(text: string): string[]
// - skip power symbols (lib_id "power:*") and symbols with "#" refs (#PWR, #FLG)
// - read properties: Reference, Value, Footprint, plus LCSC/"LCSC Part"/JLCPCB → lcsc
// - dnp: (dnp yes) node or "DNP" property; also respect (in_bom no) → exclude
// - handle multi-unit symbols: same Reference appears once in output

// bom.ts
/** Parse a KiCad BOM CSV export (header row required; flexible column names). */
export function parseBomCsv(text: string): KicadComponent[]
/** Group components into BOM lines by (class, normalized value, package). */
export function groupBom(components: KicadComponent[]): BomLine[]

// value.ts
export function classifyComponent(c: Pick<KicadComponent, "reference" | "value" | "footprint">): ComponentClass
export function parseValue(value: string, cls: ComponentClass): ParsedValue
// resistance: "10k","10K","4k7","10kΩ","0.1R","1M","470" → ohms
// capacitance: "100n","100nF","4u7","0.1uF","10p" → farads
// frequency: "8MHz","32.768kHz" → hertz
export function packageFromFootprint(footprint: string | undefined): string | undefined
// "Resistor_SMD:R_0603_1608Metric" → "0603"
// "Capacitor_SMD:C_0805_2012Metric" → "0805"
// "Package_TO_SOT_SMD:SOT-23" → "SOT-23"; "...:SOT-23-5" → "SOT-23-5"
// "Package_SO:SOIC-8_3.9x4.9mm_P1.27mm" → "SOIC-8"
// "LED_SMD:LED_0603_1608Metric" → "0603"
// unknown → undefined (never guess)
```

The example project `examples/esp32c3-sensor/esp32c3-sensor.kicad_sch` must be a
valid KiCad 8-format schematic our parser handles: ~12-15 components with a
realistic mix — 0603 R/C, LED, AMS1117-3.3 (basic part), ESP32-C3, USB-C
connector, buttons; a couple of symbols carrying an explicit LCSC field, one DNP.

## Module C — `src/engine/` (ranking + suggestion + cost)  [owner: agent-engine]

Files: `src/engine/rank.ts`, `src/engine/suggest.ts`, `src/engine/cost.ts`,
`src/engine/index.ts` (re-exports), tests in `tests/engine/`.

```ts
// rank.ts
export function unitPriceAtQty(part: Part, qty: number): number | null  // walk priceBreaks; fallback unitPrice
export function rankCandidates(line: BomLine, parts: Part[], opts: SuggestOptions): Candidate[]
// Hard filters (drop): stock <= 0; package mismatch when line.package is known
//   (case-insensitive; allow part.package aliases "0603"=="R0603"); spec mismatch:
//   resistance must equal parsed ohms (±0.5%), capacitance equal ±5% or standard E-series neighbor,
//   tolerance stricter-or-equal when line specifies one.
// Score (document weights as named consts):
//   tier: basic +100, preferred +60, extended +0
//   stock adequacy: needed = boardQty × qtyPerBoard × stockMultiple;
//     min(stock/needed, 1) × 25, plus log10 bonus up to +10 for deep stock
//   price: cheapest candidate +15 scaled down to most expensive +0 (at needed qty)
//   attribute quality: tighter tolerance small bonus (+3)
// Warnings: stock < needed ("stock risk"), tier extended ("+$3 loading fee"),
//   priceBreaks empty ("price unknown").
// Reasons: human sentences ("Basic part — no loading fee", "37M in stock", …).

// suggest.ts
export interface PartSearcher {  // implemented by JlcClient; keeps engine testable
  searchComponents(opts: SearchOptions): Promise<Part[]>
  searchResistors(opts: ResistorSearchOptions): Promise<Part[]>
  searchCapacitors(opts: CapacitorSearchOptions): Promise<Part[]>
  getPart(lcsc: string | number): Promise<Part | null>
}
export function buildSearchPlan(line: BomLine): { strategy: "resistor" | "capacitor" | "text" | "lcsc"; queries: string[] }
export async function suggestForLine(line: BomLine, searcher: PartSearcher, opts: SuggestOptions): Promise<LineSuggestion>
// - dnp → status "skipped_dnp", no search
// - line.lcsc present → getPart, status "preassigned", still verify stock and warn if low/extended
// - resistor/capacitor with parsed value → parametric search (fall back to text)
// - else text search: try value+package, then value alone, then value tokens
// - no candidates after filters → status "no_match" with notes on what was tried
// - candidates but top score weak (no tier bonus AND stock warning, or chosen is IC matched only by fuzzy text) → "needs_review"
export async function suggestForBom(lines: BomLine[], searcher: PartSearcher, opts: SuggestOptions): Promise<BomSuggestion>
// - sequential-ish (≤3 concurrent) to be polite to the API
// - BOM-level notes: package consolidation opportunities (same value R/C in ≠ packages),
//   count of extended parts and total loading fees, lines needing review

// cost.ts
export function estimateCost(lines: LineSuggestion[], boardQty: number): CostBreakdown
// componentCost from chosen candidates only; loadingFees = $3 × unique extended parts
// (dedupe by lcsc across lines; basic/preferred → $0)
export const DEFAULT_SUGGEST_OPTIONS: SuggestOptions // { boardQty: 10, stockMultiple: 5, maxCandidates: 5 }
```

Engine tests use hand-built `Part[]` fixtures — no network, no client import.

## Module D — `src/server.ts`, `src/index.ts`, `src/tools/` (MCP server)  [owner: agent-mcp]

MCP SDK 1.29 (`@modelcontextprotocol/sdk`): `McpServer` + `registerTool` + zod
raw shapes, `StdioServerTransport`. `src/index.ts` = shebang entry that builds
the server and connects stdio. **No console.log — stdout is the protocol; use
console.error for diagnostics.**

Tools (names exact):

| tool | input (zod) | behavior |
|---|---|---|
| `search_parts` | `query` str, `package?`, `tier?` enum basic/preferred/extended, `min_stock?` int, `limit?` int≤50 (default 10) | JlcClient.searchComponents |
| `search_passives` | `kind` enum resistor/capacitor, `value` str ("10k", "100nF"), `package?`, `limit?` | parse value via kicad/value.ts parseValue, then parametric search |
| `get_part` | `lcsc` str | getPart + full detail incl. price breaks, attributes |
| `find_alternatives` | `lcsc` str, `limit?` | getPart → build a BomLine-like probe from its class/specs/package → rank others, exclude itself |
| `analyze_kicad` | `path` str (.kicad_sch or BOM .csv), | read file (fs), parse, groupBom → BOM lines table |
| `suggest_bom_parts` | `path?` str OR `bom_lines?` array of {value, package?, qty?, class?}, `board_qty?` int (default 10), `stock_multiple?`, `max_candidates?` | full suggestForBom + estimateCost |
| `estimate_assembly_cost` | `parts` array of {lcsc, qty_per_board}, `board_qty` | getPart each → CostBreakdown |

Response format: every tool returns ONE text content block containing a short
human-readable summary line, then a fenced ```json block with the machine data
(compact, keys stable). On errors: `isError: true` with a clear message (e.g.
file not found, API unreachable). Tool descriptions must be written for an LLM
consumer: say when to use the tool and what the fields mean (tier semantics,
fee rules).

Also export `buildServer(client?: JlcClient): McpServer` from `src/server.ts`
for tests. Tests in `tests/server/`: build server with a stub client (inject via
constructor arg), call tools through `server` test transport
(`InMemoryTransport.createLinkedPair()` from the SDK) and assert JSON payload shape.

## Module E — `.claude/skills/jlcpcb-parts/SKILL.md` (selection skill)  [owner: agent-skill]

Frontmatter: `name: jlcpcb-parts`, `description:` one line covering triggers
(choosing JLCPCB/LCSC parts, BOM sourcing, KiCad BOM matching, assembly cost).
Body (English, ~150-250 lines): the selection doctrine —
tier rules & fees, stock heuristics (≥5-10× need; prefer >10k stock for passives),
price-break awareness, package consolidation, alternatives (≥1 backup per
critical line), when to flag needs_review (ICs matched by text, connectors),
Economic vs Standard PCBA nuance, and the exact tool-call workflow:
analyze_kicad → suggest_bom_parts → review needs_review lines with
search_parts/find_alternatives → estimate_assembly_cost → present table with
reasoning. Include a worked example table. Reference tool names exactly as in
Module D. Optional `references/heuristics.md` for the long-tail details.

## Module F — `site/index.html` (explainer website)  [owner: agent-site]

Single fully self-contained HTML file (inline CSS/JS, inline SVG diagrams, NO
external requests, no mermaid). Korean-language marketing/docs page for this
project: hero, "왜 필요한가" (fee/stock/selection pain), architecture diagram
(KiCad → MCP tools → jlcsearch data → suggestion engine → BOM), tool reference
table (7 tools from Module D), selection heuristics summary (tier/fee table:
Basic 무료, Preferred 면제, Extended $3), quickstart (claude mcp add / .mcp.json
snippet + skill usage), example suggested-BOM table (use realistic 555/ESP32
numbers, clearly marked 예시), FAQ. Light+dark theme via prefers-color-scheme
AND `:root[data-theme=…]` overrides. `<title>JLCPCB Parts MCP + Skill</title>`.
Responsive; wide tables wrapped in overflow-x:auto containers. No external
fonts; system font stack.
