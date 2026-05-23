import type { AnimeMedia } from "@/lib/api";

const BASE = "https://otakubox.otakuboxapi.workers.dev";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface OtakuCard {
  id: number;
  custom_id: string;
  anilist_id: number;
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
  streamable: boolean;
}

export interface OtakuRelationEdge {
  from: number;
  to: number;
  relationType: string;
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

function parseRelations(raw: RawRelItem[]): { nodes: OtakuRelationNode[]; edges: OtakuRelationEdge[] } {
  const nodeMap = new Map<number, OtakuRelationNode>();
  const edges: OtakuRelationEdge[] = [];

  const upsertNode = (id: number, title: string, cover?: string, type?: string, streamable = false) => {
    if (!nodeMap.has(id)) {
      nodeMap.set(id, { id, anilist_id: id, custom_id: String(id), title, cover, type, streamable });
    }
  };

  for (const item of raw) {
    upsertNode(item.id, item.title, item.cover, item.format, item.streamable);
    for (const rel of item.relations || []) {
      upsertNode(rel.id, rel.title, rel.cover, rel.format, rel.streamable);
      edges.push({ from: item.id, to: rel.id, relationType: rel.relation });
    }
  }

  return { nodes: Array.from(nodeMap.values()), edges };
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

// ─── Core fetch ───────────────────────────────────────────────────────────────

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

  // Retry on 429 with exponential backoff (max 3 attempts)
  if (res.status === 429 && attempt < 3) {
    const delay = (attempt + 1) * 1000;
    await new Promise((r) => setTimeout(r, delay));
    return get<T>(path, params, attempt + 1);
  }

  if (!res.ok) throw new Error(`Otakubox ${res.status}: ${path}`);
  const json = (await res.json()) as ApiRes<T>;
  if (!json.ok) throw new Error((json as ApiErr).error || "Otakubox error");
  return json.data;
}

// ─── Adapter: OtakuCard/Show → AnimeMedia ─────────────────────────────────────

export function cardToMedia(card: OtakuCard): AnimeMedia {
  const show = card as OtakuShow;
  return {
    id: card.anilist_id,
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

// ─── Season chain builder ─────────────────────────────────────────────────────

const SEASON_REL = new Set(["SEQUEL", "PREQUEL"]);

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
  return nodes.filter((n) => connected.has(n.anilist_id));
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
    get<Array<{ custom_id: string; anilist_id: number; title: string; cover: string }>>(
      "/suggestions",
      { q }
    ),

  getShow: (id: number | string) => get<OtakuShow>(`/show/${id}`),

  getEpisodes: (id: number | string) => get<OtakuEpisode[]>(`/episodes/${id}`),

  getAllRelations: async (id: number | string, max = 60) => {
    const raw = await get<RawRelItem[]>(`/all-relations/${id}`, { max });
    return parseRelations(raw);
  },
};
