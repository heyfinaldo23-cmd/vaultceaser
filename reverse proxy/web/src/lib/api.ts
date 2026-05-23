// Types and utility functions for anime media data.
// All data fetching is handled by src/lib/otakubox.ts.

export interface AnimeMedia {
  id: number | undefined;
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
  seasonYear?: number;
  averageScore?: number;
  meanScore?: number;
  score?: number;
  year?: number;
  rank?: number;
  airing?: boolean;
  studios?: {
    nodes?: Array<{ id: number; name: string; isAnimationStudio: boolean }>;
  } | string[];
  episodes?: number | null;
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

/** Normalize score to 0-100 range for display. Jikan = 0-10, AniList = 0-100. */
export function normalizeScore(media: AnimeMedia): number | null {
  const s = media.score ?? media.averageScore ?? media.meanScore;
  if (!s) return null;
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
