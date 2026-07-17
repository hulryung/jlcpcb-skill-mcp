import { describe, expect, it } from "vitest";
import {
  classifyComponent,
  packageFromFootprint,
  parseValue,
} from "../../src/kicad/value.js";
import type { ParsedValue } from "../../src/types.js";

function approx(actual: number, expected: number): void {
  expect(actual / expected).toBeCloseTo(1, 9);
}

describe("classifyComponent", () => {
  const cases: Array<[string, string, string | undefined, string]> = [
    ["R1", "10k", "Resistor_SMD:R_0603_1608Metric", "resistor"],
    ["RN1", "4x10k", undefined, "resistor"],
    ["C3", "100nF", undefined, "capacitor"],
    ["L1", "10uH", undefined, "inductor"],
    ["L2", "600R", "Inductor_SMD:L_FerriteBead_0805", "ferrite_bead"],
    ["FB1", "600R@100MHz", undefined, "ferrite_bead"],
    ["D1", "LED", "LED_SMD:LED_0603_1608Metric", "led"],
    ["D2", "1N4148", "Diode_SMD:D_SOD-123", "diode"],
    ["LED1", "green", undefined, "led"],
    ["Q1", "2N7002", undefined, "transistor"],
    ["U1", "ESP32-C3", undefined, "ic"],
    ["IC2", "NE555", undefined, "ic"],
    ["Y1", "32.768kHz", undefined, "crystal"],
    ["X1", "8MHz", undefined, "crystal"],
    ["J1", "USB_C_Receptacle", undefined, "connector"],
    ["P2", "Conn_01x04", undefined, "connector"],
    ["CN1", "FPC-24", undefined, "connector"],
    ["SW1", "SW_Push", undefined, "switch"],
    ["F1", "500mA", undefined, "fuse"],
    ["TP1", "TestPoint", undefined, "other"],
    ["H1", "MountingHole", undefined, "other"],
  ];
  for (const [reference, value, footprint, expected] of cases) {
    it(`${reference} (${value}) → ${expected}`, () => {
      expect(classifyComponent({ reference, value, footprint })).toBe(expected);
    });
  }
});

describe("parseValue — resistance", () => {
  const ohmsOf = (v: string): number => {
    const p = parseValue(v, "resistor");
    expect(p.kind).toBe("resistance");
    return (p as Extract<ParsedValue, { kind: "resistance" }>).ohms;
  };

  it('"4k7" → 4700', () => approx(ohmsOf("4k7"), 4700));
  it('"0.1R" → 0.1', () => approx(ohmsOf("0.1R"), 0.1));
  it('"1M" → 1e6', () => approx(ohmsOf("1M"), 1e6));
  it('"470" → 470 (bare number defaults to ohms)', () => approx(ohmsOf("470"), 470));
  it('"10k" and "10K" → 10000', () => {
    approx(ohmsOf("10k"), 10000);
    approx(ohmsOf("10K"), 10000);
  });
  it('"10kΩ" → 10000', () => approx(ohmsOf("10kΩ"), 10000));
  it('"470R" → 470', () => approx(ohmsOf("470R"), 470));
  it('"0R1" → 0.1', () => approx(ohmsOf("0R1"), 0.1));
  it('"R47" → 0.47', () => approx(ohmsOf("R47"), 0.47));
  it('"1k2" → 1200', () => approx(ohmsOf("1k2"), 1200));

  it('"10k 1%" → 10000 with tolerancePct 1', () => {
    const p = parseValue("10k 1%", "resistor");
    expect(p).toMatchObject({ kind: "resistance", tolerancePct: 1 });
    approx((p as Extract<ParsedValue, { kind: "resistance" }>).ohms, 10000);
  });

  it('"10k ±5%" → tolerancePct 5', () => {
    expect(parseValue("10k ±5%", "resistor")).toMatchObject({
      kind: "resistance",
      tolerancePct: 5,
    });
  });

  it('"10k 1% 1/4W" ignores the wattage fraction', () => {
    const p = parseValue("10k 1% 1/4W", "resistor");
    expect(p.kind).toBe("resistance");
    approx((p as Extract<ParsedValue, { kind: "resistance" }>).ohms, 10000);
  });

  it('"4,7k" (comma decimal) → 4700, not 4', () => approx(ohmsOf("4,7k"), 4700));
  it('"2,2k" (comma decimal) → 2200', () => approx(ohmsOf("2,2k"), 2200));
  it('"10 kOhm" (spaced unit) → 10000, not 10', () => approx(ohmsOf("10 kOhm"), 10000));
  it('"10 kΩ" (spaced unit) → 10000', () => approx(ohmsOf("10 kΩ"), 10000));
  it('"0805 10k" → 10000 (explicit unit beats bare number)', () =>
    approx(ohmsOf("0805 10k"), 10000));

  it("unparseable value falls back to raw", () => {
    expect(parseValue("DNP", "resistor")).toEqual({ kind: "raw", text: "DNP" });
  });

  it("empty value falls back to raw", () => {
    expect(parseValue("  ", "resistor")).toEqual({ kind: "raw", text: "" });
  });
});

