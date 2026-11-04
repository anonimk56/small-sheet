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
// "B7" -> { row: 6, col: 1 }. Returns null for junk like "7B" or "A0".
export function parseAddress(addr: string): CellPos | null {
    const match = /^([A-Z]+)([0-9]+)$/.exec(addr);
    if (!match) return null;
    let col = 0;
    // Letters are a base-26 number: "A"=1 ... "Z"=26, "AA"=27
    for (const ch of match[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
    const row = Number(match[2]) - 1;
    if (row < 0) return null;
    return { row, col: col - 1 };
  }