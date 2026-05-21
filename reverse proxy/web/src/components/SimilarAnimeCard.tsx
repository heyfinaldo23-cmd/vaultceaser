"use client";

import Link from "next/link";
import type { AnimeMedia } from "@/lib/api";
import { animeTitle } from "@/lib/anime-title";

/** Similar row: wide banner + title (not episode thumbs). */
export default function SimilarAnimeCard({ anime }: { anime: AnimeMedia }) {
  const title = animeTitle(anime);
  const banner =
    anime.bannerImage ||
    anime.coverImage?.extraLarge ||
    anime.coverImage?.large ||
    "";

  return (
    <Link
      href={`/anime/${anime.id}`}
      className="group block overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--card)] transition-colors hover:border-[var(--accent)]"
    >
      <div className="relative aspect-[16/9] bg-[#1a1d2a]">
        {banner ? (
          <img
            src={banner}
            alt={title}
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.02]"
            loading="lazy"
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = "none";
            }}
          />
        ) : null}
        <div className="absolute inset-0 bg-gradient-to-t from-[#0d0f14] via-[#0d0f14]/40 to-transparent" />
        <div className="absolute bottom-0 left-0 right-0 p-2.5">
          <h3 className="line-clamp-2 text-sm font-semibold text-white group-hover:text-[var(--accent)]">
            {title}
          </h3>
        </div>
      </div>
    </Link>
  );
}
