"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CellPos, colLabel, toAddress } from "@/lib/address";
import styles from "./Grid.module.css";
import { computeAll } from "@/lib/sheet";
import { formatValue, isError } from "@/lib/evaluate";

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
  // Sparse map: only filled cells exist. Keys are addresses like "B7".
  const [cells, setCells] = useState<Record<string, string>>({});
  // Text being typed. null means "not editing".
  const [draft, setDraft] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // Recomputed only when `cells` changes, not on every keystroke in the editor
const values = useMemo(() => computeAll(cells, ROWS, COLS), [cells]);

  const address = toAddress(active);
  const raw = cells[address] ?? "";

  function move(dRow: number, dCol: number) {
    setActive((p) => ({
      row: clamp(p.row + dRow, ROWS),
      col: clamp(p.col + dCol, COLS),
    }));
  }

  function setCell(addr: string, value: string) {
    setCells((prev) => {
      const next = { ...prev };
      if (value === "") delete next[addr];
      else next[addr] = value;
      return next;
    });
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
    if (draft !== null) return; // while editing, the input handles keys

    const nav = NAV_KEYS[e.key];
    if (nav) {
      e.preventDefault(); // stops the page scrolling
      move(nav[0], nav[1]);
    } else if (e.key === "Tab") {
      e.preventDefault();
      move(0, e.shiftKey ? -1 : 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      setDraft(raw);
    } else if (e.key === "Backspace" || e.key === "Delete") {
      setCell(address, "");
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
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
    <div ref={rootRef} tabIndex={0} className={styles.root} onKeyDown={onGridKeyDown}>
      <div className={styles.bar}>
        {address}: {draft ?? raw}
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
  const value = values[toAddress({ row: r, col: c })];
  const classes = [
    isActive ? styles.active : "",
    isError(value) ? styles.error : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <td
      key={c}
      className={classes}
      onClick={() => {
        commit();
        setActive({ row: r, col: c });
      }}
    >
      {isActive && draft !== null ? (
        <CellEditor
          value={draft}
          onChange={setDraft}
          onKeyDown={onEditorKeyDown}
        />
      ) : (
        formatValue(value)
      )}
    </td>
  );
})}
            </tr>
          ))}
        </tbody>
      </table>
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