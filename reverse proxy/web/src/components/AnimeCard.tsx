"use client";

import Link from "next/link";
import { cn } from "@/lib/utils";
import { normalizeScore, type AnimeMedia } from "@/lib/api";
import EpisodeCountBadges from "@/components/EpisodeCountBadges";
import { animeTitle } from "@/lib/anime-title";

interface AnimeCardProps {
  anime: AnimeMedia;
  index?: number;
  showRank?: boolean;
  layout?: "grid" | "list" | "horizontal";
  /** default = browse; medium = slightly smaller browse; compact = dense home grid */
  size?: "default" | "medium" | "compact";
  className?: string;
  /** Released sub episodes on stream provider */
  subCount?: number;
  /** Released dub episodes on stream provider */
  dubCount?: number;
}

export default function AnimeCard({
  anime,
  index,
  showRank,
  layout = "grid",
  size = "default",
  className,
  subCount,
  dubCount,
}: AnimeCardProps) {
  const title = animeTitle(anime);
  const image = anime.coverImage?.large || anime.coverImage?.extraLarge || "";
  const format = anime.format || "TV";
  const plannedTotal = anime.episodes ?? null;
  const score = normalizeScore(anime);
  const sub = subCount ?? 0;
  const dub = dubCount ?? 0;

  if (layout === "horizontal") {
    return (
      <Link
        href={`/anime/${anime.id}`}
        className={cn(
          "group flex items-center gap-3 rounded-lg p-2 transition-colors hover:bg-[var(--card)]",
          className
        )}
      >
        {showRank && index !== undefined && (
          <span className="w-6 shrink-0 text-center text-lg font-bold text-muted-foreground">
            {index + 1}
          </span>
        )}
        <img
          src={image}
          alt={title}
          className="h-14 w-10 shrink-0 rounded bg-[var(--card)] object-cover"
          loading="lazy"
          onError={(e) => {
            (e.target as HTMLImageElement).src = "/placeholder.svg";
          }}
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-foreground transition-colors group-hover:text-[var(--accent)]">
            {title}
          </div>
          {score ? (
            <span className="mt-0.5 text-xs font-bold text-[#e8621a]">{score}%</span>
          ) : null}
          <EpisodeCountBadges
            subCount={sub}
            dubCount={dub}
            total={plannedTotal}
            format={format}
            className="mt-1"
          />
        </div>
      </Link>
    );
  }

  if (layout === "list") {
    return (
      <Link
        href={`/anime/${anime.id}`}
        className={cn("group flex gap-3 rounded-lg p-2 transition-all hover:bg-[#1a1d2a]", className)}
      >
        <img
          src={image}
          alt={title}
          className="h-[56px] w-[100px] shrink-0 rounded bg-[#1a1d2a] object-cover"
          loading="lazy"
          onError={(e) => {
            (e.target as HTMLImageElement).src = "/placeholder.svg";
          }}
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-foreground transition-colors group-hover:text-[var(--accent)]">
            {title}
          </div>
          {score ? (
            <span className="mt-1 text-xs font-bold text-[#e8621a]">{score}%</span>
          ) : null}
          <EpisodeCountBadges
            subCount={sub}
            dubCount={dub}
            total={plannedTotal}
            format={format}
            className="mt-1.5"
          />
        </div>
      </Link>
    );
  }

  const compact = size === "compact";
  const medium = size === "medium";
  const badgeSize = compact || medium ? "compact" : "default";

  return (
    <Link href={`/anime/${anime.id}`} className={cn("group block", className)}>
      <div
        className={cn(
          "relative aspect-[2/3] overflow-hidden bg-[#1a1d28]",
          compact ? "rounded-md" : medium ? "rounded-lg" : "rounded-xl"
        )}
      >
        <img
          src={image}
          alt={title}
          className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
          loading="lazy"
          onError={(e) => {
            (e.target as HTMLImageElement).src = "/placeholder.svg";
          }}
        />
        {score ? (
          <span
            className={cn(
              "absolute left-1 top-1 rounded bg-[#e8621a] font-mono font-bold text-white",
              compact ? "px-1 py-0.5 text-[8px]" : medium ? "px-1 py-0.5 text-[9px]" : "px-1.5 py-0.5 text-[10px]"
            )}
          >
            {score}%
          </span>
        ) : null}
      </div>
      <h3
        className={cn(
          "line-clamp-2 font-mono font-medium leading-tight text-white group-hover:text-[#e8621a]",
          compact ? "mt-1 text-[11px]" : medium ? "mt-1.5 text-[12px]" : "mt-2 text-sm"
        )}
      >
        {title}
      </h3>
      <EpisodeCountBadges
        subCount={sub}
        dubCount={dub}
        total={plannedTotal}
        format={format}
        size={badgeSize}
        className={compact ? "mt-0.5" : "mt-1"}
      />
    </Link>
  );
}

export function AnimeCardSkeleton({ layout = "grid" }: { layout?: "grid" | "list" | "horizontal" }) {
  if (layout === "horizontal") {
    return (
      <div className="flex items-center gap-3 p-2">
        <div className="w-6" />
        <div className="h-14 w-10 shrink-0 rounded skeleton" />
        <div className="flex-1 space-y-2">
          <div className="h-3 skeleton w-3/4" />
          <div className="h-2 skeleton w-1/2" />
        </div>
      </div>
    );
  }

  if (layout === "list") {
    return (
      <div className="flex gap-3 p-2">
        <div className="h-[56px] w-[100px] shrink-0 rounded skeleton" />
        <div className="flex-1 space-y-2">
          <div className="h-3 skeleton w-3/4" />
          <div className="h-2 skeleton w-1/2" />
        </div>
      </div>
    );
  }

  return (
    <div className="block">
      <div className="aspect-[2/3] rounded-lg skeleton" />
      <div className="mt-2 space-y-2 px-0.5">
        <div className="h-3 skeleton w-4/5" />
        <div className="h-2 skeleton w-2/3" />
      </div>
    </div>
  );
}
