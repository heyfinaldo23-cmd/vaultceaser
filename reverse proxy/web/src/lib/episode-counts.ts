import { api } from "@/lib/api";

export type ReleasedCounts = { sub: number; dub: number };
export type EpisodeCountsMap = Record<number, ReleasedCounts>;

// ─── localStorage cache (5-min TTL) ─────────────────────────────────────────

const CACHE_KEY = "ep-counts-v1";
const CACHE_TTL = 5 * 60 * 1000;

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

function getCached(id: number): ReleasedCounts | null {
  const entry = readCache()[id];
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) return null;
  return { sub: entry.sub, dub: entry.dub };
}

function setCached(counts: EpisodeCountsMap) {
  const store = readCache();
  const now = Date.now();
  for (const [k, v] of Object.entries(counts)) {
    // 0/0 usually means "unknown/not warmed yet"; caching it hides provider
    // counts until the TTL expires.
    if ((v.sub ?? 0) <= 0 && (v.dub ?? 0) <= 0) continue;
    store[Number(k)] = { sub: v.sub, dub: v.dub, ts: now };
  }
  // Prune stale entries
  for (const [k, v] of Object.entries(store)) {
    if (now - v.ts > CACHE_TTL * 2) delete store[Number(k)];
  }
  writeCache(store);
}

// ─── Fetch ───────────────────────────────────────────────────────────────────

/** Fetch released sub/dub counts, returning from cache when fresh. */
export async function fetchEpisodeCounts(
  ids: number[],
  options: { refresh?: boolean } = {}
): Promise<EpisodeCountsMap> {
  const unique = [...new Set(ids.filter((id) => id > 0))];
  if (!unique.length) return {};

  const out: EpisodeCountsMap = {};

  // Serve from cache unless force-refresh
  const stale: number[] = [];
  if (!options.refresh) {
    for (const id of unique) {
      const cached = getCached(id);
      if (cached) out[id] = cached;
      else stale.push(id);
    }
    if (!stale.length) return out;
  }

  const toFetch = options.refresh ? unique : stale;
  try {
    const data = await api.getEpisodeCounts(toFetch, options.refresh);
    const fresh: EpisodeCountsMap = {};
    for (const [key, val] of Object.entries(data.counts || {})) {
      const id = Number(key);
      if (id && val) fresh[id] = { sub: val.sub ?? 0, dub: val.dub ?? 0 };
    }
    setCached(fresh);
    Object.assign(out, fresh);
    // Fill zeros for any ids the backend didn't return
    for (const id of toFetch) {
      if (!(id in out)) out[id] = { sub: 0, dub: 0 };
    }
  } catch {
    // Backend unavailable — return cache (possibly stale) or zeros
    for (const id of toFetch) {
      out[id] = getCached(id) ?? { sub: 0, dub: 0 };
    }
  }

  return out;
}
