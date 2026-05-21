/**
 * Client-side cache + fetch functions for Anikoto data.
 * Fetches go through /api/meta-proxy so the browser never sees anikototv.to.
 * All cache is stored in localStorage with a TTL.
 */

import {
  parseEpisodeListJson,
  parseSearchJson,
  parseWatchPage,
  parseFilterPage,
  parseSeasonsHtml,
  type AkEpisodeData,
  type AkFilterItem,
  type AkSearchResult,
  type AkSeasonEntry,
  type AkWatchInfo,
} from "./anikoto";

// ─── TTL constants ──────────────────────────────────────────────────────────

const TTL_SLUG = 7 * 24 * 60 * 60 * 1000;      // 7 days — slugs are stable
const TTL_EP_COUNT = 6 * 60 * 60 * 1000;        // 6 hours — ep counts change often
const TTL_SEARCH = 60 * 60 * 1000;              // 1 hour

const LS_SLUG_MAP = "ak:slugMap";           // malId → {slug, anikotoId, ts}
const LS_EP_COUNT_MAP = "ak:epCountMap";    // malId → {sub, dub, ts}
const LS_SEARCH_PREFIX = "ak:search:";      // keyword → {results[], ts}

// ─── types ───────────────────────────────────────────────────────────────────

interface SlugEntry {
  slug: string;
  anikotoId: number;
  ts: number;
}

interface EpCountEntry {
  sub: number;
  dub: number;
  ts: number;
}

// ─── localStorage helpers ────────────────────────────────────────────────────

function lsGet<T>(key: string): T | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function lsSet(key: string, value: unknown): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage full — evict oldest search entries then retry
    evictOldSearch();
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // give up silently
    }
  }
}

function evictOldSearch() {
  if (typeof window === "undefined") return;
  const now = Date.now();
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const key = localStorage.key(i);
    if (key?.startsWith(LS_SEARCH_PREFIX)) {
      const entry = lsGet<{ ts: number }>(key);
      if (!entry || now - entry.ts > TTL_SEARCH) {
        localStorage.removeItem(key);
      }
    }
  }
}

// ─── slug map ────────────────────────────────────────────────────────────────

function getSlugMap(): Record<string, SlugEntry> {
  return lsGet<Record<string, SlugEntry>>(LS_SLUG_MAP) ?? {};
}

function setSlugEntry(malId: number, entry: SlugEntry) {
  const map = getSlugMap();
  map[String(malId)] = entry;
  lsSet(LS_SLUG_MAP, map);
}

export function getCachedSlug(malId: number): SlugEntry | null {
  const entry = getSlugMap()[String(malId)];
  if (!entry) return null;
  if (Date.now() - entry.ts > TTL_SLUG) return null;
  return entry;
}

// ─── episode count map ───────────────────────────────────────────────────────

function getEpCountMap(): Record<string, EpCountEntry> {
  return lsGet<Record<string, EpCountEntry>>(LS_EP_COUNT_MAP) ?? {};
}

export function getCachedEpCounts(malId: number): { sub: number; dub: number } | null {
  const entry = getEpCountMap()[String(malId)];
  if (!entry) return null;
  if (Date.now() - entry.ts > TTL_EP_COUNT) return null;
  return { sub: entry.sub, dub: entry.dub };
}

export function setCachedEpCounts(malId: number, sub: number, dub: number) {
  const map = getEpCountMap();
  map[String(malId)] = { sub, dub, ts: Date.now() };
  lsSet(LS_EP_COUNT_MAP, map);
}

// ─── proxy fetch ─────────────────────────────────────────────────────────────

