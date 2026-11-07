// One cell edit: which cell, what it contained, what it contains now.
// "before"/"after" are raw text ("=A1+B1"), "" means empty.
export type CellChange = { addr: string; before: string; after: string };

// Undo goes back as far as you like. The only limit is memory: the oldest
// steps are forgotten once the history holds more than this many cell changes
// in total (a 50,000-cell paste counts as 50,000, a typed edit as 1).
const MAX_CHANGES = 500_000;

// One entry = one user action = a LIST of changes. A single edit is a list
// of one; a paste is a list of thousands, undone in a single step.
export class History {
  private undoStack: CellChange[][] = [];
  private redoStack: CellChange[][] = [];
  private size = 0; // cell changes held across both stacks

  record(changes: CellChange[]) {
    // Drop no-ops, e.g. pressing Enter without changing the text
    const real = changes.filter((c) => c.before !== c.after);
    if (real.length === 0) return;
    this.undoStack.push(real);
    this.size += real.length;
    // A new edit erases the redo "future"
    for (const entry of this.redoStack) this.size -= entry.length;
    this.redoStack = [];
    // Forget the oldest steps if memory is getting out of hand (always keep one)
    while (this.size > MAX_CHANGES && this.undoStack.length > 1) {
      this.size -= this.undoStack.shift()!.length;
    }
  }

  // Moves the latest entry to the redo stack and returns it so the caller
  // can apply the "before" values. Returns null if there is nothing to undo.
  undo(): CellChange[] | null {
    const entry = this.undoStack.pop();
    if (!entry) return null;
    this.redoStack.push(entry);
    return entry;
  }

  redo(): CellChange[] | null {
    const entry = this.redoStack.pop();
    if (!entry) return null;
    this.undoStack.push(entry);
    return entry;
  }
}