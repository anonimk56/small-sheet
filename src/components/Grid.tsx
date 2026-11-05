"use client";

import { useEffect, useRef, useState } from "react";
import { CellPos, colLabel, parseAddress, toAddress } from "@/lib/address";
import { CellChange, History } from "@/lib/history";
import styles from "./Grid.module.css";
import { Sheet } from "@/lib/sheet";
import { formatValue, isError } from "@/lib/evaluate";
import {
  inRange,
  normalizeRange,
  rangeLabel,
  rangeStats,
} from "@/lib/selection";

const ROWS = 20;
const COLS = 10;

const NAV_KEYS: Record<string, [number, number]> = {
  ArrowUp: [-1, 0],
  ArrowDown: [1, 0],
  ArrowLeft: [0, -1],
  ArrowRight: [0, 1],
};

const clamp = (value: number, count: number) =>
  Math.max(0, Math.min(count - 1, value));

export default function Grid() {
  const [active, setActive] = useState<CellPos>({ row: 0, col: 0 });

  // Opposite corner of the selected range. null = just the active cell.
  const [extent, setExtent] = useState<CellPos | null>(null);

  // True while the mouse button is held after pressing on a cell. A ref (not
  // state) because changing it shouldn't re-render anything.
  const dragging = useRef(false);

  // Text being typed. null means "not editing".
  const [draft, setDraft] = useState<string | null>(null);

  // Where the current edit is happening: inside the cell or in the formula bar.
  const [editSource, setEditSource] = useState<"cell" | "bar">("cell");

  const rootRef = useRef<HTMLDivElement>(null);

  // The mouse can be released anywhere, even outside the grid, so listen on
  // the whole window. Otherwise a drag could get "stuck on".
  useEffect(() => {
    const stop = () => {
      dragging.current = false;
    };
    window.addEventListener("mouseup", stop);
    return () => window.removeEventListener("mouseup", stop);
  }, []);

  // The engine lives for the component's lifetime. The initializer function
  // makes useState create it once, not on every render.
  const [sheet] = useState(() => new Sheet(ROWS, COLS));

  // Same pattern as the sheet: created once, mutated in place.
  const [history] = useState(() => new History());

  // `sheet` is mutated in place, so React can't see changes. Bumping this
  // counter forces a re-render after each edit.
  const [, setVersion] = useState(0);

  // Temporary: shows how many cells the last edit recomputed (for testing).
  const [recalculated, setRecalculated] = useState(0);

  const address = toAddress(active);
  const raw = sheet.raw[address] ?? "";

  const range = normalizeRange(active, extent ?? active);
  const stats = rangeStats(range, sheet.values);

  function move(dRow: number, dCol: number) {
    setExtent(null); // moving collapses any range back to one cell
    setActive((p) => ({
      row: clamp(p.row + dRow, ROWS),
      col: clamp(p.col + dCol, COLS),
    }));
  }

  // Shift+arrow: move the far corner, starting from the active cell.
  function extend(dRow: number, dCol: number) {
    setExtent((prev) => {
      const from = prev ?? active;
      return {
        row: clamp(from.row + dRow, ROWS),
        col: clamp(from.col + dCol, COLS),
      };
    });
  }

  // Every user edit goes through here: record it, then apply it.
  function setCell(addr: string, value: string) {
    const before = sheet.raw[addr] ?? "";
    history.record([{ addr, before, after: value }]);
    setRecalculated(sheet.setCell(addr, value));
    setVersion((v) => v + 1);
  }

  // Replays an entry. Undo applies "before" values, redo applies "after".
  function applyChanges(changes: CellChange[], direction: "undo" | "redo") {
    // Undo walks backwards so that if one cell appears twice in an entry
    // (possible with paste), it ends on its original value.
    const ordered = direction === "undo" ? [...changes].reverse() : changes;
    let count = 0;
    for (const c of ordered) {
      count = sheet.setCell(c.addr, direction === "undo" ? c.before : c.after);
    }
    setRecalculated(count);
    setVersion((v) => v + 1);

    setExtent(null); // undo/redo jumps to one cell, so drop any range

    // Move the selection to the changed cell so you can see what happened
    const pos = parseAddress(changes[0].addr);
    if (pos) setActive(pos);
  }

  function undo() {
    const entry = history.undo();
    if (entry) applyChanges(entry, "undo");
  }

  function redo() {
    const entry = history.redo();
    if (entry) applyChanges(entry, "redo");
  }

  function commit() {
    if (draft === null) return;
    setCell(address, draft);
    setDraft(null);
  }

  // The input unmounts when editing ends, so give focus back to the grid
  // or the arrow keys stop working.
  function refocus() {
    rootRef.current?.focus();
  }

  function onGridKeyDown(e: React.KeyboardEvent) {
    // While editing, or when the key was typed in an input (cell editor or
    // formula bar), the input handles it. Otherwise arrows would move the
    // selection instead of the text caret.
    if (draft !== null || e.target instanceof HTMLInputElement) return;

    // Cmd+Z / Ctrl+Z undo, Shift+Cmd+Z / Ctrl+Y redo
    if ((e.metaKey || e.ctrlKey) && !e.altKey) {
      const key = e.key.toLowerCase();
      if (key === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (key === "y") {
        e.preventDefault();
        redo();
        return;
      }
    }

    const nav = NAV_KEYS[e.key];
    if (nav) {
      e.preventDefault(); // stops the page scrolling
      if (e.shiftKey) extend(nav[0], nav[1]);
      else move(nav[0], nav[1]);
    } else if (e.key === "Tab") {
      e.preventDefault();
      move(0, e.shiftKey ? -1 : 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      setEditSource("cell");
      setDraft(raw);
    } else if (e.key === "Backspace" || e.key === "Delete") {
      setCell(address, "");
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      setEditSource("cell");
      setDraft(e.key); // type-to-overwrite: replaces the old content
    }
  }

  function onEditorKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
      move(1, 0);
      refocus();
    } else if (e.key === "Tab") {
      e.preventDefault();
      commit();
      move(0, e.shiftKey ? -1 : 1);
      refocus();
    } else if (e.key === "Escape") {
      setDraft(null);
      refocus();
    }
  }

  return (
    <div
      ref={rootRef}
      tabIndex={0}
      className={styles.root}
      onKeyDown={onGridKeyDown}
      onMouseDown={(e) => {
        // Clicking anywhere else in the grid (a header, empty space) finishes
        // a pending edit. Without this, an edit started in the bar could be
        // left open and the grid would ignore the keyboard.
        if (draft !== null && !(e.target instanceof HTMLInputElement)) commit();
      }}
    >
      <div className={styles.bar}>
        <span className={styles.address}>{address}</span>
        <input
          className={styles.formulaInput}
          value={draft ?? raw}
          onChange={(e) => {
            setEditSource("bar");
            setDraft(e.target.value);
          }}
          onKeyDown={onEditorKeyDown}
          aria-label="Formula bar"
          spellCheck={false}
        />
        <span className={styles.stat}>recalculated: {recalculated}</span>
      </div>
      <table className={styles.grid}>
        <thead>
          <tr>
            <th />
            {Array.from({ length: COLS }, (_, c) => (
              <th key={c}>{colLabel(c)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: ROWS }, (_, r) => (
            <tr key={r}>
              <th>{r + 1}</th>
              {Array.from({ length: COLS }, (_, c) => {
                const isActive = r === active.row && c === active.col;
                const isSelected = !isActive && inRange(range, r, c);
                const value = sheet.values[toAddress({ row: r, col: c })];
                const classes = [
                  isActive ? styles.active : "",
                  isSelected ? styles.inRange : "",
                  isError(value) ? styles.error : "",
                ]
                  .filter(Boolean)
                  .join(" ");

                let content: React.ReactNode = formatValue(value);
                if (isActive && draft !== null) {
                  content =
                    editSource === "cell" ? (
                      <CellEditor
                        value={draft}
                        onChange={setDraft}
                        onKeyDown={onEditorKeyDown}
                      />
                    ) : (
                      draft // editing in the formula bar: preview the text here
                    );
                }

                return (
                  <td
                    key={c}
                    className={classes}
                    onMouseDown={(e) => {
                      // A click inside the open cell editor is just placing the caret
                      if (e.target instanceof HTMLInputElement) return;
                      if (e.shiftKey) {
                        setExtent({ row: r, col: c }); // extend from the active cell
                      } else {
                        setActive({ row: r, col: c });
                        setExtent(null);
                        dragging.current = true; // a drag may follow
                      }
                    }}
                    onMouseEnter={() => {
                      if (dragging.current) setExtent({ row: r, col: c });
                    }}
                  >
                    {content}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>

      <div className={styles.statusBar}>
        <span>{rangeLabel(range)}</span>
        <span>Sum: {stats.count > 0 ? formatValue(stats.sum) : "—"}</span>
        <span>
          Average: {stats.average !== null ? formatValue(stats.average) : "—"}
        </span>
        <span>Count: {stats.count}</span>
      </div>
    </div>
  );
}

function CellEditor({
  value,
  onChange,
  onKeyDown,
}: {
  value: string;
  onChange: (v: string) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);

  // Runs once when the editor appears: focus it, caret at the end.
  useEffect(() => {
    const el = ref.current!;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  return (
    <input
      ref={ref}
      className={styles.editor}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKeyDown}
    />
  );
}
