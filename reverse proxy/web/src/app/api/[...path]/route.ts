import {
  staticAnime,
  staticEpisodeCounts,
  staticEpisodes,
  staticFilter,
  staticGenres,
  staticHomepage,
  staticMeta,
  staticRecommendations,
  staticRelations,
  staticSearch,
  staticSection,
  staticSuggestions,
  resolveByTitle,
} from "@/lib/static-catalog";
import { fetchJikanRelationEdges } from "@/lib/jikan-relations";
import { fetchAnilistByMalId } from "@/lib/anilist-server";
import type { AnimeMedia } from "@/lib/api";

const DEFAULT_BACKEND = "http://37.114.37.107:8080";
const BACKEND = (
  process.env.BACKEND_URL ||
  process.env.NEXT_PUBLIC_BACKEND_URL ||
  DEFAULT_BACKEND
).replace(/\/$/, "");

type RouteContext = {
  params: Promise<{ path?: string[] }>;
};

function json(data: unknown, init?: ResponseInit) {
  return Response.json(data, {
    headers: {
      "Cache-Control": "public, max-age=300, stale-while-revalidate=86400",
      ...init?.headers,
    },
    status: init?.status,
  });
}

function notFound() {
  return json({ detail: "Not found" }, { status: 404, headers: { "Cache-Control": "public, max-age=60" } });
}

function sectionKey(pathname: string) {
  switch (pathname) {
    case "trending": return "trending";
    case "popular": return "popular";
    case "upcoming": return "upcoming";
    case "recent":
    case "latest-releases": return "recent";
    case "fresh": return "fresh";
    case "recently-completed": return "recentlyCompleted";
    default: return null;
  }
}


/**
 * Enrich a static AnimeMedia entry with AniList data.
 * When the entry is not detailed (no cover/description), AniList is the source of truth.
 * Relations and tags always prefer AniList (better quality).
 */
async function enrichWithAnilist(
  base: AnimeMedia,
  malId: number
): Promise<AnimeMedia> {
  const al = await fetchAnilistByMalId(malId).catch(() => null);
  if (!al) return base;

  // If base is not detailed, replace with AniList data wholesale
  const isDetailed = !!(base.description || base.coverImage?.large);
  const merged: AnimeMedia = isDetailed
    ? {
        ...base,
        // Always take AniList tags/relations/images when they exist
        tags: al.tags?.length ? al.tags : base.tags,
        relations: al.relations?.edges?.length ? al.relations : base.relations,
        coverImage: al.coverImage?.large ? al.coverImage : base.coverImage,
        bannerImage: al.bannerImage || base.bannerImage,
        externalLinks: al.externalLinks?.length ? al.externalLinks : base.externalLinks,
        genres: al.genres?.length ? al.genres : base.genres,
      }
    : {
        ...al,
        // Preserve MAL id from static
        mal_id: malId,
        id: base.id,
      };

  return merged;
}

/**
 * Get relations for an anime.
 * Priority: static catalog → AniList live → Jikan fallback.
 */
async function relationsPayload(id: number) {
  const base = staticRelations(id);
  const staticEdges = Array.isArray(base.relations) ? base.relations : [];

  // Static catalog already has good relations for this entry
  if (staticEdges.length > 0) return base;

  // Try AniList first (best data)
  const al = await fetchAnilistByMalId(id).catch(() => null);
  const alEdges = al?.relations?.edges;
  if (alEdges && alEdges.length > 0) {
    return { ...base, relations: alEdges };
  }

  // Jikan fallback
  const jikanEdges = await fetchJikanRelationEdges(id).catch(() => []);
  if (jikanEdges.length > 0) {
    return { ...base, relations: jikanEdges };
  }

  return base;
}

/**
 * Full anime detail payload.
 * Static → enrich from AniList (tags, relations, cover) → Jikan fallback for missing.
 */
async function animeDetailPayload(id: number) {
  const staticPayload = staticAnime(id);

  if (staticPayload) {
    const isDetailed = !!(
      staticPayload.info.description ||
      staticPayload.info.coverImage?.large
    );
    const hasRelations = (staticPayload.info.relations?.edges?.length ?? 0) > 0;
    const hasTags = (staticPayload.info.tags?.length ?? 0) > 0;

    // If fully detailed with relations and tags, return as-is
    if (isDetailed && hasRelations && hasTags) {
      return staticPayload;
    }

    // Enrich missing fields from AniList
    const enriched = await enrichWithAnilist(staticPayload.info, id);
    return { ...staticPayload, info: enriched };
  }

  // Not in static catalog at all — try AniList live lookup by MAL id
  const al = await fetchAnilistByMalId(id).catch(() => null);
  if (al) {
    return { id, info: al, streaming: null };
  }

  // Final fallback: Jikan
  const jikanDetail = await fetchJikanDetail(id).catch(() => null);
  if (jikanDetail) {
    return { id, info: jikanDetail, streaming: null };
  }

  return null;
}

