# jlcsearch API — live probe notes

Base URL: `https://jlcsearch.tscircuit.com`. No auth. All probes below were run
live with curl on 2026-07-17; sample JSON is verbatim (trimmed to a few rows).
Recorded fixtures for tests live in `tests/fixtures/jlc/`.

## Summary of findings

| Question | Answer |
|---|---|
| `/capacitors/list.json` capacitance param | `capacitance=<farads>` as a **number** (decimal `0.0000001` or scientific `1e-7` both work). Unit strings (`100nF`) and picofarad numbers return **0 rows**. |
| `limit` on category endpoints (`/capacitors`, `/resistors`, `/leds`, …) | **Ignored** — always returns up to ~100 rows. Trim client-side. |
| `limit` on `/api/search` | **Respected** (`limit=3` → 3 rows). |
| `limit` on `/components/list.json` | **Ignored** (`limit=10` for `search=NE555` returned 27 rows). Trim client-side. |
| Exact LCSC lookup `/api/search?q=C7593` | Works — returns exactly 1 row, `lcsc: 7593`. Bare `q=7593` also works. |
| Exact LCSC lookup `/components/list.json?search=C7593` | Works — returns exactly 1 row **with price breaks + category** (richer than `/api/search`). Preferred endpoint for `getPart`. |
| Unknown part (`C999999999`) | HTTP 200 with `{"components": []}` on both endpoints (no 404). |
| `package=` on `/components/list.json` | Supported and filters correctly (`search=NE555&package=SOIC-8` → SOIC-8 rows only) — but **case-sensitive**: `package=soic-8` → **0 rows**. See dedicated section below. |
| `package=` on `/api/search` | Also supported (`q=NE555&package=SOIC-8&limit=20` → 3 SOIC-8 rows) and equally **case-sensitive** (`package=soic-8` → 0 rows). |
| `full=true` | Appears to be a **no-op** today: `is_basic`/`is_preferred` (and `category` on list.json) come back with or without it on both `/api/search` and `/components/list.json`. Still passed defensively. |
| `search=C<id>` on category endpoints | Works for exact-part lookup (`/resistors/list.json?search=C25804` → the C25804 row **with** its `attributes` JSON), but fuzzy: related rows ride along, capped at ~100 when unfiltered — match the exact `lcsc` client-side. |
| Fallback text queries | `/api/search?q=10k 0603` and `q=100nF 0603` return sensible passives (C25804, C14663 first). Good parametric→text fallback format: `"<human value> <package>"`. |

## `/capacitors/list.json`

`GET /capacitors/list.json?capacitance=0.0000001&package=0603&limit=3` → key `capacitors`,
100 rows (limit ignored), **all** rows `capacitance_farads ≈ 1e-7` — so the numeric
farads param genuinely filters (float-epsilon variants like `1.0000000000000001e-07`
included). `capacitance=100nF` → 0 rows. `capacitance=100000` (pF interpretation) →
0 rows at 0603. `capacitance=0.000001` → only 1e-6 rows. Sample row:

```json
{
  "lcsc": 14663,
  "mfr": "CC0603KRX7R9BB104",
  "description": "",
  "stock": 81299425,
  "price1": 0.002214286,
  "in_stock": true,
  "capacitance_farads": 1.0000000000000001e-07,
  "tolerance_fraction": 0.1,
  "voltage_rating": 50,
  "package": "0603",
  "temperature_coefficient": "X7R",
  "lifetime_hours": null,
  "esr_ohms": null,
  "ripple_current_amps": null,
  "is_polarized": false,
  "is_surface_mount": true,
  "capacitor_type": "unknown",
  "is_basic": true,
  "is_preferred": false,
  "attributes": "{\"Voltage Rated\":\"50V\",\"Tolerance\":\"±10%\",\"Capacitance\":\"100nF\",\"Temperature Coefficient\":\"X7R\"}"
}
```

Notes: `description` is empty on category endpoints; human-readable specs live in
the `attributes` JSON **string**. `price1` is a single number (qty-1-break price);
no price-break array on category endpoints.

## `/resistors/list.json`

`GET /resistors/list.json?resistance=10000&package=0603&limit=3` → key `resistors`,
100 rows (limit ignored), all `resistance: 10000`. `resistance` is in **ohms**. Sample:

```json
{
  "lcsc": 25804,
  "mfr": "0603WAF1002T5E",
  "description": "",
  "stock": 37165617,
  "price1": 0.000842857,
  "in_stock": true,
  "resistance": 10000,
  "tolerance_fraction": 0.01,
  "power_watts": 100,
  "package": "0603",
  "max_overload_voltage": 75,
  "number_of_resistors": null,
  "number_of_pins": null,
  "is_potentiometer": false,
  "is_surface_mount": true,
  "is_multi_resistor_chip": false,
  "is_basic": true,
  "is_preferred": false,
  "attributes": "{\"Resistance\":\"10kΩ\",\"Power(Watts)\":\"100mW\",\"Type\":\"Thick Film Resistors\",\"Overload Voltage (Max)\":\"75V\",\"Operating Temperature Range\":\"-55℃~+155℃\",\"Tolerance\":\"±1%\",\"Temperature Coefficient\":\"±100ppm/℃\"}"
}
```

`power_watts: 100` for a 100 mW part confirms CONTRACTS.md: the field is
milliwatt-scaled / untrusted — prefer `attributes["Power(Watts)"]`.

