"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import type { SaveInfo } from "@/lib/saver";
import { MAX_NAME_CHARS, SheetMeta } from "@/lib/sheet-meta";
import styles from "./SheetTabs.module.css";

type Props = {
  sheets: SheetMeta[];
  activeId: string;
  saves: Record<string, SaveInfo>; // save status per sheet, for the tab dots
  notice: string | null;
  onAdd: () => void;
  onRename: (id: string, name: string) => void;
};

export default function SheetTabs({
  sheets,
  activeId,
  saves,
  notice,
  onAdd,
  onRename,
}: Props) {
  // Which tab is being renamed (null = none) and the text typed so far
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  // Set as soon as Enter or Escape decides the outcome, so the blur event
  // that can follow when the input disappears doesn't act a second time.
  const settled = useRef(false);

  function startEdit(sheet: SheetMeta) {
    settled.current = false;
    setDraft(sheet.name);
    setEditingId(sheet.id);
  }

  function finish(sheet: SheetMeta, save: boolean) {
    if (settled.current) return;
    settled.current = true;
    setEditingId(null);
    const name = draft.trim();
    if (save && name !== "" && name !== sheet.name) onRename(sheet.id, name);
  }

  return (
    <nav className={styles.tabs} aria-label="Sheets">
      <div className={styles.list}>
        {sheets.map((sheet) => {
          if (editingId === sheet.id) {
            return (
              <input
                key={sheet.id}
                className={styles.rename}
                value={draft}
                maxLength={MAX_NAME_CHARS}
                autoFocus
                onFocus={(e) => e.currentTarget.select()}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    finish(sheet, true);
                  } else if (e.key === "Escape") {
                    finish(sheet, false);
                  }
                }}
                onBlur={() => finish(sheet, true)}
                aria-label={`Rename ${sheet.name}`}
              />
            );
          }
          const status = saves[sheet.id]?.status;
          return (
            <Link
              key={sheet.id}
              href={`/sheets/${sheet.id}`}
              className={styles.tab}
              aria-current={sheet.id === activeId ? "page" : undefined}
              title="Double-click or press F2 to rename"
              onDoubleClick={() => startEdit(sheet)}
              onKeyDown={(e) => {
                if (e.key === "F2") {
                  e.preventDefault();
                  startEdit(sheet);
                }
              }}
            >
              {sheet.name}
              {status && status !== "saved" && (
                <span
                  className={`${styles.dot} ${styles[status]}`}
                  title={status === "saving" ? "Saving…" : "Couldn’t save"}
                />
              )}
            </Link>
          );
        })}
      </div>
      <button className={styles.add} onClick={onAdd} aria-label="Add sheet">
        +
      </button>
      {notice && (
        <span className={styles.notice} role="alert">
          {notice}
        </span>
      )}
    </nav>
  );
}