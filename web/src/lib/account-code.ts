import { randomInt } from "crypto";

const DIGITS = "0123456789";

/** Uniform 16-digit account number (no leading-zero weakness beyond random). */
export function generateAccountCode(): string {
  let s = "";
  for (let i = 0; i < 16; i++) {
    s += DIGITS[randomInt(0, 10)];
  }
  return s;
}

export function normalizeAccountCode(raw: string): string {
  return raw.replace(/\D/g, "").slice(0, 16);
}

export function isValidAccountCode(code: string): boolean {
  return /^\d{16}$/.test(code);
}
