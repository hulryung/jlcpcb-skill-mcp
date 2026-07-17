import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { groupBom, parseBomCsv } from "../../src/kicad/bom.js";
import type { KicadComponent } from "../../src/types.js";

const groupedCsv = readFileSync(new URL("../fixtures/kicad/bom-grouped.csv", import.meta.url), "utf8");
const designatorCsv = readFileSync(
  new URL("../fixtures/kicad/bom-designator.csv", import.meta.url),
  "utf8",
);

function comp(over: Partial<KicadComponent> & Pick<KicadComponent, "reference" | "value">): KicadComponent {
  return { dnp: false, properties: {}, ...over };
}

describe("parseBomCsv — quoted, comma-grouped references", () => {
  const components = parseBomCsv(groupedCsv);
  const byRef = new Map(components.map((c) => [c.reference, c]));

  it("emits one component per individual reference", () => {
    expect(components.map((c) => c.reference).sort()).toEqual(
      ["C1", "C2", "D1", "R1", "R2", "R3", "R4", "U1"],
    );
  });

  it("splits grouped refs 'R1,R2,R3' from a single quoted cell", () => {
    for (const ref of ["R1", "R2", "R3"]) {
      const c = byRef.get(ref)!;
      expect(c.value).toBe("10k");
      expect(c.footprint).toBe("Resistor_SMD:R_0603_1608Metric");
      expect(c.lcsc).toBe("C25804");
    }
  });

  it("handles 'R1, R2' with spaces after commas", () => {
    expect(byRef.get("C1")!.value).toBe("100nF");
    expect(byRef.get("C2")!.value).toBe("100nF");
  });

  it("preserves commas inside quoted value fields", () => {
    expect(byRef.get("D1")!.value).toBe("LED, red");
  });

  it("normalizes bare-digit LCSC cells to C-prefixed form", () => {
    expect(byRef.get("R4")!.lcsc).toBe("C25804");
  });

  it("empty LCSC cells stay undefined", () => {
    expect(byRef.get("C1")!.lcsc).toBeUndefined();
  });

  it("keeps all row cells as properties", () => {
    expect(byRef.get("U1")!.properties["Value"]).toBe("NE555DR");
    expect(byRef.get("U1")!.properties["LCSC Part #"]).toBe("C7593");
  });
});

describe("parseBomCsv — semicolon-delimited Designator/Package/Quantity headers", () => {
  const components = parseBomCsv(designatorCsv);
  const byRef = new Map(components.map((c) => [c.reference, c]));

  it("parses all rows", () => {
    expect(components).toHaveLength(5);
  });

  it("maps Designator → reference and Package → footprint", () => {
    expect(byRef.get("R1")!.value).toBe("4k7");
    expect(byRef.get("R1")!.footprint).toBe("0603");
  });

  it("maps 'JLCPCB Part' → lcsc", () => {
    expect(byRef.get("SW1")!.lcsc).toBe("C318884");
  });

  it("maps the DNP column", () => {
    expect(byRef.get("R3")!.dnp).toBe(true);
    expect(byRef.get("R1")!.dnp).toBe(false);
  });
});

describe("parseBomCsv — LCSC header matching", () => {
  it('recognizes the JLCPCB template header "LCSC Part #（optional）" (full-width parens)', () => {
    const csv = 'Comment,Designator,Footprint,LCSC Part #（optional）\n10k,R1,0603,C25804\n';
    const [r1] = parseBomCsv(csv);
    expect(r1!.reference).toBe("R1");
    expect(r1!.lcsc).toBe("C25804");
  });

  it('recognizes "LCSC…"-prefixed and "JLCPCB…"-prefixed headers', () => {
    expect(parseBomCsv("Designator,LCSC Part Number\nR1,25804\n")[0]!.lcsc).toBe("C25804");
    expect(parseBomCsv("Designator,JLCPCB Part #\nR1,C7593\n")[0]!.lcsc).toBe("C7593");
  });

  it('"JLC Rotation" column with value "90" must NOT become lcsc', () => {
    const csv = "Designator,Value,JLC Rotation\nR1,10k,90\n";
    const [r1] = parseBomCsv(csv);
    expect(r1!.lcsc).toBeUndefined();
    expect(r1!.properties["JLC Rotation"]).toBe("90"); // still kept as a plain property
  });

  it("value guard: an LCSC column with a non-part value stays undefined", () => {
    expect(parseBomCsv("Designator,LCSC\nR1,see notes\n")[0]!.lcsc).toBeUndefined();
  });
});

