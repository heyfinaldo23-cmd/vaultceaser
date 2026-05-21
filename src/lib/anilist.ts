/**
 * Direct AniList GraphQL client — no server involved.
 * Each browser has its own IP/rate-limit (90 req/min).
 * Responses are cached in sessionStorage (24h TTL, max 60 entries).
 */

import type { AnimeMedia, PaginatedResult, GenreData } from "@/lib/api";

const ANILIST_GQL = "https://graphql.anilist.co";
const CACHE_MAX = 60;
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours
const CACHE_KEY = "al-gql-cache-v1";

// ─── SessionStorage cache (Miruro-style) ────────────────────────────────────

type CacheEntry = { value: unknown; ts: number };

function loadCache(): Map<string, CacheEntry> {
  try {
    const raw = typeof window !== "undefined" ? sessionStorage.getItem(CACHE_KEY) : null;
    if (!raw) return new Map();
    return new Map(JSON.parse(raw) as [string, CacheEntry][]);
  } catch {
    return new Map();
  }
}

function saveCache(map: Map<string, CacheEntry>) {
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify(Array.from(map.entries())));
  } catch {}
}

function cacheGet(key: string): unknown | undefined {
  const map = loadCache();
  const entry = map.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.ts > CACHE_TTL) {
    map.delete(key);
    saveCache(map);
    return undefined;
  }
  return entry.value;
}

function cacheSet(key: string, value: unknown) {
  const map = loadCache();
  if (map.size >= CACHE_MAX) {
    // evict oldest
    const oldest = map.keys().next().value;
    if (oldest) map.delete(oldest);
  }
  map.set(key, { value, ts: Date.now() });
  saveCache(map);
}

// ─── GQL executor ───────────────────────────────────────────────────────────

async function gql<T>(query: string, variables?: Record<string, unknown>, cacheKey?: string): Promise<T> {
  if (cacheKey) {
    const hit = cacheGet(cacheKey);
    if (hit !== undefined) return hit as T;
  }

  const res = await fetch(ANILIST_GQL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`AniList ${res.status}: ${text.slice(0, 200)}`);
  }

  const payload = await res.json();
  if (payload.errors?.length) {
    const err = payload.errors[0];
    throw new Error(`AniList GQL: ${err.message} (${err.status ?? ""})`);
  }

  const data = payload.data as T;
  if (cacheKey) cacheSet(cacheKey, data);
  return data;
}

// ─── Shared field fragments ──────────────────────────────────────────────────

const LIST_FIELDS = `
  id
  title { romaji english native }
  coverImage { large extraLarge color }
  bannerImage
  format
  season
  seasonYear
  episodes
  duration
  status
  averageScore
  meanScore
  popularity
  favourites
  genres
  source
  countryOfOrigin
  isAdult
  studios(isMain: true) { nodes { name isAnimationStudio } }
  nextAiringEpisode { episode airingAt timeUntilAiring }
  startDate { year month day }
  endDate { year month day }
`;

const FULL_FIELDS = `
  id
  idMal
  title { romaji english native }
  description(asHtml: false)
  coverImage { large extraLarge color }
  bannerImage
  format
  season
  seasonYear
  episodes
  duration
  status
  averageScore
  meanScore
  popularity
  favourites
  genres
  tags { name rank isMediaSpoiler }
  source
  countryOfOrigin
  isAdult
  synonyms
  siteUrl
  trailer { id site thumbnail }
  studios { nodes { id name isAnimationStudio siteUrl } }
  nextAiringEpisode { episode airingAt timeUntilAiring }
  startDate { year month day }
  endDate { year month day }
  characters(sort: [ROLE, RELEVANCE], perPage: 25) {
    edges {
      role
      node { id name { full native } image { large } }
      voiceActors(language: JAPANESE) { id name { full } image { large } languageV2 }
    }
  }
  relations {
    edges {
      relationType(version: 2)
      node {
        id
        title { romaji english native }
        coverImage { large }
        bannerImage
        format
        type
        status
        episodes
        meanScore
        isAdult
        seasonYear
        startDate { year month day }
      }
    }
  }
  recommendations(sort: RATING_DESC, perPage: 10) {
    nodes {
      rating
      mediaRecommendation {
        id
        title { romaji english native }
        coverImage { large }
        format
        episodes
        status
        meanScore
        averageScore
      }
    }
  }
  externalLinks { url site type }
  streamingEpisodes { title thumbnail url site }
`;

