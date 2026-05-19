"use client";

import { useEffect, useMemo, useState, useRef } from "react";
import Link from "next/link";
import AnimeCard, { AnimeCardSkeleton } from "@/components/AnimeCard";
import { api, type AnimeMedia } from "@/lib/api";
import { filterAnimeList } from "@/lib/anime-filters";
import { clientApi } from "@/lib/client-api";
import { useAuth } from "@/components/AuthProvider";
import { useEpisodeCountsMap } from "@/hooks/useEpisodeCounts";
import {
  listQualifiedLocalWatchProgress,
  type LocalWatchProgress,
} from "@/lib/watch-progress";

// ─── cute grill sidebar ───────────────────────────────────────────────────────

const CUTE_GIRLS = [
  "1363382418078.png","141000167429.png","1410001686910.png","1410306398205.png",
  "1416301704148.png","1422254058570.png","1422254999827.png","1424092566613.png",
  "1428177826695.png","1428177904344.png","1428178080167.png","1428178155255.png",
  "1428178187507.png","1428254016467.png","1428423289437.png","1428707759205.png",
  "1429510703681.png","14350958102351.png","1435095810963.png","1435212506997.png",
  "1436240851027.png","1444797684947.png","1444797896875.png","1444912076567.png",
  "1444925656945.png","1444932063639.png","1445288849940.png","1445289056206.png",
  "1445902711571.png","1446055508030.png","1446382234634.png","1446463082730.png",
  "1446543984763.png","1446567791227.png","1446781681255.png","1447699627084.png",
  "1448061734635.png","1448184200057.png","1448242472700.png","1448242666775.png",
  "1448491901093.png","1448856052869.png","1449726465401.png","1450354879735.png",
  "1450722871010.png","1450724583409.png","1450726187259.png","1453766877670.png",
  "1456435736475.png","1456626037119.png","1456795820199.png","1457227943457.png",
  "1457343592535.png","1457740113058.png","1457765150963.png","1457903809526.png",
  "1458107401807.png","1458114655716.png","1458179149667.png","1458181302393.png",
  "1458378445396.png","1458438424722.png","1458593213144.png","1458602218407.png",
  "1458689827974.png","1458695854180.png","1458701216283.png","1458879883654.png",
  "1459005360759.png","1459039594461.png","1466924283295.png","1468421480662.png",
  "1471262460053.png","1471285748918.png","1472894659994.png","1480486527028.png",
  "1484879057343.png","1486346829409.png","1489034771085.png","1489257402500.png",
  "1489281927118.png","1489297097940.png","1490418851494.png","1492281060221.png",
  "1494909700688.png","1506616576326.png","1512072270390.png","1512276789957.png",
  "7ckzd1.png","e1c25e2f18430875d15fdcfbb14257e8.png","megumin_1.png","megumin_2.png",
  "nz5vnb.png","patreon-1.png","patreon-2.png","patreon-3.png","patreon-4.png",
  "patreon-5.png","e9b96c420ce18817342e49c48a6474c589e681ba.png",
  "e5fb6b20a0c08e4c1e8b8240311b086649ee22e5.png",
  "d4eab1c1e9ed18b875bf126ca2695a3f6eb19572.png",
  "c2289fbdd0c68b41ab577b5aea13ce57244ae761.png",
  "c7a2402a46d629ecbc4ede1013725579ed5bfad8.png",
  "b938a56e8a244d36ad95d03747c885e113f85c2a.png",
  "b3bbb9663ede2787c679ed87bb275989b87a92d7.png",
  "ae317675248165f9eb0e5d1e8acb4133313c5338.png",
  "ac0d60cadc20650dc2b1909d986d6c2c0b851957.png",
  "a33ae892991a84c1b5bc21e0a94a2cd112983d8a.png",
  "a5f8a60024d2e767c4f914c7959f3bf3af6c310e.png",
  "05231e2b5d3b8a349e05a8faeeb811238c936a87.png",
  "0708bf53626f99a3d48af309bd68726e6cf3069b.png",
  "0405c517061c231de1b82ae64cdc705d84309bec.png",
  "300c90359065eff5d5bd8b7f7960b97c6b038698.png",
  "85bc49d77b4d6c6b8de30ba8dcb09fd8953c998f.png",
  "73a31b9f354dcf44d613ad260ad3fb3b050c4e1b.png",
  "041b992b2d1d471f4c9141ce6d7693feba846661.png",
  "027f2e9193b1421b57f8c346864b5e76a4dcf06e.png",
  "9f02075ced49095a4b0af001204b86b59a37fc64.png",
  "9b2c84b3e011ab903073ce52c0b6ba0bdf620aea.png",
  "8c3320676e921e900f0ff432afb3774179250c50.png",
  "7fd5965f41dcc6d73b13a9338ff9d90f76f712fe.png",
  "5db1e4e942be929fd139d895f6ada111941a0806.png",
  "5c48162e4446d4c0597813804f8a8f65e60791b5.png",
  "5a1998883c5f117fd913cbc2bfa9ea86d2f47e37.png",
  "4babdfe8cc20226b619089b55e613eacdcadf77b.png",
  "3d31d92b4fdfa126bca3aa0c3d9210350f3b8943.png",
  "3c15b632c4d1cf2406585f335f69c201011e033b.png",
  "2c003b12e53212fc13595e092d96b6282f86d456.png",
];

