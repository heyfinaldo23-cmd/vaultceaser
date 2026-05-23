import type { AnimeMedia } from "@/lib/api";

const BLOCKED_GENRES = new Set([
  "Hentai",
  "Erotica",
]);

const BLOCKED_TAG_NAMES = new Set([
  "Hentai",
  "Erotica",
  "Sex",
  "Pornography",
  "NSFW",
  "Netorare",
  "Incest",
]);

/** Drop adult / explicit catalogue entries from API results. */
export function isBlockedAnime(m: Pick<AnimeMedia, "isAdult" | "genres" | "tags">): boolean {
  if (m.isAdult) return true;
  for (const g of m.genres ?? []) {
    if (BLOCKED_GENRES.has(g)) return true;
  }
  for (const t of m.tags ?? []) {
    if (BLOCKED_TAG_NAMES.has(t.name)) return true;
  }
  return false;
}

export function filterAnimeList<T extends Pick<AnimeMedia, "id" | "isAdult" | "genres" | "tags">>(list: T[]): T[] {
  const seen = new Set<number>();
  return list.filter((x) => {
    if (isBlockedAnime(x)) return false;
    if (!x.id) return true; // no dedup key available
    if (seen.has(x.id)) return false;
    seen.add(x.id);
    return true;
  });
}
