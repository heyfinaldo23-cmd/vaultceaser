const DEFAULT_BACKEND_URL = "http://37.114.37.107:8080";
const PUBLIC_BACKEND_URL = (
  process.env.NEXT_PUBLIC_BACKEND_URL || DEFAULT_BACKEND_URL
).replace(/\/$/, "");
const SERVER_BACKEND_URL = (
  process.env.BACKEND_URL ||
  process.env.NEXT_PUBLIC_BACKEND_URL ||
  DEFAULT_BACKEND_URL
).replace(/\/$/, "");

// Server-side calls go directly to FastAPI. Browser calls stay same-origin so
// Next can proxy API and player paths through /api/*.
const BASE_URL =
  typeof window === "undefined"
    ? SERVER_BACKEND_URL
    : "";

export interface AnimeMedia {
  id: number;
  type?: string;
  title: {
    romaji?: string;
    english?: string;
    native?: string;
  };
  coverImage?: {
    large?: string;
    extraLarge?: string;
    color?: string;
  };
  bannerImage?: string;
  format?: string;
  season?: string;
  // AniList fields
  seasonYear?: number;
  averageScore?: number;
  meanScore?: number;
  // Jikan fields (overlap-safe — use score/year in components)
  score?: number;
  year?: number;
  rank?: number;
  airing?: boolean;
  aired?: string;
  broadcast?: string;
  rating?: string;
  // studios: AniList shape {nodes:[...]} OR Jikan string[]
  studios?: {
    nodes?: Array<{ id: number; name: string; isAnimationStudio: boolean }>;
  } | string[];
  episodes?: number | null;
  // duration: AniList number (minutes) OR Jikan string "24 min"
  duration?: number | string;
  status?: string;
  popularity?: number;
  favourites?: number;
  genres?: string[];
  countryOfOrigin?: string;
  source?: string;
  isAdult?: boolean;
  nextAiringEpisode?: {
    episode: number;
    airingAt: number;
    timeUntilAiring: number;
  };
  startDate?: { year?: number; month?: number; day?: number };
  endDate?: { year?: number; month?: number; day?: number };
  description?: string;
  synonyms?: string[];
  siteUrl?: string;
  trailer?: { id?: string; site?: string; thumbnail?: string } | string;
  tags?: Array<{ name: string; rank: number; isMediaSpoiler: boolean }>;
  characters?: {
    edges?: Array<{
      role: string;
      node: {
        id: number;
        name: { full: string; native?: string };
        image?: { large?: string };
      };
      voiceActors?: Array<{
        id: number;
        name: { full: string };
        image?: { large?: string };
        languageV2?: string;
      }>;
    }>;
  };
  relations?: {
    edges?: Array<{
      relationType: string;
      node: AnimeMedia;
    }>;
  };
  recommendations?: {
    nodes?: Array<{
      rating: number;
      mediaRecommendation: AnimeMedia;
    }>;
  };
  externalLinks?: Array<{ url: string; site: string; type?: string }>;
  streamingEpisodes?: Array<{ title: string; thumbnail: string; url: string; site: string }>;
  // mal_id alias
  mal_id?: number;
}

export interface PaginatedResult<T> {
  page: number;
  perPage: number;
  total: number;
  hasNextPage: boolean;
  results: T[];
}

export interface HomepageData {
  trending_airing: PaginatedResult<AnimeMedia>;
  popular_upcoming: PaginatedResult<AnimeMedia>;
  recent_episodes: PaginatedResult<AnimeMedia>;
  all_time_popular: PaginatedResult<AnimeMedia>;
  top_movies: unknown[];
  schedule: unknown[];
}

export interface EpisodeData {
  id: string;
  number: number;
  title?: string;
  image?: string;
  airDate?: string;
  description?: string;
  duration?: number;
  filler?: boolean;
  original_id?: string;
  stream_url?: string;
  stream_type?: string;
}

export interface GenreData {
  genres: string[];
  formats: string[];
  statuses: string[];
  seasons: string[];
}

