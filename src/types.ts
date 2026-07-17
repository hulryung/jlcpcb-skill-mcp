/**
 * Shared domain types for jlcpcb-skill-mcp.
 * All modules (jlc client, kicad parser, suggestion engine, MCP tools)
 * communicate through these types — see CONTRACTS.md.
 */

// ---------------------------------------------------------------------------
// Parts (JLCPCB / LCSC)
// ---------------------------------------------------------------------------

/** Quantity price break in USD. qTo === null means "and up". */
export interface PriceBreak {
  qFrom: number;
  qTo: number | null;
  price: number;
}

/**
 * JLCPCB assembly part tier.
 * - basic:     pre-loaded on pick&place lines, no loading fee
 * - preferred: "Preferred Extended" — loading fee waived (Economic PCBA)
 * - extended:  $3 loading fee per unique part per order
 */
export type PartTier = "basic" | "preferred" | "extended";

export interface Part {
  /** Canonical LCSC part number, e.g. "C25804". */
  lcsc: string;
  /** Numeric portion of the LCSC number, e.g. 25804. */
  lcscId: number;
  /** Manufacturer part number, e.g. "0603WAF1002T5E". */
  mfr: string;
  description: string;
  package: string;
  category?: string;
  subcategory?: string;
  stock: number;
  tier: PartTier;
  /** Sorted ascending by qFrom. May be empty if source only gave one price. */
  priceBreaks: PriceBreak[];
  /** Unit price at qty 1 (first price break), USD. Null if unknown. */
  unitPrice: number | null;
  /** Parsed key/value attributes (e.g. Resistance: "10kΩ", Tolerance: "±1%"). */
  attributes?: Record<string, string>;
  /** e.g. https://jlcpcb.com/partdetail/C25804 */
  productUrl: string;
}

// ---------------------------------------------------------------------------
// KiCad
// ---------------------------------------------------------------------------

export type ComponentClass =
  | "resistor"
  | "capacitor"
  | "inductor"
  | "ferrite_bead"
  | "diode"
  | "led"
  | "transistor"
  | "ic"
  | "crystal"
  | "connector"
  | "switch"
  | "fuse"
  | "other";

/** One placed symbol from a .kicad_sch (or one row of a BOM export). */
export interface KicadComponent {
  reference: string; // "R1"
  value: string; // "10k"
  footprint?: string; // "Resistor_SMD:R_0603_1608Metric"
  /** LCSC part number if the symbol carries an LCSC/JLCPCB field. */
  lcsc?: string;
  /** Do Not Populate flag. */
  dnp: boolean;
  /** All symbol properties/fields, verbatim. */
  properties: Record<string, string>;
}

/** Normalized machine-readable component value. */
export type ParsedValue =
  | { kind: "resistance"; ohms: number; tolerancePct?: number }
  | { kind: "capacitance"; farads: number; voltage?: number; dielectric?: string }
  | { kind: "inductance"; henries: number }
  | { kind: "frequency"; hertz: number }
  | { kind: "raw"; text: string };

/** One BOM line: identical (value, footprint, class) components grouped. */
export interface BomLine {
  references: string[];
  qtyPerBoard: number;
  value: string;
  footprint?: string;
  /** JLC-style package derived from footprint, e.g. "0603", "SOT-23-5", "SOIC-8". */
  package?: string;
  componentClass: ComponentClass;
  parsed?: ParsedValue;
  /** Pre-assigned LCSC number from the schematic, if any. */
  lcsc?: string;
  dnp: boolean;
}

// ---------------------------------------------------------------------------
// Suggestion engine
// ---------------------------------------------------------------------------

export interface SuggestOptions {
  /** Number of boards to be assembled. Default 10. */
  boardQty: number;
  /** Required stock ≥ neededQty × stockMultiple to avoid warnings. Default 5. */
  stockMultiple: number;
  /** Max ranked candidates kept per BOM line. Default 5. */
  maxCandidates: number;
}

export interface Candidate {
  part: Part;
  /** Higher is better. */
  score: number;
  /** Human-readable reasons this part ranked where it did. */
  reasons: string[];
  /** Risk warnings (low stock, extended fee, spec mismatch…). */
  warnings: string[];
  /** Unit price at the needed quantity (boardQty × qtyPerBoard), USD. */
  unitPriceAtQty: number | null;
  /** unitPriceAtQty × needed quantity, USD. */
  lineCost: number | null;
}

export type LineStatus = "matched" | "needs_review" | "no_match" | "preassigned" | "skipped_dnp";

export interface LineSuggestion {
  line: BomLine;
  candidates: Candidate[];
  /** Top pick (candidates[0]) unless no_match. */
  chosen?: Candidate;
  status: LineStatus;
  /** Why needs_review / no_match, notes about the search performed. */
  notes: string[];
}

export interface CostBreakdown {
  boardQty: number;
  /** Σ chosen lineCost. */
  componentCostTotal: number;
  /** $3 × number of unique extended (non-basic, non-preferred) parts. */
  loadingFees: number;
  uniqueParts: number;
  basicCount: number;
  preferredCount: number;
  extendedCount: number;
  /** componentCostTotal + loadingFees. */
  total: number;
  perBoard: number;
}

export interface BomSuggestion {
  lines: LineSuggestion[];
  cost: CostBreakdown;
  /** BOM-level advice: consolidation opportunities, risky lines, etc. */
  notes: string[];
}

// ---------------------------------------------------------------------------
// jlc client
// ---------------------------------------------------------------------------

export interface SearchOptions {
  /** Free-text query (part number, description keywords). */
  q?: string;
  package?: string;
  /** Only parts with stock ≥ minStock. */
  minStock?: number;
  /** Restrict to a tier ("basic" also admits preferred when preferBasic searches fall back). */
  tier?: PartTier;
  limit?: number;
}

export interface ResistorSearchOptions {
  ohms?: number;
  package?: string;
  /** Max tolerance fraction, e.g. 0.01 for 1%. */
  maxTolerance?: number;
  limit?: number;
}

export interface CapacitorSearchOptions {
  farads?: number;
  package?: string;
  /** Min voltage rating in volts, filtered client-side from attributes when available. */
  minVoltage?: number;
  limit?: number;
}
