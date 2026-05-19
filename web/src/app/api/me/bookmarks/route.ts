import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { bookmarks } from "@/db/schema";
import { getSessionUserId } from "@/lib/auth-server";
import { z } from "zod";

export const runtime = "nodejs";

const addSchema = z.object({
  animeId: z.number().int().positive(),
  titleRomaji: z.string().optional(),
  titleEnglish: z.string().optional(),
  poster: z.string().optional(),
});

export async function GET() {
  const db = getDb();
  const uid = await getSessionUserId();
  if (!uid) return NextResponse.json({ items: [] });

  const rows = await db.select().from(bookmarks).where(eq(bookmarks.userId, uid));
  return NextResponse.json({ items: rows });
}

export async function POST(req: Request) {
  const db = getDb();
  const uid = await getSessionUserId();
  if (!uid) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = addSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const b = parsed.data;

  await db
    .insert(bookmarks)
    .values({
      userId: uid,
      animeId: b.animeId,
      titleRomaji: b.titleRomaji ?? null,
      titleEnglish: b.titleEnglish ?? null,
      poster: b.poster ?? null,
    })
    .onConflictDoNothing({ target: [bookmarks.userId, bookmarks.animeId] });

  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  const db = getDb();
  const uid = await getSessionUserId();
  if (!uid) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const animeId = Number(url.searchParams.get("animeId"));
  if (!Number.isFinite(animeId) || animeId <= 0) {
    return NextResponse.json({ error: "animeId required" }, { status: 400 });
  }

  await db
    .delete(bookmarks)
    .where(and(eq(bookmarks.userId, uid), eq(bookmarks.animeId, animeId)));

  return NextResponse.json({ ok: true });
}
