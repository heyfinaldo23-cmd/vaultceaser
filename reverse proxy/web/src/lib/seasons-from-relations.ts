import type { AnimeMedia } from "@/lib/api";
import type { SeasonEntry } from "@/components/SeasonRail";
import { animeTitle } from "@/lib/anime-title";
import { formatLabel } from "@/lib/format-labels";

/**
 * Only SEQUEL/PREQUEL form a clean franchise chain (Miruro approach).
 * SIDE_STORY/SPIN_OFF/ONA recaps/etc. create noise and wrong "next" labels.
 */
const FRANCHISE_RELATIONS = new Set(["SEQUEL", "PREQUEL"]);

type RelationEdge = {
  relationType?: string;
  node?: AnimeMedia;
};

function normalizeEdges(
  relations?: AnimeMedia["relations"] | RelationEdge[]
): RelationEdge[] {
  if (!relations) return [];
  if (Array.isArray(relations)) return relations;
  return relations.edges || [];
}

function isValidSeasonMedia(media: AnimeMedia): boolean {
  if (!media.id || media.id <= 0) return false;
  if (media.type && media.type !== "ANIME") return false;
  if (media.isAdult) return false;
  if (media.format && ["MUSIC", "MANGA", "NOVEL", "ONE_SHOT"].includes(media.format)) {
    return false;
  }
  return true;
}

function seasonSortValue(media: AnimeMedia): number {
  const y = media.startDate?.year ?? media.seasonYear;
  if (y) return y * 10000 + (media.startDate?.month ?? 0) * 100 + (media.startDate?.day ?? 0);
  return media.status === "NOT_YET_RELEASED" ? Number.MAX_SAFE_INTEGER - 1 : media.id;
}

function entryLabel(media: AnimeMedia, index: number, isCurrent: boolean): string {
  if (isCurrent) return "You are here";
  const fmt = media.format || "";
  if (fmt === "MOVIE") return "Movie";
  if (fmt === "OVA") return "OVA";
  if (fmt === "SPECIAL") return "Special";
  if (fmt === "ONA") return "ONA";
  return `Part ${index}`;
}

/** Build ordered franchise list from AniList relations + current show. */
export function buildSeasonList(
  current: AnimeMedia,
  relations?: AnimeMedia["relations"] | RelationEdge[]
): SeasonEntry[] {
  const edges = normalizeEdges(relations);
  const related = edges
    .filter((e) => {
      if (!e.node?.id || !FRANCHISE_RELATIONS.has(e.relationType || "")) return false;
      return isValidSeasonMedia(e.node);
    })
    .map((e) => ({
      id: e.node!.id,
      media: e.node!,
      relation: e.relationType || "",
    }));

  const byId = new Map<number, SeasonEntry & { media: AnimeMedia; sort: number }>();

  byId.set(current.id, {
    id: current.id,
    label: "",
    title: animeTitle(current),
    episodes: current.episodes,
    image: current.bannerImage || current.coverImage?.large,
    isCurrent: true,
    relation: "CURRENT",
    media: current,
    sort: seasonSortValue(current),
  });

  for (const r of related) {
    if (byId.has(r.id)) continue;
    byId.set(r.id, {
      id: r.id,
      label: "",
      title: animeTitle(r.media),
      episodes: r.media.episodes,
      image: r.media.bannerImage || r.media.coverImage?.large,
      relation: r.relation,
      media: r.media,
      sort: seasonSortValue(r.media),
    });
  }

  if (byId.size <= 1) return [];

  const ordered = [...byId.values()].sort((a, b) => a.sort - b.sort || a.id - b.id);

  let part = 1;
  const out: SeasonEntry[] = ordered.map((row) => {
    const label = entryLabel(row.media, part, !!row.isCurrent);
    // Always increment so subsequent entries get the correct number regardless
    // of whether the current entry is the "You are here" slot.
    const fmt = row.media.format || "";
    if (!["MOVIE", "OVA", "SPECIAL", "ONA"].includes(fmt)) {
      part += 1;
    }
    return {
      id: row.id,
      label,
      title: row.title,
      episodes: row.episodes,
      image: row.image,
      relation: row.relation,
      isCurrent: row.isCurrent,
    };
  });

  const curIdx = out.findIndex((s) => s.isCurrent);
  if (curIdx >= 0 && curIdx < out.length - 1) {
    out[curIdx + 1] = { ...out[curIdx + 1], isNext: true };
  }

  return out;
}

export function enrichSeasonCounts(
  seasons: SeasonEntry[],
  counts: Record<number, { sub: number; dub: number }>
): SeasonEntry[] {
  return seasons.map((s) => ({
    ...s,
    releasedSub: counts[s.id]?.sub ?? 0,
    releasedDub: counts[s.id]?.dub ?? 0,
  }));
}

/** Human-readable relation badge for season cards (optional UI). */
export function relationLabel(relation?: string): string | null {
  if (!relation || relation === "CURRENT") return null;
  return formatLabel(relation);
}