## Exact LCSC-number resolution

`GET /api/search?q=C7593&limit=5&full=true` → exactly one row:

```json
{"lcsc": 7593, "mfr": "NE555DR", "package": "SOIC-8", "is_basic": false, "is_preferred": true, "description": "", "stock": 322212, "price": 0.091}
```

`GET /components/list.json?search=C7593&full=true&limit=5` → exactly one row, richer
(price-break JSON **string** + category):

```json
{"lcsc": 7593, "mfr": "NE555DR", "package": "SOIC-8", "description": "", "stock": 322212, "price": "[{\"qFrom\": 1, \"qTo\": 49, \"price\": 0.091}, {\"qFrom\": 50, \"qTo\": 149, \"price\": 0.071857143}, {\"qFrom\": 150, \"qTo\": 499, \"price\": 0.062}, {\"qFrom\": 500, \"qTo\": 2499, \"price\": 0.053714286}, {\"qFrom\": 2500, \"qTo\": 4999, \"price\": 0.051}, {\"qFrom\": 5000, \"qTo\": null, \"price\": 0.049}]", "category": "Clock and Timing", "subcategory": "Timers / Clock Oscillators", "is_basic": false, "is_preferred": true}
```

`getPart` therefore queries `/components/list.json?search=C<id>` first, verifies the
returned row's `lcsc` equals the requested id (defensive — text search could go fuzzy),
and falls back to `/api/search?q=C<id>` if the components endpoint fails/returns nothing.
Both endpoints return `{"components": []}` (HTTP 200) for unknown numbers.

Note (corrected 2026-07-17): `is_basic`/`is_preferred` are returned **regardless**
of `full=true` on both `/components/list.json` and `/api/search` (re-probed with
`search=C7593` / `q=C7593` and no `full` param — both flags plus `category` were
present). `full=true` appears to be a no-op today; the client still passes it
defensively in case the server behavior reverts.

## `package=` is case-sensitive (server-side)

`/components/list.json?search=NE555&package=SOIC-8&full=true` → 3 rows;
`...&package=soic-8&full=true` → **0 rows** (HTTP 200, empty `components` array —
no error). Same on `/api/search`: `q=NE555&package=SOIC-8&limit=20` → 3 rows,
`package=soic-8` → 0. A wrong-case package silently drops every row — including
the rich list.json rows carrying price breaks and category.

Client behavior (`searchComponents`): when a package-filtered call returns zero
rows, the client retries that call once **without** the `package` param and
relies on its case-insensitive client-side package filter instead. Both request
variants are cached as usual (per-URL cache).

## Category endpoints: `search=C<id>` exact-part lookup

`GET /resistors/list.json?search=C25804` returns the C25804 row **with** its
`attributes` JSON string (`Resistance: "10kΩ"`, `Tolerance: "±1%"`, …) — spec
data the `/components/list.json` row for the same part lacks. Likewise
`/capacitors/list.json?search=C14663` (`Capacitance: "100nF"`). The search is
fuzzy, though: related rows ride along, and an unfiltered response caps at 100
rows — so the exact `lcsc` must be matched client-side. This is what
`JlcClient.getPassiveDetail(lcsc, kind)` does. Recorded fixtures (trimmed to the
first 10 verbatim rows): `tests/fixtures/jlc/resistors-search-c25804.json`,
`tests/fixtures/jlc/capacitors-search-c14663.json`.

Reminder: the `limit` param is **ignored** by every `list.json` endpoint (the
category endpoints and `/components/list.json` alike; only `/api/search` honors
it) — always trim client-side.

## `/api/search` vs `/components/list.json` for free text

`q=NE555`: `/api/search` (limit respected) rows have single `price` number +
`is_basic`/`is_preferred`, no category. `/components/list.json?search=NE555` returned
27 rows with price-break strings + category/subcategory + tier flags. Overlap is high
but not guaranteed identical → merge by `lcsc`, preferring the row with price breaks
and category.

## `/leds/list.json` (fields only, probed `package=0603`)

Key `leds`. Row fields: `lcsc, mfr, description, stock, price1, in_stock, package,
forward_voltage, forward_current, color, wavelength_nm, luminous_intensity_mcd,
viewing_angle_deg, power_dissipation_mw, operating_temp_min, operating_temp_max,
lens_color, mounting_style, is_rgb, is_basic, is_preferred, attributes` (JSON string
incl. `Illumination Color`, `Voltage - Forward(Vf)`). `color` may be null even when
attributes carry the color.

## `/voltage_regulators/list.json` (fields only)

Key `regulators` (NOT `voltage_regulators`). Row fields: `lcsc, mfr, description,
stock, price1, in_stock, package, output_type, output_voltage_min, output_voltage_max,
output_current_max, dropout_voltage, input_voltage_min, input_voltage_max,
operating_temp_min, operating_temp_max, quiescent_current,
power_supply_rejection_db, output_noise_uvrms, is_low_dropout, is_positive,
topology, is_basic, is_preferred, attributes`.

## `/categories/list.json`

Key `categories`, 117 rows of `{category, subcategory}`; `subcategory` may be `""`.

```json
[{"category": "ADC/DAC/Data Conversion", "subcategory": "ADC/DAC - Specialized"},
 {"category": "Amplifiers", "subcategory": ""}]
```