function CuteGrillWidget() {
  const [img] = useState(() => CUTE_GIRLS[0]);
  const [visible, setVisible] = useState(false);
  const [errored, setErrored] = useState(false);

  if (errored) return null;

  return (
    <div className="pointer-events-none absolute bottom-4 right-4 z-10 w-24 overflow-hidden rounded-md border border-[var(--border)] bg-[var(--card)]/95 shadow-lg shadow-black/20 backdrop-blur-sm">
      <img
        src={`https://catbox.moe/pictures/qts/${img}`}
        alt="cute grill"
        className="block h-auto w-full"
        loading="lazy"
        style={{ opacity: visible ? 1 : 0, transition: "opacity 0.3s" }}
        onLoad={() => setVisible(true)}
        onError={() => setErrored(true)}
      />
    </div>
  );
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function SectionHeader({
  title,
  href,
  label = "Browse all",
}: {
  title: string;
  href?: string;
  label?: string;
}) {
  return (
    <div className="mb-3 flex items-center justify-between">
      <h2 className="font-mono text-xs font-semibold uppercase tracking-widest text-[var(--muted)]">
        {title}
      </h2>
      {href && (
        <Link href={href} className="font-mono text-xs text-[var(--accent)] hover:underline">
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

  return (
    <div
      ref={ref}
      className="flex gap-2 overflow-x-auto pb-2 select-none [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      onMouseDown={(e) => {
        down.current = true;
        startX.current = e.pageX - (ref.current?.offsetLeft ?? 0);
        scrollLeft.current = ref.current?.scrollLeft ?? 0;
        if (ref.current) ref.current.style.cursor = "grabbing";
      }}
      onMouseLeave={() => {
        down.current = false;
        if (ref.current) ref.current.style.cursor = "";
      }}
      onMouseUp={() => {
        down.current = false;
        if (ref.current) ref.current.style.cursor = "";
      }}
      onMouseMove={(e) => {
        if (!down.current || !ref.current) return;
        e.preventDefault();
        const x = e.pageX - ref.current.offsetLeft;
        const walk = (x - startX.current) * 1.2;
        ref.current.scrollLeft = scrollLeft.current - walk;
      }}
      style={{ cursor: "grab" }}
    >
      {children}
    </div>
  );
}

function CardRow({
  items,
  loading,
  count,
  epCounts,
}: {
  items: AnimeMedia[];
  loading: boolean;
  count: number;
  epCounts: Record<number, { sub: number; dub: number }>;
}) {
  return (
    <HScroll>
      {(loading ? Array<null>(count).fill(null) : items).map((a, i) =>
        a ? (
          <div key={a.id} className="w-[130px] shrink-0">
            <AnimeCard
              anime={a}
              size="compact"
              subCount={epCounts[a.id]?.sub}
              dubCount={epCounts[a.id]?.dub}
            />
          </div>
        ) : (
          <div key={i} className="w-[130px] shrink-0">
            <AnimeCardSkeleton />
          </div>
        )
      )}
    </HScroll>
  );
}

// ─── Airing Schedule strip ─────────────────────────────────────────────────

function ScheduleStrip({ items }: { items: AnimeMedia[] }) {
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    const updateNow = () => setNow(Math.floor(Date.now() / 1000));
    updateNow();
    const timer = setInterval(updateNow, 60_000);
    return () => clearInterval(timer);
  }, []);

  if (now === null) return null;

  const scheduled = items
    .filter((a) => a.nextAiringEpisode?.airingAt)
    .sort((a, b) => (a.nextAiringEpisode!.airingAt) - (b.nextAiringEpisode!.airingAt))
    .slice(0, 14);

  if (!scheduled.length) return null;

  function fmtCountdown(secs: number): string {
    if (secs <= 0) return "Airing now";
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }

  return (
    <HScroll>
      {scheduled.map((a) => {
        const ep = a.nextAiringEpisode!;
        const left = ep.airingAt - now;
        const title =
          a.title?.english || a.title?.romaji || `Anime #${a.id}`;
        return (
          <Link
            key={a.id}
            href={`/anime/${a.id}`}
            className="flex w-[160px] shrink-0 flex-col overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--card)] hover:border-[var(--accent)] transition-colors"
          >
            <div className="relative h-[80px] overflow-hidden bg-[#1a1d28]">
              {a.coverImage?.large && (
                <img
                  src={a.coverImage.large}
                  alt=""
                  className="h-full w-full object-cover opacity-70"
                />
              )}
              <div className="absolute inset-0 bg-gradient-to-t from-black/70 to-transparent" />
              <span className="absolute bottom-1.5 left-1.5 rounded bg-[#e8621a] px-1.5 py-0.5 font-mono text-[9px] font-bold text-white">
                EP {ep.episode}
              </span>
            </div>
            <div className="p-2">
              <p className="mb-1 line-clamp-1 font-mono text-[10px] font-semibold text-white">
                {title}
              </p>
              <span
                className={`font-mono text-[9px] font-bold ${
                  left <= 3600 ? "text-[#e8621a]" : "text-[var(--muted)]"
                }`}
              >
                {fmtCountdown(left)}
              </span>
            </div>
          </Link>
        );
      })}
    </HScroll>
  );
}

