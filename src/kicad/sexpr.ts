/**
 * Minimal s-expression parser sufficient for KiCad files (.kicad_sch etc.).
 * Atoms and quoted strings both come back as plain strings — numbers are NOT
 * converted (callers parse), and quoted-ness is not preserved.
 */

export type SExpr = string | SExpr[];

/** Parse a whole document into its list of top-level expressions. */
export function parseSExpr(text: string): SExpr[] {
  let pos = 0;
  const len = text.length;

  const isWs = (c: string): boolean => c === " " || c === "\t" || c === "\n" || c === "\r";

  function fail(msg: string): never {
    let line = 1;
    let col = 1;
    for (let i = 0; i < pos && i < len; i++) {
      if (text[i] === "\n") {
        line++;
        col = 1;
      } else {
        col++;
      }
    }
    throw new Error(`s-expression parse error at line ${line}, col ${col}: ${msg}`);
  }

  function skipWs(): void {
    while (pos < len && isWs(text[pos]!)) pos++;
  }

  function parseString(): string {
    pos++; // consume opening quote
    let out = "";
    while (pos < len) {
      const c = text[pos]!;
      if (c === '"') {
        pos++;
        return out;
      }
      if (c === "\\") {
        pos++;
        if (pos >= len) fail("unterminated escape in quoted string");
        const e = text[pos]!;
        out += e === "n" ? "\n" : e === "t" ? "\t" : e === "r" ? "\r" : e;
        pos++;
      } else {
        out += c;
        pos++;
      }
    }
    fail("unterminated quoted string");
  }

  function parseAtom(): string {
    const start = pos;
    while (pos < len) {
      const c = text[pos]!;
      if (isWs(c) || c === "(" || c === ")" || c === '"') break;
      pos++;
    }
    if (pos === start) fail(`unexpected character ${JSON.stringify(text[pos])}`);
    return text.slice(start, pos);
  }

  function parseExpr(): SExpr {
    const c = text[pos]!;
    if (c === "(") {
      pos++;
      const items: SExpr[] = [];
      for (;;) {
        skipWs();
        if (pos >= len) fail("unclosed list — missing )");
        if (text[pos] === ")") {
          pos++;
          return items;
        }
        items.push(parseExpr());
      }
    }
    if (c === ")") fail("unexpected )");
    if (c === '"') return parseString();
    return parseAtom();
  }

  const out: SExpr[] = [];
  skipWs();
  while (pos < len) {
    out.push(parseExpr());
    skipWs();
  }
  return out;
}
