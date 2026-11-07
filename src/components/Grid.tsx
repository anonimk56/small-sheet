"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CellPos, colLabel, parseAddress, toAddress } from "@/lib/address";
import { formatValue, isError } from "@/lib/evaluate";
import { COLS, ROWS } from "@/lib/grid-size";
import type { CellChange } from "@/lib/history";
import type { SaveInfo } from "@/lib/saver";
import {
  inRange,
  normalizeRange,
  rangeLabel,
  rangeStats,
} from "@/lib/selection";
import type { SheetDoc } from "@/lib/sheet-doc";
import styles from "./Grid.module.css";
import {
  copyRange,
  describePaste,
  planClear,
  planPaste,
  rememberCopy,
} from "@/lib/clipboard";

// Layout constants, in pixels. Row positions are computed from these, so
// they must match the heights used in the CSS.
const ROW_H = 28; // every body row
const HEADER_H = 28; // the column-letter row
const ROW_HEADER_W = 48; // the row-number column
const MIN_AUTO_COL_W = 96; // narrowest a column gets when columns share the width
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

// "B7" -> a position, or null if it isn't a real cell of this sheet.
function cellFromText(text: string | null): CellPos | null {
  if (!text) return null;
  const pos = parseAddress(text.trim().toUpperCase());
  return pos && pos.row < ROWS && pos.col < COLS ? pos : null;
}

// Where to start: the cell in the URL (?cell=B7), else where this sheet was
// last time, else A1.
function initialCell(doc: SheetDoc): CellPos {
  if (typeof window === "undefined") return { row: 0, col: 0 };
  const fromUrl = new URLSearchParams(window.location.search).get("cell");
  return (
    cellFromText(fromUrl) ?? cellFromText(doc.lastCell) ?? { row: 0, col: 0 }
  );
}