async function fetchJikanDetail(malId: number): Promise<AnimeMedia | null> {
  try {
    const res = await fetch(`https://api.jikan.moe/v4/anime/${malId}`, {
      headers: { Accept: "application/json", "User-Agent": "SaturdayNightWeb/1.0" },
      next: { revalidate: 3600 },
    } as RequestInit & { next?: { revalidate: number } });
    if (!res.ok) return null;
    const payload = (await res.json()) as { data?: Record<string, unknown> };
    if (!payload.data) return null;
    return jikanToAnimeMedia(payload.data, malId);
  } catch {
    return null;
  }
}

function jikanToAnimeMedia(d: Record<string, unknown>, malId: number): AnimeMedia {
  const images = d.images as Record<string, { image_url?: string; large_image_url?: string }> | undefined;
  const jpg = images?.jpg;
  const relations = d.relations as Array<{ relation: string; entry: Array<{ mal_id: number; type: string; name: string }> }> | undefined;

  const RELATION_MAP: Record<string, string> = {
    Sequel: "SEQUEL", Prequel: "PREQUEL", "Alternative version": "ALTERNATIVE",
    "Side story": "SIDE_STORY", "Parent story": "PARENT", Summary: "SUMMARY",
    "Spin-off": "SPIN_OFF", Other: "OTHER", Adaptation: "ADAPTATION",
  };

  const edges = (relations || []).flatMap((r) =>
    (r.entry || [])
      .filter((e) => e.type === "anime")
      .map((e) => ({
        relationType: RELATION_MAP[r.relation] || r.relation.toUpperCase().replace(/[^A-Z0-9]+/g, "_"),
        node: {
          id: e.mal_id,
          mal_id: e.mal_id,
          title: { english: e.name, romaji: e.name, native: undefined },
          coverImage: {} as AnimeMedia["coverImage"],
          bannerImage: "",
          genres: [] as string[],
          studios: [] as string[],
          episodes: null,
          isAdult: false,
        } as AnimeMedia,
      }))
  );

  return {
    id: malId,
    mal_id: malId,
    title: { english: (d.title_english as string) || (d.title as string), romaji: d.title as string, native: undefined },
    coverImage: { large: jpg?.large_image_url || jpg?.image_url, extraLarge: jpg?.large_image_url },
    bannerImage: "",
    format: (d.type as string) ?? "",
    season: "",
    episodes: d.episodes as number | null,
    duration: d.duration as string,
    status: d.status as string ?? "",
    score: d.score as number,
    genres: ((d.genres as Array<{ name: string }>) || []).map((g) => g.name),
    studios: ((d.studios as Array<{ name: string }>) || []).map((s) => s.name),
    description: d.synopsis as string ?? "",
    isAdult: (d.rating as string)?.includes("Rx") ?? false,
    synonyms: ((d.titles as Array<{ type: string; title: string }>) || []).map((t) => t.title),
    relations: edges.length ? { edges } : undefined,
    startDate: (() => {
      const y = d.aired as { from?: string };
      if (!y?.from) return undefined;
      const dt = new Date(y.from);
      return { year: dt.getFullYear(), month: dt.getMonth() + 1, day: dt.getDate() };
    })(),
  };
}

async function proxyToBackend(request: Request, path: string[]) {
  const url = new URL(request.url);
  const backendUrl = `${BACKEND}/api/${path.map(encodeURIComponent).join("/")}${url.search}`;
  const headers = new Headers(request.headers);
  headers.set("host", new URL(BACKEND).host);
  headers.delete("connection");

  const res = await fetch(backendUrl, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
    cache: "no-store",
    duplex: "half",
  } as RequestInit & { duplex?: "half" });

  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}

const META_HOST = "anikototv.to";
const META_ORIGIN = `https://${META_HOST}`;
const STRIP_HEADERS = new Set(["cf-ray", "cf-cache-status", "server", "via", "x-powered-by", "x-frame-options", "set-cookie"]);

