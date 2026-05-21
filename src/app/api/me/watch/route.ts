import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { watchProgress } from "@/db/schema";
import { getSessionUserId } from "@/lib/auth-server";
import { z } from "zod";

export const runtime = "nodejs";

const upsertSchema = z.object({
  animeId: z.number().int().positive(),
  episodeNumber: z.number().int().positive(),
  episodeId: z.string().min(1),
  category: z.enum(["sub", "dub", "ssub"]).default("sub"),
  title: z.string().optional(),
});

export async function GET() {
  const db = getDb();
  const uid = await getSessionUserId();
  if (!uid) return NextResponse.json({ items: [] });

  const rows = await db
    .select()
    .from(watchProgress)
    .where(eq(watchProgress.userId, uid))
    .orderBy(desc(watchProgress.updatedAt));

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
  const parsed = upsertSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body", details: parsed.error.flatten() }, { status: 400 });
  }
  const b = parsed.data;
  const now = new Date();

  await db
    .insert(watchProgress)
    .values({
      userId: uid,
      animeId: b.animeId,
      episodeNumber: b.episodeNumber,
      episodeId: b.episodeId,
      category: b.category,
      title: b.title ?? null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [watchProgress.userId, watchProgress.animeId],
      set: {
        episodeNumber: b.episodeNumber,
        episodeId: b.episodeId,
        category: b.category,
        title: b.title ?? null,
        updatedAt: now,
      },
    });

  return NextResponse.json({ ok: true });
}
