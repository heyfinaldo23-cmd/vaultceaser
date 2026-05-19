import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { getSessionUserId } from "@/lib/auth-server";

export const runtime = "nodejs";

export async function GET() {
  const db = getDb();
  const uid = await getSessionUserId();
  if (!uid) {
    return NextResponse.json({ user: null, db: true });
  }
  const [u] = await db.select().from(users).where(eq(users.id, uid)).limit(1);
  if (!u) {
    return NextResponse.json({ user: null, db: true });
  }
  return NextResponse.json({
    user: {
      id: u.id,
      displayName: u.displayName,
      createdAt: u.createdAt,
    },
    db: true,
  });
}
