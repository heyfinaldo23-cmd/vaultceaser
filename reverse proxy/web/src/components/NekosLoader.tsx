"use client";

import { useEffect, useState } from "react";

const NEKOS_CATS = ["nod", "wave", "think", "happy", "smile", "bored"];

export default function NekosLoader({ label = "Loading…" }: { label?: string }) {
  const [gifUrl, setGifUrl] = useState<string | null>(null);

  useEffect(() => {
    const cat = NEKOS_CATS[Math.floor(Math.random() * NEKOS_CATS.length)];
    fetch(`https://nekos.best/api/v2/${cat}?amount=1`)
      .then((r) => r.json())
      .then((d) => {
        const url = d?.results?.[0]?.url as string | undefined;
        if (url) setGifUrl(url);
      })
      .catch(() => null);
  }, []);

  return (
    <div className="flex min-h-[40vh] flex-col items-center justify-center gap-4 p-8">
      {gifUrl ? (
        <img
          src={gifUrl}
          alt=""
          className="h-24 w-24 rounded-full object-cover ring-2 ring-[#e8621a]/40"
        />
      ) : (
        <div className="h-24 w-24 animate-pulse rounded-full bg-white/10" />
      )}
      <p className="font-mono text-xs text-[var(--muted)]">{label}</p>
    </div>
  );
}
