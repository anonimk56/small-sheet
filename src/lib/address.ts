export type CellPos = { row: number; col: number };

// 0 -> "A", 25 -> "Z", 26 -> "AA", 27 -> "AB"
export function colLabel(index: number): string {
  let label = "";
  let n = index;
  while (n >= 0) {
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  }
  return label;
}

export function toAddress({ row, col }: CellPos): string {
  return `${colLabel(col)}${row + 1}`;
}