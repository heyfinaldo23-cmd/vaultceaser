"use client";

import { useEffect, useState } from "react";
import {
  fetchEpisodeCounts,
  type EpisodeCountsMap,
} from "@/lib/episode-counts";

const CHUNK = 24;

/** Load released sub/dub counts for card grids (home, browse). */
export function useEpisodeCountsMap(ids: number[]) {
  const [counts, setCounts] = useState<EpisodeCountsMap>({});
  const key = [...new Set(ids.filter((id) => id > 0))].sort((a, b) => a - b).join(",");

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    const uniqueIds = key.split(",").map(Number).filter((id) => id > 0);

    (async () => {
      const merged: EpisodeCountsMap = {};
      for (let i = 0; i < uniqueIds.length; i += CHUNK) {
        const chunk = uniqueIds.slice(i, i + CHUNK);
        const part = await fetchEpisodeCounts(chunk, { refresh: true });
        Object.assign(merged, part);
      }
      if (!cancelled) setCounts(merged);
    })();

    return () => {
      cancelled = true;
    };
  }, [key]);

  return key ? counts : {};
}
