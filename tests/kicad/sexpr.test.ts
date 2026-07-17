import { describe, expect, it } from "vitest";
import { parseSExpr } from "../../src/kicad/sexpr.js";

describe("parseSExpr", () => {
  it("parses a flat list of atoms", () => {
    expect(parseSExpr("(at 100 50 0)")).toEqual([["at", "100", "50", "0"]]);
  });

  it("keeps numbers as strings", () => {
    const [expr] = parseSExpr("(version 20231120)");
    expect(expr).toEqual(["version", "20231120"]);
    expect(typeof (expr as string[])[1]).toBe("string");
  });

  it("parses nested lists", () => {
    expect(parseSExpr("(a (b (c 1) (d 2)) e)")).toEqual([
      ["a", ["b", ["c", "1"], ["d", "2"]], "e"],
    ]);
  });

  it("parses quoted strings, preserving spaces and parens", () => {
    expect(parseSExpr('(property "Reference" "R1 (main)")')).toEqual([
      ["property", "Reference", "R1 (main)"],
    ]);
  });

  it("handles escaped quotes and backslashes inside strings", () => {
    expect(parseSExpr('(x "a\\"b" "c\\\\d")')).toEqual([["x", 'a"b', "c\\d"]]);
  });

  it("decodes \\n and \\t escapes", () => {
    expect(parseSExpr('(x "line1\\nline2\\tend")')).toEqual([["x", "line1\nline2\tend"]]);
  });

  it("parses multiple top-level expressions", () => {
    expect(parseSExpr("(a 1) (b 2)")).toEqual([
      ["a", "1"],
      ["b", "2"],
    ]);
  });

  it("parses empty input to an empty list", () => {
    expect(parseSExpr("")).toEqual([]);
    expect(parseSExpr("   \n\t ")).toEqual([]);
  });

  it("parses an empty list", () => {
    expect(parseSExpr("()")).toEqual([[]]);
  });

  it("handles negative and decimal number atoms", () => {
    expect(parseSExpr("(at -3.81 0.254)")).toEqual([["at", "-3.81", "0.254"]]);
  });

  it("parses a KiCad-style snippet", () => {
    const text = `(kicad_sch (version 20231120) (generator "eeschema")
      (symbol (lib_id "Device:R") (at 100 50 0)
        (property "Reference" "R1" (at 102 49 0))))`;
    const [doc] = parseSExpr(text);
    expect(Array.isArray(doc)).toBe(true);
    expect((doc as unknown[])[0]).toBe("kicad_sch");
  });

  it("throws on unbalanced parens", () => {
    expect(() => parseSExpr("(a (b 1)")).toThrow(/unclosed/i);
  });

  it("throws on a stray closing paren", () => {
    expect(() => parseSExpr(")")).toThrow(/unexpected \)/i);
  });

  it("throws on an unterminated string with position info", () => {
    expect(() => parseSExpr('(a "oops')).toThrow(/line 1/);
  });
});