describe("parseValue — capacitance", () => {
  const faradsOf = (v: string): number => {
    const p = parseValue(v, "capacitor");
    expect(p.kind).toBe("capacitance");
    return (p as Extract<ParsedValue, { kind: "capacitance" }>).farads;
  };

  it('"100n" → 1e-7', () => approx(faradsOf("100n"), 1e-7));
  it('"100nF" → 1e-7', () => approx(faradsOf("100nF"), 1e-7));
  it('"4u7" → 4.7e-6', () => approx(faradsOf("4u7"), 4.7e-6));
  it('"0.1uF" → 1e-7', () => approx(faradsOf("0.1uF"), 1e-7));
  it('"10p" → 1e-11', () => approx(faradsOf("10p"), 1e-11));
  it('"10pF" → 1e-11', () => approx(faradsOf("10pF"), 1e-11));
  it('"22µF" → 2.2e-5', () => approx(faradsOf("22µF"), 2.2e-5));
  it('"1F" → 1', () => approx(faradsOf("1F"), 1));

  it("extracts voltage and dielectric", () => {
    expect(parseValue("100nF 50V X7R", "capacitor")).toMatchObject({
      kind: "capacitance",
      voltage: 50,
      dielectric: "X7R",
    });
  });

  it('handles "100nF/50V" slash notation', () => {
    const p = parseValue("100nF/50V", "capacitor");
    expect(p).toMatchObject({ kind: "capacitance", voltage: 50 });
    approx((p as Extract<ParsedValue, { kind: "capacitance" }>).farads, 1e-7);
  });

  it('"4,7uF" (comma decimal) → 4.7e-6', () => approx(faradsOf("4,7uF"), 4.7e-6));
  it('"2,2nF" (comma decimal) → 2.2e-9', () => approx(faradsOf("2,2nF"), 2.2e-9));
  it('"4.7 uF" (spaced unit) → 4.7e-6', () => approx(faradsOf("4.7 uF"), 4.7e-6));
  it('"100 nF" (spaced unit) → 1e-7', () => approx(faradsOf("100 nF"), 1e-7));

  it("bare number is ambiguous → raw (never guess the unit)", () => {
    expect(parseValue("10", "capacitor")).toEqual({ kind: "raw", text: "10" });
  });
});

describe("parseValue — inductance and frequency", () => {
  it('"10uH" → 1e-5 H', () => {
    const p = parseValue("10uH", "inductor");
    expect(p.kind).toBe("inductance");
    approx((p as Extract<ParsedValue, { kind: "inductance" }>).henries, 1e-5);
  });

  it('"4u7" inductor → 4.7e-6 H', () => {
    const p = parseValue("4u7", "inductor");
    expect(p.kind).toBe("inductance");
    approx((p as Extract<ParsedValue, { kind: "inductance" }>).henries, 4.7e-6);
  });

  it('"8MHz" → 8e6 Hz', () => {
    const p = parseValue("8MHz", "crystal");
    expect(p.kind).toBe("frequency");
    approx((p as Extract<ParsedValue, { kind: "frequency" }>).hertz, 8e6);
  });

  it('"32.768kHz" → 32768 Hz', () => {
    const p = parseValue("32.768kHz", "crystal");
    expect(p.kind).toBe("frequency");
    approx((p as Extract<ParsedValue, { kind: "frequency" }>).hertz, 32768);
  });
});

describe("parseValue — non-parametric classes stay raw", () => {
  it("ic values are raw", () => {
    expect(parseValue("ESP32-C3", "ic")).toEqual({ kind: "raw", text: "ESP32-C3" });
  });
  it("connector values are raw", () => {
    expect(parseValue("USB_C_Receptacle", "connector")).toEqual({
      kind: "raw",
      text: "USB_C_Receptacle",
    });
  });
});

describe("packageFromFootprint", () => {
  const cases: Array<[string | undefined, string | undefined]> = [
    ["Resistor_SMD:R_0603_1608Metric", "0603"],
    ["Capacitor_SMD:C_0805_2012Metric", "0805"],
    ["Package_TO_SOT_SMD:SOT-23", "SOT-23"],
    ["Package_TO_SOT_SMD:SOT-23-5", "SOT-23-5"],
    ["Package_SO:SOIC-8_3.9x4.9mm_P1.27mm", "SOIC-8"],
    ["LED_SMD:LED_0603_1608Metric", "0603"],
    ["Package_TO_SOT_SMD:SOT-223-3_TabPin2", "SOT-223"],
    ["Package_DFN_QFN:QFN-32-1EP_5x5mm_P0.5mm_EP3.45x3.45mm", "QFN-32"],
    ["Package_SO:TSSOP-20_4.4x6.5mm_P0.65mm", "TSSOP-20"],
    ["Diode_SMD:D_SOD-123", "SOD-123"],
    ["Diode_SMD:D_SMA_Handsoldering", undefined],
    ["Package_TO_SOT_SMD:TO-252-2", "TO-252-2"],
    ["Resistor_SMD:R_0402_1005Metric", "0402"],
    ["R_0603_1608Metric_Pad0.98x0.95mm_HandSolder", "0603"],
    ["0603", "0603"],
    ["Connector_USB:USB_C_Receptacle_HRO_TYPE-C-31-M-12", undefined],
    ["Button_Switch_SMD:SW_SPST_PTS645", undefined],
    ["Crystal:Crystal_SMD_3225-4Pin_3.2x2.5mm", undefined],
    ["", undefined],
    [undefined, undefined],
  ];
  for (const [footprint, expected] of cases) {
    it(`${footprint ?? "(undefined)"} → ${expected ?? "undefined"}`, () => {
      expect(packageFromFootprint(footprint)).toBe(expected);
    });
  }
});
