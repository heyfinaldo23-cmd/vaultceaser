"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import NekosLoader from "@/components/NekosLoader";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Bookmark, Play, Star, Tv } from "lucide-react";
import GenreChips from "@/components/GenreChips";
import EpisodeCountBadges from "@/components/EpisodeCountBadges";
import SeasonRail, { type SeasonEntry } from "@/components/SeasonRail";
import { type AnimeMedia, normalizeScore, mediaStudios } from "@/lib/api";
import { isBlockedAnime } from "@/lib/anime-filters";
import { formatLabel } from "@/lib/format-labels";
import { animeTitle } from "@/lib/anime-title";
import { clientApi } from "@/lib/client-api";
import { useAuth } from "@/components/AuthProvider";
import {
  otakubox,
  cardToMedia,
  buildSeasonChain,
  findNextInChain,
} from "@/lib/otakubox";

type EpCounts = { sub: number; dub: number };

export default function AnimeOverviewPage() {
  const params = useParams();
  const router = useRouter();
  const { user } = useAuth();
  const id = Number(params.id);

  const [loading, setLoading] = useState(true);
  const [anime, setAnime] = useState<AnimeMedia | null>(null);
  const [epCounts, setEpCounts] = useState<EpCounts>({ sub: 0, dub: 0 });
  const [seasons, setSeasons] = useState<SeasonEntry[]>([]);
  const [bookmarked, setBookmarked] = useState(false);
  const [loadError, setLoadError] = useState("");

  const load = useCallback(async () => {
    if (!id || isNaN(id)) { setLoadError("Invalid anime ID"); setLoading(false); return; }
    setLoading(true);
    setLoadError("");
    setSeasons([]);

    const [detailRes, relRes] = await Promise.allSettled([
      otakubox.getShow(id),
      otakubox.getAllRelations(id),
    ]);

    if (detailRes.status === "rejected") {
      setLoadError("Anime not found");
      setAnime(null);
      setLoading(false);
      return;
    }

    try {
      const show = detailRes.value;
      const media = cardToMedia(show);
      if (isBlockedAnime(media)) {
        router.replace("/browse");
        return;
      }
      setAnime(media);
      setEpCounts({ sub: show.sub_count, dub: show.dub_count });

      // Season chain from relation graph
      if (relRes.status === "fulfilled") {
        const { nodes, edges } = relRes.value;
        const chainNodes = buildSeasonChain(id, nodes, edges);
        if (chainNodes.length > 1) {
          const nextId = findNextInChain(id, edges);
          const entries: SeasonEntry[] = chainNodes.map((n) => ({
            id: n.anilist_id,
            label: n.title,
            title: n.title,
            image: n.cover,
            format: n.type,
            isCurrent: n.anilist_id === id,
            isNext: n.anilist_id === nextId,
          }));
          setSeasons(entries);
        }
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

  if (loading) return <NekosLoader />;
  if (!anime) {
    return (
      <p className="p-8 text-center font-mono text-sm text-[var(--muted)]">
        {loadError || "Not found"}
      </p>
    );
  }

  const title = animeTitle(anime);
  const poster = anime.bannerImage || anime.coverImage?.extraLarge || anime.coverImage?.large || "";
  const plannedEps = anime.episodes ?? null;
  const score = normalizeScore(anime);
  const genres = anime.genres || [];
  const studios = mediaStudios(anime).join(", ") || null;
  const year = anime.seasonYear ?? (anime as { year?: number }).year ?? null;
  const hasPlayable = epCounts.sub > 0 || epCounts.dub > 0;
  const watchHref = `/anime/${id}/watch`;

  return (
    <div className="pb-12">
      <section className="relative min-h-[min(68svh,620px)] w-full overflow-hidden sm:min-h-[min(72vh,640px)]">
        {/* Banner backdrop */}
        <div className="absolute inset-0 overflow-hidden">
          {poster ? (
            <img
              src={poster}
              alt=""
              className="h-full w-full object-cover opacity-30 blur-sm scale-105"
            />
          ) : null}
          <div className="absolute inset-0 bg-gradient-to-t from-[#0d0f14] via-[#0d0f14]/60 to-transparent" />
        </div>

        <div className="relative z-10 mx-auto flex min-h-[min(68svh,620px)] max-w-6xl flex-col justify-end px-3 pb-8 pt-20 sm:min-h-[min(72vh,640px)] sm:px-4 sm:pb-10 sm:pt-24">
          <nav className="mb-3 font-mono text-[10px] uppercase tracking-widest text-white/50">
            <Link href="/" className="hover:text-[var(--accent)]">Home</Link>
            <span className="mx-1.5">/</span>
            <Link href="/browse" className="hover:text-[var(--accent)]">Browse</Link>
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
                {anime.status ? <MetaPill label={formatLabel(anime.status)} /> : null}
                {year ? <MetaPill label={String(year)} /> : null}
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
                anime.season && year
                  ? { label: "Season", value: `${formatLabel(anime.season)} ${year}` }
                  : null,
                plannedEps ? { label: "Planned episodes", value: String(plannedEps) } : null,
              ].filter(Boolean) as { label: string; value: string }[]}
            />
          </div>

          <aside className="space-y-8" />
        </div>

        <SeasonRail seasons={seasons} currentId={id} />
      </div>
    </div>
  );
}

function MetaPill({ label, icon }: { label: string; icon?: ReactNode }) {
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
            <dt className="font-mono text-[10px] uppercase tracking-widest text-[var(--muted)]">{row.label}</dt>
            <dd className="mt-0.5 text-sm text-[var(--foreground)]">{row.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
