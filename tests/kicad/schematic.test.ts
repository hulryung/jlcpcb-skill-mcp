import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseBomCsv } from "../../src/kicad/bom.js";
import { listSheetFiles, parseSchematic } from "../../src/kicad/schematic.js";

/** Minimal one-symbol schematic with extra (property ...) lines injected. */
function schWithSymbol(extraProps: string): string {
  return `(kicad_sch (version 20231120) (generator "eeschema")
    (symbol (lib_id "Device:R") (at 0 0 0) (unit 1) (in_bom yes) (on_board yes)
      (property "Reference" "R1" (at 0 0 0))
      (property "Value" "10k" (at 0 0 0))
      ${extraProps}
    )
  )`;
}

const exampleText = readFileSync(
  new URL("../../examples/esp32c3-sensor/esp32c3-sensor.kicad_sch", import.meta.url),
  "utf8",
);
const multiunitText = readFileSync(
  new URL("../fixtures/kicad/multiunit.kicad_sch", import.meta.url),
  "utf8",
);

describe("parseSchematic — esp32c3-sensor example", () => {
  const components = parseSchematic(exampleText);
  const byRef = new Map(components.map((c) => [c.reference, c]));

  it("extracts exactly the 15 placed parts", () => {
    expect(components).toHaveLength(15);
    expect([...byRef.keys()].sort()).toEqual(
      ["C1", "C2", "C3", "C4", "D1", "J1", "R1", "R2", "R3", "R4", "R5", "R6", "SW1", "U1", "U2"],
    );
  });

  it("skips power symbols (#PWR refs / power: lib_ids)", () => {
    for (const c of components) {
      expect(c.reference.startsWith("#")).toBe(false);
    }
  });

  it("does not emit lib_symbols definitions (no bare 'R'/'C' references)", () => {
    expect(byRef.has("R")).toBe(false);
    expect(byRef.has("C")).toBe(false);
    expect(byRef.has("U")).toBe(false);
  });

  it("reads Reference/Value/Footprint properties", () => {
    const u1 = byRef.get("U1")!;
    expect(u1.value).toBe("ESP32-C3");
    expect(u1.footprint).toBe("Package_DFN_QFN:QFN-32-1EP_5x5mm_P0.5mm_EP3.45x3.45mm");
    const r1 = byRef.get("R1")!;
    expect(r1.value).toBe("10k");
    expect(r1.footprint).toBe("Resistor_SMD:R_0603_1608Metric");
  });

  it("extracts the LCSC field from 'LCSC' and 'LCSC Part #' properties", () => {
    expect(byRef.get("J1")!.lcsc).toBe("C165948");
    expect(byRef.get("U2")!.lcsc).toBe("C6186");
    expect(byRef.get("R1")!.lcsc).toBeUndefined();
  });

  it("flags the (dnp yes) resistor and only it", () => {
    expect(byRef.get("R6")!.dnp).toBe(true);
    const dnpRefs = components.filter((c) => c.dnp).map((c) => c.reference);
    expect(dnpRefs).toEqual(["R6"]);
  });

  it("keeps all symbol properties verbatim", () => {
    const u2 = byRef.get("U2")!;
    expect(u2.properties["Reference"]).toBe("U2");
    expect(u2.properties["LCSC Part #"]).toBe("C6186");
    expect(u2.properties["Datasheet"]).toContain("ds1117");
  });
});

describe("parseSchematic — multi-unit and edge cases", () => {
  const components = parseSchematic(multiunitText);
  const byRef = new Map(components.map((c) => [c.reference, c]));

  it("emits one component per unique reference for multi-unit parts", () => {
    const u1s = components.filter((c) => c.reference === "U1");
    expect(u1s).toHaveLength(1);
    expect(u1s[0]!.value).toBe("LM358");
    expect(u1s[0]!.footprint).toBe("Package_SO:SOIC-8_3.9x4.9mm_P1.27mm");
  });

  it("excludes (in_bom no) symbols entirely", () => {
    expect(byRef.has("C1")).toBe(false);
  });

  it("honors the (dnp yes) node", () => {
    expect(byRef.get("R1")!.dnp).toBe(true);
  });

  it("honors a DNP property", () => {
    expect(byRef.get("R2")!.dnp).toBe(true);
  });

  it("non-DNP parts stay dnp: false", () => {
    expect(byRef.get("R3")!.dnp).toBe(false);
    expect(byRef.get("C2")!.dnp).toBe(false);
  });

  it("skips #PWR and #FLG power symbols", () => {
    expect([...byRef.keys()].sort()).toEqual(["C2", "R1", "R2", "R3", "U1"]);
  });

  it("normalizes LCSC numbers from JLC-style fields (bare digits get a C prefix)", () => {
    expect(byRef.get("C2")!.lcsc).toBe("C1525"); // "JLC" field, value "1525"
    expect(byRef.get("R3")!.lcsc).toBe("C25804"); // "LCSC Part #" field
  });
});

