"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import Link from "next/link";
import { useAuth } from "@/components/AuthProvider";
import AnimeCard, { AnimeCardSkeleton } from "@/components/AnimeCard";
import {
  listQualifiedLocalWatchProgress,
  type LocalWatchProgress,
} from "@/lib/watch-progress";
import { otakubox, cardToMedia, type OtakuCard } from "@/lib/otakubox";
import type { AnimeMedia } from "@/lib/api";

// ─── cute grill widget ────────────────────────────────────────────────────────

const CUTE_GIRLS = [
  "1363382418078.png","141000167429.png","1410001686910.png","1410306398205.png",
  "1416301704148.png","1422254058570.png","1422254999827.png","1424092566613.png",
  "megumin_1.png","megumin_2.png","nz5vnb.png","patreon-1.png","patreon-2.png",
  "e9b96c420ce18817342e49c48a6474c589e681ba.png",
];
const CATBOX_QTS_BASE = "https://catbox.moe/pictures/qts";

function CuteGrillWidget() {
  const [index, setIndex] = useState(0);
  const [visible, setVisible] = useState(false);
  const [errored, setErrored] = useState(false);
  const [attempts, setAttempts] = useState(0);

  useEffect(() => {
    setIndex(Math.floor(Math.random() * CUTE_GIRLS.length));
  }, []);

  if (errored) return null;
  const img = CUTE_GIRLS[index];

  return (
    <img
      key={img}
      src={`${CATBOX_QTS_BASE}/${img}`}
      alt=""
      className="h-auto w-40 align-middle drop-shadow-[0_12px_24px_rgba(0,0,0,0.45)]"
      loading="lazy"
      referrerPolicy="no-referrer"
      style={{ opacity: visible ? 1 : 0, transition: "opacity 0.3s" }}
      onLoad={() => setVisible(true)}
      onError={() => {
        if (attempts >= CUTE_GIRLS.length - 1) { setErrored(true); return; }
        setVisible(false);
        setAttempts((n) => n + 1);
        setIndex((c) => (c + 1) % CUTE_GIRLS.length);
      }}
    />
  );
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function SectionHeader({ title, href, label = "Browse all" }: { title: string; href?: string; label?: string }) {
  return (
    <div className="mb-3 flex items-center justify-between">
      <h2 className="font-mono text-xs font-bold uppercase tracking-widest text-[var(--muted)]">
        {title}
      </h2>
      {href && (
        <Link href={href} className="font-mono text-xs font-bold text-[var(--accent)] hover:underline">
          {label}
        </Link>
      )}
    </div>
  );
}

function HScroll({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const down = useRef(false);
  const startX = useRef(0);
  const scrollLeft = useRef(0);
  const hasDragged = useRef(false);

  return (
    <div
      ref={ref}
      className="flex gap-2 overflow-x-auto pb-2 select-none [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      onMouseDown={(e) => {
        down.current = true;
        hasDragged.current = false;
        startX.current = e.pageX - (ref.current?.offsetLeft ?? 0);
        scrollLeft.current = ref.current?.scrollLeft ?? 0;
        if (ref.current) ref.current.style.cursor = "grabbing";
      }}
      onMouseLeave={() => { down.current = false; if (ref.current) ref.current.style.cursor = ""; }}
      onMouseUp={() => { down.current = false; if (ref.current) ref.current.style.cursor = ""; }}
      onMouseMove={(e) => {
        if (!down.current || !ref.current) return;
        e.preventDefault();
        const x = e.pageX - ref.current.offsetLeft;
        const walk = (x - startX.current) * 1.2;
        if (Math.abs(walk) > 5) hasDragged.current = true;
        ref.current.scrollLeft = scrollLeft.current - walk;
      }}
      onDragStart={(e) => e.preventDefault()}
      onClick={(e) => {
        if (hasDragged.current) { e.preventDefault(); e.stopPropagation(); hasDragged.current = false; }
      }}
      style={{ cursor: "grab" }}
    >
      {children}
    </div>
  );
}

// ─── A-Z Browse ───────────────────────────────────────────────────────────────

const AZ_LETTERS = ["#", "0-9", ...Array.from("ABCDEFGHIJKLMNOPQRSTUVWXYZ")];

function AZBrowse() {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
      <p className="mb-3 font-mono text-[10px] font-bold uppercase tracking-widest text-[var(--muted)]">
        A-Z List · Browse anime alphabetically
      </p>
      <div className="flex flex-wrap gap-1.5">
        {AZ_LETTERS.map((l) => (
          <Link
            key={l}
            href={`/browse?letter=${encodeURIComponent(l)}`}
            className="rounded border border-[var(--border)] px-2.5 py-1 font-mono text-[11px] font-bold text-[var(--muted)] hover:border-[var(--accent)] hover:text-white transition-colors"
          >
            {l}
          </Link>
        ))}
      </div>
    </div>
  );
}