export default function Grid({ doc, save }: { doc: SheetDoc; save: SaveInfo }) {
  // The sheet's data, undo history and saver outlive this component (they
  // belong to the tab, not the screen), so they come in from outside.
  const { sheet, history, saver } = doc;

  // ---- selection ----
  const [active, setActive] = useState<CellPos>(() => initialCell(doc));
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

  // `sheet` is mutated in place, so React can't see changes. Bumping this
  // counter forces a re-render after each edit.
  const [version, setVersion] = useState(0);
  // Temporary: how many cells the last edit recomputed (for testing).
  const [recalculated, setRecalculated] = useState(0);

    // A short note about what Copy or Paste just did (or why it refused)
    const [message, setMessage] = useState<{ text: string; kind: "info" | "error" } | null>(null);

  // ---- layout ----
  const scrollerRef = useRef<HTMLDivElement>(null);
  // Index of the first row in view. Storing the row (not the pixel offset)
  // means React only re-renders when scrolling crosses a row boundary.
  const [scrollRow, setScrollRow] = useState(0);
  const [viewportH, setViewportH] = useState(600); // replaced by the real height on mount
  const [viewportW, setViewportW] = useState(1200); // replaced by the real width on mount
  // null = "share the available width"; a number = the user dragged this column
  const [userWidths, setUserWidths] = useState<(number | null)[]>(() =>
    Array.from({ length: COLS }, () => null)
  );
  // Go-to-cell box: the text being typed (null = not editing) and whether it is invalid
  const [addressDraft, setAddressDraft] = useState<string | null>(null);
  const [addressInvalid, setAddressInvalid] = useState(false);
  const addressRef = useRef<HTMLInputElement>(null);

  const formulaRef = useRef<HTMLInputElement>(null);

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

  // Keep viewportH/viewportW equal to the scroll area's real size, including
  // when the window is resized. The observer also fires once on start.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      setViewportH(el.clientHeight);
      setViewportW(el.clientWidth); // clientWidth excludes the vertical scrollbar
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Information fades away on its own. An error stays until it is dismissed:
  // a refused paste must never be something you could have missed.
  useEffect(() => {
    if (!message || message.kind === "error") return;
    const timer = setTimeout(() => setMessage(null), 6000);
    return () => clearTimeout(timer);
  }, [message]);

  // ---- derived values ----
  const address = toAddress(active);
  const raw = sheet.raw[address] ?? "";
  const range = normalizeRange(active, extent ?? active);
  // Recomputed only when the selection or the data changes, not on every
  // scroll. With a huge selection the loop is too long to run per render.
  const { r1, c1, r2, c2 } = range;
  const stats = useMemo(
    () => rangeStats({ r1, c1, r2, c2 }, sheet.values),
    // `sheet` is mutated in place, so `version` is what signals a data change
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [r1, c1, r2, c2, sheet, version]
  );

  // Columns share the space left of the row numbers, but never get narrower
  // than the minimum. A column the user dragged keeps its own width.
  const autoWidth = Math.max(
    MIN_AUTO_COL_W,
    Math.floor((viewportW - ROW_HEADER_W) / COLS)
  );
  const colWidths = userWidths.map((w) => w ?? autoWidth);

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

    // What a screen reader says when the active cell changes: "B7, 42" or
  // "B9, 2442900, formula =SUM(C9:F9)" or "A1, empty".
  const activeValue = sheet.values[address];
  const announcement = `${address}, ${formatValue(activeValue) || "empty"}${
    raw.startsWith("=") ? `, formula ${raw}` : ""
  }${isError(activeValue) ? ", error" : ""}`;

  // Cheap emptiness test (stops at the first key instead of counting them all)
  let isEmpty = true;
  for (const key in sheet.raw) {
    if (key) {
      isEmpty = false;
      break;
    }
  }

  // ---- the URL says which cell ----
  // Keep the address bar (and this sheet's remembered position) in step with
  // the selection. replaceState swaps the current history entry instead of
  // adding one, so ordinary moving around doesn't fill up the Back button.
  useEffect(() => {
    doc.rememberCell(address);
    const url = new URL(window.location.href);
    if (url.searchParams.get("cell") === address) return;
    url.searchParams.set("cell", address);
    window.history.replaceState(null, "", url);
  }, [address, doc]);

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
  // center=true is for big jumps (go-to-cell): the target lands mid-screen
  // instead of hugging the bottom edge.
  function scrollToCell(pos: CellPos, center = false) {
    const el = scrollerRef.current;
    if (!el) return;

    // Vertical: row r starts r * ROW_H below the sticky header.
    const rowTop = pos.row * ROW_H;
    const rowBottom = rowTop + ROW_H;
    const bodyHeight = el.clientHeight - HEADER_H;
    if (center) {
      el.scrollTop = Math.max(0, rowTop - (bodyHeight - ROW_H) / 2);
    } else if (rowTop < el.scrollTop) {
      el.scrollTop = rowTop;
    } else if (rowBottom > el.scrollTop + bodyHeight) {
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

  // The popstate and mount effects below call scrollToCell from a closure that
  // would go stale, so they go through a ref that always holds the latest one.
  const scrollToCellRef = useRef(scrollToCell);
  useEffect(() => {
    scrollToCellRef.current = scrollToCell;
  });

  useEffect(() => {
    scrollToCellRef.current(active, true);
    // Take the keyboard, so typing and pasting work straight away, but never
    // from a text field the person is already using.
    const focused = document.activeElement;
    if (!focused || focused === document.body || focused.tagName === "A") {
      rootRef.current?.focus({ preventScroll: true });
    }
    // Only on mount: later moves scroll themselves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Back/Forward within this sheet: follow the cell in the URL.
  useEffect(() => {
    const onPop = () => {
      const pos = cellFromText(
        new URLSearchParams(window.location.search).get("cell")
      );
      if (!pos) return;
      setActive(pos);
      setExtent(null);
      scrollToCellRef.current(pos, true);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // ---- editing and history ----
  // Every user edit goes through here: record it, apply it, queue it for saving.
  function setCell(addr: string, value: string) {
    const before = sheet.raw[addr] ?? "";
    if (value === before) return; // nothing changed, so nothing to record or save
    history.record([{ addr, before, after: value }]);
    setRecalculated(sheet.setCell(addr, value));
    saver.markDirty([[addr, value]]);
    setVersion((v) => v + 1);
  }

  // One user action that changes many cells (paste, clear a range): ONE undo
  // step, ONE recalculation, ONE save request, however many cells it touches.
  function applyBatch(changes: CellChange[]) {
    if (changes.length === 0) return;
    history.record(changes);
    const edits = changes.map((c): [string, string] => [c.addr, c.after]);
    setRecalculated(sheet.setMany(edits));
    saver.markDirty(edits);
    setVersion((v) => v + 1);
  }

  // Replays an entry. Undo applies "before" values, redo applies "after".
  function applyChanges(changes: CellChange[], direction: "undo" | "redo") {
    // Undo walks backwards so that if one cell appears twice in an entry,
    // it ends on its original value.
    const ordered = direction === "undo" ? [...changes].reverse() : changes;
    const edits = ordered.map((c): [string, string] => [
      c.addr,
      direction === "undo" ? c.before : c.after,
    ]);
    setRecalculated(sheet.setMany(edits)); // one pass, even for a 50,000-cell paste
    saver.markDirty(edits); // undo and redo are edits too and must be saved
    setVersion((v) => v + 1);
    setExtent(null); // undo/redo jumps to one cell, so drop any range
    // Move the selection to the changed cell so you can see what happened
    const pos = parseAddress(changes[0].addr);
    if (pos) {
      setActive(pos);
      scrollToCell(pos);
    }
  }

  // ---- copy and paste ----
  // These listen on the whole document, so they work wherever focus happens
  // to be (a button, a tab, nothing at all), except inside a text field,
  // where the browser copies and pastes text as usual.
  function onCopy(e: ClipboardEvent) {
    if (!e.clipboardData) return;
    e.preventDefault();
    const copied = copyRange(range, sheet.raw, sheet.values);
    e.clipboardData.setData("text/plain", copied.text);
    rememberCopy(copied); // so pasting here again keeps formulas
    const n = (r2 - r1 + 1) * (c2 - c1 + 1);
    setMessage({
      kind: "info",
      text: `Copied ${n.toLocaleString("en-US")} cell${n === 1 ? "" : "s"}`,
    });
  }

  function onPaste(e: ClipboardEvent) {
    if (!e.clipboardData) return;
    e.preventDefault();
    // Plain text only. Never "text/html": that is how a web page's markup
    // would get in, and nothing here would ever need it.
    const plan = planPaste(e.clipboardData.getData("text/plain"), range, sheet.raw);
    if (!plan.ok) {
      setMessage({ kind: "error", text: plan.error }); // refused: nothing changed
      return;
    }
    applyBatch(plan.changes);
    // Select what was pasted, like other spreadsheets do
    const { area } = plan;
    setActive({ row: area.r1, col: area.c1 });
    setExtent(
      area.r1 === area.r2 && area.c1 === area.c2
        ? null
        : { row: area.r2, col: area.c2 },
    );
    scrollToCell({ row: area.r1, col: area.c1 });
    setMessage({ kind: "info", text: describePaste(plan) });
  }

  // The listeners are added once, so they call through a ref that always
  // holds this render's versions (which know the current selection).
  const clipboardRef = useRef({ copy: onCopy, paste: onPaste });
  useEffect(() => {
    clipboardRef.current = { copy: onCopy, paste: onPaste };
  });
  useEffect(() => {
    const inTextField = (target: EventTarget | null) =>
      target instanceof Element &&
      target.closest("input, textarea, select, [contenteditable]") !== null;
    const copy = (e: ClipboardEvent) => {
      if (!inTextField(e.target)) clipboardRef.current.copy(e);
    };
    const paste = (e: ClipboardEvent) => {
      if (!inTextField(e.target)) clipboardRef.current.paste(e);
    };
    document.addEventListener("copy", copy);
    document.addEventListener("paste", paste);
    return () => {
      document.removeEventListener("copy", copy);
      document.removeEventListener("paste", paste);
    };
  }, []);

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
    rootRef.current?.focus({ preventScroll: true });
  }

  // Go-to-cell: "b7", "A9000"... Invalid input keeps the text and shows an error.
  function goTo(text: string) {
    const pos = cellFromText(text);
    if (pos) {
      if (toAddress(pos) !== address) {
        // A jump is a place worth coming back to: give it its own history
        // entry, so Back returns to the cell we left.
        const url = new URL(window.location.href);
        url.searchParams.set("cell", toAddress(pos));
        window.history.pushState(null, "", url);
      }
      setActive(pos);
      setExtent(null);
      scrollToCell(pos, true);
      setAddressDraft(null);
      setAddressInvalid(false);
      refocus();
    } else {
      setAddressInvalid(true);
    }
  }

  // ---- keyboard ----
  function onGridKeyDown(e: React.KeyboardEvent) {
    // Only handle keys while the grid itself has focus. Keys typed in an
    // input (cell editor, formula bar, go-to box) or on a button belong to it.
    if (draft !== null || e.target !== e.currentTarget) return;

        // F6: jump to the formula bar (Tab moves between cells, so it can't be
    // used to leave the grid). Escape in the bar comes back here.
    if (e.key === "F6") {
      e.preventDefault();
      formulaRef.current?.focus();
      return;
    }

    // Cmd+Z / Ctrl+Z undo, Shift+Cmd+Z / Ctrl+Y redo
    if ((e.metaKey || e.ctrlKey) && !e.altKey) {
      const key = e.key.toLowerCase();
      if (key === "g") {
        e.preventDefault(); // also stops the browser's "find next"
        addressRef.current?.focus();
        return;
      }
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
      applyBatch(planClear(range, sheet.raw)); // the whole selection, one undo step
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
    setUserWidths((prev) => prev.map((w, i) => (i === r.col ? width : w)));
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
      role="application"
      aria-roledescription="spreadsheet"
      aria-label="Spreadsheet"
      onMouseDown={(e) => {
        // Clicking anywhere else in the grid (a header, empty space) finishes
        // a pending edit.
        if (draft !== null && !(e.target instanceof HTMLInputElement)) commit();
      }}
    >
            {/* Read out by screen readers each time the active cell changes */}
            <div className={styles.srOnly} aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
      <div className={styles.bar}>
        <input
          ref={addressRef}
          className={`${styles.address} ${
            addressInvalid ? styles.addressInvalid : ""
          }`}
          value={addressDraft ?? address}
          onChange={(e) => {
            setAddressDraft(e.target.value);
            setAddressInvalid(false);
          }}
          onFocus={(e) => {
            commit(); // finish a pending cell edit first, so it lands in the right cell
            setAddressDraft(address);
            const el = e.currentTarget;
            requestAnimationFrame(() => el.select()); // survives the mouse-up that follows a click
          }}
          onBlur={() => {
            setAddressDraft(null); // clicking away cancels
            setAddressInvalid(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              goTo(addressDraft ?? address);
            } else if (e.key === "Escape") {
              setAddressDraft(null);
              setAddressInvalid(false);
              refocus();
            }
          }}
          aria-label="Go to cell"
          aria-invalid={addressInvalid}
          spellCheck={false}
          autoComplete="off"
        />
        <input
          className={styles.formulaInput}
          ref={formulaRef}
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
        <span
          className={`${styles.saveState} ${styles[save.status]}`}
          role="status"
        >
          {save.status === "saved" && "All changes saved"}
          {save.status === "saving" && "Saving…"}
          {save.status === "failed" &&
            `Couldn’t save ${save.pending} change${
              save.pending === 1 ? "" : "s"
            }`}
        </span>
        {save.status === "failed" && (
          <button
            className={styles.retry}
            onClick={() => {
              saver.retryNow();
              refocus(); // so the arrow keys keep working
            }}
          >
            Retry now
          </button>
        )}
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
                  className={`${styles.colHeader} ${
                    isFrozen ? styles.frozenCol : ""
                  }`}
                  style={
                    isFrozen ? { width: w, left: ROW_HEADER_W } : { width: w }
                  }
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
                const cellAddr = toAddress({ row: r, col: c });
                const value = sheet.values[cellAddr];
                const classes = [
                  styles.cell,
                  isFrozen ? styles.frozenCol : "",
                  isActive ? styles.active : "",
                  isActive && draft !== null ? styles.editing : "",
                  isSelected ? styles.inRange : "",
                  sheet.raw[cellAddr]?.startsWith("=") ? styles.computed : "",
                  typeof value === "number" ? styles.number : "",
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
                        refocus(); // the grid owns the keyboard from here on
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
        <span>
          Count: {stats.count}
          </span>
      </div>

      {isEmpty && (
        <div className={styles.emptyHint}>
          <strong>This sheet is empty</strong>
          Select a cell and start typing, or paste a block from another app.
        </div>
      )}

      {message && (
        <div
          className={`${styles.toast} ${message.kind === "error" ? styles.toastError : ""}`}
          role={message.kind === "error" ? "alert" : "status"}
        >
          <span>{message.text}</span>
          <button
            className={styles.toastClose}
            onClick={() => setMessage(null)}
            aria-label="Dismiss message"
          >
            ×
          </button>
        </div>
      )}
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
