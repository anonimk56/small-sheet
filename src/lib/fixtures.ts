// Sample sheets. Everything here is deterministic: the same code always
// produces the same cells, so a demo can be walked again after a reset.
// No imports on purpose, so this file has no dependencies at all.

export type Cells = Record<string, string>; // address -> raw text, e.g. "B7": "=A1+2"

export const FIXTURE_NAMES = ["budget", "big", "broken"] as const;
export type FixtureName = (typeof FIXTURE_NAMES)[number];

export function isFixtureName(value: string | undefined): value is FixtureName {
  return FIXTURE_NAMES.some((name) => name === value);
}

export function getFixture(name: FixtureName): Cells {
  if (name === "big") return bigSheet();
  if (name === "broken") return brokenSheet();
  return budgetSheet();
}

// A small seeded random number generator (mulberry32). Same seed, same
// sequence, on every machine. Math.random() can't be seeded, so it isn't used.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 0 -> "A" ... 25 -> "Z". The fixtures use fewer than 26 columns.
const letter = (col: number) => String.fromCharCode(65 + col);
const at = (col: number, row: number) => `${letter(col)}${row}`; // (1, 7) -> "B7"

// ---------------------------------------------------------------------------
// Budget: line items -> subtotals -> section totals -> summary at the TOP.
// Changing an assumption at the bottom moves the figures at the top.
// ---------------------------------------------------------------------------
function budgetSheet(): Cells {
  const cells: Cells = {};
  const put = (col: number, row: number, text: string) => {
    cells[at(col, row)] = text;
  };

  // Plain numbers for the four quarters (columns B to E)
  const plainRow = (row: number, label: string, nums: number[]) => {
    put(0, row, label);
    nums.forEach((n, i) => put(i + 1, row, String(n)));
  };
  // Same, plus a Year column (F) that adds the quarters
  const valueRow = (row: number, label: string, nums: number[]) => {
    plainRow(row, label, nums);
    put(5, row, `=SUM(B${row}:E${row})`);
  };
  // A formula per quarter; f receives the column letter ("B", "C", ...)
  const formulaRow = (
    row: number,
    label: string,
    f: (c: string) => string,
    yearTotal = true,
  ) => {
    put(0, row, label);
    for (let q = 1; q <= 4; q++) put(q, row, "=" + f(letter(q)));
    if (yearTotal) put(5, row, `=SUM(B${row}:E${row})`);
  };

  put(0, 1, "Northwind Studio — 2027 operating budget");
  ["Line item", "Q1", "Q2", "Q3", "Q4", "Year"].forEach((h, c) => put(c, 2, h));

  // Summary: each figure is just a pointer to a total further down
  formulaRow(3, "Net income", (c) => `${c}4-${c}5`);
  formulaRow(4, "Total revenue", (c) => `${c}12`);
  formulaRow(5, "Total expenses", (c) => `${c}26`);
  formulaRow(6, "Margin (net ÷ revenue)", (c) => `${c}3/${c}4`, false);
  put(5, 6, "=F3/F4");

  put(0, 8, "REVENUE");
  formulaRow(9, "Subscriptions", (c) => `${c}29*${c}30*3`);
  valueRow(10, "Services", [48000, 56000, 41000, 63000]);
  valueRow(11, "Other revenue", [4200, 3900, 5100, 4800]);
  formulaRow(12, "Revenue total", (c) => `SUM(${c}9:${c}11)`);

  put(0, 14, "EXPENSES");
  formulaRow(15, "Engineering payroll", (c) => `${c}31*${c}33`);
  formulaRow(16, "Design payroll", (c) => `${c}32*${c}33`);
  formulaRow(17, "Payroll taxes & benefits", (c) => `(${c}15+${c}16)*${c}35`);
  formulaRow(18, "Payroll subtotal", (c) => `SUM(${c}15:${c}17)`);
  formulaRow(19, "Office rent", (c) => `${c}34*3`);
  valueRow(20, "Utilities", [1850, 1800, 1700, 2100]);
  valueRow(21, "Software & tools", [9600, 10200, 11400, 12000]);
  formulaRow(22, "Facilities subtotal", (c) => `SUM(${c}19:${c}21)`);
  valueRow(23, "Advertising", [32000, 41000, 45000, 52000]);
  valueRow(24, "Events", [6500, 0, 14000, 18000]);
  formulaRow(25, "Marketing subtotal", (c) => `SUM(${c}23:${c}24)`);
  formulaRow(26, "Expenses total", (c) => `${c}18+${c}22+${c}25`);

  put(0, 28, "ASSUMPTIONS");
  plainRow(29, "Customers (end of quarter)", [1800, 2050, 2350, 2700]);
  plainRow(30, "Price per customer / month", [49, 49, 52, 52]);
  plainRow(31, "Engineers", [5, 5, 6, 6]);
  plainRow(32, "Designers", [2, 2, 3, 3]);
  plainRow(33, "Loaded cost per head / quarter", [24000, 24000, 25500, 25500]);
  plainRow(34, "Office rent / month", [3800, 3800, 4100, 4100]);
  plainRow(35, "Benefits rate", [0.22, 0.22, 0.22, 0.22]);

  return cells;
}

