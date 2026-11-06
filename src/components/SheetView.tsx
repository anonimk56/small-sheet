"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Cells, FIXTURE_NAMES } from "@/lib/fixtures";
import Grid from "./Grid";
import styles from "./SheetView.module.css";

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; cells: Cells }
  | { kind: "notFound" }
  | { kind: "error" };

// Loads a sheet from the API, then hands it to the grid.
export default function SheetView({ id }: { id: string }) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  // Bumped by the "Try again" button to run the fetch again
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();

    async function load() {
      try {
        const res = await fetch(`/api/sheets/${encodeURIComponent(id)}`, {
          cache: "no-store", // always ask the server, never a cached copy
          signal: controller.signal,
        });
        if (res.status === 404) {
          setState({ kind: "notFound" });
        } else if (!res.ok) {
          setState({ kind: "error" });
        } else {
          const body = (await res.json()) as { cells: Cells };
          setState({ kind: "ready", cells: body.cells });
        }
      } catch {
        // An aborted request just means this effect was replaced or cleaned up
        if (!controller.signal.aborted) setState({ kind: "error" });
      }
    }

    void load();
    return () => controller.abort();
  }, [id, attempt]);

  if (state.kind === "ready") {
    return <Grid sheetId={id} initialCells={state.cells} />;
  }

  if (state.kind === "loading") {
    return (
      <div className={styles.notice} role="status">
        Loading sheet…
      </div>
    );
  }

  if (state.kind === "notFound") {
    return (
      <div className={styles.notice}>
        <p>There is no sheet called “{id}”.</p>
        <p>
          Try:
          {FIXTURE_NAMES.map((name) => (
            <Link key={name} href={`/?fixture=${name}`}>
              {name}
            </Link>
          ))}
        </p>
      </div>
    );
  }

  return (
    <div className={styles.notice}>
      <p>Couldn’t load this sheet.</p>
      <button
        className={styles.button}
        onClick={() => {
          setState({ kind: "loading" });
          setAttempt((a) => a + 1);
        }}
      >
        Try again
      </button>
    </div>
  );
}