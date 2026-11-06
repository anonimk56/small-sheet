import { COLS, ROWS } from "./grid-size";
import { History } from "./history";
import { Saver } from "./saver";
import { Sheet } from "./sheet";

// Everything that belongs to one open sheet and has to survive switching
// tabs: its data, its undo history and its pending saves. The grid on screen
// is just a window onto one of these.
export class SheetDoc {
  readonly sheet = new Sheet(ROWS, COLS);
  readonly history = new History();
  readonly saver: Saver;
  // Where the cursor was last time, so coming back to the tab restores it
  lastCell: string | null = null;

  constructor(
    readonly id: string,
    cells: Record<string, string>,
  ) {
    this.sheet.load(cells);
    this.saver = new Saver(id);
  }

  rememberCell(addr: string) {
    this.lastCell = addr;
  }
}