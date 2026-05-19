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

export function filterAnimeList<T extends Pick<AnimeMedia, "isAdult" | "genres" | "tags">>(list: T[]): T[] {
  return list.filter((x) => !isBlockedAnime(x));
}
