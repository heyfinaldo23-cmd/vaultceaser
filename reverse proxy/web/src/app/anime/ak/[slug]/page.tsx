"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function AkSlugPage() {
  const router = useRouter();
  useEffect(() => { router.replace("/browse"); }, [router]);
  return (
    <p className="p-8 text-center font-mono text-sm text-[var(--muted)]">Redirecting…</p>
  );
}
