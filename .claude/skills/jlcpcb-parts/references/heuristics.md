# Long-tail selection heuristics

Supplement to SKILL.md. Load when a BOM line resists the standard doctrine.

## E-series value substitution

Resistor/capacitor catalogs follow E-series ladders. When the exact requested
value has no basic-tier or in-stock part, substitute a neighbor — but only when
the circuit tolerates it.

| Series | Step | Typical use |
|---|---|---|
| E12 | ~20% apart | 5% resistors, most capacitors |
| E24 | ~10% apart | 5%/1% resistors, better capacitors |
| E96 | ~2.4% apart | 1% precision resistors |

Substitution rules:

- **Pull-ups/pull-downs, LED ballast, RC debounce, bulk decoupling:** any
  neighbor within ±20% is fine. 10k ↔ 9.1k ↔ 12k, 100nF ↔ 220nF for
  decoupling. Prefer the neighbor that IS a basic part.
- **Voltage dividers (feedback networks, ADC scaling):** the *ratio* matters,
  not the absolute values. Re-solve the divider with two available E24/E96
  values instead of forcing one odd value. State the new ratio error.
- **Precision references, gain-set resistors, sense resistors, oscillator load
  caps, filters with defined corner frequency:** do NOT substitute silently.
  Compute the effect (corner shift, gain error) and ask the user.
- Notation reminder: "4k7" = 4.7kΩ, "4R7" = 4.7Ω, "R047" = 47mΩ.

## 0402 vs 0603 tradeoffs

| Factor | 0402 | 0603 |
|---|---|---|
| Basic-tier coverage | Good | Best (densest catalog) |
| Unit price | Equal or cheaper | Equal |
| Hand rework / prototyping | Painful | Easy |
| Power rating (typ. resistor) | 1/16 W (62.5mW) | 1/10 W (100mW) |
| Capacitance ceiling per voltage | Lower (DC-bias derating bites harder) | Higher |
| Assembly yield on cheap fab | Slightly worse | Robust |

Default to 0603 unless the board is genuinely space-constrained. Never mix
0402 and 0603 for the same value without a layout reason — consolidate.
Watch ceramic capacitor **DC-bias derating**: a 1µF 0402 X5R at 5V may deliver
less than half its rated capacitance; step up the package or the voltage
rating when the application needs the real microfarads.

## MSL and reflow notes

- Moisture Sensitivity Level (MSL) 1 parts need no handling care; MSL 3+
  (common for QFN/BGA/large ICs) require dry-pack baking before reflow.
  JLCPCB handles baking for assembled parts — this matters mainly when the user
  will hand-solder leftovers or orders parts LCSC-only.
- Electrolytic and some polymer caps have limited reflow tolerance; if a cap is
  only available as a through-hole or hand-soldered type it may force Standard
  PCBA or manual assembly (see below).
- Crystals and MEMS oscillators are reflow- and moisture-sensitive; prefer
  parts explicitly rated for standard lead-free reflow profiles.

## Multi-sourcing strategy

- For every IC, connector, crystal, and any extended part: record a **primary
  and at least one alternate** LCSC number in the BOM (KiCad field
  `LCSC ALT` or a BOM column). Run `find_alternatives` at selection time, not
  during a stockout panic.
- Prefer parts with multiple manufacturers making pin-compatible versions
  (AMS1117 clones, generic MOSFETs like AO3400, NE555, LM358, XL/MT buck
  families). A single-manufacturer boutique part with 3k stock is a red flag
  for production.
- For passives, alternates are trivial (same value/package from another maker)
  — don't clutter the BOM; the engine can re-pick. Concentrate alternate
  effort on semiconductors and electromechanical parts.
- If a critical part's stock < 2× a *year's* projected need, suggest the user
  buy ahead (LCSC order, consign later) or redesign around a commoner part.

## When Standard PCBA is forced (fee waiver lost)

Economic PCBA is the cheap lane; the preferred-tier fee waiver applies there.
These constraints push an order to **Standard PCBA**, where preferred parts are
charged like extended:

- **Through-hole assembly** by JLCPCB (hand/wave soldering of THT connectors,
  electrolytics, transformers).
- **Parts on both sides** of the board.
- **Surface finish** other than the economic options (e.g. ENIG in some
  combinations, thick gold), unusual board thickness, 4+ layer impedance
  combos outside the economic envelope.
- Boards outside economic size/panelization limits, or needing special
  processes (edge plating, press-fit).

Design responses: keep all assembled parts on one side; choose SMD connectors
over THT where mechanically acceptable; leave THT parts (big connectors,
electrolytics) off the assembly order and hand-solder them; re-check whether
the finish constraint is real. If Standard PCBA is unavoidable, recount fees:
every preferred part now adds $3, which can flip a preferred-vs-basic tie.

## LCSC-only ordering vs JLCPCB assembly

Two distinct fulfillment paths — don't conflate them:

| | JLCPCB assembly (PCBA) | LCSC order (parts shipped to you) |
|---|---|---|
| Loading fee | $3/unique extended part | None — fee is an assembly concept |
| Tier relevance | Central to cost | Irrelevant (only price/stock matter) |
| Minimum qty | Attrition + feeder minimums (a few extra units consumed per line) | Per-part MOQ (often 1-10 for cut tape, full reel for some) |
| Stock pool | JLCPCB-stocked + LCSC transfer (adds lead time) | LCSC warehouse |

- If the user is hand-assembling, ignore tiers entirely; optimize price breaks
  and MOQ instead.
- If a wanted part shows LCSC stock but not JLCPCB stock, it can usually be
  ordered in ("global sourcing"/pre-order) at the cost of lead time — flag the
  delay, don't call it unavailable.
- Consignment (user ships parts to JLCPCB) escapes loading fees but adds
  handling overhead; only worth suggesting for expensive or unobtainable parts.
