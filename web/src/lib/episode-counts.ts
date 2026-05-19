import { api } from "@/lib/api";

export type ReleasedCounts = { sub: number; dub: number };

export type EpisodeCountsMap = Record<number, ReleasedCounts>;

const FALLBACK_CONCURRENCY = 4;

function countList(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>
) {
  let index = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (index < items.length) {
        const item = items[index++];
        await fn(item);
      }
    }
  );
  await Promise.all(workers);
}

async function fetchEpisodeListCounts(id: number): Promise<ReleasedCounts> {
  const epData = await api.getEpisodes(id);
  const megaplay = epData.episodes?.providers?.megaplay;
  const episodes = megaplay?.episodes || {};
  const releasedSub = typeof epData.released?.sub === "number" ? epData.released.sub : 0;
  const releasedDub = typeof epData.released?.dub === "number" ? epData.released.dub : 0;
  const sub = countList(episodes.sub) || countList(episodes.ssub) || releasedSub;
  const dub = countList(episodes.dub) || releasedDub;
  return { sub, dub };
}

/** Fetch released sub/dub counts (non-fatal if backend route missing). */
export async function fetchEpisodeCounts(
  ids: number[],
  options: { refresh?: boolean } = {}
): Promise<EpisodeCountsMap> {
  const unique = [...new Set(ids.filter((id) => id > 0))];
  if (!unique.length) return {};

  try {
    const data = await api.getEpisodeCounts(unique, options.refresh);
    const out: EpisodeCountsMap = {};
    for (const [key, val] of Object.entries(data.counts || {})) {
      const id = Number(key);
      if (id && val) out[id] = { sub: val.sub ?? 0, dub: val.dub ?? 0 };
    }
    const fallbackIds = unique.filter((id) => {
      const counts = out[id];
      return !counts || (counts.sub === 0 && counts.dub === 0);
    });
    await mapWithConcurrency(fallbackIds, FALLBACK_CONCURRENCY, async (id) => {
      try {
        out[id] = await fetchEpisodeListCounts(id);
      } catch (e) {
        console.warn(`episode-list count fallback failed for ${id}:`, e);
        out[id] = out[id] || { sub: 0, dub: 0 };
      }
    });
    return out;
  } catch (e) {
    console.warn("episode-counts unavailable:", e);
    const out: EpisodeCountsMap = {};
    await mapWithConcurrency(unique, FALLBACK_CONCURRENCY, async (id) => {
      try {
        out[id] = await fetchEpisodeListCounts(id);
      } catch (fallbackError) {
        console.warn(`episode-list count fallback failed for ${id}:`, fallbackError);
        out[id] = { sub: 0, dub: 0 };
      }
    });
    return out;
  }
}
