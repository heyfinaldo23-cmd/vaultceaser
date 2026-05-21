import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { isValidAccountCode, normalizeAccountCode } from "@/lib/account-code";
import { signSession, cookieName } from "@/lib/session-token";
import { z } from "zod";

export const runtime = "nodejs";

const bodySchema = z.object({
  code: z.string().min(1),
});

export async function POST(req: Request) {
  const db = getDb();

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const code = normalizeAccountCode(parsed.data.code);
  if (!isValidAccountCode(code)) {
    return NextResponse.json({ error: "Code must be exactly 16 digits" }, { status: 400 });
  }

  const [user] = await db.select().from(users).where(eq(users.code, code)).limit(1);
  if (!user) {
    return NextResponse.json({ error: "Unknown account code" }, { status: 401 });
  }

  const token = await signSession(user.id);
  const res = NextResponse.json({ ok: true, displayName: user.displayName });
  res.cookies.set(cookieName(), token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return res;
}