export interface AnimeEpisodesResponse {
  id: number;
  providers?: {
    megaplay?: {
      episodes?: {
        sub?: EpisodeData[];
        dub?: EpisodeData[];
        ssub?: EpisodeData[];
      };
    };
  };
  released?: {
    sub?: number;
    dub?: number;
  };
}

async function fetchAPI<T>(path: string, options?: RequestInit): Promise<T> {
  const url = BASE_URL
    ? new URL(path, `${BASE_URL}/`)
    : new URL(path, window.location.origin);
  if (!url.searchParams.has("_")) {
    url.searchParams.set("_", String(Date.now()));
  }

  const res = await fetch(url.toString(), {
    ...options,
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...options?.headers,
    },
  });
  if (!res.ok) {
    throw new Error(`API error: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

export const api = {
  // Homepage
  getHomepage: () => fetchAPI<HomepageData>("/api/homepage"),

  // Spotlight (hero banner)
  getSpotlight: () =>
    fetchAPI<{ results: AnimeMedia[] }>("/api/spotlight"),

  // Trending
  getTrending: (page = 1, perPage = 10) =>
    fetchAPI<PaginatedResult<AnimeMedia>>(
      `/api/trending?page=${page}&per_page=${perPage}`
    ),

  // Popular
  getPopular: (page = 1, perPage = 20) =>
    fetchAPI<PaginatedResult<AnimeMedia>>(
      `/api/popular?page=${page}&per_page=${perPage}`
    ),

  // Upcoming
  getUpcoming: (page = 1, perPage = 20) =>
    fetchAPI<PaginatedResult<AnimeMedia>>(
      `/api/upcoming?page=${page}&per_page=${perPage}`
    ),

  // Recent
  getRecent: (page = 1, perPage = 20) =>
    fetchAPI<PaginatedResult<AnimeMedia>>(
      `/api/recent?page=${page}&per_page=${perPage}`
    ),

  // Fresh Additions (UPDATED_AT_DESC — newly added/updated on the platform)
  getFresh: (page = 1, perPage = 20) =>
    fetchAPI<PaginatedResult<AnimeMedia>>(
      `/api/fresh?page=${page}&per_page=${perPage}`
    ),

  // Latest Releases (currently airing, ordered by start date)
  getLatestReleases: (page = 1, perPage = 20) =>
    fetchAPI<PaginatedResult<AnimeMedia>>(
      `/api/latest-releases?page=${page}&per_page=${perPage}`
    ),

  // Recently Completed
  getRecentlyCompleted: (page = 1, perPage = 20) =>
    fetchAPI<PaginatedResult<AnimeMedia>>(
      `/api/recently-completed?page=${page}&per_page=${perPage}`
    ),

  // Schedule
  getSchedule: (page = 1, perPage = 20) =>
    fetchAPI<PaginatedResult<AnimeMedia>>(
      `/api/schedule?page=${page}&per_page=${perPage}`
    ),

  // Search
  search: (params: {
    q?: string;
    page?: number;
    perPage?: number;
    genre?: string;
    format?: string;
    status?: string;
    year?: number;
    season?: string;
    sort?: string;
  }) => {
    const qs = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== "") {
        qs.set(key, String(value));
      }
    });
    return fetchAPI<PaginatedResult<AnimeMedia>>(
      `/api/search?${qs.toString()}`
    );
  },

  // Suggestions (autocomplete)
  getSuggestions: (q: string) =>
    fetchAPI<{ results: AnimeMedia[] }>(`/api/suggestions?q=${encodeURIComponent(q)}`),

  // Filter/Browse
  filter: (params: {
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
  }) => {
    const qs = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== "") {
        qs.set(key, String(value));
      }
    });
    return fetchAPI<PaginatedResult<AnimeMedia>>(
      `/api/filter?${qs.toString()}`
    );
  },

  // Genres
  getGenres: () => fetchAPI<GenreData>("/api/genres"),

  // Anime Detail
  getAnime: (id: number) =>
    fetchAPI<{ id: number; info: AnimeMedia; streaming: unknown }>(
      `/api/anime/${id}`
    ),

  getRelations: (id: number) =>
    fetchAPI<{
      id: number;
      title: AnimeMedia["title"];
      relations: AnimeMedia["relations"] extends { edges?: infer E } ? E : never;
    }>(`/api/anime/${id}/relations`),

  // Released sub/dub counts (batch, max 30)
  getEpisodeCounts: (ids: number[], refresh = false) => {
    const qs = new URLSearchParams({ ids: ids.join(",") });
    if (refresh) qs.set("refresh", "true");
    return fetchAPI<{ counts: Record<string, { sub: number; dub: number }> }>(
      `/api/episode-counts?${qs.toString()}`
    );
  },

  // Episodes
  getEpisodes: (id: number) =>
    fetchAPI<AnimeEpisodesResponse>(`/api/anime/${id}/episodes`),

  // Recommendations
  getRecommendations: (id: number, page = 1, perPage = 10) =>
    fetchAPI<{
      recommendations: Array<{
        rating: number;
        mediaRecommendation: AnimeMedia;
      }>;
    }>(`/api/anime/${id}/recommendations?page=${page}&per_page=${perPage}`),

  // Stream URL
  getStreamUrl: (episodeId: string, category = "sub", anilistId?: number) => {
    const qs = new URLSearchParams({ episode_id: episodeId, category });
    if (anilistId) qs.set("anilist_id", String(anilistId));
    return fetchAPI<{ url: string; type: string; tracks: unknown[]; intro: unknown; outro: unknown }>(
      `/api/stream/url?${qs.toString()}`
    );
  },

  getStreamIframe: (
    episodeId: string,
    category = "sub",
    anilistId?: number,
    options?: { synthetic?: boolean }
  ) => {
    const qs = new URLSearchParams({
      episode_id: episodeId,
      category,
    });
    if (anilistId != null) qs.set("anilist_id", String(anilistId));
    if (options?.synthetic) qs.set("synthetic", "1");
    return fetchAPI<{
      iframe_url: string;
      embed_html: string;
      upstream_iframe_url: string;
      embed_s2_mode: string;
    }>(`/api/stream/iframe?${qs.toString()}`);
  },
};

export const API_BASE = BASE_URL;

/** Normalize score to 0-100 range for display. Jikan = 0-10, AniList = 0-100. */
export function normalizeScore(media: AnimeMedia): number | null {
  const s = media.score ?? media.averageScore ?? media.meanScore;
  if (!s) return null;
  // Jikan scores are 0-10, AniList 0-100. Anything ≤ 10 is Jikan.
  return s <= 10 ? Math.round(s * 10) : s;
}

/** Get display year from Jikan `year` or AniList `seasonYear`. */
export function mediaYear(media: AnimeMedia): number | null {
  return media.year ?? media.seasonYear ?? media.startDate?.year ?? null;
}

/** Get studio names from either Jikan string[] or AniList nodes shape. */
export function mediaStudios(media: AnimeMedia): string[] {
  if (!media.studios) return [];
  if (Array.isArray(media.studios)) return media.studios;
  return (media.studios.nodes ?? [])
    .filter((s) => s.isAnimationStudio !== false)
    .map((s) => s.name);
}

export function resolveStreamIframeUrl(iframeUrl: string): string {
  if (typeof window !== "undefined") {
    try {
      const parsed = new URL(iframeUrl);
      const backend = new URL(PUBLIC_BACKEND_URL);
      if (parsed.origin === backend.origin && parsed.pathname.startsWith("/api/")) {
        const current = new URL(window.location.origin);
        parsed.protocol = current.protocol;
        parsed.host = current.host;
        return parsed.toString();
      }
    } catch {
    }
  }

  if (iframeUrl.startsWith("http://") || iframeUrl.startsWith("https://")) {
    return iframeUrl;
  }
  if (BASE_URL) {
    const base = BASE_URL.replace(/\/$/, "");
    return `${base}${iframeUrl.startsWith("/") ? "" : "/"}${iframeUrl}`;
  }
  // Browser: same-origin
  return iframeUrl.startsWith("/") ? iframeUrl : `/${iframeUrl}`;
}
