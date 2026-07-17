import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { analyzeKicadFile } from "../../src/kicad/index.js";

const exampleText = readFileSync(
  new URL("../../examples/esp32c3-sensor/esp32c3-sensor.kicad_sch", import.meta.url),
  "utf8",
);
const groupedCsv = readFileSync(new URL("../fixtures/kicad/bom-grouped.csv", import.meta.url), "utf8");

describe("analyzeKicadFile — .kicad_sch dispatch", () => {
  const lines = analyzeKicadFile(exampleText, "esp32c3-sensor.kicad_sch");

  it("produces grouped BOM lines for the example project", () => {
    // U1, U2, J1, {R1,R2}, {R3,R4}, R5, R6(dnp), {C1,C2}, C3, C4, D1, SW1
    expect(lines).toHaveLength(12);
    const totalRefs = lines.reduce((n, l) => n + l.references.length, 0);
    expect(totalRefs).toBe(15);
  });

  it("groups the two 10k pull-ups but not the DNP 10k", () => {
    const tenK = lines.filter(
      (l) => l.componentClass === "resistor" && l.parsed?.kind === "resistance" && l.parsed.ohms === 10000,
    );
    expect(tenK).toHaveLength(2);
    const populated = tenK.find((l) => !l.dnp)!;
    const dnp = tenK.find((l) => l.dnp)!;
    expect(populated.references).toEqual(["R1", "R2"]);
    expect(populated.qtyPerBoard).toBe(2);
    expect(populated.package).toBe("0603");
    expect(dnp.references).toEqual(["R6"]);
  });

  it("groups the two 100nF decoupling caps", () => {
    const line = lines.find((l) => l.value === "100nF")!;
    expect(line.references).toEqual(["C1", "C2"]);
    expect(line.package).toBe("0603");
    expect(line.componentClass).toBe("capacitor");
  });

  it("derives JLC packages for the ICs", () => {
    const u1 = lines.find((l) => l.references.includes("U1"))!;
    expect(u1.package).toBe("QFN-32");
    expect(u1.componentClass).toBe("ic");
    const u2 = lines.find((l) => l.references.includes("U2"))!;
    expect(u2.package).toBe("SOT-223");
  });

  it("carries pre-assigned LCSC numbers onto the lines", () => {
    expect(lines.find((l) => l.references.includes("J1"))!.lcsc).toBe("C165948");
    expect(lines.find((l) => l.references.includes("U2"))!.lcsc).toBe("C6186");
  });

  it("classifies the LED and switch", () => {
    expect(lines.find((l) => l.references.includes("D1"))!.componentClass).toBe("led");
    expect(lines.find((l) => l.references.includes("SW1"))!.componentClass).toBe("switch");
  });
});

describe("analyzeKicadFile — .csv dispatch", () => {
  it("routes .csv content through the BOM parser", () => {
    const lines = analyzeKicadFile(groupedCsv, "bom.csv");
    const tenK = lines.find((l) => l.value === "10k")!;
    expect(tenK.references).toEqual(["R1", "R2", "R3"]);
    expect(tenK.qtyPerBoard).toBe(3);
    expect(tenK.lcsc).toBe("C25804");
  });

  it("is case-insensitive on the extension", () => {
    expect(analyzeKicadFile(groupedCsv, "BOM.CSV").length).toBeGreaterThan(0);
  });
});

describe("analyzeKicadFile — unsupported extensions", () => {
  it("throws on unknown file types", () => {
    expect(() => analyzeKicadFile("{}", "board.kicad_pcb")).toThrow(/Unsupported file type/);
  });
});
