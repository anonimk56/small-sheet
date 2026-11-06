// Server-only storage: one JSON file per sheet in ./data. No database.
// Deleting ./data resets everything: a missing file is rebuilt from the
// deterministic fixture the next time it is read (see `npm run reset`).
import { promises as fs } from "fs";
import path from "path";
import { parseAddress, toAddress } from "./address";
import { Cells, getFixture, isFixtureName } from "./fixtures";
import { COLS, ROWS } from "./grid-size";

const DIR = path.join(process.cwd(), "data");

// Reads and writes must not interleave (read-modify-write would lose
// edits). Every operation waits for the previous one to finish.
let chain: Promise<unknown> = Promise.resolve();
function serialize<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(task, task);
  chain = run.catch(() => undefined);
  return run;
}

async function writeCells(id: string, cells: Cells) {
  await fs.mkdir(DIR, { recursive: true });
  const file = path.join(DIR, `${id}.json`);
  // Write a temp file, then rename it over the real one: a crash halfway
  // through can't leave a half-written sheet behind.
  await fs.writeFile(file + ".tmp", JSON.stringify(cells));
  await fs.rename(file + ".tmp", file);
}

async function loadCells(id: string): Promise<Cells | null> {
  // Only known ids get this far, which also keeps odd ids out of the file path
  if (!isFixtureName(id)) return null;
  try {
    const text = await fs.readFile(path.join(DIR, `${id}.json`), "utf8");
    return JSON.parse(text) as Cells;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    const cells = getFixture(id); // first read, or right after a reset
    await writeCells(id, cells);
    return cells;
  }
}

export function readSheet(id: string): Promise<Cells | null> {
  return serialize(() => loadCells(id));
}

// address -> new raw text. "" means the cell was cleared.
export type Changes = Record<string, string>;

// Returns false if the sheet doesn't exist.
export function applyChanges(id: string, changes: Changes): Promise<boolean> {
  return serialize(async () => {
    const cells = await loadCells(id);
    if (!cells) return false;
    for (const [addr, value] of Object.entries(changes)) {
      if (value === "") delete cells[addr];
      else cells[addr] = value;
    }
    await writeCells(id, cells);
    return true;
  });
}

const MAX_CELL_CHARS = 2000;

// The request body is input we did not write. Returns null unless every
// single entry is valid.
export function parseChanges(body: unknown): Changes | null {
  if (typeof body !== "object" || body === null) return null;
  const changes = (body as { changes?: unknown }).changes;
  if (typeof changes !== "object" || changes === null || Array.isArray(changes)) {
    return null;
  }
  const entries = Object.entries(changes);
  if (entries.length > ROWS * COLS) return null;
  for (const [addr, value] of entries) {
    const pos = parseAddress(addr);
    // toAddress check: only the canonical spelling ("A1", not "A01")
    if (!pos || toAddress(pos) !== addr || pos.row >= ROWS || pos.col >= COLS) {
      return null;
    }
    if (typeof value !== "string" || value.length > MAX_CELL_CHARS) return null;
  }
  return changes as Changes;
}