"use client";

import { Suspense, useState, useEffect, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import AnimeCard, { AnimeCardSkeleton } from "@/components/AnimeCard";
import BrowseFilterBar from "@/components/BrowseFilterBar";
import { type GenreData } from "@/lib/api";
import { otakubox, cardToMedia } from "@/lib/otakubox";

// Map AniList-style filter values → Otakubox values
const FORMAT_MAP: Record<string, string> = {
  TV: "TV",
  MOVIE: "Movie",
  OVA: "OVA",
  ONA: "ONA",
  SPECIAL: "Special",
  TV_SHORT: "",
};
const STATUS_MAP: Record<string, string> = {
  RELEASING: "Currently Airing",
  FINISHED: "Completed",
  NOT_YET_RELEASED: "Not yet aired",
  CANCELLED: "",
  HIATUS: "",
};
const SORT_MAP: Record<string, string> = {
  UPDATED_AT_DESC: "recent",
  POPULARITY_DESC: "score",
  TRENDING_DESC: "score",
  START_DATE_DESC: "year",
  SCORE_DESC: "score",
};

function BrowseContent() {
  const searchParams = useSearchParams();

  const [loading, setLoading] = useState(true);
  const [results, setResults] = useState<ReturnType<typeof cardToMedia>[]>([]);
  const [subCounts, setSubCounts] = useState<number[]>([]);
  const [dubCounts, setDubCounts] = useState<number[]>([]);
  const [genres, setGenres] = useState<GenreData | null>(null);
  const [openGenre, setOpenGenre] = useState(false);

  const [query, setQuery] = useState(searchParams.get("q") || "");
  const [selectedGenre, setSelectedGenre] = useState(searchParams.get("genre") || "");
  const [selectedFormat, setSelectedFormat] = useState(searchParams.get("format") || "");
  const [selectedStatus, setSelectedStatus] = useState(searchParams.get("status") || "");
  const [sort, setSort] = useState(searchParams.get("sort") || "SCORE_DESC");
  const [page, setPage] = useState(1);
  const [hasNextPage, setHasNextPage] = useState(false);

  const perPage = 24;

  const fetchResults = useCallback(async (p: number) => {
    setLoading(true);
    try {
      const rawCards = await otakubox.search({
        q: query.trim() || undefined,
        genre: selectedGenre || undefined,
        type: FORMAT_MAP[selectedFormat] || undefined,
        status: STATUS_MAP[selectedStatus] || undefined,
        sort: SORT_MAP[sort] || "score",
        page: p,
        limit: perPage,
      });

      const cards = rawCards.filter((c) => c.anilist_id);
      setResults(cards.map(cardToMedia));
      setSubCounts(cards.map((c) => c.sub_count));
      setDubCounts(cards.map((c) => c.dub_count));
      setHasNextPage(rawCards.length >= perPage);
    } catch (e) {
      console.error("Browse search failed:", e);
      setResults([]);
      setSubCounts([]);
      setDubCounts([]);
    } finally {
      setLoading(false);
    }
  }, [query, selectedGenre, selectedFormat, selectedStatus, sort]);

  useEffect(() => {
    otakubox.getGenres()
      .then((list) => setGenres({ genres: list, formats: [], statuses: [], seasons: [] }))
      .catch(() => {});
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
            Browse
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
                subCount={subCounts[i]}
                dubCount={dubCounts[i]}
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
            <span className="px-3 font-mono text-sm text-[#9ca3af]">{page}</span>
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
