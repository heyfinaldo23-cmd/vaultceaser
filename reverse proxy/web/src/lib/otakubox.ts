import type { AnimeMedia } from "@/lib/api";

const BASE = "https://otakubox.otakuboxapi.workers.dev";
const ANILIST_GQL = "https://graphql.anilist.co";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface OtakuCard {
  id: number;
  custom_id: string;
  anilist_id: number | null;
  title: string;
  cover: string;
  banner?: string;
  year?: number;
  season?: string;
  type: string;
  status: string;
  genres: string[];
  score?: number;
  sub_count: number;
  dub_count: number;
  episode_count: number;
  streamable: boolean;
}

export interface OtakuShow extends OtakuCard {
  description?: string;
  studios?: string[];
  next_airing?: { episode: number; timeUntilAiring: number } | null;
  synonyms?: string[];
  anikoto_id?: number;
}

export interface OtakuEpisode {
  id: string; // "ani:{anilist_id}:{episode_num}" or "s2:{db_row_id}:{episode_num}"
  episode_num: string;
  title?: string;
  has_sub: boolean;
  has_dub: boolean;
}

export interface OtakuRelationNode {
  id: number;
  anilist_id: number;
  custom_id: string;
  title: string;
  cover?: string;
  type?: string;
  year?: number;
  streamable: boolean;
}

export interface OtakuRelationEdge {
  from: number;
  to: number;
  relationType: string;
}

export interface OtakuSearchParams {
  q?: string;
  genre?: string;
  year?: number | string;
  season?: string;
  type?: string;
  status?: string;
  lang?: string;
  sort?: string;
  page?: number;
  limit?: number;
}

// Raw shape returned by /all-relations endpoint
type RawRelEntry = {
  relation: string;
  id: number;
  title: string;
  cover?: string;
  format?: string;
  status?: string;
  year?: number;
  streamable: boolean;
};

type RawRelItem = {
  id: number;
  title: string;
  cover?: string;
  format?: string;
  streamable: boolean;
  relations: RawRelEntry[];
};

// ─── ID resolver: handles custom_id pattern "ani_{anilist_id}" ────────────────

export function resolveAnilistId(card: Pick<OtakuCard, "anilist_id" | "custom_id">): number | null {
  if (card.anilist_id) return card.anilist_id;
  if (card.custom_id?.startsWith("ani_")) {
    const n = Number(card.custom_id.slice(4));
    return n || null;
  }
  return null;
}

// ─── Core fetch with retry ────────────────────────────────────────────────────

type ApiOk<T> = { ok: true; data: T };
type ApiErr = { ok: false; error: string; status: number };
type ApiRes<T> = ApiOk<T> | ApiErr;

