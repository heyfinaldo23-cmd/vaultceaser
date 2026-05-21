import { getCachedEpCounts } from "@/lib/anikoto-cache";

export type ReleasedCounts = { sub: number; dub: number };
export type EpisodeCountsMap = Record<number, ReleasedCounts>;

// ─── localStorage write-through (for detail/watch pages to persist Anikoto counts) ─

const CACHE_KEY = "ep-counts-v1";

type CacheStore = Record<number, { sub: number; dub: number; ts: number }>;

function readCache(): CacheStore {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY) || "{}") as CacheStore;
  } catch {
    return {};
  }
}

function writeCache(store: CacheStore) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(store));
  } catch {}
}

/** Persist freshly-fetched Anikoto counts so grid cards can read them. */
export function rememberEpisodeCounts(counts: EpisodeCountsMap) {
  const store = readCache();
  const now = Date.now();
  for (const [k, v] of Object.entries(counts)) {
    if ((v.sub ?? 0) <= 0 && (v.dub ?? 0) <= 0) continue;
    store[Number(k)] = { sub: v.sub, dub: v.dub, ts: now };
  }
  const TTL2 = 10 * 60 * 1000;
  for (const [k, v] of Object.entries(store)) {
    if (now - v.ts > TTL2) delete store[Number(k)];
  }
  writeCache(store);
}

// ─── Fetch ───────────────────────────────────────────────────────────────────

/**
 * Read sub/dub counts from Anikoto localStorage cache only.
 * No backend calls — counts come from Anikoto (populated by detail/watch pages).
 * Grid cards start at 0 and update once the user visits the detail page.
 */
export async function fetchEpisodeCounts(
  ids: number[],
): Promise<EpisodeCountsMap> {
  const unique = [...new Set(ids.filter((id) => id > 0))];
  if (!unique.length) return {};

  const out: EpisodeCountsMap = {};
  for (const id of unique) {
    // Try Anikoto cache first (has dub counts)
    const ak = getCachedEpCounts(id);
    if (ak) { out[id] = ak; continue; }
    // Fall back to old ep-counts-v1 cache entry (from previous sessions)
    const store = readCache();
    const entry = store[id];
    if (entry) { out[id] = { sub: entry.sub, dub: entry.dub }; continue; }
    out[id] = { sub: 0, dub: 0 };
  }
  return out;
}
