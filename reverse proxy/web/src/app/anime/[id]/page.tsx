"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  Bookmark,
  Calendar,
  Clock,
  ExternalLink,
  Play,
  Star,
  Tv,
} from "lucide-react";
import AnimeTrailerBackdrop from "@/components/AnimeTrailerBackdrop";
import GenreChips from "@/components/GenreChips";
import EpisodeCountBadges from "@/components/EpisodeCountBadges";
import SeasonRail, { type SeasonEntry } from "@/components/SeasonRail";
import SimilarCarousel from "@/components/SimilarCarousel";
import { api, type AnimeMedia, normalizeScore, mediaYear, mediaStudios } from "@/lib/api";
import { isBlockedAnime, filterAnimeList } from "@/lib/anime-filters";
import { formatLabel } from "@/lib/format-labels";
import { animeTitle } from "@/lib/anime-title";
import { formatAnimeDate, resolveTrailer } from "@/lib/anime-trailer";
import { clientApi } from "@/lib/client-api";
import { useAuth } from "@/components/AuthProvider";
import { fetchEpisodeCounts, rememberEpisodeCounts } from "@/lib/episode-counts";
import { buildSeasonList, enrichSeasonCounts } from "@/lib/seasons-from-relations";
import { getAnikotoEpCounts } from "@/lib/anikoto-cache";
import { filterExternalLinks, isBlockedExternalLink } from "@/lib/external-links";

type EpCounts = { sub: number; dub: number };

