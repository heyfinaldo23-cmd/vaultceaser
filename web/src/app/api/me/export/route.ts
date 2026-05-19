import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { bookmarks, watchProgress } from "@/db/schema";
import { getSessionUserId } from "@/lib/auth-server";

export const runtime = "nodejs";

export async function GET() {
  const db = getDb();
  const uid = await getSessionUserId();
  if (!uid) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const [bm, wp] = await Promise.all([
    db.select().from(bookmarks).where(eq(bookmarks.userId, uid)),
    db.select().from(watchProgress).where(eq(watchProgress.userId, uid)),
  ]);

  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    bookmarks: bm.map((b) => ({
      animeId: b.animeId,
      titleRomaji: b.titleRomaji,
      titleEnglish: b.titleEnglish,
      poster: b.poster,
    })),
    watchProgress: wp.map((w) => ({
      animeId: w.animeId,
      episodeNumber: w.episodeNumber,
      episodeId: w.episodeId,
      category: w.category,
      title: w.title,
    })),
  };

  return new NextResponse(JSON.stringify(payload, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="otakuvault-export-${Date.now()}.json"`,
    },
  });
}
