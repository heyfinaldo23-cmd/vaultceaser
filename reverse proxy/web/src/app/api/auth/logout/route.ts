import { NextResponse } from "next/server";
import { cookieName } from "@/lib/session-token";

export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(cookieName(), "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return res;
}
