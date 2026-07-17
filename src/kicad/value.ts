/**
 * Component classification, value parsing ("4k7" → 4700 Ω), and
 * footprint → JLC-style package derivation.
 */

import type { ComponentClass, KicadComponent, ParsedValue } from "../types.js";

// ---------------------------------------------------------------------------
// classifyComponent
// ---------------------------------------------------------------------------

/** Map a reference-designator prefix (plus value/footprint hints) to a class. */
export function classifyComponent(
  c: Pick<KicadComponent, "reference" | "value" | "footprint">,
): ComponentClass {
  const prefix = (c.reference.match(/^[A-Za-z]+/)?.[0] ?? "").toUpperCase();
  const hint = `${c.value ?? ""} ${c.footprint ?? ""}`.toLowerCase();
  switch (prefix) {
    case "R":
    case "RN":
      return "resistor";
    case "C":
      return "capacitor";
    case "L":
      return hint.includes("ferrite") ? "ferrite_bead" : "inductor";
    case "FB":
      return "ferrite_bead";
    case "D":
      return hint.includes("led") ? "led" : "diode";
    case "LED":
      return "led";
    case "Q":
      return "transistor";
    case "U":
    case "IC":
      return "ic";
    case "X":
    case "Y":
    case "XTAL":
      return "crystal";
    case "J":
    case "P":
    case "CN":
    case "CON":
    case "USB":
      return "connector";
    case "S":
    case "SW":
      return "switch";
    case "F":
      return "fuse";
    default:
      return "other";
  }
}

// ---------------------------------------------------------------------------
// parseValue
// ---------------------------------------------------------------------------

export function parseValue(value: string, cls: ComponentClass): ParsedValue {
  const text = value.trim();
  const fallback: ParsedValue = { kind: "raw", text };
  if (!text) return fallback;
  switch (cls) {
    case "resistor":
      return parseResistance(text) ?? fallback;
    case "capacitor":
      return parseCapacitance(text) ?? fallback;
    case "inductor":
    case "ferrite_bead":
      return parseInductance(text) ?? fallback;
    case "crystal":
      return parseFrequency(text) ?? fallback;
    default:
      return fallback;
  }
}

/**
 * A standalone unit/multiplier token (optionally SI-prefixed) that should be
 * glued onto a preceding bare number: "10 kOhm" → "10kOhm", "4.7 uF" → "4.7uF".
 * U+2126 ohm sign, U+03A9/U+03C9 greek omegas, U+00B5 micro, U+03BC greek mu.
 */
const PURE_UNIT_RE =
  /^(?:[pnuµμmkg]?(?:Ω|Ω|ω|ohms?|f|h|hz|w)|[kmgr](?:Ω|Ω)?)$/i;

const BARE_NUMBER_RE = /^\d*\.?\d+$/;

/**
 * Split a value string into candidate tokens.
 * - European comma decimals are rewritten first ("4,7k" → "4.7k") so the
 *   comma is a decimal point, never a token separator, between digits.
 * - A bare number followed by a standalone unit token is re-joined
 *   ("10 kOhm" → "10kOhm") so the unit is not lost.
 * - Wattage annotations are dropped whole so "1/4W" is never misread as
 *   "1 Ω"; other "/"-joined specs ("100nF/50V") are split apart.
 */
function tokenize(text: string): string[] {
  const rewritten = text.replace(/(\d),(\d)/g, "$1.$2");
  const rough: string[] = [];
  for (const chunk of rewritten.split(/[\s,]+/)) {
    if (!chunk) continue;
    if (/^\d+\/\d+w?$/i.test(chunk)) continue; // fractional wattage ("1/4W")
    for (const tok of chunk.split("/")) {
      if (tok) rough.push(tok);
    }
  }
  const joined: string[] = [];
  for (let i = 0; i < rough.length; i++) {
    const tok = rough[i]!;
    const next = rough[i + 1];
    if (next !== undefined && BARE_NUMBER_RE.test(tok) && PURE_UNIT_RE.test(next)) {
      joined.push(tok + next);
      i++;
      continue;
    }
    joined.push(tok);
  }
  return joined.filter((tok) => !/^\d*\.?\d+\s*m?w$/i.test(tok)); // wattage ("0.25W", "250mW")
}

