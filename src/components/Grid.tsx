"use client";

import { useEffect, useRef, useState } from "react";
import { CellPos, colLabel, parseAddress, toAddress } from "@/lib/address";
import { Sheet } from "@/lib/sheet";
import { formatValue, isError } from "@/lib/evaluate";
import { CellChange, History } from "@/lib/history";
import {
  inRange,
  normalizeRange,
  rangeLabel,
  rangeStats,
} from "@/lib/selection";
import styles from "./Grid.module.css";

const ROWS = 10_000;
const COLS = 12;

// Layout constants, in pixels. Row positions are computed from these, so
// they must match the heights used in the CSS.
const ROW_H = 28; // every body row
const HEADER_H = 28; // the column-letter row
const ROW_HEADER_W = 48; // the row-number column
const DEFAULT_COL_W = 96;
const MIN_COL_W = 40;
const OVERSCAN = 5; // extra rows rendered above and below the visible ones

const NAV_KEYS: Record<string, [number, number]> = {
  ArrowUp: [-1, 0],
  ArrowDown: [1, 0],
  ArrowLeft: [0, -1],
  ArrowRight: [0, 1],
};

const clamp = (value: number, count: number) =>
  Math.max(0, Math.min(count - 1, value));

export default function Grid() {
  // ---- selection ----
  const [active, setActive] = useState<CellPos>({ row: 0, col: 0 });
  // Opposite corner of the selected range. null = just the active cell.
  const [extent, setExtent] = useState<CellPos | null>(null);
  // True while the mouse button is held after pressing on a cell.
  const dragging = useRef(false);

  // ---- editing ----
  // Text being typed. null means "not editing".
  const [draft, setDraft] = useState<string | null>(null);
  // Where the current edit is happening: inside the cell or in the formula bar.
  const [editSource, setEditSource] = useState<"cell" | "bar">("cell");
  const rootRef = useRef<HTMLDivElement>(null);

  // ---- engine (created once, mutated in place) ----
  const [sheet] = useState(() => new Sheet(ROWS, COLS));
  const [history] = useState(() => new History());
  // `sheet` is mutated in place, so React can't see changes. Bumping this
  // counter forces a re-render after each edit.
  const [, setVersion] = useState(0);
  // Temporary: how many cells the last edit recomputed (for testing).
  const [recalculated, setRecalculated] = useState(0);

  // ---- layout ----
  const scrollerRef = useRef<HTMLDivElement>(null);
  // Index of the first row in view. Storing the row (not the pixel offset)
  // means React only re-renders when scrolling crosses a row boundary.
  const [scrollRow, setScrollRow] = useState(0);
  const [viewportH, setViewportH] = useState(600); // replaced by the real height on mount
  const [colWidths, setColWidths] = useState<number[]>(() =>
    Array.from({ length: COLS }, () => DEFAULT_COL_W),
  );
  const [frozen, setFrozen] = useState(false);
  const resizing = useRef<{
    col: number;
    startX: number;
    startWidth: number;
  } | null>(null);

  // The mouse can be released anywhere, even outside the grid, so listen on
  // the whole window. Otherwise a drag could get "stuck on".
  useEffect(() => {
    const stop = () => {
      dragging.current = false;
    };
    window.addEventListener("mouseup", stop);
    return () => window.removeEventListener("mouseup", stop);
  }, []);

  // Keep viewportH equal to the scroll area's real height, including when
  // the window is resized. The observer also fires once on start.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setViewportH(el.clientHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // ---- derived values ----
  const address = toAddress(active);
  const raw = sheet.raw[address] ?? "";
  const range = normalizeRange(active, extent ?? active);
  const stats = rangeStats(range, sheet.values);

  const totalWidth = ROW_HEADER_W + colWidths.reduce((a, b) => a + b, 0);
  const visibleCount = Math.ceil(viewportH / ROW_H);
  const firstRow = Math.max(0, scrollRow - OVERSCAN);
  const lastRow = Math.min(ROWS - 1, scrollRow + visibleCount + OVERSCAN);
  const rowsToRender: number[] = [];
  for (let r = firstRow; r <= lastRow; r++) rowsToRender.push(r);
  // Always keep the active row in the page, even when scrolled far away,
  // so an open cell editor (and its focus) isn't destroyed.
  if (active.row < firstRow || active.row > lastRow) {
    rowsToRender.push(active.row);
  }

  // ---- navigation ----
  function move(dRow: number, dCol: number) {
    const next = {
      row: clamp(active.row + dRow, ROWS),
      col: clamp(active.col + dCol, COLS),
    };
    setActive(next);
    setExtent(null); // moving collapses any range back to one cell
    scrollToCell(next);
  }

  // Shift+arrow: move the far corner, starting from the active cell.
  function extend(dRow: number, dCol: number) {
    const from = extent ?? active;
    const next = {
      row: clamp(from.row + dRow, ROWS),
      col: clamp(from.col + dCol, COLS),
    };
    setExtent(next);
    scrollToCell(next);
  }

  // Scroll the minimum amount needed to bring a cell fully into view,
  // allowing for the sticky header and the sticky left columns.
  function scrollToCell(pos: CellPos) {
    const el = scrollerRef.current;
    if (!el) return;

    // Vertical: row r starts r * ROW_H below the sticky header.
    const rowTop = pos.row * ROW_H;
    const rowBottom = rowTop + ROW_H;
    const bodyHeight = el.clientHeight - HEADER_H;
    if (rowTop < el.scrollTop) el.scrollTop = rowTop;
    else if (rowBottom > el.scrollTop + bodyHeight) {
      el.scrollTop = rowBottom - bodyHeight;
    }

    // Horizontal: the row numbers (and column A when frozen) always cover
    // the left edge, so a cell is only "visible" to the right of them.
    if (frozen && pos.col === 0) return;
    const stuck = ROW_HEADER_W + (frozen ? colWidths[0] : 0);
    let left = ROW_HEADER_W;
    for (let i = 0; i < pos.col; i++) left += colWidths[i];
    const right = left + colWidths[pos.col];
    if (left < el.scrollLeft + stuck) el.scrollLeft = left - stuck;
    else if (right > el.scrollLeft + el.clientWidth) {
      el.scrollLeft = right - el.clientWidth;
    }
  }

  // ---- editing and history ----
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
    if (pos) {
      setActive(pos);
      scrollToCell(pos);
    }
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

  // ---- keyboard ----
  function onGridKeyDown(e: React.KeyboardEvent) {
    // While editing, or when the key was typed in an input (cell editor,
    // formula bar, checkbox), the input handles it.
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
      scrollToCell(active); // the cell may have been scrolled out of view
      setEditSource("cell");
      setDraft(raw);
    } else if (e.key === "Backspace" || e.key === "Delete") {
      setCell(address, "");
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      scrollToCell(active);
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

  // ---- column resizing ----
  // Pointer capture makes the handle keep receiving move events even when
  // the pointer leaves it, so no window-level listeners are needed.
  function onResizeDown(e: React.PointerEvent<HTMLDivElement>, col: number) {
    e.currentTarget.setPointerCapture(e.pointerId);
    resizing.current = {
      col,
      startX: e.clientX,
      startWidth: colWidths[col],
    };
  }

  function onResizeMove(e: React.PointerEvent) {
    const r = resizing.current;
    if (!r) return;
    const width = Math.max(MIN_COL_W, r.startWidth + e.clientX - r.startX);
    setColWidths((prev) => prev.map((w, i) => (i === r.col ? width : w)));
  }

  function onResizeEnd() {
    resizing.current = null;
  }

  // ---- render ----
  return (
    <div
      ref={rootRef}
      tabIndex={0}
      className={styles.root}
      onKeyDown={onGridKeyDown}
      onMouseDown={(e) => {
        // Clicking anywhere else in the grid (a header, empty space) finishes
        // a pending edit.
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
        <label className={styles.toggle}>
          <input
            type="checkbox"
            checked={frozen}
            onChange={(e) => {
              setFrozen(e.target.checked);
              refocus(); // so the arrow keys keep working
            }}
          />
          Freeze column A
        </label>
        <span className={styles.stat}>recalculated: {recalculated}</span>
      </div>

      <div
        ref={scrollerRef}
        className={styles.scroller}
        onScroll={(e) =>
          setScrollRow(Math.floor(e.currentTarget.scrollTop / ROW_H))
        }
      >
        {/* The sizer is as big as the whole 10,000-row grid; that is what
            gives the scrollbar its real length. */}
        <div
          className={styles.sizer}
          style={{ width: totalWidth, height: HEADER_H + ROWS * ROW_H }}
        >
          <div className={styles.headerRow} style={{ height: HEADER_H }}>
            <div className={styles.corner} style={{ width: ROW_HEADER_W }} />
            {colWidths.map((w, c) => {
              const isFrozen = frozen && c === 0;
              return (
                <div
                  key={c}
                  className={`${styles.colHeader} ${isFrozen ? styles.frozenCol : ""}`}
                  style={isFrozen ? { width: w, left: ROW_HEADER_W } : { width: w }}
                >
                  {colLabel(c)}
                  <div
                    className={styles.resizeHandle}
                    onPointerDown={(e) => onResizeDown(e, c)}
                    onPointerMove={onResizeMove}
                    onPointerUp={onResizeEnd}
                    onPointerCancel={onResizeEnd}
                  />
                </div>
              );
            })}
          </div>

          {rowsToRender.map((r) => (
            <div
              key={r}
              className={styles.row}
              style={{
                top: HEADER_H + r * ROW_H,
                height: ROW_H,
                width: totalWidth,
              }}
            >
              <div className={styles.rowHeader} style={{ width: ROW_HEADER_W }}>
                {r + 1}
              </div>
              {colWidths.map((w, c) => {
                const isActive = r === active.row && c === active.col;
                const isSelected = !isActive && inRange(range, r, c);
                const isFrozen = frozen && c === 0;
                const value = sheet.values[toAddress({ row: r, col: c })];
                const classes = [
                  styles.cell,
                  isFrozen ? styles.frozenCol : "",
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
                  <div
                    key={c}
                    className={classes}
                    style={
                      isFrozen ? { width: w, left: ROW_HEADER_W } : { width: w }
                    }
                    onMouseDown={(e) => {
                      // A click inside the open cell editor just places the caret
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
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>

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
  // preventScroll: the grid does its own scrolling (the browser doesn't
  // know about the sticky headers and could park the cell underneath them).
  useEffect(() => {
    const el = ref.current!;
    el.focus({ preventScroll: true });
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