export default function AnimeOverviewPage() {
  const params = useParams();
  const router = useRouter();
  const { user } = useAuth();
  const id = Number(params.id);

  const [loading, setLoading] = useState(true);
  const [anime, setAnime] = useState<AnimeMedia | null>(null);
  const [epCounts, setEpCounts] = useState<EpCounts>({ sub: 0, dub: 0 });
  const [recs, setRecs] = useState<AnimeMedia[]>([]);
  const [seasons, setSeasons] = useState<SeasonEntry[]>([]);
  const [bookmarked, setBookmarked] = useState(false);
  const [loadError, setLoadError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    setSeasons([]);
    setRecs([]);

    const [detailRes, epRes, recRes] = await Promise.allSettled([
      api.getAnime(id),
      api.getEpisodes(id),
      api.getRecommendations(id, 1, 12),
    ]);

    if (detailRes.status === "rejected") {
      setLoadError(
        detailRes.reason instanceof Error ? detailRes.reason.message : "Anime not found"
      );
      setAnime(null);
      setLoading(false);
      return;
    }

    try {
      const info = detailRes.value.info;
      if (isBlockedAnime(info)) {
        router.replace("/browse");
        return;
      }
      setAnime(info);

      let subN = 0;
      let dubN = 0;
      if (epRes.status === "fulfilled") {
        const epData = epRes.value;
        const megaplay = epData.providers?.megaplay || {};
        const eps = megaplay.episodes || {};
        subN = (eps.sub?.length || 0) || epData.released?.sub || 0;
        dubN = (eps.dub?.length || 0) || epData.released?.dub || 0;
      } else {
        const counts = await fetchEpisodeCounts([id]);
        subN = counts[id]?.sub ?? 0;
        dubN = counts[id]?.dub ?? 0;
      }
      setEpCounts({ sub: subN, dub: dubN });
      if (subN > 0 || dubN > 0) rememberEpisodeCounts({ [id]: { sub: subN, dub: dubN } });

      // Background: get dub count from Anikoto (backend often reports 0 dub even when it works)
      const titleStr = animeTitle(info);
      getAnikotoEpCounts(id, titleStr).then((akCounts) => {
        if (!akCounts) return;
        setEpCounts((prev) => {
          const s = Math.max(prev.sub, akCounts.sub);
          const d = Math.max(prev.dub, akCounts.dub);
          if (s === prev.sub && d === prev.dub) return prev;
          rememberEpisodeCounts({ [id]: { sub: s, dub: d } });
          return { sub: s, dub: d };
        });
      }).catch(() => {});

      // If episodes call failed, try batch counts endpoint for fresher data
      if (epRes.status === "rejected" && subN === 0 && dubN === 0) {
        fetchEpisodeCounts([id]).then((counts) => {
          const c = counts[id];
          if (!c) return;
          setEpCounts({ sub: Math.max(subN, c.sub), dub: Math.max(dubN, c.dub) });
          if (c.sub > 0 || c.dub > 0) rememberEpisodeCounts({ [id]: { sub: c.sub, dub: c.dub } });
        }).catch(() => {});
      }

      if (recRes.status === "fulfilled") {
        const recommendations = (recRes.value.recommendations || [])
          .map((r) => r.mediaRecommendation)
          .filter(Boolean);
        setRecs(filterAnimeList(recommendations));
      }

      // BFS traversal of SEQUEL/PREQUEL chain — up to 4 hops so the full
      // franchise is visible regardless of which part you start on.
      // (AniList only returns direct neighbours; Part 5 of 6 needs 4 hops back.)
      const allEdges = [...(info.relations?.edges || [])];
      const seen = new Set<number>([id]);
      for (const e of allEdges) if (e.node?.id) seen.add(e.node.id);

      let frontier = allEdges
        .filter((e) => ["SEQUEL", "PREQUEL"].includes(e.relationType || "") && e.node?.id)
        .map((e) => e.node!.id);

      for (let hop = 0; hop < 4 && frontier.length > 0; hop++) {
        const fetches = await Promise.allSettled(frontier.map((rid) => api.getRelations(rid)));
        const nextFrontier: number[] = [];
        for (const res of fetches) {
          if (res.status !== "fulfilled") continue;
          const edges = res.value.relations as NonNullable<typeof info.relations>["edges"];
          if (!Array.isArray(edges)) continue;
          for (const edge of edges) {
            if (!edge?.node?.id || seen.has(edge.node.id)) continue;
            seen.add(edge.node.id);
            allEdges.push(edge);
            if (["SEQUEL", "PREQUEL"].includes(edge.relationType || "")) {
              nextFrontier.push(edge.node.id);
            }
          }
        }
        frontier = nextFrontier;
      }

      const relations = { edges: allEdges };
      const fullSeasons = buildSeasonList(info, relations);
      if (fullSeasons.length) {
        const seasonCounts = await fetchEpisodeCounts(fullSeasons.map((s) => s.id));
        setSeasons(
          enrichSeasonCounts(fullSeasons, {
            ...seasonCounts,
            [id]: { sub: subN, dub: dubN },
          })
        );
      }
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [id, router]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!user) return;
    clientApi
      .getBookmarks()
      .then((r) => setBookmarked(r.items.some((b) => b.animeId === id)))
      .catch(() => {});
  }, [user, id]);

  const toggleBookmark = async () => {
    if (!user) {
      router.push("/login");
      return;
    }
    if (!anime) return;
    try {
      if (bookmarked) {
        await clientApi.removeBookmark(id);
        setBookmarked(false);
      } else {
        await clientApi.addBookmark({
          animeId: id,
          titleEnglish: anime.title?.english,
          titleRomaji: anime.title?.romaji,
          poster: anime.coverImage?.large,
        });
        setBookmarked(true);
      }
    } catch (e) {
      console.error(e);
    }
  };

  if (loading) {
    return <p className="p-8 text-center font-mono text-sm text-[var(--muted)]">Loading…</p>;
  }
  if (!anime) {
    return (
      <p className="p-8 text-center font-mono text-sm text-[var(--muted)]">
        {loadError || "Not found"}
      </p>
    );
  }

  const title = animeTitle(anime);
  const poster =
    anime.bannerImage || anime.coverImage?.extraLarge || anime.coverImage?.large || "";
  const { youtubeId } = resolveTrailer(anime);
  const plannedEps = anime.episodes ?? null;
  const score = normalizeScore(anime);
  const genres = anime.genres || [];
  const studios = mediaStudios(anime).join(", ") || null;
  const start = formatAnimeDate(anime.startDate);
  const end = formatAnimeDate(anime.endDate);
  const dateLine =
    start && end && start !== end ? `${start} – ${end}` : start || (mediaYear(anime) ? String(mediaYear(anime)) : null);

  const external = filterExternalLinks([
    ...(anime.siteUrl ? [{ url: anime.siteUrl, site: "AniList", type: "INFO" }] : []),
    ...(anime.externalLinks || []).map((l) => ({
      url: l.url,
      site: l.site,
      type: l.type,
    })),
  ]);
  const streaming = (anime.streamingEpisodes || []).filter(
    (ep) => ep.url && !isBlockedExternalLink({ url: ep.url, site: ep.site })
  );
  const hasPlayable = epCounts.sub > 0 || epCounts.dub > 0;
  const watchHref = `/anime/${id}/watch`;

  return (
    <div className="pb-12">
      <section className="relative min-h-[min(68svh,620px)] w-full overflow-hidden sm:min-h-[min(72vh,640px)]">
        <AnimeTrailerBackdrop youtubeId={youtubeId} poster={poster} title={title} />

        <div className="relative z-10 mx-auto flex min-h-[min(68svh,620px)] max-w-6xl flex-col justify-end px-3 pb-8 pt-20 sm:min-h-[min(72vh,640px)] sm:px-4 sm:pb-10 sm:pt-24">
          <nav className="mb-3 font-mono text-[10px] uppercase tracking-widest text-white/50">
            <Link href="/" className="hover:text-[var(--accent)]">
              Home
            </Link>
            <span className="mx-1.5">/</span>
            <Link href="/browse" className="hover:text-[var(--accent)]">
              Browse
            </Link>
            <span className="mx-1.5">/</span>
            <span className="text-white/80">{title}</span>
          </nav>

          <div className="flex flex-col gap-6 lg:flex-row lg:items-end">
            {anime.coverImage?.large ? (
              <img
                src={anime.coverImage.large}
                alt=""
                className="hidden h-52 w-36 shrink-0 rounded-lg border border-white/10 object-cover shadow-2xl sm:block lg:h-64 lg:w-44"
              />
            ) : null}

            <div className="min-w-0 flex-1">
              <h1 className="font-display text-2xl font-bold tracking-tight text-white sm:text-4xl md:text-5xl">
                {title}
              </h1>

              <EpisodeCountBadges
                subCount={epCounts.sub}
                dubCount={epCounts.dub}
                total={plannedEps}
                format={anime.format}
                className="mt-3"
              />

              <div className="mt-4 flex flex-wrap items-center gap-2">
                {score ? (
                  <span className="inline-flex items-center gap-1 rounded-md bg-[#e8621a]/90 px-2.5 py-1 font-mono text-xs font-bold text-white">
                    <Star className="h-3.5 w-3.5 fill-current" />
                    {score}%
                  </span>
                ) : null}
                {anime.format ? (
                  <MetaPill icon={<Tv className="h-3 w-3" />} label={formatLabel(anime.format)} />
                ) : null}
                {anime.status ? (
                  <MetaPill label={formatLabel(anime.status)} />
                ) : null}
                {dateLine ? (
                  <MetaPill icon={<Calendar className="h-3 w-3" />} label={dateLine} />
                ) : null}
                {anime.duration ? (
                  <MetaPill
                    icon={<Clock className="h-3 w-3" />}
                    label={`${anime.duration} min`}
                  />
                ) : null}
              </div>

              <GenreChips genres={genres} max={14} variant="hero" className="mt-4" />

              <div className="mt-6 flex flex-wrap items-center gap-2 sm:gap-3">
                <Link
                  href={watchHref}
                  className="inline-flex flex-1 items-center justify-center gap-2 rounded-lg bg-[var(--accent)] px-5 py-3 font-mono text-sm font-bold uppercase tracking-wide text-black shadow-lg shadow-[var(--accent)]/25 transition-transform hover:scale-[1.02] sm:flex-none sm:px-6"
                >
                  <Play className="h-5 w-5 fill-current" />
                  {hasPlayable ? "Play" : "Open player"}
                </Link>
                <button
                  type="button"
                  onClick={toggleBookmark}
                  className={`inline-flex flex-1 items-center justify-center gap-2 rounded-lg border px-4 py-3 font-mono text-xs font-semibold backdrop-blur-md transition-colors sm:flex-none ${
                    bookmarked
                      ? "border-[var(--accent)] bg-[var(--accent)]/15 text-[var(--accent)]"
                      : "border-white/25 bg-black/40 text-white hover:border-[var(--accent)]"
                  }`}
                >
                  <Bookmark className="h-4 w-4" />
                  {bookmarked ? "Saved" : "Bookmark"}
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>

      <div className="mx-auto max-w-6xl px-3 sm:px-4">
        <div className="mt-8 grid gap-8 lg:mt-10 lg:grid-cols-[1fr_320px] lg:gap-10">
          <div>
            {anime.description ? (
              <section>
                <h2 className="mb-3 font-mono text-xs font-semibold uppercase tracking-widest text-[var(--muted)]">
                  Overview
                </h2>
                <p
                  className="text-sm leading-relaxed text-[var(--muted)]"
                  dangerouslySetInnerHTML={{
                    __html: anime.description.replace(/<br\s*\/?>/gi, " "),
                  }}
                />
              </section>
            ) : null}

            <InfoGrid
              items={[
                studios ? { label: "Studio", value: studios } : null,
                anime.source ? { label: "Source", value: formatLabel(anime.source) } : null,
                anime.countryOfOrigin
                  ? { label: "Country", value: anime.countryOfOrigin }
                  : null,
                anime.season && (anime.seasonYear ?? anime.year)
                  ? {
                      label: "Season",
                      value: `${formatLabel(anime.season)} ${anime.seasonYear ?? anime.year}`,
                    }
                  : null,
                plannedEps ? { label: "Planned episodes", value: String(plannedEps) } : null,
                anime.popularity
                  ? { label: "Popularity", value: `#${anime.popularity.toLocaleString()}` }
                  : null,
              ].filter(Boolean) as { label: string; value: string }[]}
            />
          </div>

          <aside className="space-y-8">
            {(external.length > 0 || streaming.length > 0) && (
              <section className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
                <h2 className="mb-3 font-mono text-xs font-semibold uppercase tracking-widest text-[var(--muted)]">
                  Links &amp; resources
                </h2>
                <ul className="space-y-2">
                  {external.map((link) => (
                    <li key={link.url}>
                      <a
                        href={link.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-2 text-sm text-[var(--foreground)] hover:text-[var(--accent)]"
                      >
                        <ExternalLink className="h-3.5 w-3.5 shrink-0 opacity-60" />
                        <span className="truncate">{link.site}</span>
                      </a>
                    </li>
                  ))}
                  {streaming.map((ep, i) => (
                    <li key={`${ep.url}-${i}`}>
                      <a
                        href={ep.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-2 text-sm text-[var(--foreground)] hover:text-[var(--accent)]"
                      >
                        <ExternalLink className="h-3.5 w-3.5 shrink-0 opacity-60" />
                        <span className="truncate">
                          {ep.site}
                          {ep.title ? ` — ${ep.title}` : ""}
                        </span>
                      </a>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {anime.tags && anime.tags.length > 0 ? (
              <section className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
                <h2 className="mb-3 font-mono text-xs font-semibold uppercase tracking-widest text-[var(--muted)]">
                  Tags
                </h2>
                <div className="flex flex-wrap gap-1.5">
                  {anime.tags
                    .filter((t) => !t.isMediaSpoiler)
                    .slice(0, 12)
                    .map((t) => (
                      <span
                        key={t.name}
                        className="rounded-md border border-[var(--border)] bg-[#0a0b0f] px-2 py-0.5 font-mono text-[10px] text-[var(--muted)]"
                      >
                        {t.name}
                      </span>
                    ))}
                </div>
              </section>
            ) : null}
          </aside>
        </div>

        <SeasonRail seasons={seasons} currentId={id} />
        <SimilarCarousel items={recs} />
      </div>
    </div>
  );
}

function MetaPill({
  label,
  icon,
}: {
  label: string;
  icon?: ReactNode;
}) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-white/15 bg-black/35 px-2 py-0.5 font-mono text-xs text-white/85 backdrop-blur-sm">
      {icon}
      {label}
    </span>
  );
}

function InfoGrid({ items }: { items: { label: string; value: string }[] }) {
  if (!items.length) return null;
  return (
    <section className="mt-8 rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
      <h2 className="mb-3 font-mono text-xs font-semibold uppercase tracking-widest text-[var(--muted)]">
        Details
      </h2>
      <dl className="grid gap-3 sm:grid-cols-2">
        {items.map((row) => (
          <div key={row.label}>
            <dt className="font-mono text-[10px] uppercase tracking-widest text-[var(--muted)]">
              {row.label}
            </dt>
            <dd className="mt-0.5 text-sm text-[var(--foreground)]">{row.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