function tolFromToken(tok: string): number | undefined {
  const m = tok.match(/^±?(\d+(?:\.\d+)?)%$/);
  return m ? Number(m[1]) : undefined;
}

// U+03A9 greek omega, U+03C9 lowercase omega, U+2126 ohm sign
function resMultiplier(m: string | undefined): number {
  switch ((m ?? "").toLowerCase()) {
    case "k":
      return 1e3;
    case "m":
      return 1e6; // both "m" and "M" conventionally mean mega on resistor values
    case "g":
      return 1e9;
    default:
      return 1; // "", "r", "Ω"
  }
}

/**
 * Parse one token as a resistance. `explicit` is true when the token carries
 * an explicit unit or multiplier (k/M/G/R/Ω/ohm), false for a bare number.
 */
function resistanceToken(tok: string): { ohms: number; explicit: boolean } | null {
  const t = tok.replace(/Ω/g, "Ω");
  let m = t.match(/^(\d+(?:\.\d+)?)\s*([kmgrΩω])?\s*(Ω|ω|ohms?)?$/i);
  if (m) {
    return {
      ohms: Number(m[1]) * resMultiplier(m[2]),
      explicit: m[2] !== undefined || m[3] !== undefined,
    };
  }
  // letter-as-decimal-point notation: "4k7", "0R1", "R47", "1M2"
  m = t.match(/^(\d*)([kmgrΩω])(\d+)$/i);
  if (m) return { ohms: Number(`${m[1] || "0"}.${m[3]}`) * resMultiplier(m[2]), explicit: true };
  return null;
}

function parseResistance(text: string): ParsedValue | null {
  let explicitOhms: number | null = null;
  let bareOhms: number | null = null;
  let tolerancePct: number | undefined;
  for (const tok of tokenize(text)) {
    const tol = tolFromToken(tok);
    if (tol !== undefined) {
      tolerancePct ??= tol;
      continue;
    }
    const r = resistanceToken(tok);
    if (!r) continue;
    // a token with an explicit unit/multiplier beats a bare number
    if (r.explicit) explicitOhms ??= r.ohms;
    else bareOhms ??= r.ohms;
  }
  const ohms = explicitOhms ?? bareOhms;
  if (ohms === null) return null;
  const out: { kind: "resistance"; ohms: number; tolerancePct?: number } = {
    kind: "resistance",
    ohms,
  };
  if (tolerancePct !== undefined) out.tolerancePct = tolerancePct;
  return out;
}

// U+00B5 micro sign, U+03BC greek mu
const SI_SMALL: Record<string, number> = {
  p: 1e-12,
  n: 1e-9,
  u: 1e-6,
  "µ": 1e-6,
  "μ": 1e-6,
  m: 1e-3,
};

function capacitanceFarads(tok: string): number | null {
  let m = tok.match(/^(\d+(?:\.\d+)?)([pnumµμ])?(f)?$/i);
  if (m) {
    if (!m[2] && !m[3]) return null; // bare number: unit unknown, never guess
    const mult = m[2] ? SI_SMALL[m[2].toLowerCase()] : 1;
    if (mult === undefined) return null;
    return Number(m[1]) * mult;
  }
  m = tok.match(/^(\d*)([pnumµμ])(\d+)f?$/i); // "4u7", "2n2"
  if (m) {
    const mult = SI_SMALL[m[2]!.toLowerCase()];
    if (mult === undefined) return null;
    return Number(`${m[1] || "0"}.${m[3]}`) * mult;
  }
  return null;
}

function parseCapacitance(text: string): ParsedValue | null {
  let farads: number | null = null;
  let voltage: number | undefined;
  let dielectric: string | undefined;
  for (const tok of tokenize(text)) {
    const v = tok.match(/^(\d+(?:\.\d+)?)\s*v(?:dc)?$/i);
    if (v) {
      voltage ??= Number(v[1]);
      continue;
    }
    if (/^(c0g|np0|npo|x5r|x6s|x7r|x7s|x7t|y5v|z5u)$/i.test(tok)) {
      dielectric ??= tok.toUpperCase();
      continue;
    }
    if (tolFromToken(tok) !== undefined) continue;
    if (farads === null) farads = capacitanceFarads(tok);
  }
  if (farads === null) return null;
  const out: { kind: "capacitance"; farads: number; voltage?: number; dielectric?: string } = {
    kind: "capacitance",
    farads,
  };
  if (voltage !== undefined) out.voltage = voltage;
  if (dielectric !== undefined) out.dielectric = dielectric;
  return out;
}

