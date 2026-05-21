"use client";

import { Suspense, useState, useEffect, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import AnimeCard, { AnimeCardSkeleton } from "@/components/AnimeCard";
import BrowseFilterBar from "@/components/BrowseFilterBar";
import { type AnimeMedia, type GenreData, api } from "@/lib/api";
import { filterAnimeList } from "@/lib/anime-filters";
import { useEpisodeCountsMap } from "@/hooks/useEpisodeCounts";

function BrowseContent() {
  const searchParams = useSearchParams();

  const [loading, setLoading] = useState(true);
  const [results, setResults] = useState<AnimeMedia[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [genres, setGenres] = useState<GenreData | null>(null);
  const [openGenre, setOpenGenre] = useState(false);

  const [query, setQuery] = useState(searchParams.get("q") || "");
  const [selectedGenre, setSelectedGenre] = useState(searchParams.get("genre") || "");
  const [selectedFormat, setSelectedFormat] = useState(searchParams.get("format") || "");
  const [selectedStatus, setSelectedStatus] = useState(searchParams.get("status") || "");
  const selectedSeason = searchParams.get("season") || "";
  const selectedYear = searchParams.get("year") || "";
  const [sort, setSort] = useState(searchParams.get("sort") || "POPULARITY_DESC");

  const perPage = 24;
  const resultIds = results.map((a) => a.id);
  const epCounts = useEpisodeCountsMap(resultIds);

  const fetchResults = useCallback(async (p: number) => {
    setLoading(true);
    try {
      const hasQuery = Boolean(query.trim());
      const params: Record<string, string | number> = { page: p, perPage, sort };
      if (selectedGenre) params.genre = selectedGenre;
      if (selectedFormat) params.format = selectedFormat;
      if (selectedStatus) params.status = selectedStatus;
      if (selectedSeason) params.season = selectedSeason;
      if (selectedYear) params.year = parseInt(selectedYear);

      const data = hasQuery
        ? await api.search({ ...params, q: query.trim() })
        : await api.filter(params);
      setResults(filterAnimeList(data.results || []));
      setTotal(data.total || 0);
    } catch (e) {
      console.error("Browse search failed:", e);
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

  const totalPages = Math.ceil(total / perPage);

  return (
    <div className="min-h-screen bg-[#0d0f14]">
      <div className="mx-auto max-w-[1440px] px-3 py-5 sm:px-4 sm:py-6">
        <div className="mb-5 flex items-center justify-between gap-3">
          <h1 className="font-display text-xl font-bold uppercase tracking-wide text-white sm:text-2xl md:text-3xl">
            Browser
          </h1>
          <span className="shrink-0 text-xs text-[#9ca3af] sm:text-sm">
            {total.toLocaleString()} anime
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
                subCount={epCounts[anime.id]?.sub}
                dubCount={epCounts[anime.id]?.dub}
              />
            ) : (
              <AnimeCardSkeleton key={i} />
            )
          )}
        </div>

        {!loading && results.length === 0 && (
          <p className="py-16 text-center text-[#9ca3af]">No anime found. Try different filters.</p>
        )}

        {totalPages > 1 && (
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
              {page} / {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage(Math.min(totalPages, page + 1))}
              disabled={page >= totalPages}
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
