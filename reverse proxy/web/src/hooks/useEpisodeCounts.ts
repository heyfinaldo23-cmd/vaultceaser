"use client";

import { useEffect, useState } from "react";
import { getCachedEpCounts } from "@/lib/anikoto-cache";
import type { EpisodeCountsMap } from "@/lib/episode-counts";

function readAll(ids: number[]): EpisodeCountsMap {
  const out: EpisodeCountsMap = {};
  for (const id of ids) {
    const c = getCachedEpCounts(id);
    out[id] = c ?? { sub: 0, dub: 0 };
  }
  return out;
}

/** Read sub/dub counts for card grids from Anikoto localStorage cache.
 *  Updates automatically when detail/watch pages populate the cache. */
export function useEpisodeCountsMap(ids: number[]) {
  const key = [...new Set(ids.filter((id) => id > 0))].sort((a, b) => a - b).join(",");
  const uniqueIds = key ? key.split(",").map(Number) : [];

  const [counts, setCounts] = useState<EpisodeCountsMap>(() => readAll(uniqueIds));

  useEffect(() => {
    if (!key) return;
    // Refresh when another tab/page writes to localStorage (detail page resolves Anikoto)
    const onStorage = (e: StorageEvent) => {
      if (e.key === "ak:epCountMap" || e.key === "ep-counts-v1") {
        setCounts(readAll(uniqueIds));
      }
    };
    window.addEventListener("storage", onStorage);
    // Also re-read after a short delay in case same-tab detail page just wrote
    const timer = window.setTimeout(() => setCounts(readAll(uniqueIds)), 1500);
    const refresh = window.setInterval(() => setCounts(readAll(uniqueIds)), 30_000);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.clearTimeout(timer);
      window.clearInterval(refresh);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return key ? counts : {};
}
