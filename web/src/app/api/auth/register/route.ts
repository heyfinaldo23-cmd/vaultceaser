import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { generateAccountCode } from "@/lib/account-code";
import { signSession, cookieName } from "@/lib/session-token";

export const runtime = "nodejs";

export async function POST() {
  const db = getDb();
  if (!db) {
    return NextResponse.json(
      { error: "DATABASE_URL is not configured" },
      { status: 503 }
    );
  }

  for (let attempt = 0; attempt < 12; attempt++) {
    const code = generateAccountCode();
    try {
      const [row] = await db.insert(users).values({ code }).returning({ id: users.id });
      if (!row) continue;
      const token = await signSession(row.id);
      const res = NextResponse.json({
        ok: true,
        code,
        message: "Save this 16-digit code. It is your only login credential.",
      });
      res.cookies.set(cookieName(), token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
        maxAge: 60 * 60 * 24 * 30,
      });
      return res;
    } catch {
      /* unique collision */
    }
  }
  return NextResponse.json({ error: "Could not allocate account code" }, { status: 500 });
}
