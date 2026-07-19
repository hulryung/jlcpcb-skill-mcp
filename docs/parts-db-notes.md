# JLCPCB parts FTS5 database — verified notes

Everything below was verified against a **real download** performed with
`npm run db:update` (scripts/update-db.ts) on 2026-07-19, using Node v26.5.0
`node:sqlite` in readonly mode. Nothing here is assumed from upstream docs.

## Source & download

- Published at `https://bouni.github.io/kicad-jlcpcb-tools` (the kicad-jlcpcb-tools plugin DB).
- Split zip: chunk count in `chunk_num_fts5.txt` (**11** at download time), chunks
  `parts-fts5.db.zip.001` … `.011`. Chunks 1-10 are exactly 80,000,000 bytes
  (76.3 MB), chunk 11 was 66.9 MB; total download **870,132,302 bytes (~830 MB)**.
- Concatenating all chunks yields one plain zip containing a single file
  `parts-fts5.db`; `unzip -o` extracts it.
- Extracted DB size: **5,284,036,608 bytes (~4.9 GiB)** — plan disk space accordingly.
- Installed to `${XDG_CACHE_HOME:-~/.cache}/jlcpcb-parts/parts-fts5.db` with
  `meta.json` `{downloadedAt, chunks, bytes, source}` beside it.
  `npm run db:update` skips when the DB is < 7 days old; `-- --force` re-downloads;
  `-- --dir <path>` overrides the target directory.

## Exact table list (sqlite_master)

| name | type | rows | notes |
|---|---|---|---|
| `parts` | virtual (FTS5) | **7,116,519** | the data |
| `categories` | table | 1,780 | (`'First Category'`,`'Second Category'`) pairs; includes one blank `("","")` row |
| `mapping` | table | **0** | (`'footprint'`,`'value'`,`'LCSC'`) — empty in this snapshot |
| `meta` | table | 1 | see below |
| `parts_config`/`parts_content`/`parts_data`/`parts_docsize`/`parts_idx` | tables | — | FTS5 shadow tables (`parts_config` has `version=4`) |

`meta` contents (verbatim):

```json
{"filename":"cache.sqlite3","size":5284036608,"partcount":7116519,
 "date":"2026-07-18","last_update":"2026-07-18T07:49:15.806859"}
```

`partcount` matched the actual `COUNT(*)` exactly.

## parts DDL (verbatim)

```sql
CREATE VIRTUAL TABLE parts using fts5 (
      'LCSC Part',
      'First Category',
      'Second Category',
      'MFR.Part',
      'Package',
      'Solder Joint' unindexed,
      'Manufacturer',
      'Library Type',
      'Description',
      'Datasheet' unindexed,
      'Price' unindexed,
      'Stock' unindexed
  , tokenize="trigram")
```

Column order (PRAGMA table_info): `LCSC Part`, `First Category`,
`Second Category`, `MFR.Part`, `Package`, `Solder Joint`, `Manufacturer`,
`Library Type`, `Description`, `Datasheet`, `Price`, `Stock`.
All column names except `MFR.Part` contain spaces — always double-quote them in SQL.

Two things matter enormously here:

1. **`tokenize="trigram"`** — MATCH does *substring* matching (see caveats below).
2. **`Solder Joint`, `Datasheet`, `Price`, `Stock` are `unindexed`** — a MATCH
   column filter on them (e.g. `MATCH 'Stock:335073'`) returns **0 rows silently,
   no error**. Filter those with plain SQL after the MATCH.

## Library Type — the tier reality (CRITICAL)

```sql
SELECT "Library Type", COUNT(*) FROM parts GROUP BY 1;
-- Extended  7,116,168
-- Basic           351      (350 of them have Stock > 0)
```

- Only two values exist: **`Basic`** and **`Extended`**. There is **no
  "Preferred" value anywhere** (`LIKE '%referred%'` → 0 rows). This DB
  **cannot distinguish JLCPCB Preferred-Extended parts** — for the
  basic/preferred/extended tier mapping you still need jlcsearch's
  `is_basic`/`is_preferred` flags (see CONTRACTS.md).
- Only 351 Basic rows in this snapshot — far fewer than JLCPCB's advertised
  "~700 basic types". Treat `Library Type = 'Basic'` as a strong positive
  signal, but its absence proves nothing about preferred status.

## Other column facts

- **`Stock` is TEXT** (`typeof(Stock)` = `text` for all 7,116,519 rows), holding
  a bare integer string like `"335073"`. **6,423,717 rows (90%) are `"0"`**;
  only **692,802 parts have stock > 0**. Use `CAST(Stock AS INTEGER)` for
  compare/sort — it works fine.
- **`Price` is TEXT**, tiered format `qFrom-qTo:price` joined with commas; the
  last tier has an empty `qTo` meaning "and up"; a single open tier is `1-:price`:
  - `"1-:0.003"` (C25804), `"1-1999:0.019,2000-:0.018"` (C14663),
    `"1-49:0.132,50-149:0.105,150-499:0.092,500-2499:0.081,2500-4999:0.077,5000-:0.074"` (C7593).
  - **`Price` is the empty string for 6,356,807 rows (89%)** — mostly the
    out-of-stock ones. Parse defensively.
  - No currency column; values are consistent with LCSC USD unit prices.
