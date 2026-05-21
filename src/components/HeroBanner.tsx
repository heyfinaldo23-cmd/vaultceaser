"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight, Bookmark, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { mediaYear, normalizeScore, type AnimeMedia } from "@/lib/api";

interface HeroBannerProps {
  items: AnimeMedia[];
}

export default function HeroBanner({ items }: HeroBannerProps) {
  const [current, setCurrent] = useState(0);
  const total = items.length;

  const next = useCallback(() => {
    setCurrent((prev) => (prev + 1) % total);
  }, [total]);

  const prev = useCallback(() => {
    setCurrent((prev) => (prev - 1 + total) % total);
  }, [total]);

  // Auto-rotate every 6 seconds
  useEffect(() => {
    if (total <= 1) return;
    const timer = setInterval(next, 6000);
    return () => clearInterval(timer);
  }, [next, total]);

  if (!items.length) return null;

  const anime = items[current];
  const title = anime.title?.english || anime.title?.romaji || "Unknown";
  const bannerImage = anime.bannerImage || anime.coverImage?.extraLarge || anime.coverImage?.large || "";
  const score = normalizeScore(anime);
  const year = mediaYear(anime);
  const genres = anime.genres || [];
  const synopsis = anime.description
    ? anime.description.replace(/<[^>]*>/g, "").slice(0, 180)
    : "";

  return (
    <div className="relative w-full h-[420px] md:h-[480px] overflow-hidden bg-[#0d0f14]">
      {/* Background image with blur */}
      {bannerImage && (
        <>
          <div
            className="absolute inset-0 bg-cover bg-center scale-110 blur-md"
            style={{ backgroundImage: `url(${bannerImage})` }}
          />
          <div className="absolute inset-0 bg-black/50" />
          <div className="absolute inset-0 hero-gradient" />
        </>
      )}

      {/* Content */}
      <div className="relative h-full max-w-[1440px] mx-auto px-4 md:px-8 flex items-end pb-12">
        <div className="max-w-2xl">
          {/* Title */}
          <h1 className="text-3xl md:text-4xl lg:text-5xl font-heading font-bold text-white leading-tight mb-3">
            {title}
          </h1>

          {/* Genre badges */}
          <div className="flex flex-wrap gap-2 mb-3">
            {genres.slice(0, 4).map((genre) => (
              <Badge key={genre} variant="outline" className="text-xs border-[#1e2130] text-muted-foreground">
                {genre}
              </Badge>
            ))}
          </div>

          {/* Synopsis */}
          {synopsis && (
            <p className="text-sm text-gray-400 mb-4 line-clamp-2 leading-relaxed max-w-xl">
              {synopsis}
            </p>
          )}

          {/* Info row */}
          <div className="flex items-center gap-3 mb-5">
            {score && (
              <span className="text-base font-bold text-[#e8621a]">★ {score}%</span>
            )}
            {year && <span className="text-sm text-gray-400">{year}</span>}
            <span className="text-xs bg-[#e8621a]/20 text-[#e8621a] px-2 py-0.5 rounded font-medium">
              HD
            </span>
            <span className="text-sm text-gray-400">
              {anime.episodes || "?"} Episodes
            </span>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-3">
            <Link href={`/anime/${anime.id}`}>
              <Button className="bg-[#e8621a] hover:bg-[#d45510] text-white font-heading gap-2 px-6">
                <Play className="h-4 w-4 fill-current" />
                WATCH NOW
              </Button>
            </Link>
            <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-foreground">
              <Bookmark className="h-5 w-5" />
            </Button>
          </div>
        </div>
      </div>

      {/* Slide counter & arrows */}
      <div className="absolute bottom-4 right-4 md:right-8 flex items-center gap-3">
        <button
          onClick={prev}
          className="w-8 h-8 rounded-full bg-black/40 hover:bg-black/60 flex items-center justify-center text-white transition-colors cursor-pointer"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <span className="text-sm text-white/80 font-medium">
          {current + 1} / {total}
        </span>
        <button
          onClick={next}
          className="w-8 h-8 rounded-full bg-black/40 hover:bg-black/60 flex items-center justify-center text-white transition-colors cursor-pointer"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>

      {/* Dots */}
      <div className="absolute bottom-4 left-4 md:left-8 flex gap-1.5">
        {items.map((_, i) => (
          <button
            key={i}
            onClick={() => setCurrent(i)}
            className={`w-2 h-2 rounded-full transition-all cursor-pointer ${
              i === current ? "bg-[#e8621a] w-5" : "bg-white/30 hover:bg-white/50"
            }`}
          />
        ))}
      </div>
    </div>
  );
}

export function HeroBannerSkeleton() {
  return (
    <div className="relative w-full h-[420px] md:h-[480px] skeleton" />
  );
}
