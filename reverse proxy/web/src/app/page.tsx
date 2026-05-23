"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import Link from "next/link";
import { useAuth } from "@/components/AuthProvider";
import AnimeCard, { AnimeCardSkeleton } from "@/components/AnimeCard";
import {
  listQualifiedLocalWatchProgress,
  type LocalWatchProgress,
} from "@/lib/watch-progress";
import { otakubox, cardToMedia, resolveAnilistId, type OtakuCard } from "@/lib/otakubox";
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

// ─── Otakubox card row ────────────────────────────────────────────────────────

function OtakuRow({ cards }: { cards: OtakuCard[] }) {
  return (
    <HScroll>
      {cards.filter((c) => resolveAnilistId(c)).map((card) => {
        const media: AnimeMedia = cardToMedia(card);
        const aid = resolveAnilistId(card)!;
        return (
          <div key={aid} className="w-[140px] shrink-0 sm:w-[160px]">
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
              <HScroll>
                {continueList.map((w) => {
                  const media: AnimeMedia = {
                    id: w.animeId,
                    title: { english: w.animeTitle || undefined, romaji: w.animeTitle || undefined },
                    coverImage: { large: w.poster || undefined, extraLarge: w.poster || undefined },
                    episodes: null,
                  };
                  return (
                    <div key={w.id} className="w-[140px] shrink-0 sm:w-[160px]">
                      <AnimeCard
                        anime={media}
                        size="compact"
                        href={`/anime/${w.animeId}/watch?ep=${w.episodeNumber}&cat=${w.category}`}
                      />
                    </div>
                  );
                })}
              </HScroll>
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
        </div>

        <aside className="pointer-events-none fixed bottom-0 right-0 z-[9999] hidden xl:block">
          <CuteGrillWidget />
        </aside>
      </div>
    </div>
  );
}