// ---------------------------------------------------------------------------
// Big: 10,000 rows x 12 columns. Row 1 is headers, rows 2-9999 are orders,
// row 10000 holds the totals. Column L is a formula all the way down.
// ---------------------------------------------------------------------------
const BIG_ROWS = 10_000;

function bigSheet(): Cells {
  const cells: Cells = {};
  const rand = mulberry32(2027);
  const pick = (list: string[]) => list[Math.floor(rand() * list.length)];
  const between = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));
  // Round to cents so the text is "23.45", never "23.450000000000003"
  const money = (min: number, max: number) =>
    String(Math.round((min + rand() * (max - min)) * 100) / 100);

  const headers = [
    "Order", "Region", "Units", "Unit price", "Discount", "Shipping",
    "Unit cost", "Returns", "Days to ship", "Rating", "Tax rate", "Net revenue",
  ];
  headers.forEach((h, c) => (cells[at(c, 1)] = h));

  const regions = ["North", "South", "East", "West"];
  const discounts = ["0", "0.05", "0.1", "0.15"];
  const taxRates = ["0.06", "0.08", "0.1"];

  for (let row = 2; row < BIG_ROWS; row++) {
    cells[at(0, row)] = `ORD-${String(row - 1).padStart(5, "0")}`;
    cells[at(1, row)] = pick(regions);
    cells[at(2, row)] = String(between(1, 50));
    cells[at(3, row)] = money(4, 120);
    cells[at(4, row)] = pick(discounts);
    cells[at(5, row)] = money(0, 25);
    cells[at(6, row)] = money(2, 60);
    cells[at(7, row)] = String(between(0, 3));
    cells[at(8, row)] = String(between(1, 14));
    cells[at(9, row)] = String(between(1, 5));
    cells[at(10, row)] = pick(taxRates);
    // The formula column: units x price, less discount, plus shipping
    cells[at(11, row)] = `=C${row}*D${row}*(1-E${row})+F${row}`;
  }

  // Totals on the last row
  const last = BIG_ROWS;
  cells[at(0, last)] = "TOTAL";
  for (const col of [2, 5, 7, 11]) {
    cells[at(col, last)] = `=SUM(${letter(col)}2:${letter(col)}${last - 1})`;
  }

  return cells;
}

// ---------------------------------------------------------------------------
// Broken: one of everything that can go wrong. Column B is the result,
// column C says what it should show.
// ---------------------------------------------------------------------------
function brokenSheet(): Cells {
  const cells: Cells = {};

  cells[at(0, 1)] = "Broken formulas — nothing here may crash the page";
  cells[at(0, 2)] = "Case";
  cells[at(1, 2)] = "Result";
  cells[at(2, 2)] = "Should show";

  // Rows start at 3. Several formulas point at other rows by number, so
  // keep the order. Comments give the row each case lands on.
  const cases: [string, string, string][] = [
    ["Division by zero", "=10/(5-5)", "#DIV/0!"], // row 3
    ["Refers to itself", "=B4+1", "#CYCLE!"], // row 4
    ["Cycle, first half (needs B6)", "=B6+1", "#CYCLE!"], // row 5
    ["Cycle, second half (needs B5)", "=B5+1", "#CYCLE!"], // row 6
    ["Column that does not exist", "=Z1+1", "#REF!"], // row 7
    ["Row that does not exist", "=A10001*2", "#REF!"], // row 8
    ["Range that leaves the sheet", "=SUM(A1:Z5)", "#REF!"], // row 9
    ["Text used as a number", "=A10+1", "#VALUE!"], // row 10 (A10 is this label)
    ["Function that does not exist", "=MEDIAN(B16)", "#NAME?"], // row 11
    ["Formula that is not valid", "=2+*3", "#ERROR!"], // row 12
    ["Depends on a division by zero", "=B3+100", "#DIV/0!"], // row 13
    ["Depends on a cycle", "=B4*2", "#CYCLE!"], // row 14
    ["Sum that includes B3", "=SUM(B16,B3)", "#DIV/0!"], // row 15
    ["Control: nothing wrong", "=2+2", "4"], // row 16
  ];
  cases.forEach(([label, formula, expected], i) => {
    const row = i + 3;
    cells[at(0, row)] = label;
    cells[at(1, row)] = formula;
    cells[at(2, row)] = expected;
  });

  return cells;
}