- **`Solder Joint` is INTEGER** for all rows. Distribution top: 5 → 4,904,419;
  2 → 909,025; 0 → 746,056; 4 → 85,209; 6 → 70,830; 8 → 65,806. The values look
  unreliable as a pad count (C25804, a 2-pad 0603 resistor, has `0`; a 2-terminal
  tantalum cap has `5`) — treat as untrusted.
- **`Datasheet`** holds LCSC PDF URLs
  (`https://www.lcsc.com/datasheet/lcsc_datasheet_<id>_<mfr>-<mpn>_<lcsc>.pdf`).
- **`Description`** embeds specs as space-separated tokens with Unicode units
  (`℃`, `Ω`, `±`), no key=value structure. Typical resistor:
  `-55℃~+155℃ 100mW 10kΩ 75V Thick Film Resistor ±1% ±100ppm/℃`.
  Some parts just say `not ROHS` as the entire description.
- **`MFR.Part` is not always a real MPN**: `C9900…`-series rows (customer/
  hand-created parts) carry description-like strings, e.g.
  `"100nF ±10% 100V X7R"` or `"0603_X7R_100nF_50V_K_FengHua_EHRA"`.

## Verbatim sample rows

### C25804 (10k 0603 resistor)

```json
{"LCSC Part":"C25804","First Category":"Resistors",
 "Second Category":"Chip Resistor - Surface Mount","MFR.Part":"0603WAF1002T5E",
 "Package":"0603","Solder Joint":0,"Manufacturer":"UNI-ROYAL(Uniroyal Elec)",
 "Library Type":"Basic",
 "Description":"-55℃~+155℃ 100mW 10kΩ 75V Thick Film Resistor ±1% ±100ppm/℃",
 "Datasheet":"https://www.lcsc.com/datasheet/lcsc_datasheet_2206010045_UNI-ROYAL-Uniroyal-Elec-0603WAF1002T5E_C25804.pdf",
 "Price":"1-:0.003","Stock":"335073"}
```

### C14663 (100nF cap)

```json
{"LCSC Part":"C14663","First Category":"Capacitors",
 "Second Category":"Multilayer Ceramic Capacitors MLCC - SMD/SMT",
 "MFR.Part":"CC0603KRX7R9BB104","Package":"0603","Solder Joint":0,
 "Manufacturer":"YAGEO","Library Type":"Basic",
 "Description":"100nF 50V X7R ±10%",
 "Datasheet":"https://www.lcsc.com/datasheet/lcsc_datasheet_2211101700_YAGEO-CC0603KRX7R9BB104_C14663.pdf",
 "Price":"1-1999:0.019,2000-:0.018","Stock":"67887231"}
```

### C7593 (NE555)

```json
{"LCSC Part":"C7593","First Category":"Clock/Timing",
 "Second Category":"555 Timers / Counters","MFR.Part":"NE555DR",
 "Package":"SOIC-8","Solder Joint":0,"Manufacturer":"Texas Instruments",
 "Library Type":"Extended","Description":"0℃~+70℃ 10mA 4.5V~16V",
 "Datasheet":"https://www.lcsc.com/datasheet/lcsc_datasheet_1811012330_Texas-Instruments-NE555DR_C7593.pdf",
 "Price":"1-49:0.132,50-149:0.105,150-499:0.092,500-2499:0.081,2500-4999:0.077,5000-:0.074",
 "Stock":"185367"}
```

Note: this DB says NE555DR is **Extended**, with no way to see that JLCPCB
lists it as a preferred/economic part.

### C2286 (red LED 0603)

```json
{"LCSC Part":"C2286","First Category":"Optoelectronics",
 "Second Category":"LED Indication - Discrete","MFR.Part":"KT-0603R",
 "Package":"0603","Solder Joint":0,"Manufacturer":"Hubei KENTO Elec",
 "Library Type":"Basic",
 "Description":"-40℃~+85℃ 1.6mm x 0.8mm square LED 1.8V~2.4V 120° 20mA 300mcd 40mW 615nm~630nm 645nm Discrete Diode Red Water Clear",
 "Datasheet":"https://www.lcsc.com/datasheet/lcsc_datasheet_1810231112_Hubei-KENTO-Elec-KT-0603R_C2286.pdf",
 "Price":"1-:0.007","Stock":"6450125"}
```

### C165948 (USB-C receptacle)

```json
{"LCSC Part":"C165948","First Category":"Connectors",
 "Second Category":"USB Connectors","MFR.Part":"TYPE-C-31-M-12",
 "Package":"SMD","Solder Joint":0,"Manufacturer":"Korean Hroparts Elec",
 "Library Type":"Extended",
 "Description":"-30℃~+80℃ 1 10,000 cycles 16P 20V 5A 7.35mm Female Surface Mount, Right Angle Type-C",
 "Datasheet":"https://www.lcsc.com/datasheet/lcsc_datasheet_2205251630_Korean-Hroparts-Elec-TYPE-C-31-M-12_C165948.pdf",
 "Price":"1-49:0.184,50-149:0.145,150-999:0.126,1000-1999:0.102,2000-4999:0.098,5000-:0.095",
 "Stock":"323846"}
```