// ─── Continue Watching ────────────────────────────────────────────────────────

type ContinueItem = {
  id: string;
  animeId: number;
  episodeNumber: number;
  category: string;
  animeTitle?: string | null;
  poster?: string | null;
  positionSeconds?: number | null;
  updatedAt: string;
};

function localWatchToContinueItem(w: LocalWatchProgress): ContinueItem {
  return {
    id: `local-${w.animeId}-${w.category}-${w.episodeNumber}`,
    animeId: w.animeId,
    episodeNumber: w.episodeNumber,
    category: w.category,
    animeTitle: w.animeTitle,
    poster: w.poster,
    positionSeconds: w.positionSeconds,
    updatedAt: w.updatedAt,
  };
}

function mergeContinueItems(items: ContinueItem[]) {
  const seen = new Set<number>();
  return [...items]
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .filter((item) => { if (seen.has(item.animeId)) return false; seen.add(item.animeId); return true; });
}

function formatResumeTime(seconds?: number | null) {
  if (!seconds || seconds < 1) return null;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

// ─── Otakubox card row ────────────────────────────────────────────────────────

function OtakuRow({ cards }: { cards: OtakuCard[] }) {
  return (
    <HScroll>
      {cards.map((card) => {
        const media: AnimeMedia = cardToMedia(card);
        return (
          <div key={card.anilist_id} className="w-[140px] shrink-0 sm:w-[160px]">
            <AnimeCard
              anime={media}
              size="compact"
              subCount={card.sub_count}
              dubCount={card.dub_count}
            />
          </div>
        );
      })}
    </HScroll>
  );
}

function OtakuRowSkeleton() {
  return (
    <div className="flex gap-2 overflow-hidden pb-2">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="w-[140px] shrink-0 sm:w-[160px]">
          <AnimeCardSkeleton />
        </div>
      ))}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function HomePage() {
  const { user } = useAuth();
  const [continueList, setContinueList] = useState<ContinueItem[]>([]);

  const [trending, setTrending] = useState<OtakuCard[]>([]);
  const [recent, setRecent] = useState<OtakuCard[]>([]);
  const [trendingLoading, setTrendingLoading] = useState(true);
  const [recentLoading, setRecentLoading] = useState(true);

  const resolve = useCallback(async () => {
    setContinueList(mergeContinueItems(listQualifiedLocalWatchProgress(6).map(localWatchToContinueItem)).slice(0, 6));
  }, []);

  useEffect(() => {
    resolve();

    otakubox.getTrending(1, 20)
      .then(setTrending)
      .catch(() => {})
      .finally(() => setTrendingLoading(false));

    otakubox.getRecent(1, 20)
      .then(setRecent)
      .catch(() => {})
      .finally(() => setRecentLoading(false));
  }, [resolve, user]);

  return (
    <div className="mx-auto max-w-[1520px] px-3 py-5 sm:px-4 sm:py-6">
      <div className="relative">
        <div className="min-w-0 space-y-10">

          {/* Continue Watching */}
          {continueList.length > 0 && (
            <section>
              <SectionHeader title="Continue Watching" href="/profile?tab=continue" label="See all" />
              <div className="flex flex-col gap-2">
                {continueList.map((w) => {
                  const resumeTime = formatResumeTime(w.positionSeconds);
                  return (
                    <Link
                      key={w.id}
                      href={`/anime/${w.animeId}/watch?ep=${w.episodeNumber}&cat=${w.category}`}
                      className="flex items-center gap-3 rounded border border-[var(--border)] bg-[var(--card)] px-3 py-2 font-mono text-xs font-bold hover:border-[var(--accent)]"
                    >
                      {w.poster && (
                        <img src={w.poster} alt="" className="h-12 w-9 shrink-0 rounded object-cover" loading="lazy" />
                      )}
                      <span className="min-w-0">
                        <span className="block truncate text-[var(--foreground)]">
                          {w.animeTitle || `Anime #${w.animeId}`}
                        </span>
                        <span className="text-[var(--muted)]">
                          EP {w.episodeNumber} ({w.category}){resumeTime ? ` · ${resumeTime}` : ""}
                        </span>
                      </span>
                    </Link>
                  );
                })}
              </div>
            </section>
          )}

          {/* Trending */}
          <section>
            <SectionHeader title="Trending" href="/browse?sort=score" />
            {trendingLoading ? <OtakuRowSkeleton /> : <OtakuRow cards={trending} />}
          </section>

          {/* Recent */}
          <section>
            <SectionHeader title="Recently Updated" href="/browse?sort=recent" />
            {recentLoading ? <OtakuRowSkeleton /> : <OtakuRow cards={recent} />}
          </section>

          {/* A-Z Browse */}
          <section><AZBrowse /></section>

        </div>

        <aside className="pointer-events-none fixed bottom-0 right-0 z-[9999] hidden xl:block">
          <CuteGrillWidget />
        </aside>
      </div>
    </div>
  );
}