const RELATION_FIELDS = `
  id
  title { romaji english native }
  coverImage { large }
  bannerImage
  format
  type
  status
  episodes
  meanScore
  isAdult
  seasonYear
  startDate { year month day }
`;

// ─── Collection helper ───────────────────────────────────────────────────────

type PageGql = {
  Page: {
    pageInfo: { total: number; currentPage: number; hasNextPage: boolean; perPage: number };
    media: AnimeMedia[];
  };
};

async function fetchCollection(
  sort: string,
  status?: string,
  page = 1,
  perPage = 20,
  extra = ""
): Promise<PaginatedResult<AnimeMedia>> {
  const statusLine = status ? `, status: ${status}` : "";
  const q = `
    query ($page: Int, $perPage: Int) {
      Page(page: $page, perPage: $perPage) {
        pageInfo { total currentPage hasNextPage perPage }
        media(type: ANIME, sort: [${sort}]${statusLine}${extra}) {
          ${LIST_FIELDS}
        }
      }
    }
  `;
  const key = `col:${sort}:${status ?? ""}:${extra}:${page}:${perPage}`;
  const data = await gql<PageGql>(q, { page, perPage }, key);
  const p = data.Page;
  return {
    page: p.pageInfo.currentPage,
    perPage: p.pageInfo.perPage,
    total: p.pageInfo.total,
    hasNextPage: p.pageInfo.hasNextPage,
    results: p.media,
  };
}

// ─── Public API ──────────────────────────────────────────────────────────────

