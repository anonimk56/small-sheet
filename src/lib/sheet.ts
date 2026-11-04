import { evaluate, Value } from "./evaluate";
import { parseFormula } from "./formula";

// Takes raw cell text ("=A1+B1", "42", "hello"), returns computed values.
export function computeAll(
  cells: Record<string, string>,
  rows: number,
  cols: number,
): Record<string, Value> {
  const results: Record<string, Value> = {}; // memo: each cell computed once
  const visiting = new Set<string>(); // cells currently being computed

  function valueOf(addr: string): Value | undefined {
    const raw = cells[addr];
    if (raw === undefined) return undefined; // empty cell
    if (addr in results) return results[addr]; // already done
    // Seeing a cell that is still being computed means we looped back to it
    if (visiting.has(addr)) return { error: "#CYCLE!" };

    visiting.add(addr);
    const value = compute(raw);
    visiting.delete(addr);
    results[addr] = value;
    return value;
  }

  function compute(raw: string): Value {
    if (!raw.startsWith("=")) {
      // Plain input: a number if it looks like one, otherwise text
      const n = Number(raw);
      return raw.trim() !== "" && Number.isFinite(n) ? n : raw;
    }
    const parsed = parseFormula(raw.slice(1)); // drop the "="
    if (!parsed.ok) return { error: "#ERROR!" };
    // A formula's cell references call back into valueOf
    return evaluate(parsed.node, { rows, cols, get: valueOf });
  }

  for (const addr of Object.keys(cells)) valueOf(addr);
  return results;
}