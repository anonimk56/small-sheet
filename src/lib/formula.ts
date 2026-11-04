// What the parser produces: a tree of these nodes.
export type BinOp = "+" | "-" | "*" | "/";

export type Node =
  | { type: "num"; value: number }
  | { type: "ref"; addr: string } // A1
  | { type: "range"; from: string; to: string } // A1:B3
  | { type: "neg"; arg: Node } // -A1
  | { type: "bin"; op: BinOp; left: Node; right: Node }
  | { type: "call"; name: string; args: Node[] }; // SUM(...)

// Errors are returned as values, never thrown out of this file.
export type ParseResult = { ok: true; node: Node } | { ok: false };

// Internal only: thrown deep inside the parser, caught in parseFormula.
class ParseError extends Error {}

type Token =
  | { kind: "num"; value: number }
  | { kind: "id"; text: string } // A1, SUM
  | { kind: "op"; text: string }; // + - * / ( ) , :
type OpToken = Extract<Token, { kind: "op" }>;

const CELL_RE = /^[A-Z]+[0-9]+$/;

// Stage 1: split the text into tokens. "A1+2" -> [id A1, op +, num 2]
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
      const value = Number(src.slice(i, j));
      if (Number.isNaN(value)) throw new ParseError(); // e.g. "1.2.3"
      tokens.push({ kind: "num", value });
      i = j;
    } else if (/[A-Za-z]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9]/.test(src[j])) j++;
      tokens.push({ kind: "id", text: src.slice(i, j).toUpperCase() });
      i = j;
    } else if ("+-*/(),:".includes(ch)) {
      tokens.push({ kind: "op", text: ch });
      i++;
    } else {
      throw new ParseError(); // unknown character
    }
  }
  return tokens;
}

// Stage 2: build the tree. Grammar, lowest precedence first:
//   expr    := term (("+" | "-") term)*
//   term    := unary (("*" | "/") unary)*
//   unary   := "-" unary | primary
//   primary := number | "(" expr ")" | NAME "(" args ")" | CELL (":" CELL)?
// Each rule calls the next-higher-precedence rule, which is what makes
// "*" bind tighter than "+".
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
    // A loop (not recursion) makes it left-associative: 10-2-3 = (10-2)-3
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
    if (!t) throw new ParseError(); // formula ended too early, e.g. "1+"
    if (t.kind === "num") return { type: "num", value: t.value };
    if (t.kind === "op") {
      if (t.text !== "(") throw new ParseError();
      const inner = parseExpr(); // parentheses restart at lowest precedence
      expectOp(")");
      return inner;
    }
    // An identifier: a function call, a range, or a single cell
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
  if (pos < tokens.length) throw new ParseError(); // leftovers, e.g. "1 2"
  return node;
}

export function parseFormula(source: string): ParseResult {
  try {
    return { ok: true, node: parseTokens(tokenize(source)) };
  } catch (e) {
    if (e instanceof ParseError) return { ok: false };
    throw e; // a real bug should still surface
  }
}