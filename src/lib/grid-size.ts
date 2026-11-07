// The sheet's dimensions, shared by the grid (browser) and the server.
export const ROWS = 10_000;
export const COLS = 12;

// The longest text one cell may hold. The server rejects longer values and
// the browser refuses to paste them.
export const MAX_CELL_CHARS = 2000;