import { NextResponse } from "next/server";
import { createSheet, listSheets } from "@/lib/store";

export const dynamic = "force-dynamic"; // never cache the list

// GET /api/sheets -> { sheets: [{ id, name }, ...] }
export async function GET() {
  return NextResponse.json({ sheets: await listSheets() });
}

// POST /api/sheets -> { sheet: { id, name } }   (creates an empty sheet)
export async function POST() {
  const sheet = await createSheet();
  if (!sheet) {
    return NextResponse.json({ error: "Too many sheets" }, { status: 409 });
  }
  return NextResponse.json({ sheet }, { status: 201 });
}