function inductanceHenries(tok: string): number | null {
  let m = tok.match(/^(\d+(?:\.\d+)?)([pnumµμ])?(h)?$/i);
  if (m) {
    if (!m[2] && !m[3]) return null;
    const mult = m[2] ? SI_SMALL[m[2].toLowerCase()] : 1;
    if (mult === undefined) return null;
    return Number(m[1]) * mult;
  }
  m = tok.match(/^(\d*)([pnumµμ])(\d+)h?$/i);
  if (m) {
    const mult = SI_SMALL[m[2]!.toLowerCase()];
    if (mult === undefined) return null;
    return Number(`${m[1] || "0"}.${m[3]}`) * mult;
  }
  return null;
}

function parseInductance(text: string): ParsedValue | null {
  for (const tok of tokenize(text)) {
    const henries = inductanceHenries(tok);
    if (henries !== null) return { kind: "inductance", henries };
  }
  return null;
}

const FREQ_MULT: Record<string, number> = { k: 1e3, m: 1e6, g: 1e9 };

function frequencyHertz(tok: string): number | null {
  const m = tok.match(/^(\d+(?:\.\d+)?)([kmg])?(hz)?$/i);
  if (!m) return null;
  const mult = m[2] ? FREQ_MULT[m[2].toLowerCase()]! : 1;
  return Number(m[1]) * mult;
}

function parseFrequency(text: string): ParsedValue | null {
  for (const tok of tokenize(text)) {
    const hertz = frequencyHertz(tok);
    if (hertz !== null) return { kind: "frequency", hertz };
  }
  return null;
}

// ---------------------------------------------------------------------------
// packageFromFootprint
// ---------------------------------------------------------------------------

const CHIP_SIZES = new Set([
  "01005",
  "0201",
  "0402",
  "0603",
  "0805",
  "1206",
  "1210",
  "1806",
  "1812",
  "2010",
  "2220",
  "2512",
]);

/** Derive a JLC-style package name from a KiCad footprint. Unknown → undefined. */
export function packageFromFootprint(footprint: string | undefined): string | undefined {
  if (!footprint) return undefined;
  const name = footprint.slice(footprint.lastIndexOf(":") + 1).trim();
  if (!name) return undefined;

  // BOM CSV "Package" columns often carry the bare chip size already
  if (CHIP_SIZES.has(name)) return name;

  // "R_0603_1608Metric", "C_0805_2012Metric", "LED_0603_1608Metric..."
  const chip = name.match(/(?:^|_)(\d{4,5})_\d{4,5}Metric/i);
  if (chip && CHIP_SIZES.has(chip[1]!)) return chip[1]!;

  const ic = name.match(
    /(HTSSOP|TSSOP|SSOP|TSOP|MSOP|SOIC|SOP|VQFN|WQFN|UQFN|QFN|DFN|WSON|SON|LQFP|TQFP|QFP|PDIP|DIP|PLCC|BGA|LGA)-(\d+)/i,
  );
  if (ic) return `${ic[1]!.toUpperCase()}-${ic[2]}`;

  const sot = name.match(/SOT-(\d+)(?:-(\d+))?/i);
  if (sot) {
    // SOT-223's pin-count suffix ("SOT-223-3_TabPin2") is noise; JLC lists SOT-223
    if (sot[2] && sot[1] !== "223") return `SOT-${sot[1]}-${sot[2]}`;
    return `SOT-${sot[1]}`;
  }

  const sod = name.match(/(SOD|DO)-(\d+[A-Z]*)/i);
  if (sod) return `${sod[1]!.toUpperCase()}-${sod[2]!.toUpperCase()}`;

  const to = name.match(/TO-(\d+)(?:-(\d+))?/i);
  if (to) return to[2] ? `TO-${to[1]}-${to[2]}` : `TO-${to[1]}`;

  return undefined;
}
