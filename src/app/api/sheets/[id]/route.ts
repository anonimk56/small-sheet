import { NextResponse } from "next/server";
import {
  applyChanges,
  parseChanges,
  parseName,
  readSheet,
  renameSheet,
} from "@/lib/store";

type Context = { params: Promise<{ id: string }> };

// GET /api/sheets/budget -> { id, cells }
export async function GET(_request: Request, { params }: Context) {
  const { id } = await params;
  const cells = await readSheet(id);
  if (!cells) {
    return NextResponse.json({ error: "Sheet not found" }, { status: 404 });
  }
  return NextResponse.json({ id, cells });
}

// PUT /api/sheets/budget with { changes: { "B7": "=A1+2", "C3": "" } }
export async function PUT(request: Request, { params }: Context) {
  const { id } = await params;

  // Check the request first: bad requests are rejected immediately
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const changes = parseChanges(body);
  if (!changes) {
    return NextResponse.json({ error: "Invalid changes" }, { status: 400 });
  }

  // ---- On purpose, as the test asks: slow, and failing about 1 time in 5 ----
  await new Promise((resolve) => setTimeout(resolve, 350 + Math.random() * 1150));
  if (Math.random() < 0.2) {
    // Fails BEFORE anything is written, so a retry starts from a clean state
    return NextResponse.json({ error: "Simulated save failure" }, { status: 503 });
  }

  const found = await applyChanges(id, changes);
  if (!found) {
    return NextResponse.json({ error: "Sheet not found" }, { status: 404 });
  }
  return NextResponse.json({ savedAt: Date.now() });
}

// PATCH /api/sheets/budget with { name: "Q1 budget" }  (renames the tab)
export async function PATCH(request: Request, { params }: Context) {
  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const name = parseName(body);
  if (!name) {
    return NextResponse.json({ error: "Invalid name" }, { status: 400 });
  }

  const sheet = await renameSheet(id, name);
  if (!sheet) {
    return NextResponse.json({ error: "Sheet not found" }, { status: 404 });
  }
  return NextResponse.json({ sheet });
}