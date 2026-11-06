import { evaluate, Value } from "./evaluate";
import { Node, parseFormula, ParseResult } from "./formula";
import { CellPos, parseAddress, toAddress } from "./address";

// The spreadsheet engine. Plain TypeScript, no React.
// It is a class because it holds state that outlives a single edit:
// the cells, their computed values, and the dependency graph.
export class Sheet {
  raw: Record<string, string> = {}; // what the user typed: "=A1+B1", "42"
  values: Record<string, Value> = {}; // what the cell shows
  private parsed = new Map<string, ParseResult>(); // formula trees, parsed once
  private precedents = new Map<string, Set<string>>(); // cell -> cells it reads
  private dependents = new Map<string, Set<string>>(); // cell -> cells that read it

  constructor(
    readonly rows: number,
    readonly cols: number,
  ) {}

    // Replace the whole sheet in one pass: register every cell and formula
  // first, then compute everything once, in dependency order. Used when a
  // sheet is opened. Order of the incoming cells doesn't matter.
  load(cells: Record<string, string>): number {
    this.raw = {};
    this.values = {};
    this.parsed.clear();
    this.precedents.clear();
    this.dependents.clear();

    for (const [addr, input] of Object.entries(cells)) {
      if (input === "") continue;
      this.raw[addr] = input;
      if (input.startsWith("=")) {
        const result = parseFormula(input.slice(1));
        this.parsed.set(addr, result);
        if (result.ok) this.link(addr, this.refsOf(result.node));
      }
    }
    return this.recalc(Object.keys(this.raw));
  }

  // Change one cell. Returns how many cells were recomputed.
  setCell(addr: string, input: string): number {
    this.unlink(addr); // forget the old formula's dependencies

    if (input === "") {
      delete this.raw[addr];
      this.parsed.delete(addr);
    } else {
      this.raw[addr] = input;
      if (input.startsWith("=")) {
        const result = parseFormula(input.slice(1));
        this.parsed.set(addr, result);
        if (result.ok) this.link(addr, this.refsOf(result.node));
      } else {
        this.parsed.delete(addr);
      }
    }
    return this.recalc([addr]);
  }

  // ---- graph bookkeeping ----

  // Remove addr's edges. Needed when a formula is replaced or cleared, or a
  // stale edge would keep triggering recalculation (and fake cycles).
  private unlink(addr: string) {
    for (const p of this.precedents.get(addr) ?? []) {
      this.dependents.get(p)?.delete(addr);
    }
    this.precedents.delete(addr);
  }

  private link(addr: string, refs: Set<string>) {
    this.precedents.set(addr, refs);
    for (const p of refs) {
      let set = this.dependents.get(p);
      if (!set) {
        set = new Set();
        this.dependents.set(p, set);
      }
      set.add(addr);
    }
  }

  private inGrid(p: CellPos | null): p is CellPos {
    return p !== null && p.row < this.rows && p.col < this.cols;
  }

  // Every cell a formula reads. Ranges are expanded to individual cells.
  private refsOf(node: Node, out = new Set<string>()): Set<string> {
    switch (node.type) {
      case "ref":
        if (this.inGrid(parseAddress(node.addr))) out.add(node.addr);
        break;
      case "range": {
        const a = parseAddress(node.from);
        const b = parseAddress(node.to);
        // Out-of-grid ranges evaluate to #REF!, so no edges are needed.
        // This also stops "A1:ZZ99999" from expanding into millions of cells.
        if (this.inGrid(a) && this.inGrid(b)) {
          for (let row = Math.min(a.row, b.row); row <= Math.max(a.row, b.row); row++) {
            for (let col = Math.min(a.col, b.col); col <= Math.max(a.col, b.col); col++) {
              out.add(toAddress({ row, col }));
            }
          }
        }
        break;
      }
      case "neg":
        this.refsOf(node.arg, out);
        break;
      case "bin":
        this.refsOf(node.left, out);
        this.refsOf(node.right, out);
        break;
      case "call":
        for (const arg of node.args) this.refsOf(arg, out);
        break;
    }
    return out;
  }

  // ---- recalculation ----

  private recalc(starts: string[]): number {
    // 1. Affected set: the starting cells plus everything downstream.
    const affected = new Set<string>(starts);
    const stack = [...starts];
    while (stack.length > 0) {
      const a = stack.pop()!;
      for (const d of this.dependents.get(a) ?? []) {
        if (!affected.has(d)) {
          affected.add(d);
          stack.push(d);
        }
      }
    }

    // 2. For each affected cell, count inputs that are also being recomputed.
    //    Zero means it can be computed now; otherwise it waits.
    const waiting = new Map<string, number>();
    const ready: string[] = [];
    for (const a of affected) {
      let n = 0;
      for (const p of this.precedents.get(a) ?? []) {
        if (affected.has(p)) n++;
      }
      if (n === 0) ready.push(a);
      else waiting.set(a, n);
    }

    // 3. Compute ready cells; each one finished unblocks its dependents.
    while (ready.length > 0) {
      const a = ready.pop()!;
      this.setValue(a, this.compute(a));
      for (const d of this.dependents.get(a) ?? []) {
        const left = waiting.get(d);
        if (left === undefined) continue; // not part of this recalculation
        if (left === 1) {
          waiting.delete(d);
          ready.push(d);
        } else {
          waiting.set(d, left - 1);
        }
      }
    }

    // 4. Still waiting = its inputs never finished = a cycle, or downstream
    //    of one. (A cell that reads itself waits on itself forever.)
    for (const a of waiting.keys()) this.setValue(a, { error: "#CYCLE!" });

    return affected.size;
  }

  private compute(addr: string): Value | undefined {
    const raw = this.raw[addr];
    if (raw === undefined) return undefined; // cell was cleared
    const parsed = this.parsed.get(addr);
    if (!parsed) {
      // Plain input: a number if it looks like one, otherwise text
      const n = Number(raw);
      return raw.trim() !== "" && Number.isFinite(n) ? n : raw;
    }
    if (!parsed.ok) return { error: "#ERROR!" };
    return evaluate(parsed.node, {
      rows: this.rows,
      cols: this.cols,
      // Inputs are already final because of the ordering in recalc()
      get: (a) => this.values[a],
    });
  }

  private setValue(addr: string, value: Value | undefined) {
    if (value === undefined) delete this.values[addr];
    else this.values[addr] = value;
  }
}