describe("parseSchematic — DNP property values", () => {
  const dnpOf = (props: string): boolean => parseSchematic(schWithSymbol(props))[0]!.dnp;

  it('empty (property "DNP" "") is NOT dnp', () => {
    expect(dnpOf('(property "DNP" "" (at 0 0 0))')).toBe(false);
  });

  it("whitespace-only DNP value is NOT dnp", () => {
    expect(dnpOf('(property "DNP" "  " (at 0 0 0))')).toBe(false);
  });

  it('explicit negatives "no"/"false"/"0" are NOT dnp', () => {
    expect(dnpOf('(property "DNP" "no" (at 0 0 0))')).toBe(false);
    expect(dnpOf('(property "DNP" "false" (at 0 0 0))')).toBe(false);
    expect(dnpOf('(property "DNP" "0" (at 0 0 0))')).toBe(false);
  });

  it('non-empty values ("DNP", "yes") are dnp', () => {
    expect(dnpOf('(property "DNP" "DNP" (at 0 0 0))')).toBe(true);
    expect(dnpOf('(property "DNP" "yes" (at 0 0 0))')).toBe(true);
  });

  it("schematic and BOM-CSV paths agree on DNP semantics", () => {
    const values = ["", "  ", "no", "false", "0", "DNP", "yes", "x"];
    for (const v of values) {
      const fromSch = parseSchematic(
        schWithSymbol(`(property "DNP" "${v}" (at 0 0 0))`),
      )[0]!.dnp;
      const fromCsv = parseBomCsv(`Reference,Value,DNP\nR1,10k,"${v}"\n`)[0]!.dnp;
      expect(fromSch, `value ${JSON.stringify(v)}`).toBe(fromCsv);
    }
  });
});

describe("parseSchematic — LCSC property name matching", () => {
  const lcscOf = (props: string): string | undefined =>
    parseSchematic(schWithSymbol(props))[0]!.lcsc;

  it('recognizes JLCPCB template spelling "LCSC Part #（optional）" (full-width parens)', () => {
    expect(lcscOf('(property "LCSC Part #（optional）" "C25804" (at 0 0 0))')).toBe("C25804");
  });

  it('recognizes any "LCSC…"-prefixed property', () => {
    expect(lcscOf('(property "LCSC Part Number" "25804" (at 0 0 0))')).toBe("C25804");
  });

  it('"JLC Rotation" with value "90" must NOT become an LCSC number', () => {
    expect(lcscOf('(property "JLC Rotation" "90" (at 0 0 0))')).toBeUndefined();
  });

  it("value guard: an LCSC-named property with a non-part value is ignored", () => {
    expect(lcscOf('(property "LCSC" "see BOM" (at 0 0 0))')).toBeUndefined();
  });
});

describe("listSheetFiles", () => {
  it("returns Sheetfile values of top-level sheets in document order", () => {
    const text = `(kicad_sch (version 20231120)
      (sheet (at 100 50) (size 20 10)
        (property "Sheetname" "power" (at 0 0 0))
        (property "Sheetfile" "power.kicad_sch" (at 0 0 0))
      )
      (sheet (at 140 50) (size 20 10)
        (property "Sheetname" "mcu" (at 0 0 0))
        (property "Sheetfile" "mcu.kicad_sch" (at 0 0 0))
      )
    )`;
    expect(listSheetFiles(text)).toEqual(["power.kicad_sch", "mcu.kicad_sch"]);
  });

  it('accepts the KiCad 6 spelling "Sheet file"', () => {
    const text = `(kicad_sch
      (sheet (at 0 0) (property "Sheet file" "sub.kicad_sch" (at 0 0 0)))
    )`;
    expect(listSheetFiles(text)).toEqual(["sub.kicad_sch"]);
  });

  it("dedupes repeated sheet files (one sheet instantiated twice)", () => {
    const text = `(kicad_sch
      (sheet (at 0 0) (property "Sheetfile" "sub.kicad_sch" (at 0 0 0)))
      (sheet (at 50 0) (property "Sheetfile" "sub.kicad_sch" (at 0 0 0)))
    )`;
    expect(listSheetFiles(text)).toEqual(["sub.kicad_sch"]);
  });

  it("returns [] when there are no sheets", () => {
    expect(listSheetFiles(multiunitText)).toEqual([]);
  });

  it("ignores sheets without a Sheetfile property", () => {
    const text = `(kicad_sch
      (sheet (at 0 0) (property "Sheetname" "orphan" (at 0 0 0)))
      (sheet (at 50 0) (property "Sheetfile" "real.kicad_sch" (at 0 0 0)))
    )`;
    expect(listSheetFiles(text)).toEqual(["real.kicad_sch"]);
  });

  it("throws on a non-schematic document", () => {
    expect(() => listSheetFiles("(foo)")).toThrow(/kicad_sch/);
  });
});

describe("parseSchematic — errors", () => {
  it("throws a clear error on a non-schematic document", () => {
    expect(() => parseSchematic("(foo (bar 1))")).toThrow(/kicad_sch/);
  });

  it("throws on malformed s-expressions", () => {
    expect(() => parseSchematic("(kicad_sch (symbol")).toThrow(/parse error/i);
  });
});
