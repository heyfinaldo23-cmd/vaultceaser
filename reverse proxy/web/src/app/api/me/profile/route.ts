import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { getSessionUserId } from "@/lib/auth-server";
import { z } from "zod";

export const runtime = "nodejs";

const patchSchema = z.object({
  displayName: z.string().min(1).max(64),
});

export async function PATCH(req: Request) {
  const db = getDb();
  const uid = await getSessionUserId();
  if (!uid) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = patchSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  await db.update(users).set({ displayName: parsed.data.displayName }).where(eq(users.id, uid));

  return NextResponse.json({ ok: true, displayName: parsed.data.displayName });
}
