// Copy and paste. Plain TypeScript, no React.
//
// The clipboard is input we did not write. Everything that arrives passes
// through planPaste, which either returns a complete list of changes or
// refuses the whole paste: it never applies half of one.
import { CellPos, colLabel, parseAddress, toAddress } from "./address";
import { formatValue, Value } from "./evaluate";
import { countRefs, parseFormula, shiftFormula } from "./formula";
import { COLS, MAX_CELL_CHARS, ROWS } from "./grid-size";
import type { CellChange } from "./history";
import { inRange, Range } from "./selection";

// Limits. Each one is a deliberate answer to a hostile or runaway paste.
const MAX_PASTE_CHARS = 5_000_000; // size of the clipboard text
export const MAX_PASTE_REFS = 300_000; // cells all pasted formulas read, in total

// ---- copying ----

// What the last Copy took from this sheet: the exact text of each cell
// (formulas included) and where it came from.
export type Copied = { text: string; origin: CellPos; rows: string[][] };

let lastCopy: Copied | null = null;

export function rememberCopy(copied: Copied) {
  lastCopy = copied;
}

// Quote a field the way other spreadsheets do: only when it has to be.
function quote(field: string): string {
  return /[\t\r\n"]/.test(field) ? `"${field.replace(/"/g, '""')}"` : field;
}

// The range as tab-separated text of what the cells SHOW (values), which is
// what other applications expect. Our own paste uses `rows` (the raw text,
// formulas included) when it recognises this same copy coming back.
export function copyRange(
  range: Range,
  raw: Record<string, string>,
  values: Record<string, Value>,
): Copied {
  const letters: string[] = [];
  for (let col = range.c1; col <= range.c2; col++) letters.push(colLabel(col));
  const rows: string[][] = [];
  const lines: string[] = [];
  for (let row = range.r1; row <= range.r2; row++) {
    const rawRow: string[] = [];
    const shown: string[] = [];
    for (let col = range.c1; col <= range.c2; col++) {
      const addr = letters[col - range.c1] + (row + 1);
      rawRow.push(raw[addr] ?? "");
      shown.push(quote(formatValue(values[addr])));
    }
    rows.push(rawRow);
    lines.push(shown.join("\t"));
  }
  return { text: lines.join("\n"), origin: { row: range.r1, col: range.c1 }, rows };
}

// ---- reading what was copied elsewhere ----

// Tab-separated text, as produced by Excel, Google Sheets, Numbers and most
// tables on web pages. Handles quoted fields (which may contain tabs, line
// breaks and doubled quotes), \r\n and \n line ends, and a trailing newline.
// Stops reading at maxRows / maxCols, so a huge paste can't allocate more
// than the sheet could ever hold.
export function parseTsv(
  text: string,
  maxRows: number,
  maxCols: number,
): { rows: string[][]; truncated: boolean } {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let fieldStart = true;
  let truncated = false;
  const n = text.length;
  let i = 0;

  const endField = () => {
    if (row.length < maxCols) row.push(field);
    else truncated = true;
    field = "";
    fieldStart = true;
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < n) {
    const ch = text[i];
    if (fieldStart && ch === '"') {
      // A quoted field: read to the closing quote; "" is a literal quote
      i++;
      while (i < n) {
        if (text[i] === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i += 2;
          } else {
            i++;
            break;
          }
        } else {
          field += text[i++];
        }
      }
      fieldStart = false;
    } else if (ch === "\t") {
      endField();
      i++;
    } else if (ch === "\n" || ch === "\r") {
      i += ch === "\r" && text[i + 1] === "\n" ? 2 : 1;
      endRow();
      if (rows.length >= maxRows) {
        if (i < n) truncated = true;
        return { rows, truncated };
      }
    } else {
      field += ch;
      fieldStart = false;
      i++;
    }
  }
  if (field !== "" || row.length > 0) endRow(); // last line without a final newline
  return { rows, truncated };
}

// A cell is one line of printable text. Control characters (NUL, bells, and
// the tabs and line breaks that can hide inside a quoted field) become spaces.
const CONTROL = /[\u0000-\u001f\u007f]/g;
export function cleanCell(text: string): string {
  return text.replace(CONTROL, " ");
}

// ---- pasting ----

export type PastePlan =
  | {
      ok: true;
      changes: CellChange[]; // only cells whose text actually changes
      area: Range; // what to select afterwards
      cells: number; // how many cells the paste covered
      clipped: boolean; // true if part of it fell outside the sheet
    }
  | { ok: false; error: string };

const plural = (n: number) => (n === 1 ? "" : "s");

// Turns clipboard text into a list of changes (or an error message).
//   text       the clipboard's plain text
//   selection  where to paste: the top-left of it is the anchor. One copied
//              cell is repeated across the whole selection ("fill").
//   raw        the sheet's current cell text, for the "before" of each change
export function planPaste(
  text: string,
  selection: Range,
  raw: Record<string, string>,
): PastePlan {
  // Our own copy coming back? Then use the exact cell text (formulas move
  // their references). Anything else is just text.
  const internal = lastCopy !== null && lastCopy.text === text ? lastCopy : null;

  if (!internal) {
    if (text === "") return { ok: false, error: "Nothing to paste: the clipboard has no text." };
    if (text.length > MAX_PASTE_CHARS) {
      return { ok: false, error: "That’s too much to paste (the limit is about 5 MB of text)." };
    }
  }

  const anchorRow = selection.r1;
  const anchorCol = selection.c1;
  let clipped = false;

  let rows: string[][];
  if (internal) {
    rows = internal.rows;
  } else {
    const parsed = parseTsv(text, ROWS - anchorRow, COLS - anchorCol);
    rows = parsed.rows;
    clipped = parsed.truncated;
  }
  const height = rows.length;
  const width = rows.reduce((max, r) => Math.max(max, r.length), 0);
  if (height === 0 || width === 0) {
    return { ok: false, error: "Nothing to paste: the clipboard has no cells." };
  }

  const selectionIsOneCell = selection.r1 === selection.r2 && selection.c1 === selection.c2;
  const fill = height === 1 && width === 1 && !selectionIsOneCell;

  const changes: CellChange[] = [];
  let cells = 0;
  let refs = 0;
  let failure: string | null = null;

  // Work out what one destination cell should end up holding
  const place = (r: number, c: number, i: number, j: number) => {
    if (failure) return;
    if (r >= ROWS || c >= COLS) {
      clipped = true;
      return;
    }
    const field = rows[i][j];
    if (field === undefined) return; // a short row leaves the rest alone
    let after: string;
    if (internal) {
      after = shiftFormula(
        field,
        r - (internal.origin.row + i),
        c - (internal.origin.col + j),
        ROWS,
        COLS,
      );
    } else {
      after = cleanCell(field);
    }
    if (after.length > MAX_CELL_CHARS) {
      failure = `A cell in that paste is longer than ${MAX_CELL_CHARS.toLocaleString("en-US")} characters, so nothing was pasted.`;
      return;
    }
    if (after.startsWith("=")) {
      const parsed = parseFormula(after.slice(1));
      if (parsed.ok) refs += countRefs(parsed.node, ROWS, COLS);
      if (refs > MAX_PASTE_REFS) {
        failure = "Those formulas refer to too many cells at once, so nothing was pasted.";
        return;
      }
    }
    cells++;
    const addr = toAddress({ row: r, col: c });
    const before = raw[addr] ?? "";
    if (before !== after) changes.push({ addr, before, after });
  };

  let area: Range;
  if (fill) {
    for (let r = selection.r1; r <= selection.r2; r++) {
      for (let c = selection.c1; c <= selection.c2; c++) place(r, c, 0, 0);
    }
    area = selection;
  } else {
    for (let i = 0; i < height; i++) {
      for (let j = 0; j < rows[i].length; j++) place(anchorRow + i, anchorCol + j, i, j);
    }
    area = {
      r1: anchorRow,
      c1: anchorCol,
      r2: Math.min(ROWS - 1, anchorRow + height - 1),
      c2: Math.min(COLS - 1, anchorCol + width - 1),
    };
  }

  if (failure) return { ok: false, error: failure };
  return { ok: true, changes, area, cells, clipped };
}

export function describePaste(plan: Extract<PastePlan, { ok: true }>): string {
  const { cells, changes, clipped } = plan;
  let message = `Pasted ${cells.toLocaleString("en-US")} cell${plural(cells)}`;
  if (changes.length === 0) message = "Pasted, but nothing changed (the cells already held those values)";
  if (clipped) message += ". The rest fell outside the sheet";
  return message;
}

// ---- clearing ----

// Delete/Backspace over a range: everything in it becomes empty. Walks
// whichever is smaller, the rectangle or the filled cells, so clearing the
// whole sheet stays quick.
export function planClear(range: Range, raw: Record<string, string>): CellChange[] {
  const changes: CellChange[] = [];
  const area = (range.r2 - range.r1 + 1) * (range.c2 - range.c1 + 1);
  const filled = Object.keys(raw);
  if (area <= filled.length) {
    for (let row = range.r1; row <= range.r2; row++) {
      for (let col = range.c1; col <= range.c2; col++) {
        const addr = toAddress({ row, col });
        if (raw[addr] !== undefined) changes.push({ addr, before: raw[addr], after: "" });
      }
    }
  } else {
    for (const addr of filled) {
      const pos = parseAddress(addr);
      if (pos && inRange(range, pos.row, pos.col)) {
        changes.push({ addr, before: raw[addr], after: "" });
      }
    }
  }
  return changes;
}