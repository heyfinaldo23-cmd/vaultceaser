import type { AnimeMedia } from "@/lib/api";
import { getMediaById } from "@/lib/static-catalog";

const JIKAN_BASE = "https://api.jikan.moe/v4";

const RELATION_MAP: Record<string, string> = {
  Sequel: "SEQUEL",
  Prequel: "PREQUEL",
  "Alternative version": "ALTERNATIVE",
  "Side story": "SIDE_STORY",
  "Parent story": "PARENT",
  Summary: "SUMMARY",
  SpinOff: "SPIN_OFF",
  "Spin-off": "SPIN_OFF",
  Other: "OTHER",
  Adaptation: "ADAPTATION",
};

export type RelationEdge = {
  relationType: string;
  node: AnimeMedia;
};

function stubMedia(malId: number, name: string): AnimeMedia {
  return {
    id: malId,
    mal_id: malId,
    title: { english: name, romaji: name, native: undefined },
    coverImage: {},
    bannerImage: "",
    genres: [],
    studios: [],
    episodes: null,
    isAdult: false,
  };
}

function nodeForMalId(malId: number, name?: string): AnimeMedia {
  const fromCatalog = getMediaById(malId);
  if (fromCatalog) {
    const node = { ...fromCatalog };
    delete (node as { relations?: unknown }).relations;
    return node;
  }
  return stubMedia(malId, name || `Anime ${malId}`);
}

/** Jikan v4 `/anime/{id}/relations` → AniList-style edges (cached 24h). */
export async function fetchJikanRelationEdges(malId: number): Promise<RelationEdge[]> {
  if (!malId || malId <= 0) return [];

  const url = `${JIKAN_BASE}/anime/${malId}/relations`;
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "SaturdayNightWeb/1.0" },
    next: { revalidate: 60 * 60 * 24 },
  });
  if (!res.ok) return [];

  const payload = (await res.json()) as {
    data?: Array<{
      relation?: string;
      entry?: Array<{ type?: string; mal_id?: number; name?: string }>;
    }>;
  };

  const edges: RelationEdge[] = [];
  for (const rel of payload.data || []) {
    const relationType =
      RELATION_MAP[rel.relation || ""] ||
      String(rel.relation || "")
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, "_");
    for (const entry of rel.entry || []) {
      if (entry.type !== "anime" || !entry.mal_id) continue;
      const relatedId = Number(entry.mal_id);
      if (!relatedId) continue;
      edges.push({
        relationType,
        node: nodeForMalId(relatedId, entry.name),
      });
    }
  }
  return edges;
}
