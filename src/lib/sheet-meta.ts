// What the tab bar knows about a sheet, plus limits shared by the server
// (which enforces them) and the browser (which respects them).
export type SheetMeta = { id: string; name: string };

export const MAX_SHEETS = 20;
export const MAX_NAME_CHARS = 40;