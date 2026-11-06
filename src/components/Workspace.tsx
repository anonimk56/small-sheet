"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { Cells } from "@/lib/fixtures";
import type { SaveInfo } from "@/lib/saver";
import { SheetDoc } from "@/lib/sheet-doc";
import type { SheetMeta } from "@/lib/sheet-meta";
import Grid from "./Grid";
import SheetTabs from "./SheetTabs";
import styles from "./Workspace.module.css";

type LoadState =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "notFound" }
  | { kind: "error" };

// Lives in the /sheets layout, so it keeps every sheet you have opened in
// memory while you move between tabs: instant switching, undo history kept,
// and a save that is still retrying never loses its edits.
export default function Workspace({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { id = "" } = useParams<{ id: string }>(); // the current sheet, from the URL

  const [sheets, setSheets] = useState<SheetMeta[] | null>(null); // the tab list
  const [docs] = useState(() => new Map<string, SheetDoc>()); // opened sheets
  const [loads, setLoads] = useState<Record<string, LoadState>>({});
  const [saves, setSaves] = useState<Record<string, SaveInfo>>({});
  const [attempt, setAttempt] = useState(0); // bumped by "Try again"
  const [notice, setNotice] = useState<string | null>(null);

  // Load the tab list once
  useEffect(() => {
    const controller = new AbortController();
    async function loadList() {
      try {
        const res = await fetch("/api/sheets", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { sheets: SheetMeta[] };
        setSheets(body.sheets);
      } catch {
        if (!controller.signal.aborted) setNotice("Couldn’t load the list of sheets.");
      }
    }
    void loadList();
    return () => controller.abort();
  }, []);

  // Open the sheet named in the URL, unless it is already open
  useEffect(() => {
    if (!id || docs.has(id)) return;
    const controller = new AbortController();

    async function load() {
      try {
        const res = await fetch(`/api/sheets/${encodeURIComponent(id)}`, {
          cache: "no-store", // always ask the server, never a cached copy
          signal: controller.signal,
        });
        if (res.status === 404) {
          setLoads((prev) => ({ ...prev, [id]: { kind: "notFound" } }));
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { cells: Cells };
        const doc = new SheetDoc(id, body.cells);
        doc.saver.subscribe((info) => setSaves((prev) => ({ ...prev, [id]: info })));
        docs.set(id, doc);
        setLoads((prev) => ({ ...prev, [id]: { kind: "ready" } }));
      } catch {
        // An aborted request just means this effect was replaced or cleaned up
        if (!controller.signal.aborted) {
          setLoads((prev) => ({ ...prev, [id]: { kind: "error" } }));
        }
      }
    }

    void load();
    return () => controller.abort();
  }, [id, attempt, docs]);

  // Warn before closing or reloading while ANY sheet has unsaved edits.
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      for (const doc of docs.values()) {
        if (doc.saver.pending > 0) {
          e.preventDefault();
          return;
        }
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [docs]);

  async function addSheet() {
    try {
      const res = await fetch("/api/sheets", { method: "POST" });
      if (res.status === 409) {
        setNotice("A workbook can have at most 20 sheets.");
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { sheet: SheetMeta };
      setSheets((list) => [...(list ?? []), body.sheet]);
      setNotice(null);
      router.push(`/sheets/${body.sheet.id}`);
    } catch {
      setNotice("Couldn’t add a sheet.");
    }
  }

  async function renameSheet(sheetId: string, name: string) {
    const previous = sheets?.find((s) => s.id === sheetId)?.name;
    // Show the new name straight away; put the old one back if the save fails
    setSheets((list) => list?.map((s) => (s.id === sheetId ? { ...s, name } : s)) ?? null);
    try {
      const res = await fetch(`/api/sheets/${encodeURIComponent(sheetId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setNotice(null);
    } catch {
      if (previous !== undefined) {
        setSheets(
          (list) =>
            list?.map((s) => (s.id === sheetId ? { ...s, name: previous } : s)) ?? null,
        );
      }
      setNotice("Couldn’t rename the sheet.");
    }
  }

  const doc = docs.get(id);
  const load = loads[id];

  let body: React.ReactNode;
  if (doc) {
    // key: a new sheet gets a fresh grid (its own scroll position and selection)
    body = <Grid key={id} doc={doc} save={saves[id] ?? doc.saver.info} />;
  } else if (load?.kind === "notFound") {
    body = (
      <div className={styles.notice}>
        <p>There is no sheet called “{id}”.</p>
        <p>
          {sheets?.map((s) => (
            <Link key={s.id} href={`/sheets/${s.id}`}>
              {s.name}
            </Link>
          ))}
        </p>
      </div>
    );
  } else if (load?.kind === "error") {
    body = (
      <div className={styles.notice}>
        <p>Couldn’t load this sheet.</p>
        <button
          className={styles.button}
          onClick={() => {
            setLoads((prev) => ({ ...prev, [id]: { kind: "loading" } }));
            setAttempt((a) => a + 1);
          }}
        >
          Try again
        </button>
      </div>
    );
  } else {
    body = (
      <div className={styles.notice} role="status">
        Loading sheet…
      </div>
    );
  }

  return (
    <div className={styles.workspace}>
      <div className={styles.body}>{body}</div>
      {sheets && (
        <SheetTabs
          sheets={sheets}
          activeId={id}
          saves={saves}
          notice={notice}
          onAdd={addSheet}
          onRename={renameSheet}
        />
      )}
      {children}
    </div>
  );
}