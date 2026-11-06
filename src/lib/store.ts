// Server-only storage: JSON files in ./data. No database.
//   data/index.json   the list of sheets (id + name), in tab order
//   data/<id>.json    one sheet's cells
// Deleting ./data resets everything: missing files are rebuilt from the
// deterministic fixtures the next time they are read (see `npm run reset`).
import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { parseAddress, toAddress } from "./address";
import { Cells, getFixture, isFixtureName } from "./fixtures";
import { COLS, ROWS } from "./grid-size";
import { MAX_NAME_CHARS, MAX_SHEETS, SheetMeta } from "./sheet-meta";

const DIR = path.join(process.cwd(), "data");

const DEFAULT_SHEETS: SheetMeta[] = [
  { id: "budget", name: "Budget" },
  { id: "big", name: "Big sheet" },
  { id: "broken", name: "Broken" },
];

const ID_RE = /^[a-z0-9-]{1,40}$/;

// Reads and writes must not interleave (read-modify-write would lose
// edits). Every operation waits for the previous one to finish.
let chain: Promise<unknown> = Promise.resolve();
function serialize<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(task, task);
  chain = run.catch(() => undefined);
  return run;
}

async function readJson<T>(name: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(DIR, name), "utf8")) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

async function writeJson(name: string, data: unknown) {
  await fs.mkdir(DIR, { recursive: true });
  const file = path.join(DIR, name);
  // Write a temp file, then rename it over the real one: a crash halfway
  // through can't leave a half-written file behind.
  await fs.writeFile(file + ".tmp", JSON.stringify(data));
  await fs.rename(file + ".tmp", file);
}

async function loadIndex(): Promise<SheetMeta[]> {
  const list = await readJson<SheetMeta[]>("index.json");
  if (list) return list;
  await writeJson("index.json", DEFAULT_SHEETS); // first run, or right after a reset
  return [...DEFAULT_SHEETS];
}

async function loadCells(id: string): Promise<Cells | null> {
  // The id ends up in a file path: it must look right AND be in the index
  if (!ID_RE.test(id)) return null;
  const index = await loadIndex();
  if (!index.some((s) => s.id === id)) return null;

  const cells = await readJson<Cells>(`${id}.json`);
  if (cells) return cells;
  const fresh = isFixtureName(id) ? getFixture(id) : {}; // new sheets start empty
  await writeJson(`${id}.json`, fresh);
  return fresh;
}

// ---- sheets ----

export function listSheets(): Promise<SheetMeta[]> {
  return serialize(loadIndex);
}

// Returns null when the limit is reached.
export function createSheet(): Promise<SheetMeta | null> {
  return serialize(async () => {
    const list = await loadIndex();
    if (list.length >= MAX_SHEETS) return null;
    let n = list.length + 1;
    while (list.some((s) => s.name === `Sheet ${n}`)) n++;
    const sheet = { id: `sheet-${randomUUID().slice(0, 8)}`, name: `Sheet ${n}` };
    // Cells first, index second: a crash in between leaves an unused file,
    // never a tab that points at nothing
    await writeJson(`${sheet.id}.json`, {});
    await writeJson("index.json", [...list, sheet]);
    return sheet;
  });
}

// Returns null if the sheet doesn't exist.
export function renameSheet(id: string, name: string): Promise<SheetMeta | null> {
  return serialize(async () => {
    const list = await loadIndex();
    const sheet = list.find((s) => s.id === id);
    if (!sheet) return null;
    const renamed = { ...sheet, name };
    await writeJson("index.json", list.map((s) => (s.id === id ? renamed : s)));
    return renamed;
  });
}

// The request body is input we did not write.
export function parseName(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const name = (body as { name?: unknown }).name;
  if (typeof name !== "string") return null;
  const trimmed = name.trim();
  if (trimmed === "" || trimmed.length > MAX_NAME_CHARS) return null;
  if (/\p{Cc}/u.test(trimmed)) return null; // no control characters
  return trimmed;
}

// ---- cells ----

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
    await writeJson(`${id}.json`, cells);
    return true;
  });
}

const MAX_CELL_CHARS = 2000;

// Returns null unless every single entry is valid.
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