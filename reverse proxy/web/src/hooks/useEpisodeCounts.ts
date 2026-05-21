"use client";

import { useEffect, useState } from "react";
import { fetchEpisodeCounts, type EpisodeCountsMap } from "@/lib/episode-counts";

const CHUNK = 4;
const REFRESH_INTERVAL = 5 * 60 * 1000;

/** Load released sub/dub counts for card grids. Backend refreshes stale counts in the background. */
export function useEpisodeCountsMap(ids: number[]) {
  const [counts, setCounts] = useState<EpisodeCountsMap>({});
  const key = [...new Set(ids.filter((id) => id > 0))].sort((a, b) => a - b).join(",");

  useEffect(() => {
    if (!key) return;
    let cancelled = false;

    const uniqueIds = key.split(",").map(Number).filter((id) => id > 0);

    const load = async () => {
      const merged: EpisodeCountsMap = {};
      for (let i = 0; i < uniqueIds.length; i += CHUNK) {
        if (cancelled) break;
        const chunk = uniqueIds.slice(i, i + CHUNK);
        const part = await fetchEpisodeCounts(chunk);
        Object.assign(merged, part);
        if (!cancelled) {
          setCounts((prev) => ({ ...prev, ...part }));
        }
      }
    };

    void load();
    const retry = window.setTimeout(() => void load(), 4_000);
    const timer = window.setInterval(() => void load(), REFRESH_INTERVAL);

    return () => {
      cancelled = true;
      window.clearTimeout(retry);
      window.clearInterval(timer);
    };
  }, [key]);

  return key ? counts : {};
}