async function proxyFetch(path: string): Promise<string | null> {
  const url = `/api/meta-proxy?p=${encodeURIComponent(path)}`;
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

// ─── search ──────────────────────────────────────────────────────────────────

export async function akSearch(keyword: string): Promise<AkSearchResult[]> {
  const cacheKey = `${LS_SEARCH_PREFIX}${keyword.toLowerCase().trim()}`;
  const cached = lsGet<{ results: AkSearchResult[]; ts: number }>(cacheKey);
  if (cached && Date.now() - cached.ts < TTL_SEARCH) {
    return cached.results;
  }

  const raw = await proxyFetch(`/ajax/anime/search?keyword=${encodeURIComponent(keyword)}`);
  if (!raw) return [];

  const results = parseSearchJson(raw);
  if (results.length > 0) {
    lsSet(cacheKey, { results, ts: Date.now() });
  }
  return results;
}

// ─── watch page ───────────────────────────────────────────────────────────────

export async function akFetchWatchInfo(slug: string): Promise<AkWatchInfo | null> {
  const raw = await proxyFetch(`/watch/${slug}`);
  if (!raw) return null;
  return parseWatchPage(raw);
}

// ─── episode list ─────────────────────────────────────────────────────────────

export async function akFetchEpisodeList(anikotoId: number): Promise<AkEpisodeData | null> {
  const raw = await proxyFetch(`/ajax/episode/list/${anikotoId}?vrf=`);
  if (!raw) return null;
  return parseEpisodeListJson(raw);
}

// ─── resolve MAL ID → anikoto slug + ID ──────────────────────────────────────

/**
 * Given an anime title (from static catalog) and MAL ID, find the best matching
 * Anikoto slug. Caches the result so subsequent calls are instant.
 */
export async function resolveAnikotoSlug(
  malId: number,
  title: string
): Promise<SlugEntry | null> {
  const cached = getCachedSlug(malId);
  if (cached) return cached;

  const results = await akSearch(title);
  if (results.length === 0) return null;

  // Best match: exact title match first, then first result
  const normalizeTitle = (t: string) => t.toLowerCase().replace(/[^a-z0-9]/g, "");
  const normalTitle = normalizeTitle(title);

  const match =
    results.find((r) => normalizeTitle(r.title) === normalTitle) ??
    results.find((r) => normalizeTitle(r.title).includes(normalTitle)) ??
    results.find((r) => normalTitle.includes(normalizeTitle(r.title).slice(0, 10))) ??
    results[0];

  if (!match?.slug) return null;

  // Fetch watch page to get anikotoId
  const info = await akFetchWatchInfo(match.slug);
  if (!info?.anikotoId) return null;

  const entry: SlugEntry = { slug: match.slug, anikotoId: info.anikotoId, ts: Date.now() };
  setSlugEntry(malId, entry);

  // Also map via episode list malId if different (e.g. title mismatch)
  return entry;
}

// ─── main public function ─────────────────────────────────────────────────────

/**
 * Get sub/dub episode counts for an anime by MAL ID.
 * Uses: static title → search → watch page → episode list.
 * Returns null if any step fails.
 */
export async function getAnikotoEpCounts(
  malId: number,
  title: string
): Promise<{ sub: number; dub: number } | null> {
  // 1. check cache
  const cached = getCachedEpCounts(malId);
  if (cached) return cached;

  // 2. resolve slug → anikotoId
  const slugEntry = await resolveAnikotoSlug(malId, title);
  if (!slugEntry) return null;

  // 3. fetch episode list
  const epData = await akFetchEpisodeList(slugEntry.anikotoId);
  if (!epData) return null;

  // 4. if malId from episode list differs from our malId, also cache under that ID
  if (epData.malId && epData.malId !== malId) {
    setCachedEpCounts(epData.malId, epData.subCount, epData.dubCount);
  }

  setCachedEpCounts(malId, epData.subCount, epData.dubCount);
  return { sub: epData.subCount, dub: epData.dubCount };
}

// ─── genre / sort / format / status maps ─────────────────────────────────────

const AK_GENRES: Record<string, number> = {
  "Action": 1, "Adventure": 2, "Cars": 538, "Comedy": 8, "Dementia": 453,
  "Demons": 119, "Drama": 62, "Ecchi": 214, "Fantasy": 3, "Game": 180,
  "Harem": 215, "Historical": 70, "Horror": 222, "Isekai": 74, "Josei": 404,
  "Kids": 46, "Magic": 203, "Mahou Shoujo": 2310, "Martial Arts": 114,
  "Mecha": 123, "Military": 125, "Music": 242, "Mystery": 57, "Parody": 162,
  "Police": 136, "Psychological": 73, "Romance": 28, "Samurai": 163,
  "School": 14, "Sci-Fi": 12, "Seinen": 50, "Shoujo": 252, "Shoujo Ai": 235,
  "Shounen": 15, "Shounen Ai": 233, "Slice of Life": 35, "Space": 124,
  "Sports": 29, "Super Power": 16, "Supernatural": 9, "Thriller": 54,
  "Vampire": 58,
};

const AK_SORT: Record<string, string> = {
  "POPULARITY_DESC": "most-viewed",
  "TRENDING_DESC": "most-viewed",
  "SCORE_DESC": "score",
  "UPDATED_AT_DESC": "latest-updated",
  "START_DATE_DESC": "release-date",
};

const AK_FORMAT: Record<string, string> = {
  "TV": "TV", "MOVIE": "Movie", "OVA": "OVA", "ONA": "ONA",
  "SPECIAL": "Special", "MUSIC": "Music",
};

const AK_STATUS: Record<string, string> = {
  "RELEASING": "currently-airing",
  "FINISHED": "finished-airing",
  "NOT_YET_RELEASED": "not-yet-aired",
};

// ─── Anikoto /filter page fetcher ────────────────────────────────────────────

export async function akFetchFilter(params: {
  keyword?: string;
  genre?: string;
  format?: string;
  status?: string;
  sort?: string;
  season?: string;
  year?: string;
  page?: number;
}): Promise<AkFilterItem[]> {
  const p = new URLSearchParams();

  if (params.keyword) p.set("keyword", params.keyword);

  if (params.genre) {
    for (const g of params.genre.split(",").map((s) => s.trim()).filter(Boolean)) {
      const id = AK_GENRES[g];
      if (id) p.append("genre[]", String(id));
    }
  }

  if (params.format) {
    const akFmt = AK_FORMAT[params.format.toUpperCase()];
    if (akFmt) p.append("term_type[]", akFmt);
  }

  if (params.status) {
    const akStat = AK_STATUS[params.status.toUpperCase()];
    if (akStat) p.append("status[]", akStat);
  }

  if (params.season) p.append("season[]", params.season.toLowerCase());
  if (params.year) p.append("year[]", params.year);

  p.set("sort", AK_SORT[params.sort ?? ""] ?? "most-viewed");
  if (params.page && params.page > 1) p.set("page", String(params.page));

  const html = await proxyFetch(`/filter?${p.toString()}`);
  if (!html) return [];
  return parseFilterPage(html);
}

/**
 * Fetch the seasons rail for an Anikoto anime ID.
 * Returns ordered season entries with name, slug, banner.
 */
export async function akFetchSeasons(anikotoId: number): Promise<AkSeasonEntry[]> {
  const raw = await proxyFetch(`/api/seasons/${anikotoId}`);
  if (!raw) return [];
  return parseSeasonsHtml(raw);
}


