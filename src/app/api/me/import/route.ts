import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { bookmarks, watchProgress } from "@/db/schema";
import { getSessionUserId } from "@/lib/auth-server";
import { z } from "zod";

export const runtime = "nodejs";

const importSchema = z.object({
  version: z.literal(1),
  bookmarks: z
    .array(
      z.object({
        animeId: z.number().int().positive(),
        titleRomaji: z.string().nullable().optional(),
        titleEnglish: z.string().nullable().optional(),
        poster: z.string().nullable().optional(),
      })
    )
    .optional()
    .default([]),
  watchProgress: z
    .array(
      z.object({
        animeId: z.number().int().positive(),
        episodeNumber: z.number().int().positive(),
        episodeId: z.string().min(1),
        category: z.enum(["sub", "dub", "ssub"]).default("sub"),
        title: z.string().nullable().optional(),
      })
    )
    .optional()
    .default([]),
});

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
  const parsed = importSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid export file shape" }, { status: 400 });
  }
  const data = parsed.data;
  const now = new Date();

  for (const b of data.bookmarks) {
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
  }

  for (const w of data.watchProgress) {
    await db
      .insert(watchProgress)
      .values({
        userId: uid,
        animeId: w.animeId,
        episodeNumber: w.episodeNumber,
        episodeId: w.episodeId,
        category: w.category,
        title: w.title ?? null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [watchProgress.userId, watchProgress.animeId],
        set: {
          episodeNumber: w.episodeNumber,
          episodeId: w.episodeId,
          category: w.category,
          title: w.title ?? null,
          updatedAt: now,
        },
      });
  }

  return NextResponse.json({ ok: true, imported: { bookmarks: data.bookmarks.length, watch: data.watchProgress.length } });
}
