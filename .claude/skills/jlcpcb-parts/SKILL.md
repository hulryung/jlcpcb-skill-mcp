---
name: jlcpcb-parts
description: Select and suggest JLCPCB/LCSC parts for a circuit or KiCad project with assembly-cost awareness (basic/preferred/extended tiers, loading fees, stock risk). Use when choosing components, matching a KiCad BOM to LCSC part numbers, or estimating PCBA cost.
---

# JLCPCB Part Selection

## 1. When to use

Use this skill whenever the user is:

- Choosing components for a board that JLCPCB will assemble (PCBA).
- Matching a KiCad schematic or BOM CSV to LCSC part numbers (`C#####`).
- Comparing candidate parts, finding alternatives, or de-risking a BOM.
- Estimating assembly cost (component cost + loading fees) for N boards.

Do NOT hand-pick parts from memory. Part numbers, stock, prices, and tier
status change constantly — always go through the MCP tools below, and re-verify
immediately before the user actually orders.

## 2. Core facts

### Part tiers and loading fees

| Tier | Meaning | Loading fee |
|---|---|---|
| `basic` | ~700 common part types, pre-loaded on pick&place lines | **None** |
| `preferred` | "Preferred Extended" parts | **Waived** on Economic PCBA |
| `extended` | Everything else | **$3 per unique part type** per order |

- The fee is per *unique part*, not per placement: 100 boards × 1 extended part
  = $3 total; 1 board × 10 different extended parts = $30.
- Tier mapping from search results: `is_basic → basic`, else
  `is_preferred → preferred`, else `extended`.
- LCSC numbers are written `"C" + id` (25804 → `C25804`). Part page:
  `https://jlcpcb.com/partdetail/C<id>`.

### Economic vs Standard PCBA caveat

The preferred-tier fee waiver applies to **Economic PCBA only**. If the design
forces Standard PCBA (through-hole assembly, parts on both sides, unusual
surface finishes, large/heavy boards — see `references/heuristics.md`),
preferred parts are charged like extended ones. When a design smells like
Standard PCBA, count preferred parts into the fee risk and say so.

### Price breaks

- Prices are quantity-tiered (`qFrom`/`qTo` breaks). Always quote the unit
  price **at the quantity actually needed** (board_qty × qty_per_board), never
  the qty-1 price or the deepest break.
- A part that is cheaper at qty 10 can be more expensive at qty 1000 than a
  rival — re-rank when the user changes board quantity.
- Some sources return a single price with no breaks; treat that price as
  approximate and flag "price unknown at volume".

## 3. Selection heuristics (ranking doctrine)

Apply in this order — earlier criteria dominate later ones:

1. **Tier first.** A basic part beats a preferred part beats an extended part
   at comparable specs. The suggestion engine scores tier basic +100 /
   preferred +60 / extended +0 — that dominance is intentional: a $3 fee wipes
   out any per-unit saving on cheap passives. Only pick extended when no
   basic/preferred part meets the spec.
2. **Stock adequacy.** Required stock ≥ 5-10× the production need
   (need = board_qty × qty_per_board). For passives additionally demand
   **>10k absolute stock** — anything thinner can vanish between quoting and
   ordering. Stock < need is a hard "stock risk" warning; stock ≤ 0 disqualifies.
3. **Price at the needed quantity.** Compare candidates at the same quantity
   using their price breaks. Price is a tiebreaker after tier and stock, not
   the lead criterion.
4. **Package consolidation.** If the BOM has the same value in multiple
   packages (10k in 0402 and 0603), propose consolidating to one package —
   fewer unique parts, fewer feeders, fewer fee-bearing lines.
5. **Alternatives.** For every critical or single-source line (ICs, connectors,
   crystals, anything extended), name **at least one backup part**. A BOM with
   no second source on its MCU is a schedule risk, say so explicitly.

Component-type guidance:

- **Passives:** prefer 0603, then 0402 — that's where the basic-tier catalog is
  densest. Resistors: default ±1% (basic 1% parts cost the same as 5%).
  Capacitors: for decoupling/general use specify X7R (or better) and a voltage
  rating ≥ 2× the rail; avoid Y5V. Exact-value fixation wastes money — accept
  E-series neighbors when the circuit tolerates it (rules in
  `references/heuristics.md`).
- **ICs — text-match risk.** Search is fuzzy text; "LM358" matches dozens of
  suffix variants with different packages, grades, temperature ranges. **Always
  verify the full MPN AND the package against the datasheet** before accepting
  an IC match. Never accept an IC line on description similarity alone — that
  is exactly what `needs_review` status exists for.
- **Connectors:** verify the footprint's pin pitch, pin count, and mounting
  style against the candidate's drawing. "USB-C connector" matches dozens of
  mechanically incompatible parts. Treat every connector match as needs_review
  until footprint-verified.
- **Stock volatility:** stock figures are a snapshot. Re-run `get_part` on
  every chosen LCSC number right before the user orders; flag any line whose
  stock dropped below the 5× threshold.

