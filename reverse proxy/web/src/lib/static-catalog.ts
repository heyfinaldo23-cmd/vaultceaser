import catalog from "@/data/static-catalog.json";
import type { AnimeMedia, GenreData, HomepageData, PaginatedResult } from "@/lib/api";

type StaticCatalog = {
  generatedAt: string;
  media: Array<AnimeMedia & { staticDetailed?: boolean; synonyms?: string[] }>;
  sections: Record<string, number[]>;
  genres: string[];
};

const data = catalog as StaticCatalog;
const allMedia = data.media.filter((item) => item?.id && !item.isAdult);
const mediaById = new Map(allMedia.map((item) => [item.id, item]));

const SEARCH_ALIASES: Record<string, string> = {
  jjk: "jujutsu kaisen",
  "jujustu kaisen": "jujutsu kaisen",
  jujustu: "jujutsu kaisen",
  jujutsu: "jujutsu kaisen",
  aot: "attack on titan",
  snk: "attack on titan",
  "demon slayer": "kimetsu no yaiba",
  kimetsu: "kimetsu no yaiba",
  mha: "boku no hero academia",
  "my hero academia": "boku no hero academia",
  rezero: "re zero",
};

const DEFAULT_GENRES = [
  "Action", "Adventure", "Comedy", "Drama", "Fantasy", "Horror", "Mystery",
  "Romance", "Sci-Fi", "Slice of Life", "Sports", "Supernatural", "Suspense",
  "Ecchi", "Mecha", "Music", "Psychological", "Historical", "School",
  "Isekai", "Demons", "Game", "Magic", "Martial Arts", "Samurai",
];

const FORMATS = ["TV", "Movie", "OVA", "ONA", "Special"];
const STATUSES = ["Airing", "Finished Airing", "Not yet aired"];
const SEASONS = ["winter", "spring", "summer", "fall"];

