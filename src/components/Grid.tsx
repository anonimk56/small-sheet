"use client";

import { useState } from "react";
import styles from "./Grid.module.css";

const ROWS = 20;
const COLS = 10;

function colLabel(index: number): string {
  return String.fromCharCode(65 + index); // 0 -> "A", 1 -> "B"
}

export default function Grid() {
  const [active, setActive] = useState({ row: 0, col: 0 });

  return (
    <div>
      <div className={styles.bar}>
        {colLabel(active.col)}
        {active.row + 1}
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
              {Array.from({ length: COLS }, (_, c) => (
                <td
                  key={c}
                  className={
                    r === active.row && c === active.col ? styles.active : undefined
                  }
                  onClick={() => setActive({ row: r, col: c })}
                />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}