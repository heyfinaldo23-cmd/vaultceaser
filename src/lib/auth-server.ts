import { cookies } from "next/headers";
import { cookieName, verifySession } from "@/lib/session-token";

export async function getSessionUserId(): Promise<string | null> {
  const jar = await cookies();
  const t = jar.get(cookieName())?.value;
  if (!t) return null;
  return verifySession(t);
}