function normalize(value: unknown): string {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function titleText(item: AnimeMedia): string {
  return [item.title?.english, item.title?.romaji, item.title?.native, ...(item.synonyms || [])]
    .filter(Boolean)
    .join(" ");
}

function queryOf(value: unknown): string {
  const q = normalize(value);
  return SEARCH_ALIASES[q] || q;
}

function pageParams(searchParams: URLSearchParams) {
  const page = Math.max(1, Number(searchParams.get("page") || "1"));
  const perPage = Math.min(
    50,
    Math.max(1, Number(searchParams.get("perPage") || searchParams.get("per_page") || "20")),
  );
  return { page, perPage };
}

function paginate<T>(items: T[], page: number, perPage: number): PaginatedResult<T> {
  const start = (page - 1) * perPage;
  const results = items.slice(start, start + perPage);
  return {
    page,
    perPage,
    total: items.length,
    hasNextPage: start + perPage < items.length,
    results,
  };
}

function scoreSearch(item: AnimeMedia, q: string): number {
  if (!q) return 0;
  const title = normalize(titleText(item));
  if (title === q) return 1000;
  if (title.startsWith(q)) return 800;
  if (title.includes(q)) return 600;
  const words = q.split(" ").filter(Boolean);
  if (words.length && words.every((word) => title.includes(word))) return 450;
  return 0;
}

function matchesFilters(item: AnimeMedia, searchParams: URLSearchParams): boolean {
  const genreParam = searchParams.get("genre") || searchParams.get("tag") || "";
  const format = normalize(searchParams.get("format"));
  const status = normalize(searchParams.get("status"));
  const season = normalize(searchParams.get("season"));
  const year = Number(searchParams.get("year") || 0);

  if (genreParam) {
    const wanted = genreParam.split(",").map(normalize).filter(Boolean);
    const genres = (item.genres || []).map(normalize);
    if (wanted.length && !wanted.every((genre) => genres.includes(genre))) return false;
  }
  if (format && normalize(item.format) !== format) return false;
  if (status) {
    const itemStatus = normalize(item.status);
    if (status === "releasing" && !["airing", "currently airing"].includes(itemStatus)) return false;
    else if (status === "finished" && !itemStatus.includes("finished")) return false;
    else if (status === "not yet released" && !itemStatus.includes("not yet")) return false;
    else if (!["releasing", "finished", "not yet released"].includes(status) && itemStatus !== status) return false;
  }
  if (season && normalize(item.season) !== season) return false;
  if (year && item.year !== year && item.seasonYear !== year && item.startDate?.year !== year) return false;
  return true;
}

function sortMedia(items: AnimeMedia[], sort = "POPULARITY_DESC"): AnimeMedia[] {
  const out = [...items];
  const number = (value: unknown, fallback: number) =>
    typeof value === "number" && Number.isFinite(value) ? value : fallback;
  switch (sort) {
    case "SCORE_DESC":
      return out.sort((a, b) => number(b.score ?? b.averageScore, -1) - number(a.score ?? a.averageScore, -1));
    case "START_DATE_DESC":
    case "UPDATED_AT_DESC":
      return out.sort((a, b) => number(b.year ?? b.seasonYear, 0) - number(a.year ?? a.seasonYear, 0));
    case "POPULARITY_ASC":
      return out.sort((a, b) => number(b.popularity, 999999) - number(a.popularity, 999999));
    case "TRENDING_DESC":
    case "POPULARITY_DESC":
    default:
      return out.sort((a, b) => number(a.popularity, 999999) - number(b.popularity, 999999));
  }
}

function sectionItems(key: string): AnimeMedia[] {
  const ids = data.sections[key] || [];
  return ids.map((id) => mediaById.get(id)).filter(Boolean) as AnimeMedia[];
}

export function staticSearch(searchParams: URLSearchParams): PaginatedResult<AnimeMedia> {
  const { page, perPage } = pageParams(searchParams);
  const q = queryOf(searchParams.get("q"));
  const sort = searchParams.get("sort") || "SEARCH_MATCH";
  let items = allMedia.filter((item) => matchesFilters(item, searchParams));
  if (q) {
    items = items
      .map((item) => ({ item, score: scoreSearch(item, q) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        const detailed = Number(Boolean(b.item.staticDetailed)) - Number(Boolean(a.item.staticDetailed));
        if (detailed !== 0) return detailed;
        return (a.item.popularity ?? 999999) - (b.item.popularity ?? 999999);
      })
      .map(({ item }) => item);
  } else {
    items = sortMedia(items, sort);
  }
  return paginate(items, page, perPage);
}

export function staticFilter(searchParams: URLSearchParams): PaginatedResult<AnimeMedia> {
  return staticSearch(searchParams);
}

export function staticSection(key: string, searchParams: URLSearchParams): PaginatedResult<AnimeMedia> {
  const { page, perPage } = pageParams(searchParams);
  const items = sectionItems(key);
  return paginate(items, page, perPage);
}

export function staticHomepage(): HomepageData {
  return {
    trending_airing: paginate(sectionItems("trending"), 1, 12),
    popular_upcoming: paginate(sectionItems("upcoming"), 1, 12),
    recent_episodes: paginate(sectionItems("recent"), 1, 12),
    all_time_popular: paginate(sectionItems("popular"), 1, 12),
    top_movies: [],
    schedule: [],
  };
}

export function staticSuggestions(searchParams: URLSearchParams) {
  const q = queryOf(searchParams.get("q"));
  if (!q) return { results: [] };
  const params = new URLSearchParams({ q, page: "1", perPage: "8" });
  return { results: staticSearch(params).results.slice(0, 8) };
}

export function staticGenres(): GenreData {
  return {
    genres: [...new Set([...DEFAULT_GENRES, ...(data.genres || [])])].sort((a, b) => a.localeCompare(b)),
    formats: FORMATS,
    statuses: STATUSES,
    seasons: SEASONS,
  };
}

export function staticAnime(id: number) {
  const info = mediaById.get(id);
  if (!info) return null;
  return { id, info, streaming: null };
}

export function staticRelations(id: number) {
  const info = mediaById.get(id);
  return {
    id,
    title: info?.title || { english: "", romaji: "", native: null },
    relations: info?.relations?.edges || [],
  };
}

export function staticRecommendations(id: number, searchParams: URLSearchParams) {
  const { page, perPage } = pageParams(searchParams);
  const info = mediaById.get(id);
  const genres = new Set((info?.genres || []).map(normalize));
  const candidates = sortMedia(
    allMedia.filter((item) => item.id !== id && (item.genres || []).some((genre) => genres.has(normalize(genre)))),
    "POPULARITY_DESC",
  );
  return {
    recommendations: paginate(candidates, page, perPage).results.map((mediaRecommendation) => ({
      rating: 0,
      mediaRecommendation,
    })),
  };
}

export function staticMeta() {
  return {
    generatedAt: data.generatedAt,
    total: allMedia.length,
    detailed: allMedia.filter((item) => item.staticDetailed).length,
  };
}
