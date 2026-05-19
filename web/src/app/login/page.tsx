"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { clientApi } from "@/lib/client-api";
import { useAuth } from "@/components/AuthProvider";
import { isValidAccountCode, normalizeAccountCode } from "@/lib/account-code";

export default function LoginPage() {
  const router = useRouter();
  const { refresh } = useAuth();
  const [digits, setDigits] = useState<string[]>(Array(16).fill(""));
  const [newCode, setNewCode] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const code = digits.join("");

  const setAt = (i: number, v: string) => {
    const d = v.replace(/\D/g, "");
    if (!d) {
      const next = [...digits];
      next[i] = "";
      setDigits(next);
      return;
    }
    const ch = d.slice(-1);
    const next = [...digits];
    next[i] = ch;
    setDigits(next);
    if (i < 15) {
      const el = document.getElementById(`d-${i + 1}`) as HTMLInputElement | null;
      el?.focus();
    }
  };

  const onPaste = (e: React.ClipboardEvent) => {
    const raw = normalizeAccountCode(e.clipboardData.getData("text"));
    if (raw.length === 0) return;
    e.preventDefault();
    const next = Array(16).fill("");
    for (let i = 0; i < Math.min(16, raw.length); i++) next[i] = raw[i];
    setDigits(next);
  };

  const onLogin = async () => {
    setError("");
    if (!isValidAccountCode(code)) {
      setError("Enter all 16 digits");
      return;
    }
    setBusy(true);
    try {
      await clientApi.login(code);
      await refresh();
      router.push("/profile");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Login failed");
    } finally {
      setBusy(false);
    }
  };

  const onRegister = async () => {
    setError("");
    setBusy(true);
    try {
      const r = await clientApi.register();
      setNewCode(r.code);
      const next = Array(16).fill("");
      for (let i = 0; i < 16; i++) next[i] = r.code[i];
      setDigits(next);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create account");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-md px-4 py-16">
      <p className="text-center text-xs uppercase tracking-[0.2em] text-[var(--muted)]">
        OtakuVault
      </p>
      <h1 className="mt-2 text-center text-2xl font-semibold">Account access</h1>
      <p className="mt-2 text-center text-sm text-[var(--muted)]">
        Enter your 16-digit code. No email. No password.
      </p>

      {newCode && (
        <div className="mt-6 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm">
          <p className="font-medium text-amber-200">Save this code now</p>
          <p className="mt-1 font-mono text-lg tracking-widest">{newCode}</p>
          <p className="mt-2 text-[var(--muted)]">
            We cannot show it again. Copy it somewhere safe.
          </p>
        </div>
      )}

      <div className="mt-8 flex flex-wrap justify-center gap-1.5" onPaste={onPaste}>
        {digits.map((d, i) => (
          <input
            key={i}
            id={`d-${i}`}
            type="text"
            inputMode="numeric"
            maxLength={1}
            value={d}
            onChange={(e) => setAt(i, e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Backspace" && !digits[i] && i > 0) {
                const el = document.getElementById(`d-${i - 1}`) as HTMLInputElement | null;
                el?.focus();
              }
              if (e.key === "Enter") onLogin();
            }}
            className="h-11 w-7 rounded border border-[var(--border)] bg-[var(--card)] text-center font-mono text-sm focus:border-[var(--accent)] focus:outline-none sm:w-8"
          />
        ))}
      </div>

      {error && (
        <p className="mt-4 text-center text-sm text-red-400">{error}</p>
      )}

      <div className="mt-8 flex flex-col gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={onLogin}
          className="h-11 rounded-lg bg-[var(--accent)] font-medium text-black disabled:opacity-50"
        >
          Log in
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onRegister}
          className="h-11 rounded-lg border border-[var(--border)] text-sm hover:bg-[var(--card)] disabled:opacity-50"
        >
          Generate new code
        </button>
      </div>

      <p className="mt-8 text-center text-sm text-[var(--muted)]">
        <Link href="/" className="text-[var(--accent)] hover:underline">
          Back to browse
        </Link>
      </p>
    </div>
  );
}
