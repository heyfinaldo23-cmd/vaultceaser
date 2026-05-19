"use client";

import { useRef, useEffect } from "react";
import { Search, ChevronDown, Wand2 } from "lucide-react";
import type { GenreData } from "@/lib/api";
import { FORMAT_OPTIONS, STATUS_OPTIONS } from "@/lib/format-labels";

const SORT_OPTIONS = [
  { value: "UPDATED_AT_DESC", label: "Updated date" },
  { value: "POPULARITY_DESC", label: "Most popular" },
  { value: "TRENDING_DESC", label: "Trending" },
  { value: "START_DATE_DESC", label: "Newest" },
  { value: "SCORE_DESC", label: "Top rated" },
];

export type BrowseFilterState = {
  query: string;
  selectedGenre: string;
  selectedFormat: string;
  selectedStatus: string;
  sort: string;
};

type Props = BrowseFilterState & {
  genres: GenreData | null;
  openGenre: boolean;
  setOpenGenre: (v: boolean) => void;
  onChange: (patch: Partial<BrowseFilterState>) => void;
  onApply: () => void;
  toggleGenre: (genre: string) => void;
};

const selectCls =
  "browse-select h-10 min-w-[100px] cursor-pointer appearance-none rounded-lg border border-[#2a2d3a] bg-[#1a1d28] pl-3 pr-8 text-sm text-white focus:border-[#e8621a] focus:outline-none";

export default function BrowseFilterBar({
  query,
  selectedGenre,
  selectedFormat,
  selectedStatus,
  sort,
  genres,
  openGenre,
  setOpenGenre,
  onChange,
  onApply,
  toggleGenre,
}: Props) {
  const genreRef = useRef<HTMLDivElement>(null);
  const selectedGenres = selectedGenre ? selectedGenre.split(",").filter(Boolean) : [];

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (genreRef.current && !genreRef.current.contains(e.target as Node)) {
        setOpenGenre(false);
      }
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [setOpenGenre]);

  return (
    <div className="mb-6 flex flex-wrap items-center gap-2 lg:flex-nowrap">
      {/* Search */}
      <div className="relative min-w-[140px] flex-1">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#6b7280]" />
        <input
          value={query}
          onChange={(e) => onChange({ query: e.target.value })}
          onKeyDown={(e) => e.key === "Enter" && onApply()}
          placeholder="Search..."
          className="h-10 w-full rounded-lg border border-[#2a2d3a] bg-[#1a1d28] pl-9 pr-3 text-sm text-white placeholder:text-[#6b7280] focus:border-[#e8621a] focus:outline-none"
        />
      </div>

      {/* Type */}
      <select
        value={selectedFormat}
        onChange={(e) => onChange({ selectedFormat: e.target.value })}
        className={selectCls}
        aria-label="Type"
      >
        {FORMAT_OPTIONS.map((o) => (
          <option key={o.value || "all"} value={o.value}>
            {o.value ? o.label : "Type"}
          </option>
        ))}
      </select>

      {/* Genre */}
      <div ref={genreRef} className="relative">
        <button
          type="button"
          onClick={() => setOpenGenre(!openGenre)}
          className={`${selectCls} flex items-center gap-1 text-left`}
        >
          <span className="truncate">
            {selectedGenres.length ? `Genre (${selectedGenres.length})` : "Genre"}
          </span>
          <ChevronDown className="ml-auto h-3.5 w-3.5 shrink-0 text-[#6b7280]" />
        </button>

        {openGenre && genres && (
          <div className="absolute left-0 top-full z-50 mt-1 w-[min(520px,calc(100vw-2rem))] rounded-xl border border-[#2a2d3a] bg-[#1a1d28] p-4 shadow-2xl">
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3 md:grid-cols-4">
              {genres.genres.map((genre) => (
                <label
                  key={genre}
                  className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm text-[#c8cad4] hover:bg-[#252830] hover:text-white"
                >
                  <input
                    type="checkbox"
                    checked={selectedGenres.includes(genre)}
                    onChange={() => toggleGenre(genre)}
                    className="h-3.5 w-3.5 rounded border-[#3d4254] accent-[#e8621a]"
                  />
                  <span className="truncate">{genre}</span>
                </label>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Status */}
      <select
        value={selectedStatus}
        onChange={(e) => onChange({ selectedStatus: e.target.value })}
        className={selectCls}
        aria-label="Status"
      >
        {STATUS_OPTIONS.map((o) => (
          <option key={o.value || "all"} value={o.value}>
            {o.value ? o.label : "Status"}
          </option>
        ))}
      </select>

      {/* Updated date → sort */}
      <select
        value={sort}
        onChange={(e) => onChange({ sort: e.target.value })}
        className={`${selectCls} min-w-[130px]`}
        aria-label="Updated date"
      >
        {SORT_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>

      <button
        type="button"
        onClick={onApply}
        className="flex h-10 shrink-0 items-center justify-center gap-2 rounded-lg bg-[#e8621a] px-5 text-sm font-semibold text-white shadow-lg shadow-[#e8621a]/25 transition-colors hover:bg-[#d45510]"
      >
        <Wand2 className="h-4 w-4" />
        Filter
      </button>
    </div>
  );
}
