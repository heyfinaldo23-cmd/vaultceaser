"use client";

import { useRef, useState, useMemo } from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

export type SeasonEntry = {
  id: number;
  label: string;
  title?: string;
  episodes?: number | null;
  releasedSub?: number;
  releasedDub?: number;
  image?: string;
  relation?: string;
  format?: string;
  isCurrent?: boolean;
  isNext?: boolean;
};

// Filter options — "ALL" + every unique format in the list
const FORMAT_LABELS: Record<string, string> = {
  TV: "TV",
  MOVIE: "Movie",
  OVA: "OVA",
  ONA: "ONA",
  SPECIAL: "Special",
};

export default function SeasonRail({
  seasons,
  currentId,
}: {
  seasons: SeasonEntry[];
  currentId: number;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const startX = useRef(0);
  const scrollLeft = useRef(0);
  const hasDragged = useRef(false);

  const [filter, setFilter] = useState<string>("ALL");

  // Build the filter list from formats actually present in the data
  const formats = useMemo(() => {
    const seen = new Set<string>();
    for (const s of seasons) {
      if (s.format && FORMAT_LABELS[s.format]) seen.add(s.format);
    }
    return Array.from(seen);
  }, [seasons]);

  const visible = useMemo(
    () =>
      filter === "ALL"
        ? seasons
        : seasons.filter((s) => (s.format || "") === filter || s.isCurrent),
    [seasons, filter]
  );

  if (!seasons.length) return null;

  return (
    <section className="mt-8">
      {/* Header + filter row */}
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h2 className="mr-auto font-mono text-xs font-semibold uppercase tracking-widest text-[var(--muted)]">
          Seasons
        </h2>
        {/* Filter pills — only show when there are multiple formats */}
        {formats.length > 1 && (
          <div className="flex gap-1 overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {["ALL", ...formats].map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={cn(
                  "shrink-0 rounded px-2.5 py-0.5 font-mono text-[10px] font-semibold transition-colors",
                  filter === f
                    ? "bg-[#e8621a] text-white"
                    : "border border-[var(--border)] text-[var(--muted)] hover:border-[var(--accent)] hover:text-white"
                )}
              >
                {f === "ALL" ? "All" : FORMAT_LABELS[f] ?? f}
              </button>
            ))}
          </div>
        )}
        <span className="font-mono text-[10px] text-[var(--muted)] hidden sm:block">
          Drag to scroll
        </span>
      </div>

      {/* Draggable scroll container */}
      <div
        ref={scrollRef}
        className="flex gap-2 overflow-x-auto pb-2 select-none [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        style={{ cursor: "grab" }}
        onMouseDown={(e) => {
          dragging.current = true;
          hasDragged.current = false;
          startX.current = e.pageX - (scrollRef.current?.offsetLeft ?? 0);
          scrollLeft.current = scrollRef.current?.scrollLeft ?? 0;
          if (scrollRef.current) scrollRef.current.style.cursor = "grabbing";
        }}
        onMouseLeave={() => {
          dragging.current = false;
          if (scrollRef.current) scrollRef.current.style.cursor = "grab";
        }}
        onMouseUp={() => {
          dragging.current = false;
          if (scrollRef.current) scrollRef.current.style.cursor = "grab";
        }}
        onMouseMove={(e) => {
          if (!dragging.current || !scrollRef.current) return;
          e.preventDefault();
          const x = e.pageX - scrollRef.current.offsetLeft;
          const walk = (x - startX.current) * 1.2;
          if (Math.abs(walk) > 5) hasDragged.current = true;
          scrollRef.current.scrollLeft = scrollLeft.current - walk;
        }}
        onDragStart={(e) => e.preventDefault()}
        onClick={(e) => {
          if (hasDragged.current) {
            e.preventDefault();
            e.stopPropagation();
            hasDragged.current = false;
          }
        }}
      >
        {visible.map((s, i) => {
          const active = s.id === currentId;
          const planned = s.episodes;
          const released = Math.max(s.releasedSub ?? 0, s.releasedDub ?? 0);
          const epLabel =
            planned != null && planned > 0
              ? `${released > 0 ? released : "0"} / ${planned}`
              : released > 0
                ? String(released)
                : "?";

          return (
            <Link
              key={`${s.id}-${i}`}
              href={`/anime/${s.id}`}
              className={cn(
                "group relative h-[96px] w-[148px] shrink-0 overflow-hidden rounded-lg border transition-all",
                active
                  ? "border-[#e8621a] ring-2 ring-[#e8621a]/40"
                  : s.isNext
                    ? "border-[#3ddc84]/60 ring-1 ring-[#3ddc84]/30 hover:border-[#3ddc84]"
                    : "border-[var(--border)] hover:border-[var(--muted)]"
              )}
            >
              {s.image ? (
                <img
                  src={s.image}
                  alt=""
                  className="h-full w-full object-cover opacity-75 transition-opacity group-hover:opacity-95"
                />
              ) : (
                <div className="h-full w-full bg-[#1a1d28]" />
              )}
              <div className="absolute inset-0 bg-gradient-to-t from-black via-black/50 to-transparent" />

              {s.isNext && !active && (
                <span className="absolute right-1.5 top-1.5 flex items-center gap-0.5 rounded bg-[#3ddc84] px-1.5 py-0.5 font-mono text-[8px] font-bold uppercase text-black">
                  Up next <ChevronRight className="h-3 w-3" />
                </span>
              )}

              {s.format && FORMAT_LABELS[s.format] && s.format !== "TV" && (
                <span className="absolute left-1.5 top-1.5 rounded bg-black/60 px-1.5 py-0.5 font-mono text-[8px] font-bold text-white/70">
                  {FORMAT_LABELS[s.format]}
                </span>
              )}

              <div className="absolute inset-x-0 bottom-0 p-2 text-center">
                <p className="font-mono text-[11px] font-bold text-white">{s.label}</p>
                {s.title && (
                  <p className="mt-0.5 line-clamp-1 text-[9px] text-white/60">{s.title}</p>
                )}
                <span
                  className={cn(
                    "mt-1 inline-block rounded px-2 py-0.5 font-mono text-[9px] font-bold",
                    active
                      ? "bg-[#e8621a] text-black"
                      : s.isNext
                        ? "bg-[#3ddc84]/90 text-black"
                        : "bg-white/20 text-white"
                  )}
                >
                  {epLabel} Eps
                </span>
              </div>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
