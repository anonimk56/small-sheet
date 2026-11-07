import { parseAddress, toAddress } from "./address";

export type BinOp = "+" | "-" | "*" | "/";

export type Node =
  | { type: "num"; value: number }
  | { type: "ref"; addr: string }
  | { type: "range"; from: string; to: string }
  | { type: "neg"; arg: Node }
  | { type: "bin"; op: BinOp; left: Node; right: Node }
  | { type: "call"; name: string; args: Node[] };

export type ParseResult = { ok: true; node: Node } | { ok: false };

class ParseError extends Error {}

type Token =
  | { kind: "num"; value: number; text: string }
  | { kind: "id"; text: string }
  | { kind: "op"; text: string };
type OpToken = Extract<Token, { kind: "op" }>;

const CELL_RE = /^[A-Z]+[0-9]+$/;

// What a reference turns into when pasting moves it off the sheet. It parses,
// and evaluates to the #REF! error, like in other spreadsheets.
const BROKEN_REF = "#REF!";

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === " ") {
      i++;
    } else if (/[0-9.]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      const text = src.slice(i, j);
      const value = Number(text);
      if (Number.isNaN(value)) throw new ParseError();
      tokens.push({ kind: "num", value, text });
      i = j;
    } else if (/[A-Za-z]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9]/.test(src[j])) j++;
      tokens.push({ kind: "id", text: src.slice(i, j).toUpperCase() });
      i = j;
    } else if (ch === "#") {
      if (src.slice(i, i + 5).toUpperCase() !== BROKEN_REF) throw new ParseError();
      tokens.push({ kind: "id", text: BROKEN_REF });
      i += 5;
    } else if ("+-*/(),:".includes(ch)) {
      tokens.push({ kind: "op", text: ch });
      i++;
    } else {
      throw new ParseError();
    }
  }
  return tokens;
}

function parseTokens(tokens: Token[]): Node {
  let pos = 0;
  const isOp = (text: string) => {
    const t = tokens[pos];
    return t !== undefined && t.kind === "op" && t.text === text;
  };
  const expectOp = (text: string) => {
    if (!isOp(text)) throw new ParseError();
    pos++;
  };
  function parseExpr(): Node {
    let left = parseTerm();
    while (isOp("+") || isOp("-")) {
      const op = (tokens[pos++] as OpToken).text as BinOp;
      left = { type: "bin", op, left, right: parseTerm() };
    }
    return left;
  }
  function parseTerm(): Node {
    let left = parseUnary();
    while (isOp("*") || isOp("/")) {
      const op = (tokens[pos++] as OpToken).text as BinOp;
      left = { type: "bin", op, left, right: parseUnary() };
    }
    return left;
  }
  function parseUnary(): Node {
    if (isOp("-")) {
      pos++;
      return { type: "neg", arg: parseUnary() };
    }
    return parsePrimary();
  }
  function parsePrimary(): Node {
    const t = tokens[pos++];
    if (!t) throw new ParseError();
    if (t.kind === "num") return { type: "num", value: t.value };
    if (t.kind === "op") {
      if (t.text !== "(") throw new ParseError();
      const inner = parseExpr();
      expectOp(")");
      return inner;
    }
    if (isOp("(")) {
      pos++;
      const args: Node[] = [];
      if (!isOp(")")) {
        args.push(parseExpr());
        while (isOp(",")) {
          pos++;
          args.push(parseExpr());
        }
      }
      expectOp(")");
      return { type: "call", name: t.text, args };
    }
    if (t.text === BROKEN_REF) return { type: "ref", addr: t.text };
    if (!CELL_RE.test(t.text)) throw new ParseError();
    if (isOp(":")) {
      pos++;
      const end = tokens[pos++];
      if (!end || end.kind !== "id" || !CELL_RE.test(end.text)) {
        throw new ParseError();
      }
      return { type: "range", from: t.text, to: end.text };
    }
    return { type: "ref", addr: t.text };
  }
  const node = parseExpr();
  if (pos < tokens.length) throw new ParseError();
  return node;
}

export function parseFormula(source: string): ParseResult {
  try {
    return { ok: true, node: parseTokens(tokenize(source)) };
  } catch (e) {
    // RangeError: nested so deeply that the call stack ran out. The text is
    // too extreme to be a real formula, so it is just an error like any other.
    if (e instanceof ParseError || e instanceof RangeError) return { ok: false };
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Used when a formula is copied and pasted somewhere else.
// ---------------------------------------------------------------------------

// Move one reference by (dRow, dCol). null = it would land off the sheet.
function shiftAddr(addr: string, dRow: number, dCol: number, rows: number, cols: number): string | null {
  const pos = parseAddress(addr);
  if (!pos) return null;
  // A reference that was already off the sheet stays as it is
  if (pos.row >= rows || pos.col >= cols) return addr;
  const row = pos.row + dRow;
  const col = pos.col + dCol;
  if (row < 0 || col < 0 || row >= rows || col >= cols) return null;
  return toAddress({ row, col });
}

// "=A1+B2" pasted one row down and one column right becomes "=B2+C3": every
// reference moves by the distance the formula moved. A reference that would
// leave the sheet becomes #REF!. Text that isn't a valid formula is returned
// untouched, so an error stays the same error.
export function shiftFormula(
  formula: string,
  dRow: number,
  dCol: number,
  rows: number,
  cols: number,
): string {
  if (!formula.startsWith("=")) return formula;
  const source = formula.slice(1);
  if (!parseFormula(source).ok) return formula;

  const tokens = tokenize(source);
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind === "id" && CELL_RE.test(t.text)) {
      const next = tokens[i + 1];
      const end = tokens[i + 2];
      if (next?.kind === "op" && next.text === ":" && end?.kind === "id" && CELL_RE.test(end.text)) {
        // A range: both ends move together, or the whole range is lost
        const a = shiftAddr(t.text, dRow, dCol, rows, cols);
        const b = shiftAddr(end.text, dRow, dCol, rows, cols);
        out.push(a && b ? `${a}:${b}` : BROKEN_REF);
        i += 2;
      } else {
        out.push(shiftAddr(t.text, dRow, dCol, rows, cols) ?? BROKEN_REF);
      }
    } else {
      out.push(t.text);
    }
  }
  return "=" + out.join("");
}

// How many cells a formula reads (a range counts every cell in it). Mirrors
// what the engine links into its graph, so a paste can be refused BEFORE it
// builds something too large.
export function countRefs(node: Node, rows: number, cols: number): number {
  const inGrid = (addr: string) => {
    const p = parseAddress(addr);
    return p !== null && p.row < rows && p.col < cols ? p : null;
  };
  switch (node.type) {
    case "ref":
      return inGrid(node.addr) ? 1 : 0;
    case "range": {
      const a = inGrid(node.from);
      const b = inGrid(node.to);
      if (!a || !b) return 0;
      return (Math.abs(a.row - b.row) + 1) * (Math.abs(a.col - b.col) + 1);
    }
    case "neg":
      return countRefs(node.arg, rows, cols);
    case "bin":
      return countRefs(node.left, rows, cols) + countRefs(node.right, rows, cols);
    case "call":
      return node.args.reduce((sum, arg) => sum + countRefs(arg, rows, cols), 0);
    default:
      return 0;
  }
}