async function get<T>(
  path: string,
  params?: Record<string, string | number | undefined>,
  attempt = 0
): Promise<T> {
  const url = new URL(`${BASE}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v != null && String(v) !== "") url.searchParams.set(k, String(v));
    }
  }
  const res = await fetch(url.toString(), { cache: "no-store" });

  // Retry on HTTP 429
  if (res.status === 429 && attempt < 3) {
    await new Promise((r) => setTimeout(r, (attempt + 1) * 1000));
    return get<T>(path, params, attempt + 1);
  }

  if (!res.ok) throw new Error(`Otakubox ${res.status}: ${path}`);
  const json = (await res.json()) as ApiRes<T>;

  // Retry when Otakubox itself got rate-limited by AniList
  if (!json.ok) {
    const bodyStatus = (json as ApiErr).status;
    if (bodyStatus === 429 && attempt < 3) {
      await new Promise((r) => setTimeout(r, (attempt + 1) * 1500));
      return get<T>(path, params, attempt + 1);
    }
    throw new Error((json as ApiErr).error || "Otakubox error");
  }

  return json.data;
}

// ─── AniList direct fallback (used when Otakubox hits AniList rate limit) ─────

const AL_SHOW_QUERY = `
query ($id: Int) {
  Media(id: $id, type: ANIME) {
    id title { english romaji }
    coverImage { large extraLarge }
    bannerImage format status season seasonYear episodes
    averageScore description genres
    studios { nodes { id name isAnimationStudio } }
    nextAiringEpisode { episode airingAt timeUntilAiring }
    synonyms
  }
}`;

async function anilistGetShow(id: number): Promise<OtakuShow> {
  const res = await fetch(ANILIST_GQL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query: AL_SHOW_QUERY, variables: { id } }),
    cache: "no-store",
  });
  const json = await res.json() as { data?: { Media?: Record<string, unknown> } };
  const m = json.data?.Media as {
    id: number; title?: { english?: string; romaji?: string };
    coverImage?: { large?: string; extraLarge?: string };
    bannerImage?: string; format?: string; status?: string;
    season?: string; seasonYear?: number; episodes?: number;
    averageScore?: number; description?: string; genres?: string[];
    studios?: { nodes?: Array<{ id: number; name: string; isAnimationStudio: boolean }> };
    nextAiringEpisode?: { episode: number; airingAt: number; timeUntilAiring: number } | null;
    synonyms?: string[];
  } | undefined;
  if (!m) throw new Error("Not found on AniList");
  return {
    id: 0,
    custom_id: `ani_${id}`,
    anilist_id: m.id,
    title: m.title?.english || m.title?.romaji || "Unknown",
    cover: m.coverImage?.large || m.coverImage?.extraLarge || "",
    banner: m.bannerImage || undefined,
    year: m.seasonYear,
    season: m.season?.toLowerCase(),
    type: m.format || "TV",
    status: m.status || "UNKNOWN",
    genres: m.genres || [],
    score: m.averageScore ? m.averageScore / 10 : undefined,
    sub_count: 0,
    dub_count: 0,
    episode_count: m.episodes || 0,
    streamable: true,
    description: m.description || undefined,
    studios: m.studios?.nodes?.map((n) => n.name) || [],
    next_airing: m.nextAiringEpisode || null,
    synonyms: m.synonyms || [],
  };
}

// ─── Adapter: OtakuCard/Show → AnimeMedia ─────────────────────────────────────

export function cardToMedia(card: OtakuCard): AnimeMedia {
  const show = card as OtakuShow;
  const resolvedId = resolveAnilistId(card) ?? undefined;
  return {
    id: resolvedId,
    title: { english: card.title, romaji: card.title },
    coverImage: { large: card.cover, extraLarge: card.cover },
    bannerImage: card.banner,
    format: card.type as AnimeMedia["format"],
    season: card.season?.toUpperCase() as AnimeMedia["season"],
    seasonYear: card.year,
    year: card.year,
    averageScore: card.score ? Math.round(card.score * 10) : undefined,
    score: card.score,
    status: card.status,
    genres: card.genres || [],
    episodes: card.episode_count || undefined,
    description: show.description,
    synonyms: show.synonyms,
    studios: show.studios
      ? {
          nodes: show.studios.map((s) => ({
            id: 0,
            name: s,
            isAnimationStudio: true,
          })),
        }
      : undefined,
    nextAiringEpisode: show.next_airing
      ? {
          episode: show.next_airing.episode,
          airingAt: 0,
          timeUntilAiring: show.next_airing.timeUntilAiring,
        }
      : undefined,
  };
}

// ─── Relations parser ─────────────────────────────────────────────────────────

function parseRelations(raw: RawRelItem[]): { nodes: OtakuRelationNode[]; edges: OtakuRelationEdge[] } {
  const nodeMap = new Map<number, OtakuRelationNode>();
  const edges: OtakuRelationEdge[] = [];

  const upsertNode = (id: number, title: string, cover?: string, type?: string, year?: number, streamable = false) => {
    const existing = nodeMap.get(id);
    if (!existing) {
      nodeMap.set(id, { id, anilist_id: id, custom_id: String(id), title, cover, type, year, streamable });
    } else {
      if (cover && !existing.cover) existing.cover = cover;
      if (type && !existing.type) existing.type = type;
      if (year && !existing.year) existing.year = year;
    }
  };

  for (const item of raw) {
    upsertNode(item.id, item.title, item.cover, item.format, undefined, item.streamable);
    for (const rel of item.relations || []) {
      upsertNode(rel.id, rel.title, rel.cover, rel.format, rel.year, rel.streamable);
      edges.push({ from: item.id, to: rel.id, relationType: rel.relation });
    }
  }

  return { nodes: Array.from(nodeMap.values()), edges };
}

// ─── Season chain builder ─────────────────────────────────────────────────────

const SEASON_REL = new Set(["SEQUEL", "PREQUEL"]);
// Exclude these from the season rail — they're not proper "seasons"
const NON_SEASON_FORMATS = new Set(["MOVIE", "OVA", "SPECIAL", "MUSIC", "ONE_SHOT", "MANGA", "NOVEL"]);

export function buildSeasonChain(
  currentId: number,
  nodes: OtakuRelationNode[],
  edges: OtakuRelationEdge[]
): OtakuRelationNode[] {
  const adj = new Map<number, number[]>();
  for (const e of edges) {
    if (!SEASON_REL.has(e.relationType)) continue;
    const push = (a: number, b: number) => {
      if (!adj.has(a)) adj.set(a, []);
      adj.get(a)!.push(b);
    };
    push(e.from, e.to);
    push(e.to, e.from);
  }
  const connected = new Set<number>([currentId]);
  const queue = [currentId];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const nb of adj.get(cur) || []) {
      if (!connected.has(nb)) {
        connected.add(nb);
        queue.push(nb);
      }
    }
  }
  // Include node if connected AND not an explicitly non-season format, then sort by air year
  return nodes
    .filter((n) => connected.has(n.anilist_id) && !NON_SEASON_FORMATS.has(n.type ?? ""))
    .sort((a, b) => (a.year ?? 9999) - (b.year ?? 9999));
}

/** Returns the anilist_id of the next node after currentId via a SEQUEL edge. */
export function findNextInChain(
  currentId: number,
  edges: OtakuRelationEdge[]
): number | null {
  const next = edges.find(
    (e) => e.from === currentId && e.relationType === "SEQUEL"
  );
  return next?.to ?? null;
}

// ─── API methods ──────────────────────────────────────────────────────────────

export const otakubox = {
  getTrending: (page = 1, limit = 24) =>
    get<OtakuCard[]>("/trending", { page, limit }),

  getRecent: (page = 1, limit = 24) =>
    get<OtakuCard[]>("/recent", { page, limit }),

  getSeason: (year: number, season: string, page = 1, limit = 24) =>
    get<OtakuCard[]>("/season", { year, season, page, limit }),

  search: (params: OtakuSearchParams) =>
    get<OtakuCard[]>("/search", params as Record<string, string | number | undefined>),

  getGenres: () => get<string[]>("/genres"),

  getSuggestions: (q: string) =>
    get<Array<{ custom_id: string; anilist_id: number | null; title: string; cover: string }>>(
      "/suggestions",
      { q }
    ),

  getShow: async (id: number | string): Promise<OtakuShow> => {
    try {
      return await get<OtakuShow>(`/show/${id}`);
    } catch (e) {
      // Fall back to AniList directly when Otakubox hits a rate limit
      if (e instanceof Error && e.message.toLowerCase().includes("rate limit")) {
        return anilistGetShow(Number(id));
      }
      throw e;
    }
  },

  getEpisodes: (id: number | string) => get<OtakuEpisode[]>(`/episodes/${id}`),

  getAllRelations: async (id: number | string, max = 60) => {
    const raw = await get<RawRelItem[]>(`/all-relations/${id}`, { max });
    return parseRelations(raw);
  },
};

