/**
 * Server-side AniList GQL client.
 * Uses Next.js fetch caching (revalidate 1h) — no sessionStorage.
 * Only call from route handlers / server components.
 */

import type { AnimeMedia } from "@/lib/api";

const ANILIST_GQL = "https://graphql.anilist.co";

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
  studios { nodes { id name isAnimationStudio } }
  nextAiringEpisode { episode airingAt timeUntilAiring }
  startDate { year month day }
  endDate { year month day }
  externalLinks { url site type }
  relations {
    edges {
      relationType(version: 2)
      node {
        id
        idMal
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
`;

async function anilistGql<T>(
  query: string,
  variables: Record<string, unknown>
): Promise<T | null> {
  try {
    const res = await fetch(ANILIST_GQL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query, variables }),
      // Cache 1 hour on the edge
      next: { revalidate: 3600 },
    } as RequestInit & { next?: { revalidate: number } });

    if (!res.ok) return null;

    const payload = (await res.json()) as { data?: T; errors?: unknown[] };
    if (payload.errors?.length) return null;
    return payload.data ?? null;
  } catch {
    return null;
  }
}

/** Map AniList Media node for relation edges (strip nested relations to avoid cycles). */
function mapRelationNode(node: Record<string, unknown>): AnimeMedia {
  return {
    id: node.id as number,
    mal_id: (node.idMal as number) ?? undefined,
    title: node.title as AnimeMedia["title"],
    coverImage: (node.coverImage as AnimeMedia["coverImage"]) ?? {},
    bannerImage: (node.bannerImage as string) ?? "",
    format: (node.format as string) ?? "",
    type: node.type as string | undefined,
    status: (node.status as string) ?? "",
    episodes: node.episodes as number | null,
    meanScore: node.meanScore as number | undefined,
    isAdult: (node.isAdult as boolean) ?? false,
    seasonYear: node.seasonYear as number | undefined,
    startDate: node.startDate as AnimeMedia["startDate"],
    genres: [],
    studios: [],
  };
}

/** Fetch a single anime by its MAL id from AniList. Returns null on miss. */
export async function fetchAnilistByMalId(malId: number): Promise<AnimeMedia | null> {
  if (!malId || malId <= 0) return null;

  type MediaGql = { Media: Record<string, unknown> };
  const q = `
    query ($idMal: Int) {
      Media(idMal: $idMal, type: ANIME) {
        ${FULL_FIELDS}
      }
    }
  `;

  const data = await anilistGql<MediaGql>(q, { idMal: malId });
  if (!data?.Media) return null;

  return mapAnilistMedia(data.Media);
}

/** Fetch a single anime by its AniList id. Returns null on miss. */
export async function fetchAnilistById(anilistId: number): Promise<AnimeMedia | null> {
  if (!anilistId || anilistId <= 0) return null;

  type MediaGql = { Media: Record<string, unknown> };
  const q = `
    query ($id: Int) {
      Media(id: $id, type: ANIME) {
        ${FULL_FIELDS}
      }
    }
  `;

  const data = await anilistGql<MediaGql>(q, { id: anilistId });
  if (!data?.Media) return null;

  return mapAnilistMedia(data.Media);
}

function mapAnilistMedia(m: Record<string, unknown>): AnimeMedia {
  const relations = m.relations as
    | { edges?: Array<{ relationType: string; node: Record<string, unknown> }> }
    | undefined;

  const edges = (relations?.edges || [])
    .filter((e) => {
      const n = e.node;
      if (!n?.id || (n.isAdult as boolean)) return false;
      const type = (n.type as string | undefined)?.toUpperCase();
      return !type || type === "ANIME";
    })
    .map((e) => ({
      relationType: e.relationType,
      node: mapRelationNode(e.node),
    }));

  return {
    id: m.id as number,
    mal_id: (m.idMal as number) ?? undefined,
    title: m.title as AnimeMedia["title"],
    coverImage: (m.coverImage as AnimeMedia["coverImage"]) ?? {},
    bannerImage: (m.bannerImage as string) ?? "",
    format: (m.format as string) ?? "",
    season: (m.season as string) ?? "",
    seasonYear: m.seasonYear as number | undefined,
    episodes: m.episodes as number | null,
    duration: m.duration as number | undefined,
    status: (m.status as string) ?? "",
    averageScore: m.averageScore as number | undefined,
    meanScore: m.meanScore as number | undefined,
    popularity: m.popularity as number | undefined,
    favourites: m.favourites as number | undefined,
    genres: (m.genres as string[]) ?? [],
    tags: m.tags as AnimeMedia["tags"],
    source: (m.source as string) ?? "",
    countryOfOrigin: m.countryOfOrigin as string | undefined,
    isAdult: (m.isAdult as boolean) ?? false,
    synonyms: (m.synonyms as string[]) ?? [],
    siteUrl: m.siteUrl as string | undefined,
    trailer: m.trailer as AnimeMedia["trailer"],
    studios: m.studios as AnimeMedia["studios"],
    nextAiringEpisode: m.nextAiringEpisode as AnimeMedia["nextAiringEpisode"],
    startDate: m.startDate as AnimeMedia["startDate"],
    endDate: m.endDate as AnimeMedia["endDate"],
    description: (m.description as string) ?? "",
    externalLinks: m.externalLinks as AnimeMedia["externalLinks"],
    relations: edges.length > 0 ? { edges } : undefined,
  };
}