async function metaProxy(target: string) {
  if (!target || !target.startsWith("/")) return notFound();
  const res = await fetch(`${META_ORIGIN}${target}`, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Referer": `${META_ORIGIN}/`,
      "X-Requested-With": "XMLHttpRequest",
      "Accept": "text/html,application/json,*/*;q=0.9",
      "Accept-Language": "en-US,en;q=0.9",
    },
    cache: "no-store",
  });
  const body = await res.text();
  const outHeaders = new Headers();
  outHeaders.set("Content-Type", res.headers.get("content-type") || "text/html; charset=utf-8");
  outHeaders.set("Cache-Control", "public, max-age=300, stale-while-revalidate=3600");
  return new Response(body, { status: res.status, headers: outHeaders });
}

export async function GET(request: Request, context: RouteContext) {
  const { path = [] } = await context.params;
  const pathname = path.join("/");
  const url = new URL(request.url);

  // Thin passthrough proxy — source hidden from browser
  if (pathname === "meta-proxy") {
    const target = url.searchParams.get("p") ?? "";
    return metaProxy(target);
  }

  if (pathname === "_static-meta") return json(staticMeta());
  if (pathname === "search") return json(staticSearch(url.searchParams));
  if (pathname === "suggestions") return json(staticSuggestions(url.searchParams));
  if (pathname === "filter") return json(staticFilter(url.searchParams));
  if (pathname === "genres") return json(staticGenres());
  if (pathname === "homepage") return json(staticHomepage());
  if (pathname === "spotlight") return json({ results: staticSection("trending", url.searchParams).results.slice(0, 10) });
  if (pathname === "schedule") return json({ page: 1, perPage: 20, total: 0, hasNextPage: false, results: [] });

  if (pathname === "episode-counts") {
    return json(staticEpisodeCounts(url.searchParams));
  }

  if (pathname === "resolve-titles") {
    const raw = url.searchParams.get("titles") ?? "";
    const titles = raw.split("|").map((t) => t.trim()).filter(Boolean);
    const result: Record<string, number> = {};
    for (const t of titles) {
      const m = resolveByTitle(t);
      if (m?.id) result[t] = m.id;
    }
    return json(result);
  }

  const collection = sectionKey(pathname);
  if (collection) return json(staticSection(collection, url.searchParams));

  const animeMatch = pathname.match(/^anime\/(\d+)$/);
  if (animeMatch) {
    const payload = await animeDetailPayload(Number(animeMatch[1]));
    return payload ? json(payload) : notFound();
  }

  const relationsMatch = pathname.match(/^anime\/(\d+)\/relations$/);
  if (relationsMatch) return json(await relationsPayload(Number(relationsMatch[1])));

  const episodesMatch = pathname.match(/^anime\/(\d+)\/episodes$/);
  if (episodesMatch) {
    const malId = Number(episodesMatch[1]);
    try {
      const res = await fetch(`${BACKEND}/api/anime/${malId}/episodes`, {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (res.ok) {
        const data = (await res.json()) as {
          providers?: { megaplay?: { episodes?: { sub?: unknown[]; dub?: unknown[] } } };
          released?: { sub?: number; dub?: number };
        };
        const eps = data.providers?.megaplay?.episodes;
        if ((eps?.sub?.length || 0) > 0 || (eps?.dub?.length || 0) > 0) {
          return json(data);
        }
      }
    } catch {
      // fall through
    }
    const payload = staticEpisodes(malId);
    return payload ? json(payload) : proxyToBackend(request, path);
  }

  const recommendationsMatch = pathname.match(/^anime\/(\d+)\/recommendations$/);
  if (recommendationsMatch) return json(staticRecommendations(Number(recommendationsMatch[1]), url.searchParams));

  return proxyToBackend(request, path);
}

export async function HEAD(request: Request, context: RouteContext) {
  const { path = [] } = await context.params;
  return proxyToBackend(request, path);
}

export async function POST(request: Request, context: RouteContext) {
  const { path = [] } = await context.params;
  return proxyToBackend(request, path);
}

export async function PUT(request: Request, context: RouteContext) {
  const { path = [] } = await context.params;
  return proxyToBackend(request, path);
}

export async function DELETE(request: Request, context: RouteContext) {
  const { path = [] } = await context.params;
  return proxyToBackend(request, path);
}
