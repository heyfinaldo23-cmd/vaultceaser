"use client";

import { useRef } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { AnimeMedia } from "@/lib/api";
import { animeTitle } from "@/lib/anime-title";

export default function SimilarCarousel({ items }: { items: AnimeMedia[] }) {
  const ref = useRef<HTMLDivElement>(null);

  const scroll = (dir: number) => {
    ref.current?.scrollBy({ left: dir * 200, behavior: "smooth" });
  };

  if (!items.length) return null;

  return (
    <section className="mt-8">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="font-mono text-xs font-semibold uppercase tracking-widest text-[var(--muted)]">
          Similar
        </h2>
        <div className="flex gap-1">
          <button
            type="button"
            onClick={() => scroll(-1)}
            className="rounded border border-[var(--border)] p-1 text-[var(--muted)] hover:text-white"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => scroll(1)}
            className="rounded border border-[var(--border)] p-1 text-[var(--muted)] hover:text-white"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div
        ref={ref}
        className="flex gap-2 overflow-x-auto pb-1 scroll-smooth [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {items.map((a, i) => {
          const title = animeTitle(a);
          const img = a.coverImage?.large || a.bannerImage || "";
          return (
            <Link
              key={`${a.id}-${i}`}
              href={`/anime/${a.id}`}
              className="group w-[120px] shrink-0"
            >
              <div className="relative aspect-[2/3] overflow-hidden rounded-lg border border-[var(--border)] bg-[#1a1d28]">
                {img ? (
                  <img
                    src={img}
                    alt={title}
                    className="h-full w-full object-cover transition-transform group-hover:scale-105"
                    loading="lazy"
                  />
                ) : null}
              </div>
              <p className="mt-1 line-clamp-2 font-mono text-[10px] leading-tight text-[var(--foreground)] group-hover:text-[#e8621a]">
                {title}
              </p>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
