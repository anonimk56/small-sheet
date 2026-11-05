// One cell edit: which cell, what it contained, what it contains now.
// "before"/"after" are raw text ("=A1+B1"), "" means empty.
export type CellChange = { addr: string; before: string; after: string };

const MAX_ENTRIES = 200; // keeps memory bounded

// One entry = one user action = a LIST of changes. A single edit is a list
// of one; a paste will be a list of thousands, undone in a single step.
export class History {
  private undoStack: CellChange[][] = [];
  private redoStack: CellChange[][] = [];

  record(changes: CellChange[]) {
    // Drop no-ops, e.g. pressing Enter without changing the text
    const real = changes.filter((c) => c.before !== c.after);
    if (real.length === 0) return;
    this.undoStack.push(real);
    if (this.undoStack.length > MAX_ENTRIES) this.undoStack.shift();
    this.redoStack = []; // a new edit erases the redo "future"
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