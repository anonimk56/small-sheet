import { Node } from "./formula";
import { CellPos, parseAddress, toAddress } from "./address";

export type ErrorCode =
  | "#ERROR!" // formula can't be parsed
  | "#REF!" // refers to a cell outside the sheet
  | "#DIV/0!"
  | "#CYCLE!" // cell depends on itself
  | "#VALUE!" // wrong kind of value, e.g. text in arithmetic
  | "#NAME?"; // unknown function

export type CellError = { error: ErrorCode };
// A computed cell is a number, text, or an error. Errors are plain values,
// so they flow through formulas without any try/catch.
export type Value = number | string | CellError;

// The evaluator doesn't know where cells live. The caller supplies a lookup.
export type Context = {
  rows: number;
  cols: number;
  get: (addr: string) => Value | undefined; // undefined = empty cell
};

export const isError = (v: Value | undefined): v is CellError =>
  typeof v === "object";

const err = (error: ErrorCode): CellError => ({ error });

// How a value looks in a cell. toPrecision hides float noise:
// 0.1+0.2 is 0.30000000000000004 in JS, but shows as 0.3
export function formatValue(v: Value | undefined): string {
  if (v === undefined) return "";
  if (isError(v)) return v.error;
  if (typeof v === "number") return String(parseFloat(v.toPrecision(12)));
  return v;
}

function inBounds(pos: CellPos | null, ctx: Context): pos is CellPos {
  return pos !== null && pos.row < ctx.rows && pos.col < ctx.cols;
}

// For arithmetic: empty counts as 0, text is an error, errors pass through.
function toNumber(v: Value | undefined): number | CellError {
  if (v === undefined) return 0;
  if (typeof v === "number") return v;
  if (isError(v)) return v;
  return err("#VALUE!");
}

export function evaluate(node: Node, ctx: Context): Value {
  switch (node.type) {
    case "num":
      return node.value;

    case "ref": {
      if (!inBounds(parseAddress(node.addr), ctx)) return err("#REF!");
      return ctx.get(node.addr) ?? 0; // "=A1" shows A1's value, even text
    }

    case "range":
      return err("#VALUE!"); // a bare range like "=A1:B2" is meaningless

    case "neg": {
      const n = toNumber(evaluate(node.arg, ctx));
      return typeof n === "number" ? -n : n;
    }

    case "bin": {
      const l = toNumber(evaluate(node.left, ctx));
      if (typeof l !== "number") return l; // error on the left wins
      const r = toNumber(evaluate(node.right, ctx));
      if (typeof r !== "number") return r;
      switch (node.op) {
        case "+":
          return l + r;
        case "-":
          return l - r;
        case "*":
          return l * r;
        case "/":
          return r === 0 ? err("#DIV/0!") : l / r;
      }
    }

    case "call":
      return callFunction(node.name, node.args, ctx);
  }
}

function callFunction(name: string, args: Node[], ctx: Context): Value {
  if (name !== "SUM" && name !== "AVG") return err("#NAME?");
  const nums = collectNumbers(args, ctx);
  if (!Array.isArray(nums)) return nums; // an error came back
  const sum = nums.reduce((a, b) => a + b, 0);
  if (name === "SUM") return sum;
  return nums.length === 0 ? err("#DIV/0!") : sum / nums.length;
}

// Gathers every number from the arguments. Ranges skip empty and text
// cells (like Excel); an error anywhere makes the whole result that error.
function collectNumbers(args: Node[], ctx: Context): number[] | CellError {
  const nums: number[] = [];
  for (const arg of args) {
    if (arg.type === "range") {
      const a = parseAddress(arg.from);
      const b = parseAddress(arg.to);
      if (!inBounds(a, ctx) || !inBounds(b, ctx)) return err("#REF!");
      // min/max so "B2:A1" works the same as "A1:B2"
      for (let row = Math.min(a.row, b.row); row <= Math.max(a.row, b.row); row++) {
        for (let col = Math.min(a.col, b.col); col <= Math.max(a.col, b.col); col++) {
          const v = ctx.get(toAddress({ row, col }));
          if (isError(v)) return v;
          if (typeof v === "number") nums.push(v);
        }
      }
    } else {
      const n = toNumber(evaluate(arg, ctx));
      if (typeof n !== "number") return n;
      nums.push(n);
    }
  }
  return nums;
}