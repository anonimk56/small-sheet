// Client-side autosave. Plain TypeScript, no React.
//
// It remembers every cell edited since the last CONFIRMED save (`dirty`).
// Nothing leaves that list until the server says OK, so a failed save
// loses nothing: the same cells are simply sent again.

export type SaveStatus = "saved" | "saving" | "failed";
export type SaveInfo = { status: SaveStatus; pending: number };

const DEBOUNCE_MS = 600; // wait this long after the last edit before saving
const RETRY_BASE_MS = 3000; // first automatic retry; doubles, up to 8x
const REQUEST_TIMEOUT_MS = 10_000;

export class Saver {
  // address -> raw text ("" = cleared), for edits the server hasn't confirmed
  private dirty = new Map<string, string>();
  private inFlight = false;
  private failures = 0; // consecutive failed attempts
  private status: SaveStatus = "saved";
  private timer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<(info: SaveInfo) => void>();

  constructor(private sheetId: string) {}

  get pending(): number {
    return this.dirty.size;
  }

  get info(): SaveInfo {
    return { status: this.status, pending: this.dirty.size };
  }

  // Listen for status changes. Returns a function that stops listening.
  subscribe(listener: (info: SaveInfo) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // Call after every edit, undo or redo.
  markDirty(changes: Iterable<[string, string]>) {
    for (const [addr, value] of changes) this.dirty.set(addr, value);
    if (this.status === "saved") this.setStatus("saving");
    // While failed, a retry is already counting down; don't hammer the server
    if (this.status !== "failed") this.schedule(DEBOUNCE_MS);
    this.notify();
  }

  retryNow() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    void this.flush();
  }

  private schedule(delay: number) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), delay);
  }

  private notify() {
    const info = this.info;
    for (const listener of this.listeners) listener(info);
  }

  private setStatus(status: SaveStatus) {
    this.status = status;
    this.notify();
  }

  private async flush() {
    this.timer = null;
    // One request at a time. Edits made meanwhile go out in the next one.
    if (this.inFlight || this.dirty.size === 0) return;
    this.inFlight = true;
    const sent = new Map(this.dirty); // a snapshot of what this request carries
    this.setStatus("saving");

    try {
      const res = await fetch(`/api/sheets/${encodeURIComponent(this.sheetId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ changes: Object.fromEntries(sent) }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Forget what was saved, but only if the cell still holds the value we
      // sent. If it was edited again while the request was in the air, it
      // stays dirty and goes out in the next request.
      for (const [addr, value] of sent) {
        if (this.dirty.get(addr) === value) this.dirty.delete(addr);
      }
      this.failures = 0;
    } catch {
      this.failures++;
    }
    this.inFlight = false;

    if (this.failures > 0) {
      this.setStatus("failed");
      this.schedule(RETRY_BASE_MS * 2 ** Math.min(this.failures - 1, 3));
    } else if (this.dirty.size > 0) {
      this.schedule(0); // more edits arrived during the request
    } else {
      this.setStatus("saved");
    }
  }
}