// ─── Latest Updates grid (All / Sub / Dub / Trending / Random) ────────────

const UPDATE_TABS = ["All", "Sub", "Dub", "Trending", "Random"] as const;
type UpdateTab = (typeof UPDATE_TABS)[number];

function LatestUpdatesGrid({
  all,
  trending,
  epCounts,
}: {
  all: AnimeMedia[];
  trending: AnimeMedia[];
  epCounts: Record<number, { sub: number; dub: number }>;
}) {
  const [tab, setTab] = useState<UpdateTab>("All");
  const [seed] = useState(() => Math.random());

  const items = useMemo(() => {
    let pool = all;
    if (tab === "Trending") pool = trending;
    if (tab === "Random") {
      // Deterministic shuffle using seed so it doesn't change on every render
      let s = seed * 2147483647;
      const shuffled = [...all].sort(() => {
        s = (s * 1664525 + 1013904223) % 2147483648;
        return (s / 2147483648) - 0.5;
      });
      return shuffled.slice(0, 12);
    }
    if (tab === "Sub") pool = all.filter((a) => (epCounts[a.id]?.sub ?? 0) > 0);
    if (tab === "Dub") pool = all.filter((a) => (epCounts[a.id]?.dub ?? 0) > 0);
    return pool.slice(0, 12);
  }, [tab, all, trending, epCounts, seed]);

  return (
    <div>
      <div className="mb-3 flex items-center gap-1 overflow-x-auto pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {UPDATE_TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`shrink-0 rounded px-3 py-1 font-mono text-[11px] font-semibold transition-colors ${
              tab === t
                ? "bg-[#e8621a] text-white"
                : "border border-[var(--border)] text-[var(--muted)] hover:border-[var(--accent)] hover:text-white"
            }`}
          >
            {t}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
        {items.map((a) => (
          <AnimeCard
            key={a.id}
            anime={a}
            size="compact"
            subCount={epCounts[a.id]?.sub}
            dubCount={epCounts[a.id]?.dub}
          />
        ))}
      </div>
    </div>
  );
}

// ─── A-Z Browse ───────────────────────────────────────────────────────────

const AZ_LETTERS = ["#", "0-9", ...Array.from("ABCDEFGHIJKLMNOPQRSTUVWXYZ")];

function AZBrowse() {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
      <p className="mb-3 font-mono text-[10px] uppercase tracking-widest text-[var(--muted)]">
        A-Z List · Searching anime order by alphabet name A to Z
      </p>
      <div className="flex flex-wrap gap-1.5">
        {AZ_LETTERS.map((l) => (
          <Link
            key={l}
            href={`/browse?letter=${encodeURIComponent(l)}`}
            className="rounded border border-[var(--border)] px-2.5 py-1 font-mono text-[11px] font-semibold text-[var(--muted)] hover:border-[var(--accent)] hover:text-white transition-colors"
          >
            {l}
          </Link>
        ))}
      </div>
    </div>
  );
}

type ContinueItem = {
  id: string;
  animeId: number;
  episodeNumber: number;
  category: string;
  title?: string | null;
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
    title: w.title,
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
    .filter((item) => {
      if (seen.has(item.animeId)) return false;
      seen.add(item.animeId);
      return true;
    });
}

function formatResumeTime(seconds?: number | null) {
  if (!seconds || seconds < 1) return null;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

// ─── Page ─────────────────────────────────────────────────────────────────

export default function HomePage() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);

  const [trending, setTrending] = useState<AnimeMedia[]>([]);
  const [fresh, setFresh] = useState<AnimeMedia[]>([]);
  const [latestReleases, setLatestReleases] = useState<AnimeMedia[]>([]);
  const [recentlyCompleted, setRecentlyCompleted] = useState<AnimeMedia[]>([]);
  const [schedule, setSchedule] = useState<AnimeMedia[]>([]);
  const [continueList, setContinueList] = useState<ContinueItem[]>([]);

  const allIds = useMemo(
    () => [...trending, ...fresh, ...latestReleases, ...recentlyCompleted].map((a) => a.id),
    [trending, fresh, latestReleases, recentlyCompleted]
  );
  const epCounts = useEpisodeCountsMap(allIds);

  useEffect(() => {
    (async () => {
      try {
        const [trendRes, freshRes, latestRes, completedRes, schedRes] = await Promise.all([
          api.getTrending(1, 12),
          api.getFresh(1, 16),
          api.getLatestReleases(1, 12),
          api.getRecentlyCompleted(1, 10),
          api.getSchedule(1, 25),
        ]);
        setTrending(filterAnimeList(trendRes.results || []));
        setFresh(filterAnimeList(freshRes.results || []));
        setLatestReleases(filterAnimeList(latestRes.results || []));
        setRecentlyCompleted(filterAnimeList(completedRes.results || []));
        // schedule uses media from airingSchedules; getSchedule returns results with nextAiringEpisode
        setSchedule(filterAnimeList((schedRes.results as AnimeMedia[]) || []));
        const localItems = listQualifiedLocalWatchProgress(12).map(localWatchToContinueItem);
        if (user) await clientApi.getWatch().catch(() => null);
        setContinueList(mergeContinueItems(localItems).slice(0, 6));
      } catch (e) {
        console.warn("Home feed failed to load:", e);
        setContinueList(listQualifiedLocalWatchProgress(6).map(localWatchToContinueItem));
      } finally {
        setLoading(false);
      }
    })();
  }, [user]);

  return (
    <div className="mx-auto max-w-[1520px] px-4 py-6">
      <div className="relative">
        <div className="min-w-0 space-y-10 xl:pr-36">

      {/* Continue Watching */}
      {continueList.length > 0 && (
        <section>
          <SectionHeader title="Continue Watching" href="/profile?tab=continue" label="See all" />
          <div className="flex flex-col gap-2">
            {continueList.map((w) => (
              (() => {
                const resumeTime = formatResumeTime(w.positionSeconds);
                return (
                  <Link
                    key={w.id}
                    href={`/anime/${w.animeId}/watch?ep=${w.episodeNumber}&cat=${w.category}`}
                    className="flex items-center gap-3 rounded border border-[var(--border)] bg-[var(--card)] px-3 py-2 font-mono text-xs hover:border-[var(--accent)]"
                  >
                    {w.poster ? (
                      <img
                        src={w.poster}
                        alt=""
                        className="h-12 w-9 shrink-0 rounded object-cover"
                        loading="lazy"
                      />
                    ) : null}
                    <span className="min-w-0">
                      <span className="block truncate text-[var(--foreground)]">
                        {w.animeTitle || `Anime #${w.animeId}`}
                      </span>
                      <span className="text-[var(--muted)]">
                        EP {w.episodeNumber} ({w.category})
                        {resumeTime ? ` · ${resumeTime}` : ""}
                      </span>
                    </span>
                  </Link>
                );
              })()
            ))}
          </div>
        </section>
      )}

      {/* Trending */}
      <section>
        <SectionHeader title="Trending" href="/browse?sort=TRENDING_DESC" />
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
          {(loading ? Array<null>(12).fill(null) : trending).map((a, i) =>
            a ? (
              <AnimeCard
                key={a.id}
                anime={a}
                size="compact"
                subCount={epCounts[a.id]?.sub}
                dubCount={epCounts[a.id]?.dub}
              />
            ) : (
              <AnimeCardSkeleton key={i} />
            )
          )}
        </div>
      </section>

      {/* Airing Schedule */}
      {(loading || schedule.length > 0) && (
        <section>
          <SectionHeader title="Airing Schedule" href="/browse?status=RELEASING&sort=TRENDING_DESC" label="View all airing" />
          {loading ? (
            <div className="flex gap-2 overflow-hidden">
              {Array<null>(8).fill(null).map((_, i) => (
                <div key={i} className="h-[130px] w-[160px] shrink-0 animate-pulse rounded-lg bg-[var(--card)]" />
              ))}
            </div>
          ) : (
            <ScheduleStrip items={schedule} />
          )}
        </section>
      )}

      {/* Latest Updates */}
      <section>
        <SectionHeader title="Latest Updates" />
        <LatestUpdatesGrid all={fresh} trending={trending} epCounts={epCounts} />
      </section>

      {/* Fresh Additions */}
      <section>
        <SectionHeader title="Fresh Additions" href="/browse?sort=UPDATED_AT_DESC" />
        <CardRow items={fresh} loading={loading} count={16} epCounts={epCounts} />
      </section>

      {/* Latest Releases */}
      <section>
        <SectionHeader title="Latest Releases" href="/browse?status=RELEASING&sort=START_DATE_DESC" />
        <CardRow items={latestReleases} loading={loading} count={12} epCounts={epCounts} />
      </section>

      {/* Recently Completed */}
      <section>
        <SectionHeader title="Recently Completed" href="/browse?status=FINISHED&sort=END_DATE_DESC" />
        <CardRow items={recentlyCompleted} loading={loading} count={10} epCounts={epCounts} />
      </section>

      {/* A-Z Browse */}
      <section>
        <AZBrowse />
      </section>

        </div>{/* end main content */}

        {/* Cute grill widget, only on very wide screens */}
        <aside className="pointer-events-none hidden xl:block">
          <CuteGrillWidget />
        </aside>
      </div>
    </div>
  );
}