Note `Package` for connectors can be just `"SMD"` — don't rely on Package for
connector matching.

## FTS5 query syntax that works (all actually run, timings on an M-series Mac, warm cache)

```sql
-- free text (22ms):
... WHERE parts MATCH '10k 0603 resistor' LIMIT 5

-- package column filter + text (0ms):
... WHERE parts MATCH 'Package:0603 AND "10k"' LIMIT 5

-- brace form also works, incl. multi-column (2ms):
... WHERE parts MATCH '{Package}: 0603' LIMIT 5
... WHERE parts MATCH '{Package Description}: 0805' LIMIT 3

-- spaced column names MUST be double-quoted inside the MATCH string (3-9ms):
... WHERE parts MATCH '"First Category": Resistors' LIMIT 5
... WHERE parts MATCH '"Second Category": "Chip Resistor"' LIMIT 5
--   unquoted  'First Category: Resistors'  → error: no such column: Category

-- text + package combo (7ms):
... WHERE parts MATCH 'NE555 AND Package:SOP' LIMIT 5
--   → NE555PWR/TSSOP-8, NE555M/SOP-8, …

-- MPN column filter (28ms):
... WHERE parts MATCH '"MFR.Part": 0603WAF1002T5E'

-- exact-part lookup — go THROUGH the FTS index, then pin with SQL equality (16ms):
SELECT * FROM parts WHERE parts MATCH '"LCSC Part": C25804' AND "LCSC Part" = 'C25804';
--   plain  WHERE "LCSC Part" = 'C25804'  without MATCH = full scan, 1171ms
--   MATCH 'C25804' alone also returns C2580400, C2580401… (substring!)

-- boolean operators AND / OR / NOT and NEAR all work (2-12ms):
... WHERE parts MATCH 'resistor NOT 0402' LIMIT 3

-- relevance sort (85ms):
... WHERE parts MATCH '"100nF" AND X7R AND Package:0603' ORDER BY rank LIMIT 5

-- stock sort after MATCH — CAST needed because Stock is TEXT (387-456ms on ~180k-row match):
SELECT "LCSC Part", Stock FROM parts
WHERE parts MATCH 'Package:0603 AND "10kΩ" AND "First Category":Resistors'
  AND CAST(Stock AS INTEGER) > 0
ORDER BY CAST(Stock AS INTEGER) DESC LIMIT 5;

-- counting a big MATCH is fine (533ms for 178,660 rows):
SELECT COUNT(*) FROM parts WHERE parts MATCH '"First Category": Resistors AND Package:0603';
```

### Trigram tokenizer caveats (verified)

- **Substring semantics**: `NE555` matches `NE555DR`; `10k` matches `510kΩ`;
  `Package:0603` matches package `0603x4`; `C25804` matches `C2580400`.
  For exact package/part matching, add a plain SQL equality after the MATCH
  (cheap once the FTS index has narrowed the rows): `AND Package = '0603'`.
- **Queries shorter than 3 characters return 0 rows silently** — `'R1'`, `'1k'`
  find nothing, no error. Pad the query (`'10kΩ'`) or fall back to `LIKE`.
- **Case-insensitive**: `'ne555'` and `'NE555'` return identical results.
- Prefix `'ESP32*'` works but is redundant — trigram already matches substrings.
- **Hyphens must be quoted**: `Package:SOT-23` → error `no such column: 23`;
  use `Package:"SOT-23"`.
- Column filters on the unindexed columns (`Stock`, `Price`, `Datasheet`,
  `Solder Joint`) return **0 rows with no error** — easy silent-failure trap.

### Performance summary

- Any query going through `MATCH`: **0-90ms** typical, ~0.5s when the match set
  is ~180k rows and needs sorting/counting.
- Any query NOT using MATCH is a full table scan over 7.1M rows / 4.9 GiB:
  equality lookup 1.2s, `COUNT(*)` 6.6s, `GROUP BY "Library Type"` 2.9s,
  `WHERE Price = ''` 4.4s. Never filter without MATCH in interactive paths.

## Surprises / gotchas recap

- No `Preferred` library type — Basic (351) / Extended only; tier data here is
  strictly worse than jlcsearch's `is_basic`/`is_preferred`.
- 90% of rows have Stock `"0"` and 89% have an empty Price — the DB is a
  catalog dump, not an in-stock list. Filter `CAST(Stock AS INTEGER) > 0` early.
- `Stock` and `Price` are TEXT; `Solder Joint` is INTEGER but unreliable.
- `Datasheet` column exists (unindexed) with LCSC PDF URLs.
- `mapping` table exists but is empty; `categories` has 1,780 rows including a
  blank pair.
- `MFR.Part` for `C9900…` parts is a free-text description, not an MPN.
- Everything (columns and shadow tables) hangs off one FTS5 virtual table —
  there is no plain indexed column anywhere, so MATCH is the only fast path.