export const anilist = {
  getTrending: (page = 1, perPage = 20) =>
    fetchCollection("TRENDING_DESC", undefined, page, perPage),

  getPopular: (page = 1, perPage = 20) =>
    fetchCollection("POPULARITY_DESC", undefined, page, perPage),

  getFresh: (page = 1, perPage = 20) =>
    fetchCollection("UPDATED_AT_DESC", undefined, page, perPage),

  getLatestReleases: (page = 1, perPage = 20) =>
    fetchCollection("START_DATE_DESC", "RELEASING", page, perPage),

  getRecentlyCompleted: (page = 1, perPage = 20) =>
    fetchCollection("END_DATE_DESC", "FINISHED", page, perPage),

  getSchedule: async (page = 1, perPage = 25): Promise<PaginatedResult<AnimeMedia>> => {
    const q = `
      query ($page: Int, $perPage: Int, $now: Int) {
        Page(page: $page, perPage: $perPage) {
          pageInfo { total currentPage hasNextPage perPage }
          airingSchedules(airingAt_greater: $now, sort: TIME) {
            media {
              ${LIST_FIELDS}
            }
          }
        }
      }
    `;
    const now = Math.floor(Date.now() / 1000);
    const key = `schedule:${page}:${perPage}:${Math.floor(now / 300)}`; // 5-min bucket
    type ScheduleGql = {
      Page: {
        pageInfo: { total: number; currentPage: number; hasNextPage: boolean; perPage: number };
        airingSchedules: Array<{ media: AnimeMedia }>;
      };
    };
    const data = await gql<ScheduleGql>(q, { page, perPage, now }, key);
    const p = data.Page;
    // Deduplicate by anime id
    const seen = new Set<number>();
    const results: AnimeMedia[] = [];
    for (const s of p.airingSchedules) {
      if (s.media && !seen.has(s.media.id)) {
        seen.add(s.media.id);
        results.push(s.media);
      }
    }
    return {
      page: p.pageInfo.currentPage,
      perPage: p.pageInfo.perPage,
      total: p.pageInfo.total,
      hasNextPage: p.pageInfo.hasNextPage,
      results,
    };
  },

  getSpotlight: async (): Promise<{ results: AnimeMedia[] }> => {
    const q = `
      query {
        Page(page: 1, perPage: 10) {
          media(type: ANIME, sort: [TRENDING_DESC], status: RELEASING) {
            ${LIST_FIELDS}
          }
        }
      }
    `;
    const data = await gql<PageGql>(q, undefined, "spotlight");
    return { results: data.Page.media };
  },

  getAnime: async (id: number): Promise<{ id: number; info: AnimeMedia; streaming: unknown }> => {
    const q = `
      query ($id: Int) {
        Media(id: $id, type: ANIME) {
          ${FULL_FIELDS}
        }
      }
    `;
    const key = `anime:${id}`;
    type AnimeGql = { Media: AnimeMedia };
    const data = await gql<AnimeGql>(q, { id }, key);
    const media = data.Media;
    return {
      id: media.id,
      info: media,
      streaming: {
        has_episodes: false,
        total_episodes: media.episodes ?? 0,
        status: media.status,
        episodes_url: `/api/anime/${id}/episodes`,
        stream_url: `/api/anime/${id}/stream`,
      },
    };
  },

  getRelations: async (id: number) => {
    const q = `
      query ($id: Int) {
        Media(id: $id, type: ANIME) {
          id
          title { romaji english }
          relations {
            edges {
              relationType(version: 2)
              node { ${RELATION_FIELDS} }
            }
          }
        }
      }
    `;
    const key = `relations:${id}`;
    type RelGql = { Media: { id: number; title: AnimeMedia["title"]; relations: { edges: unknown[] } } };
    const data = await gql<RelGql>(q, { id }, key);
    const media = data.Media;
    return {
      id: media.id,
      title: media.title,
      relations: media.relations?.edges ?? [],
    };
  },

  getRecommendations: async (id: number, page = 1, perPage = 12) => {
    const q = `
      query ($id: Int, $page: Int, $perPage: Int) {
        Media(id: $id, type: ANIME) {
          recommendations(sort: RATING_DESC, page: $page, perPage: $perPage) {
            pageInfo { total currentPage hasNextPage perPage }
            nodes {
              rating
              mediaRecommendation {
                id
                title { romaji english native }
                coverImage { large }
                format
                episodes
                status
                meanScore
                averageScore
              }
            }
          }
        }
      }
    `;
    const key = `recs:${id}:${page}:${perPage}`;
    type RecGql = { Media: { recommendations: { nodes: Array<{ rating: number; mediaRecommendation: AnimeMedia }> } } };
    const data = await gql<RecGql>(q, { id, page, perPage }, key);
    return { recommendations: data.Media.recommendations.nodes };
  },

  search: async (params: {
    q?: string;
    page?: number;
    perPage?: number;
    genre?: string;
    format?: string;
    status?: string;
    year?: number;
    season?: string;
    sort?: string;
  }): Promise<PaginatedResult<AnimeMedia>> => {
    const args: string[] = ["type: ANIME", "isAdult: false"];
    const vars: Record<string, unknown> = {
      page: params.page ?? 1,
      perPage: params.perPage ?? 20,
    };
    const varDefs: string[] = ["$page: Int", "$perPage: Int"];

    if (params.q) { args.push("search: $search"); vars.search = params.q; varDefs.push("$search: String"); }
    if (params.genre) { args.push("genre_in: $genreIn"); vars.genreIn = params.genre.split(",").map(g => g.trim()); varDefs.push("$genreIn: [String]"); }
    if (params.format) { args.push("format: $format"); vars.format = params.format; varDefs.push("$format: MediaFormat"); }
    if (params.status) { args.push("status: $status"); vars.status = params.status; varDefs.push("$status: MediaStatus"); }
    if (params.year) { args.push("seasonYear: $year"); vars.year = params.year; varDefs.push("$year: Int"); }
    if (params.season) { args.push("season: $season"); vars.season = params.season; varDefs.push("$season: MediaSeason"); }

    const sortKey = params.sort ?? (params.q ? "SEARCH_MATCH" : "POPULARITY_DESC");
    args.push(`sort: [${sortKey}]`);

    const q = `
      query (${varDefs.join(", ")}) {
        Page(page: $page, perPage: $perPage) {
          pageInfo { total currentPage hasNextPage perPage }
          media(${args.join(", ")}) {
            ${LIST_FIELDS}
          }
        }
      }
    `;
    const key = `search:${JSON.stringify(params)}`;
    const data = await gql<PageGql>(q, vars, key);
    const p = data.Page;
    return {
      page: p.pageInfo.currentPage,
      perPage: p.pageInfo.perPage,
      total: p.pageInfo.total,
      hasNextPage: p.pageInfo.hasNextPage,
      results: p.media,
    };
  },

  filter: async (params: {
    genre?: string;
    tag?: string;
    year?: number;
    season?: string;
    format?: string;
    status?: string;
    sort?: string;
    page?: number;
    perPage?: number;
    q?: string;
    letter?: string;
  }): Promise<PaginatedResult<AnimeMedia>> => {
    // Delegate to search — AniList has no separate filter endpoint
    return anilist.search({
      q: params.q,
      page: params.page,
      perPage: params.perPage,
      genre: params.genre,
      format: params.format,
      status: params.status,
      year: params.year,
      season: params.season,
      sort: params.sort ?? "POPULARITY_DESC",
    });
  },

  getSuggestions: async (q: string): Promise<{ results: AnimeMedia[] }> => {
    const query = `
      query ($search: String) {
        Page(page: 1, perPage: 8) {
          media(type: ANIME, search: $search, sort: [SEARCH_MATCH], isAdult: false) {
            id
            idMal
            title { romaji english native }
            coverImage { large }
            format
            episodes
            status
            averageScore
          }
        }
      }
    `;
    const key = `suggest:${q}`;
    const data = await gql<PageGql>(query, { search: q }, key);
    // Remap so .id is the MAL id when available (site routes by MAL id)
    const media = data.Page.media.map((m) => {
      const raw = m as AnimeMedia & { idMal?: number };
      if (raw.idMal) return { ...m, id: raw.idMal };
      return m;
    });
    return { results: media };
  },

  getGenres: async (): Promise<GenreData> => {
    // AniList has a GenreCollection query
    const q = `query { GenreCollection }`;
    type GenreGql = { GenreCollection: string[] };
    const data = await gql<GenreGql>(q, undefined, "genres");
    return {
      genres: data.GenreCollection,
      formats: ["TV", "TV_SHORT", "MOVIE", "SPECIAL", "OVA", "ONA", "MUSIC"],
      statuses: ["RELEASING", "FINISHED", "NOT_YET_RELEASED", "CANCELLED", "HIATUS"],
      seasons: ["WINTER", "SPRING", "SUMMER", "FALL"],
    };
  },

  /**
   * Build an episode list from AniList data only — no backend involved.
   *
   * Uses `streamingEpisodes` for titles/thumbnails when available
   * (AniList aggregates these from Crunchyroll, HiDive, etc.).
   * Falls back to numbered placeholders using the `episodes` count.
   * Episode id format is `ep:{number}` — the backend resolves these
   * on-demand to megaplay stream URLs without needing the full pipe
   * episode list on every page load.
   */
  getEpisodeList: async (anilistId: number): Promise<{ sub: EpisodeEntry[]; dub: EpisodeEntry[] }> => {
    const q = `
      query EpisodeList($id: Int) {
        Media(id: $id, type: ANIME) {
          episodes
          streamingEpisodes {
            title
            thumbnail
            url
            site
          }
        }
      }
    `;
    type EpGql = {
      Media: {
        episodes: number | null;
        streamingEpisodes: { title: string; thumbnail: string; url: string; site: string }[];
      };
    };
    const data = await gql<EpGql>(q, { id: anilistId }, `eps:${anilistId}`);
    const { episodes: count, streamingEpisodes: streaming } = data.Media;

    const total = count ?? streaming.length;
    const list: EpisodeEntry[] = [];

    for (let n = 1; n <= total; n++) {
      // streamingEpisodes are 0-indexed; try to match by position
      const meta = streaming[n - 1];
      list.push({
        id: `ep:${n}`,
        original_id: `ep:${n}`,
        number: n,
        title: meta?.title || `Episode ${n}`,
        image: meta?.thumbnail || undefined,
      });
    }

    // AniList doesn't know which episodes have dub — return empty dub list.
    // The real dub count comes from the batch /api/episode-counts endpoint (pipe).
    return { sub: list, dub: [] };
  },
};

export interface EpisodeEntry {
  id: string;
  original_id: string;
  number: number;
  title: string;
  image?: string;
  description?: string;
  airDate?: string;
}