describe("parseBomCsv — errors", () => {
  it("throws when no reference column exists", () => {
    expect(() => parseBomCsv("Value,Footprint\n10k,R_0603\n")).toThrow(/reference column/i);
  });

  it("throws on empty input", () => {
    expect(() => parseBomCsv("")).toThrow(/empty/i);
  });
});

describe("groupBom", () => {
  it("groups identical (class, value, package) components into one line", () => {
    const lines = groupBom(parseBomCsv(designatorCsv));
    const r47 = lines.find((l) => l.value === "4k7" && !l.dnp)!;
    expect(r47.references).toEqual(["R1", "R2", "R10"]); // natural sort: R2 before R10
    expect(r47.qtyPerBoard).toBe(3);
    expect(r47.package).toBe("0603");
    expect(r47.componentClass).toBe("resistor");
    expect(r47.parsed).toMatchObject({ kind: "resistance" });
  });

  it("keeps DNP components on separate lines with dnp: true", () => {
    const lines = groupBom([
      comp({ reference: "R1", value: "10k", footprint: "Resistor_SMD:R_0603_1608Metric" }),
      comp({ reference: "R2", value: "10k", footprint: "Resistor_SMD:R_0603_1608Metric" }),
      comp({ reference: "R3", value: "10k", footprint: "Resistor_SMD:R_0603_1608Metric", dnp: true }),
    ]);
    expect(lines).toHaveLength(2);
    const populated = lines.find((l) => !l.dnp)!;
    const dnp = lines.find((l) => l.dnp)!;
    expect(populated.references).toEqual(["R1", "R2"]);
    expect(dnp.references).toEqual(["R3"]);
    expect(dnp.qtyPerBoard).toBe(1);
  });

  it("merges equivalent value spellings ('100n' vs '0.1uF' vs '100nF')", () => {
    const lines = groupBom([
      comp({ reference: "C1", value: "100n", footprint: "Capacitor_SMD:C_0603_1608Metric" }),
      comp({ reference: "C2", value: "0.1uF", footprint: "Capacitor_SMD:C_0603_1608Metric" }),
      comp({ reference: "C3", value: "100nF", footprint: "Capacitor_SMD:C_0603_1608Metric" }),
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.references).toEqual(["C1", "C2", "C3"]);
  });

  it("does not merge same value in different packages", () => {
    const lines = groupBom([
      comp({ reference: "R1", value: "10k", footprint: "Resistor_SMD:R_0603_1608Metric" }),
      comp({ reference: "R2", value: "10k", footprint: "Resistor_SMD:R_0402_1005Metric" }),
    ]);
    expect(lines).toHaveLength(2);
  });

  it("does not merge different tolerances", () => {
    const lines = groupBom([
      comp({ reference: "R1", value: "10k 1%", footprint: "Resistor_SMD:R_0603_1608Metric" }),
      comp({ reference: "R2", value: "10k", footprint: "Resistor_SMD:R_0603_1608Metric" }),
    ]);
    expect(lines).toHaveLength(2);
  });

  it("splits lines when only one component carries a pre-assigned LCSC number", () => {
    const lines = groupBom([
      comp({ reference: "R1", value: "10k", footprint: "Resistor_SMD:R_0603_1608Metric", lcsc: "C25804" }),
      comp({ reference: "R2", value: "10k", footprint: "Resistor_SMD:R_0603_1608Metric" }),
    ]);
    expect(lines).toHaveLength(2);
    expect(lines.find((l) => l.lcsc === "C25804")!.references).toEqual(["R1"]);
  });

  it("groups raw-value parts by trimmed text (ICs by value string)", () => {
    const lines = groupBom([
      comp({ reference: "U1", value: "NE555DR", footprint: "Package_SO:SOIC-8_3.9x4.9mm_P1.27mm" }),
      comp({ reference: "U2", value: "NE555DR", footprint: "Package_SO:SOIC-8_3.9x4.9mm_P1.27mm" }),
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.qtyPerBoard).toBe(2);
    expect(lines[0]!.package).toBe("SOIC-8");
    expect(lines[0]!.componentClass).toBe("ic");
  });

  it("never invents a package for unknown footprints", () => {
    const lines = groupBom([comp({ reference: "SW1", value: "TS-1187A", footprint: "Button_Switch_SMD:SW_SPST_PTS645" })]);
    expect(lines[0]!.package).toBeUndefined();
    expect(lines[0]!.footprint).toBe("Button_Switch_SMD:SW_SPST_PTS645");
  });
});
