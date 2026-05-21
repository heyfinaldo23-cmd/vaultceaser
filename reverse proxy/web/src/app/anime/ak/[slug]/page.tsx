"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { akFetchWatchInfo, akFetchEpisodeList } from "@/lib/anikoto-cache";

const NEKOS = ["nod", "think", "wave", "smile", "happy"];
const LS_PREFIX = "ak:slug2mal:";

function useNekosGif() {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const cat = NEKOS[Math.floor(Math.random() * NEKOS.length)];
    fetch(`https://nekos.best/api/v2/${cat}?amount=1`)
      .then((r) => r.json())
      .then((d) => { const u = d?.results?.[0]?.url; if (u) setUrl(u); })
      .catch(() => null);
  }, []);
  return url;
}

export default function AkSlugPage({ params }: { params: Promise<{ slug: string }> }) {
  const router = useRouter();
  const [resolvedSlug, setResolvedSlug] = useState<string | null>(null);
  const [status, setStatus] = useState("Resolving anime…");
  const gifUrl = useNekosGif();

  useEffect(() => {
    params.then(({ slug }) => setResolvedSlug(slug));
  }, [params]);

  useEffect(() => {
    if (!resolvedSlug) return;

    // Check localStorage cache first
    const cached = localStorage.getItem(`${LS_PREFIX}${resolvedSlug}`);
    if (cached) {
      router.replace(`/anime/${cached}`);
      return;
    }

    (async () => {
      setStatus("Fetching anime info…");
      const info = await akFetchWatchInfo(resolvedSlug);
      if (!info?.anikotoId) {
        setStatus("Not found, searching…");
        router.replace(`/browse?q=${encodeURIComponent(resolvedSlug.replace(/-[a-z0-9]{4,6}$/i, "").replace(/-/g, " "))}`);
        return;
      }

      setStatus("Loading episodes…");
      const epData = await akFetchEpisodeList(info.anikotoId);
      const malId = epData?.malId;

      if (malId) {
        localStorage.setItem(`${LS_PREFIX}${resolvedSlug}`, String(malId));
        router.replace(`/anime/${malId}`);
      } else {
        router.replace(`/browse?q=${encodeURIComponent(info.title || resolvedSlug.replace(/-/g, " "))}`);
      }
    })();
  }, [resolvedSlug, router]);

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-5">
      {gifUrl ? (
        <img src={gifUrl} alt="loading" className="h-28 w-28 rounded-xl object-cover shadow-lg" />
      ) : (
        <div className="h-28 w-28 rounded-xl skeleton" />
      )}
      <p className="font-mono text-sm font-semibold text-[var(--muted)]">{status}</p>
    </div>
  );
}
