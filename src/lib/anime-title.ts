import type { AnimeMedia } from "@/lib/api";

export function animeTitle(a: {
  title?: AnimeMedia["title"] | string;
  title_romaji?: string;
}): string {
  const t = a.title;
  if (typeof t === "string") return t;
  return t?.english || t?.romaji || a.title_romaji || "Unknown";
}