## 4. Workflow (exact tool sequence)

1. **`analyze_kicad`** — pass the `.kicad_sch` or BOM `.csv` path. Review the
   grouped BOM lines: check quantities look sane, note DNP lines and any
   pre-assigned LCSC fields.
2. **`suggest_bom_parts`** — pass the same `path` (or explicit `bom_lines`)
   plus `board_qty` (ask the user; default 10). Optionally `stock_multiple`
   (default 5) and `max_candidates` (default 5). Read the per-line status:
   - `matched` — accept the chosen candidate; skim its warnings.
   - `preassigned` — the schematic pinned an LCSC number. Keep it, but relay
     any low-stock or extended-fee warnings; suggest a basic swap if one exists.
   - `skipped_dnp` — do not source, do not cost; list it as DNP in the output.
   - `needs_review` — see step 3.
   - `no_match` — see step 4.
3. **Resolve `needs_review` lines.** Typical causes: IC matched only by fuzzy
   text, or the top pick is extended with a stock warning. Run **`get_part`**
   on the candidate to inspect full attributes and price breaks, verify MPN +
   package against the datasheet, and run **`find_alternatives`** to look for a
   basic/preferred or better-stocked substitute. If still ambiguous, present
   the top 2-3 candidates and ask the user to decide.
4. **Resolve `no_match` lines.** For resistors/capacitors, retry with
   **`search_passives`** (`kind`, `value` like `"10k"`/`"100nF"`, `package`).
   For everything else, retry **`search_parts`** with progressively looser
   queries (MPN → MPN family → function keywords), or relax the package. If
   nothing fits, tell the user the line needs a manual pick or a consigned part
   — never silently drop it.
5. **`estimate_assembly_cost`** — pass the final chosen list as
   `parts: [{lcsc, qty_per_board}]` plus `board_qty` for the authoritative
   cost breakdown (component total, loading fees, per-board).
6. **Present** the suggested BOM in the format below, with per-line reasoning,
   the cost summary, and the risk list.
7. **Import into KiCad (optional, on request).** When the user wants a chosen
   part usable in their design, run **`import_part_to_kicad`** with the
   `lcsc` (one or many) and `project_dir` (their KiCad project). It fetches the
   symbol, footprint, and 3D model (STEP + WRL), writes them into the project's
   `libs/lcsc/` libraries, and registers them in the sym/fp-lib-table so they
   appear in the choosers — the user just reopens the project. Pass a whole
   accepted BOM's LCSC list to import everything at once; pass `include` to
   limit to e.g. symbol+footprint. Requires the kicad-lcsc-manager engine and
   python3; if it reports the engine is missing, point the user to install it.
   Do NOT import a `needs_review` IC/connector before its MPN + footprint are
   confirmed.

## 5. Output format

Suggested-BOM table (one row per BOM line; Qty = per board):

| Ref | Qty | Value/MPN | LCSC | Tier | Stock | Unit$ | Line$ | Why |
|---|---|---|---|---|---|---|---|---|

- `Unit$` = unit price at the needed quantity; `Line$` = unit × qty_per_board
  × board_qty. DNP rows: mark `DNP`, no LCSC/cost.
- `Why` = one clause: tier + the deciding factor ("Basic, 30M stock", "Only
  X7R 0603 in stock", "Extended — no basic equivalent").

Cost summary block:

```
Boards: 10
Components: $X.XX
Loading fees: $Y (N extended parts × $3; preferred waived on Economic PCBA)
Total: $Z.ZZ  (≈ $Z.ZZ / board, excl. PCB fab + assembly service fee)
```

Risk list: bullet every warning — low stock lines, extended fees, text-matched
ICs pending datasheet check, single-source lines without alternatives, DNP.

## 6. Worked micro-example

3-line BOM, 10 boards:

| Ref | Qty | Value/MPN | LCSC | Tier | Stock | Unit$ | Line$ | Why |
|---|---|---|---|---|---|---|---|---|
| R1-R4 | 4 | 10kΩ ±1% 0603 | C25804 | basic | 30M+ | USD 0.001 | USD 0.04 | Basic, huge stock, no fee |
| C1-C3 | 3 | 100nF X7R 50V 0603 (CC0603KRX7R9BB104) | C14663 | basic | 80M+ | USD 0.002 | USD 0.06 | Basic decoupling staple |
| U1 | 1 | AP2112K-3.3 SOT-25-5 (= SOT-23-5 footprint) | C51118 | extended | 180k | USD 0.13 | $1.27 | Meets 600mA/low-IQ spec; +$3 fee |

```
Boards: 10
Components: $1.37
Loading fees: $3 (1 extended part × $3)
Total: $4.37  (≈ USD 0.44 / board, excl. PCB fab + assembly service fee)
```

Risks: U1 is extended and single-source here — alternative: AMS1117-3.3
(C6186, basic, no fee) if the higher dropout and ~5mA quiescent current are
acceptable; ask the user before swapping. Re-verify all stock before ordering.
