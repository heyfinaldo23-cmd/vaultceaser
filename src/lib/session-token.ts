import { SignJWT, jwtVerify } from "jose";

const COOKIE = "ov_session";

function getSecret(): Uint8Array {
  const raw = process.env.SESSION_SECRET ?? "";
  if (raw.length >= 32) {
    return new TextEncoder().encode(raw);
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("SESSION_SECRET must be at least 32 characters in production");
  }
  return new TextEncoder().encode("dev-only-insecure-32chars-minimum!!");
}

export function cookieName() {
  return COOKIE;
}

export async function signSession(userId: string): Promise<string> {
  const secret = getSecret();
  return new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("30d")
    .setIssuedAt()
    .sign(secret);
}

export async function verifySession(token: string): Promise<string | null> {
  try {
    const secret = getSecret();
    const { payload } = await jwtVerify(token, secret, { algorithms: ["HS256"] });
    const sub = payload.sub;
    return typeof sub === "string" ? sub : null;
  } catch {
    return null;
  }
}
