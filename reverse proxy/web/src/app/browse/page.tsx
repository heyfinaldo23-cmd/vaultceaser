"use client";

import { Suspense, useState, useEffect, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import AnimeCard, { AnimeCardSkeleton } from "@/components/AnimeCard";
import BrowseFilterBar from "@/components/BrowseFilterBar";
import { type AnimeMedia, type GenreData, api } from "@/lib/api";
import { filterAnimeList } from "@/lib/anime-filters";
import { akFetchFilter } from "@/lib/anikoto-cache";
import type { AkFilterItem } from "@/lib/anikoto";

type AkResult = AnimeMedia & { akSub: number; akDub: number };

async function resolveAkItems(items: AkFilterItem[]): Promise<AkResult[]> {
  if (!items.length) return [];

  // Batch resolve titles → MAL IDs via server-side static catalog
  const titles = items.flatMap((i) => [i.title, i.native].filter(Boolean));
  const unique = [...new Set(titles)];
  let titleMap: Record<string, number> = {};
  try {
    const qs = `titles=${encodeURIComponent(unique.join("|"))}`;
    const res = await fetch(`/api/resolve-titles?${qs}`, { cache: "no-store" });
    if (res.ok) titleMap = (await res.json()) as Record<string, number>;
  } catch {
    // silently continue — some items just won't have MAL IDs
  }

  const seen = new Set<number>();
  const out: AkResult[] = [];

  for (const item of items) {
    const malId = titleMap[item.title] ?? titleMap[item.native] ?? 0;
    if (!malId || seen.has(malId)) continue;
    seen.add(malId);

    out.push({
      id: malId,
      title: { romaji: item.title, english: item.title, native: item.native },
      coverImage: { large: item.poster, extraLarge: item.poster },
      format: item.type.toUpperCase() as AnimeMedia["format"],
      genres: item.genres,
      averageScore: item.score ? Math.round(item.score * 10) : undefined,
      isAdult: false,
      akSub: item.subCount,
      akDub: item.dubCount,
    });
  }

  return out;
}

function BrowseContent() {
  const searchParams = useSearchParams();

  const [loading, setLoading] = useState(true);
  const [results, setResults] = useState<AkResult[]>([]);
  const [genres, setGenres] = useState<GenreData | null>(null);
  const [openGenre, setOpenGenre] = useState(false);

  const [query, setQuery] = useState(searchParams.get("q") || "");
  const [selectedGenre, setSelectedGenre] = useState(searchParams.get("genre") || "");
  const [selectedFormat, setSelectedFormat] = useState(searchParams.get("format") || "");
  const [selectedStatus, setSelectedStatus] = useState(searchParams.get("status") || "");
  const selectedSeason = searchParams.get("season") || "";
  const selectedYear = searchParams.get("year") || "";
  const [sort, setSort] = useState(searchParams.get("sort") || "POPULARITY_DESC");
  const [page, setPage] = useState(1);
  const [hasNextPage, setHasNextPage] = useState(false);

  const perPage = 24;

  const fetchResults = useCallback(async (p: number) => {
    setLoading(true);
    try {
      const items = await akFetchFilter({
        keyword: query.trim() || undefined,
        genre: selectedGenre || undefined,
        format: selectedFormat || undefined,
        status: selectedStatus || undefined,
        season: selectedSeason || undefined,
        year: selectedYear || undefined,
        sort,
        page: p,
      });

      const resolved = await resolveAkItems(items);
      const filtered = filterAnimeList(resolved);
      setResults(filtered);
      // Anikoto returns ~28 per page; show next button when full page comes back
      setHasNextPage(items.length >= 24);
    } catch (e) {
      console.error("Browse search failed:", e);
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, [query, selectedGenre, selectedFormat, selectedStatus, selectedSeason, selectedYear, sort]);

  useEffect(() => {
    api.getGenres().then(setGenres).catch(() => {});
  }, []);

  useEffect(() => {
    fetchResults(page);
  }, [page, fetchResults]);

  const handleFilter = () => {
    setPage(1);
    fetchResults(1);
    setOpenGenre(false);
  };

  const toggleGenre = (genre: string) => {
    const gs = selectedGenre ? selectedGenre.split(",") : [];
    const idx = gs.indexOf(genre);
    if (idx >= 0) gs.splice(idx, 1);
    else gs.push(genre);
    setSelectedGenre(gs.join(","));
  };

  return (
    <div className="min-h-screen bg-[#0d0f14]">
      <div className="mx-auto max-w-[1440px] px-3 py-5 sm:px-4 sm:py-6">
        <div className="mb-5 flex items-center justify-between gap-3">
          <h1 className="font-display text-xl font-bold uppercase tracking-wide text-white sm:text-2xl md:text-3xl">
            Browser
          </h1>
          <span className="shrink-0 text-xs text-[#9ca3af] sm:text-sm">
            {results.length} anime
          </span>
        </div>

        <BrowseFilterBar
          query={query}
          selectedGenre={selectedGenre}
          selectedFormat={selectedFormat}
          selectedStatus={selectedStatus}
          sort={sort}
          genres={genres}
          openGenre={openGenre}
          setOpenGenre={setOpenGenre}
          onChange={(patch) => {
            if (patch.query !== undefined) setQuery(patch.query);
            if (patch.selectedGenre !== undefined) setSelectedGenre(patch.selectedGenre);
            if (patch.selectedFormat !== undefined) setSelectedFormat(patch.selectedFormat);
            if (patch.selectedStatus !== undefined) setSelectedStatus(patch.selectedStatus);
            if (patch.sort !== undefined) setSort(patch.sort);
          }}
          onApply={handleFilter}
          toggleGenre={toggleGenre}
        />

        <div className="grid grid-cols-[repeat(auto-fill,minmax(128px,1fr))] gap-x-2 gap-y-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-7">
          {(loading ? Array(perPage).fill(null) : results).map((anime, i) =>
            anime ? (
              <AnimeCard
                key={`${anime.id}-${i}`}
                anime={anime}
                size="medium"
                subCount={anime.akSub}
                dubCount={anime.akDub}
              />
            ) : (
              <AnimeCardSkeleton key={i} />
            )
          )}
        </div>

        {!loading && results.length === 0 && (
          <p className="py-16 text-center text-[#9ca3af]">No anime found. Try different filters.</p>
        )}

        {(page > 1 || hasNextPage) && (
          <div className="mt-8 flex items-center justify-center gap-2 pb-8">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage(Math.max(1, page - 1))}
              disabled={page <= 1}
              className="border-[#2a2d3a] bg-[#1a1d28]"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="px-3 font-mono text-sm text-[#9ca3af]">
              {page}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage(page + 1)}
              disabled={!hasNextPage}
              className="border-[#2a2d3a] bg-[#1a1d28]"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

export default function BrowsePage() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto max-w-[1440px] px-3 py-5 sm:px-4 sm:py-6">
          <div className="mb-6 h-8 w-32 animate-pulse rounded bg-[#1a1d28]" />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
            {Array.from({ length: 12 }).map((_, i) => (
              <AnimeCardSkeleton key={i} />
            ))}
          </div>
        </div>
      }
    >
      <BrowseContent />
    </Suspense>
  );
}
