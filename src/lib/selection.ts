import { CellPos, toAddress } from "./address";
import { Value } from "./evaluate";

// A rectangle of cells, inclusive. r1/c1 is the top-left corner.
export type Range = { r1: number; c1: number; r2: number; c2: number };

// Takes any two opposite corners, in any order, and returns the rectangle.
// Dragging up-left gives the same range as dragging down-right.
export function normalizeRange(a: CellPos, b: CellPos): Range {
  return {
    r1: Math.min(a.row, b.row),
    c1: Math.min(a.col, b.col),
    r2: Math.max(a.row, b.row),
    c2: Math.max(a.col, b.col),
  };
}

export function inRange(range: Range, row: number, col: number): boolean {
  return (
    row >= range.r1 && row <= range.r2 && col >= range.c1 && col <= range.c2
  );
}

// "B2" for one cell, "B2:D4" for several.
export function rangeLabel(range: Range): string {
  const from = toAddress({ row: range.r1, col: range.c1 });
  const to = toAddress({ row: range.r2, col: range.c2 });
  return from === to ? from : `${from}:${to}`;
}

export type Stats = { sum: number; count: number; average: number | null };

// Sum, count and average of the NUMBERS in the range. Text, errors and
// empty cells are skipped (a number is the only kind of value that is a JS
// number; errors are objects and text is a string).
export function rangeStats(range: Range, values: Record<string, Value>): Stats {
  let sum = 0;
  let count = 0;
  for (let row = range.r1; row <= range.r2; row++) {
    for (let col = range.c1; col <= range.c2; col++) {
      const v = values[toAddress({ row, col })];
      if (typeof v === "number") {
        sum += v;
        count++;
      }
    }
  }
  return { sum, count, average: count === 0 ? null : sum / count };
}