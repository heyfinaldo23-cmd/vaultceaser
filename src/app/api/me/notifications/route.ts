import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { notifications } from "@/db/schema";
import { getSessionUserId } from "@/lib/auth-server";

export const runtime = "nodejs";

/** In-app notifications (Drizzle). Real-time alerts can be wired to Supabase later. */
export async function GET() {
  const db = getDb();
  const uid = await getSessionUserId();
  if (!uid) return NextResponse.json({ items: [] });

  const rows = await db
    .select()
    .from(notifications)
    .where(eq(notifications.userId, uid))
    .orderBy(desc(notifications.createdAt))
    .limit(50);

  return NextResponse.json({ items: rows });
}
