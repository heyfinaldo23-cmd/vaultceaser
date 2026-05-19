"use client";

import { useCallback, useEffect, useRef, useState, Suspense } from "react";
import { useParams, useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Bookmark, X } from "lucide-react";
import GenreChips from "@/components/GenreChips";
import EpisodeCountBadges from "@/components/EpisodeCountBadges";
import PlayerToolbar from "@/components/PlayerToolbar";
import SeasonRail, { type SeasonEntry } from "@/components/SeasonRail";
import SimilarCarousel from "@/components/SimilarCarousel";
import { api, resolveStreamIframeUrl, type AnimeMedia, type EpisodeData } from "@/lib/api";
import { isBlockedAnime, filterAnimeList } from "@/lib/anime-filters";
import { formatLabel } from "@/lib/format-labels";
import { animeTitle } from "@/lib/anime-title";
import { clientApi } from "@/lib/client-api";
import { useAuth } from "@/components/AuthProvider";
import { loadPlayerPrefs, savePlayerPrefs, type PlayerPrefs } from "@/lib/player-prefs";
import { fetchEpisodeCounts } from "@/lib/episode-counts";
import { buildSeasonList, enrichSeasonCounts } from "@/lib/seasons-from-relations";
import {
  getLatestLocalWatchForAnime,
  getLocalWatchProgress,
  qualifiesForContinue,
  upsertLocalWatchProgress,
} from "@/lib/watch-progress";
import { cn } from "@/lib/utils";

type EpCounts = { sub: number; dub: number };

function WatchPageInner() {
  const params = useParams();
  const searchParams = useSearchParams();
  const router = useRouter();
  const { user } = useAuth();
  const id = Number(params.id);

  const [loading, setLoading] = useState(true);
  const [anime, setAnime] = useState<AnimeMedia | null>(null);
  const [episodes, setEpisodes] = useState<EpisodeData[]>([]);
  const [epCounts, setEpCounts] = useState<EpCounts>({ sub: 0, dub: 0 });
  const [recs, setRecs] = useState<AnimeMedia[]>([]);
  const [seasons, setSeasons] = useState<SeasonEntry[]>([]);
  const [category, setCategory] = useState<"sub" | "dub">(
    searchParams.get("cat") === "dub" ? "dub" : "sub"
  );
  const categoryRef = useRef<"sub" | "dub">(category);
  const [currentEp, setCurrentEp] = useState<EpisodeData | null>(null);
  const [iframeSrc, setIframeSrc] = useState("");
  const [playerError, setPlayerError] = useState("");
  const [bookmarked, setBookmarked] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [watchedEpisodeNumbers, setWatchedEpisodeNumbers] = useState<number[]>([]);
  const [prefs, setPrefs] = useState<PlayerPrefs>({ autoNext: true, autoPlay: true, autoSkip: false, focus: false });
  const [megaplayEps, setMegaplayEps] = useState<{
    sub?: EpisodeData[];
    dub?: EpisodeData[];
  } | null>(null);
  const [loadError, setLoadError] = useState("");
  const [resumeAt, setResumeAt] = useState(0);
  const [watchedSeconds, setWatchedSeconds] = useState(0);
  const [playerDurationSeconds, setPlayerDurationSeconds] = useState<number | null>(null);
  const currentEpRef = useRef<EpisodeData | null>(null);
  const animeRef = useRef<AnimeMedia | null>(null);
  const prefsRef = useRef<PlayerPrefs>(prefs);
  const userRef = useRef(user);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const lastPlayerTimeRef = useRef(0);
  const lastPlayerRawTimeRef = useRef(0);
  const lastTickAtRef = useRef(0);
  const watchedSecondsRef = useRef(0);
  const watchedRemainderRef = useRef(0);
  const playerDurationSecondsRef = useRef<number | null>(null);
  const lastSavedProgressRef = useRef("");
  const lastSyncedProgressRef = useRef("");
  const playerCanReportRef = useRef(false);
  // auto-next countdown (seconds remaining to play next episode, null = inactive)
  const [autoNextSecsLeft, setAutoNextSecsLeft] = useState<number | null>(null);
  const autoNextDelayRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoNextTickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    setPrefs(loadPlayerPrefs());
  }, []);

  useEffect(() => {
    prefsRef.current = prefs;
    iframeRef.current?.contentWindow?.postMessage(
      { type: "vaultceaser:set-auto-skip", enabled: prefs.autoSkip },
      "*"
    );
  }, [prefs]);

  useEffect(() => {
    userRef.current = user;
  }, [user]);

  useEffect(() => {
    categoryRef.current = category;
  }, [category]);

  useEffect(() => {
    currentEpRef.current = currentEp;
  }, [currentEp]);

  useEffect(() => {
    animeRef.current = anime;
  }, [anime]);

  useEffect(() => {
    watchedSecondsRef.current = watchedSeconds;
  }, [watchedSeconds]);

  useEffect(() => {
    playerDurationSecondsRef.current = playerDurationSeconds;
  }, [playerDurationSeconds]);

  useEffect(() => {
    if (!user) {
      setWatchedEpisodeNumbers([]);
      return;
    }
    clientApi
      .getWatch()
      .then((r) => {
        const maxWatched = Math.max(
          0,
          ...r.items.filter((w) => w.animeId === id).map((w) => w.episodeNumber)
        );
        const items = Array.from({ length: maxWatched }, (_, i) => i + 1);
        setWatchedEpisodeNumbers(items);
      })
      .catch(() => {});
  }, [user, id]);

  const clearAutoNextTimers = useCallback(() => {
    if (autoNextDelayRef.current) {
      clearTimeout(autoNextDelayRef.current);
      autoNextDelayRef.current = null;
    }
    if (autoNextTickRef.current) {
      clearInterval(autoNextTickRef.current);
      autoNextTickRef.current = null;
    }
    setAutoNextSecsLeft(null);
  }, []);

  const persistProgress = useCallback(
    (options?: {
      positionSeconds?: number | null;
      durationSeconds?: number | null;
      watchedSeconds?: number | null;
      force?: boolean;
    }) => {
      const ep = currentEpRef.current;
      if (!ep) return null;
      const eid = ep.original_id || ep.id;
      const currentAnime = animeRef.current;
      const positionSeconds = Math.max(
        0,
        Math.floor(options?.positionSeconds ?? lastPlayerTimeRef.current ?? 0)
      );
      const durationSeconds =
        options?.durationSeconds ?? playerDurationSecondsRef.current ?? null;
      const nextWatchedSeconds = Math.max(
        watchedSecondsRef.current,
        Math.floor(options?.watchedSeconds ?? watchedSecondsRef.current ?? 0)
      );
      const progressKey = `${ep.number}:${categoryRef.current}:${positionSeconds}:${nextWatchedSeconds}`;
      if (!options?.force && progressKey === lastSavedProgressRef.current) {
        return null;
      }
      lastSavedProgressRef.current = progressKey;
      watchedSecondsRef.current = nextWatchedSeconds;
      setWatchedSeconds(nextWatchedSeconds);
      if (durationSeconds != null) {
        playerDurationSecondsRef.current = durationSeconds;
        setPlayerDurationSeconds(durationSeconds);
      }
      return upsertLocalWatchProgress({
        animeId: id,
        episodeNumber: ep.number,
        episodeId: eid,
        category: categoryRef.current,
        title: ep.title,
        animeTitle: currentAnime ? animeTitle(currentAnime) : null,
        poster: currentAnime?.coverImage?.large ?? currentAnime?.coverImage?.extraLarge ?? null,
        positionSeconds,
        durationSeconds,
        watchedSeconds: nextWatchedSeconds,
      });
    },
    [id]
  );

  const syncQualifiedProgress = useCallback(
    (options?: {
      positionSeconds?: number | null;
      durationSeconds?: number | null;
      watchedSeconds?: number | null;
      force?: boolean;
    }) => {
      if (!userRef.current) return;
      const ep = currentEpRef.current;
      if (!ep) return;
      const positionSeconds = Math.max(
        0,
        Math.floor(options?.positionSeconds ?? lastPlayerTimeRef.current ?? 0)
      );
      const durationSeconds =
        options?.durationSeconds ?? playerDurationSecondsRef.current ?? null;
      const nextWatchedSeconds = Math.max(
        watchedSecondsRef.current,
        Math.floor(options?.watchedSeconds ?? watchedSecondsRef.current ?? 0)
      );
      if (
        !qualifiesForContinue({
          positionSeconds,
          durationSeconds,
          watchedSeconds: nextWatchedSeconds,
        })
      ) {
        return;
      }

      const eid = ep.original_id || ep.id;
      const syncKey = `${ep.number}:${categoryRef.current}:${Math.floor(positionSeconds / 10)}:${Math.floor(nextWatchedSeconds / 10)}`;
      if (!options?.force && syncKey === lastSyncedProgressRef.current) return;
      lastSyncedProgressRef.current = syncKey;

      setWatchedEpisodeNumbers((prev) =>
        [...new Set([...prev, ...Array.from({ length: ep.number }, (_, i) => i + 1)])]
      );

      void clientApi
        .saveWatch({
          animeId: id,
          episodeNumber: ep.number,
          episodeId: eid,
          category: categoryRef.current,
          title: ep.title,
        })
        .catch(() => {});
    },
    [id]
  );

  const playEpisode = useCallback(
    async (ep: EpisodeData, streamCategory: "sub" | "dub") => {
      clearAutoNextTimers();
      setCurrentEp(ep);
      setPlayerError("");
      setIframeSrc("");
      if (typeof window !== "undefined") {
        const url = new URL(window.location.href);
        url.searchParams.set("ep", String(ep.number));
        url.searchParams.set("cat", streamCategory);
        window.history.replaceState(window.history.state, "", url);
      }
      const storedProgress = getLocalWatchProgress(id, ep.number, streamCategory);
      const storedPosition = storedProgress?.positionSeconds ?? 0;
      setResumeAt(storedPosition);
      setWatchedSeconds(storedProgress?.watchedSeconds ?? 0);
      setPlayerDurationSeconds(storedProgress?.durationSeconds ?? null);
      lastPlayerTimeRef.current = storedPosition;
      lastPlayerRawTimeRef.current = storedPosition;
      lastTickAtRef.current = 0;
      watchedRemainderRef.current = 0;
      lastSavedProgressRef.current = "";
      lastSyncedProgressRef.current = "";
      playerCanReportRef.current = false;
      const eid = ep.original_id || ep.id;
      try {
        const data = await api.getStreamIframe(eid, streamCategory, id, {
          synthetic: true,
        });
        const src = new URL(resolveStreamIframeUrl(data.iframe_url));
        if (storedPosition > 0) {
          src.searchParams.set("t", String(storedPosition));
        }
        if (prefsRef.current.autoSkip) {
          src.searchParams.set("autoskip", "1");
        }
        setIframeSrc(src.toString());
      } catch (e) {
        setPlayerError(e instanceof Error ? e.message : "Could not load player");
      }
    },
    [clearAutoNextTimers, id]
  );

  const selectCategory = useCallback(
    (nextCategory: "sub" | "dub") => {
      if (nextCategory === category) return;
      if (!megaplayEps) {
        setCategory(nextCategory);
        return;
      }

      const list = nextCategory === "dub" ? megaplayEps.dub || [] : megaplayEps.sub || [];
      const nextEpisode =
        (currentEp && list.find((ep) => ep.number === currentEp.number)) || list[0];

      setCategory(nextCategory);
      setEpisodes(list);
      setExpanded(false);

      if (nextEpisode) {
        void playEpisode(nextEpisode, nextCategory);
      } else {
        setCurrentEp(null);
        setIframeSrc("");
        setPlayerError("");
      }
    },
    [category, currentEp, megaplayEps, playEpisode]
  );

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
      const msg =
        detailRes.reason instanceof Error ? detailRes.reason.message : "Anime not found";
      setLoadError(msg);
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

      let subList: EpisodeData[] = [];
      let dubList: EpisodeData[] = [];
      let subN = 0;
      let dubN = 0;

      if (epRes.status === "fulfilled") {
        const epData = epRes.value;
        const megaplay = epData.episodes?.providers?.megaplay || {};
        subList = megaplay.episodes?.sub || [];
        dubList = megaplay.episodes?.dub || [];
        subN = subList.length || epData.released?.sub || 0;
        dubN = dubList.length || epData.released?.dub || 0;
      } else {
        console.warn("episodes load failed:", epRes.reason);
        setLoadError("Episodes temporarily unavailable — try again in a moment.");
      }

      setMegaplayEps({ sub: subList, dub: dubList });
      setEpCounts({ sub: subN, dub: dubN });
      const cat = searchParams.get("cat") === "dub" ? "dub" : "sub";
      const list = cat === "dub" ? dubList : subList;
      setCategory(cat);
      setEpisodes(list);

      if (recRes.status === "fulfilled") {
        const recommendations = (recRes.value.recommendations || [])
          .map((r) => r.mediaRecommendation)
          .filter(Boolean);
        setRecs(filterAnimeList(recommendations));
      }

      // Always fetch rich relations — the main query returns minimal node data
      // (no bannerImage, startDate, isAdult) which breaks ordering and season card images.
      let relations = info.relations;
      try {
        const rel = await api.getRelations(id);
        relations = { edges: rel.relations as NonNullable<typeof relations>["edges"] };
      } catch {
        /* fall back to whatever info.relations has */
      }

      const baseSeasons = buildSeasonList(info, relations);
      if (baseSeasons.length) {
        // One more hop so full franchise is visible regardless of which season you land on
        const relatedIds = baseSeasons.filter((s) => !s.isCurrent).map((s) => s.id);
        if (relatedIds.length) {
          const extraFetches = await Promise.allSettled(
            relatedIds.map((rid) => api.getRelations(rid))
          );
          const allEdges = [...(relations?.edges || [])];
          for (const res of extraFetches) {
            if (res.status !== "fulfilled") continue;
            const extraEdges = res.value.relations as NonNullable<typeof relations>["edges"];
            if (!Array.isArray(extraEdges)) continue;
            for (const edge of extraEdges) {
              if (edge?.node?.id && !allEdges.some((e) => e.node?.id === edge.node?.id)) {
                allEdges.push(edge);
              }
            }
          }
          if (allEdges.length > (relations?.edges?.length ?? 0)) {
            relations = { edges: allEdges };
          }
        }
        const fullSeasons = buildSeasonList(info, relations);
        const seasonCounts = await fetchEpisodeCounts(fullSeasons.map((s) => s.id));
        setSeasons(enrichSeasonCounts(fullSeasons, {
          ...seasonCounts,
          [id]: { sub: subN, dub: dubN },
        }));
      }

      const epNum = Number(searchParams.get("ep"));
      const p = loadPlayerPrefs();
      if (epNum && list.length) {
        const found = list.find((ep: EpisodeData) => ep.number === epNum);
        if (found) await playEpisode(found, cat);
      } else {
        const latest = getLatestLocalWatchForAnime(id);
        const latestCat = latest?.category === "dub" ? "dub" : "sub";
        const latestList = latestCat === "dub" ? dubList : subList;
        const latestEpisode = latest
          ? latestList.find((ep: EpisodeData) => ep.number === latest.episodeNumber)
          : null;

        if (latestEpisode) {
          setCategory(latestCat);
          setEpisodes(latestList);
          await playEpisode(latestEpisode, latestCat);
        } else if (p.autoPlay && list.length) {
          await playEpisode(list[0], cat);
        }
      }
    } catch (e) {
      console.error(e);
      setLoadError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [id, router, searchParams, playEpisode]);

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

  useEffect(() => {
    if (loading || !episodes.length || currentEp) return;
    if (!prefs.autoPlay) return;
    const epNum = Number(searchParams.get("ep"));
    if (epNum) return;
    void playEpisode(episodes[0], categoryRef.current);
  }, [loading, episodes, currentEp, prefs.autoPlay, searchParams, playEpisode]);

  useEffect(() => {
    if (!user || !currentEp) return;
    const save = () => {
      const progress = persistProgress({ force: true });
      if (!progress?.qualified) return;
      clientApi.saveWatchBeacon({
        animeId: id,
        episodeNumber: currentEp.number,
        episodeId: currentEp.original_id || currentEp.id,
        category,
        title: currentEp.title,
      });
    };
    window.addEventListener("pagehide", save);
    window.addEventListener("beforeunload", save);
    return () => {
      window.removeEventListener("pagehide", save);
      window.removeEventListener("beforeunload", save);
    };
  }, [category, currentEp, id, persistProgress, user]);

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

  const togglePref = (key: keyof PlayerPrefs) => {
    setPrefs((prev) => {
      const next = savePlayerPrefs({ [key]: !prev[key] });
      return next;
    });
  };

  const currentIndex = currentEp
    ? episodes.findIndex((e) => e.number === currentEp.number)
    : -1;
  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex >= 0 && currentIndex < episodes.length - 1;

  const goPrev = useCallback(() => {
    if (currentIndex > 0) {
      void playEpisode(episodes[currentIndex - 1], category);
    }
  }, [currentIndex, episodes, category, playEpisode]);

  const goNext = useCallback(() => {
    if (currentIndex >= 0 && currentIndex < episodes.length - 1) {
      void playEpisode(episodes[currentIndex + 1], category);
    }
  }, [currentIndex, episodes, category, playEpisode]);

  const goNextRef = useRef(goNext);
  useEffect(() => {
    goNextRef.current = goNext;
  }, [goNext]);

  useEffect(() => {
    if (!currentEp || !iframeSrc) return;

    const onMessage = (event: MessageEvent) => {
      if (iframeRef.current?.contentWindow && event.source !== iframeRef.current.contentWindow) {
        return;
      }
      const data = event.data as
        | {
            type?: string;
            currentTime?: number;
            duration?: number;
            message?: string;
          }
        | undefined;
      if (!data?.type || !String(data.type).startsWith("vaultceaser:")) return;

      if (data.type === "vaultceaser:player-error") {
        setPlayerError(data.message || "Could not load player");
        return;
      }

      if (
        data.type === "vaultceaser:player-ready" ||
        data.type === "vaultceaser:player-resumed" ||
        data.type === "vaultceaser:timeupdate" ||
        data.type === "vaultceaser:player-skipped"
      ) {
        playerCanReportRef.current = true;
        clearAutoNextTimers();
        const rawPosition = Math.max(0, Number(data.currentTime ?? 0) || 0);
        const position = Math.floor(rawPosition);
        const duration =
          data.duration && Number.isFinite(data.duration) && data.duration > 0
            ? Math.floor(data.duration)
            : null;
        const now = Date.now();
        let nextWatchedSeconds = watchedSecondsRef.current;
        if (
          data.type === "vaultceaser:timeupdate" &&
          lastTickAtRef.current &&
          rawPosition > lastPlayerRawTimeRef.current
        ) {
          const deltaWall = Math.max(0, Math.min(5, (now - lastTickAtRef.current) / 1000));
          const deltaVideo = Math.max(0, Math.min(5, rawPosition - lastPlayerRawTimeRef.current));
          watchedRemainderRef.current += Math.min(
            deltaWall || deltaVideo,
            deltaVideo || deltaWall
          );
          const wholeSeconds = Math.floor(watchedRemainderRef.current);
          if (wholeSeconds > 0) {
            nextWatchedSeconds += wholeSeconds;
            watchedRemainderRef.current -= wholeSeconds;
          }
        }
        lastTickAtRef.current = now;
        lastPlayerTimeRef.current = position;
        lastPlayerRawTimeRef.current = rawPosition;
        setResumeAt(position);

        persistProgress({
          positionSeconds: position,
          durationSeconds: duration,
          watchedSeconds: nextWatchedSeconds,
        });
        syncQualifiedProgress({
          positionSeconds: position,
          durationSeconds: duration,
          watchedSeconds: nextWatchedSeconds,
        });
        return;
      }

      if (data.type === "vaultceaser:episode-ended") {
        const duration = playerDurationSecondsRef.current;
        const position =
          duration && duration > 0 ? Math.max(0, duration - 1) : lastPlayerTimeRef.current;
        persistProgress({
          positionSeconds: position,
          durationSeconds: duration,
          watchedSeconds: Math.max(watchedSecondsRef.current, 60),
          force: true,
        });
        syncQualifiedProgress({
          positionSeconds: position,
          durationSeconds: duration,
          watchedSeconds: Math.max(watchedSecondsRef.current, 60),
          force: true,
        });
        if (prefsRef.current.autoNext && hasNext) {
          goNextRef.current();
        }
      }
    };

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [clearAutoNextTimers, currentEp, hasNext, iframeSrc, persistProgress, syncQualifiedProgress]);

  // Duration-based auto-next: start a countdown near the end of the episode.
  // The megaplay iframe is cross-origin — postMessage events from it never arrive,
  // so we derive timing from AniList's episode duration instead.
  useEffect(() => {
    clearAutoNextTimers();
    if (!iframeSrc || !prefs.autoNext || !hasNext || playerCanReportRef.current) return;

    const COUNTDOWN_SECS = 30;
    const episodeMins = anime?.duration ?? 24;
    const delaySecs = Math.max(episodeMins * 60 - COUNTDOWN_SECS, 10);

    autoNextDelayRef.current = setTimeout(() => {
      setAutoNextSecsLeft(COUNTDOWN_SECS);
      autoNextTickRef.current = setInterval(() => {
        setAutoNextSecsLeft((prev) => {
          if (prev === null || prev <= 1) {
            clearInterval(autoNextTickRef.current!);
            autoNextTickRef.current = null;
            goNextRef.current();
            return null;
          }
          return prev - 1;
        });
      }, 1000);
    }, delaySecs * 1000);

    return clearAutoNextTimers;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [iframeSrc]);

  useEffect(() => {
    if (!iframeSrc || !currentEp) return;
    const save = () => {
      persistProgress({ force: true });
    };
    window.addEventListener("pagehide", save);
    window.addEventListener("beforeunload", save);
    return () => {
      window.removeEventListener("pagehide", save);
      window.removeEventListener("beforeunload", save);
    };
  }, [currentEp, iframeSrc, persistProgress]);

  const dimChrome = prefs.focus && !!iframeSrc && !expanded;
  const exitFocus = useCallback(() => {
    setPrefs((prev) => savePlayerPrefs({ ...prev, focus: false }));
  }, []);

  useEffect(() => {
    if (!dimChrome) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") exitFocus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dimChrome, exitFocus]);

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
  const banner = anime.bannerImage || anime.coverImage?.extraLarge || anime.coverImage?.large || "";
  const plannedEps = anime.episodes ?? null;
  const score = anime.averageScore || anime.meanScore;
  const genres = anime.genres || [];

  return (
    <div className="pb-10">
      <section
        className={cn(
          "relative mx-auto max-w-6xl overflow-hidden rounded-b-2xl border border-t-0 border-[var(--border)] px-4 pt-2 transition-opacity",
          dimChrome && "opacity-25"
        )}
      >
        <div className="relative aspect-[21/9] min-h-[200px] max-h-[340px] w-full overflow-hidden rounded-xl bg-[var(--card)]">
          {banner ? (
            <img src={banner} alt="" className="h-full w-full object-cover" />
          ) : null}
          <div className="absolute inset-0 bg-gradient-to-t from-[#0a0b0d] via-[#0a0b0d]/70 to-transparent" />
          <div className="absolute inset-0 bg-gradient-to-r from-[#0a0b0d]/80 via-transparent to-transparent" />

          <div className="absolute bottom-0 left-0 right-0 p-4 sm:p-6">
            <nav className="mb-2 font-mono text-[10px] uppercase tracking-widest text-white/50">
              <Link href="/" className="hover:text-[var(--accent)]">
                Home
              </Link>
              <span className="mx-1.5">/</span>
              <Link href={`/anime/${id}`} className="hover:text-[var(--accent)]">
                {title}
              </Link>
              <span className="mx-1.5">/</span>
              <span className="text-white/70">Watch</span>
            </nav>
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div className="min-w-0 flex-1">
                <h1 className="font-display text-2xl font-bold tracking-tight text-white sm:text-3xl md:text-4xl">
                  {title}
                </h1>
                <EpisodeCountBadges
                  subCount={epCounts.sub}
                  dubCount={epCounts.dub}
                  total={plannedEps}
                  format={anime.format}
                  className="mt-2"
                />
              </div>
              <button
                type="button"
                onClick={toggleBookmark}
                className={`flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-1.5 font-mono text-xs font-medium backdrop-blur-md transition-colors ${
                  bookmarked
                    ? "border-[var(--accent)] bg-[var(--accent)]/15 text-[var(--accent)]"
                    : "border-white/20 bg-black/40 text-white hover:border-[var(--accent)]"
                }`}
              >
                <Bookmark className="h-3.5 w-3.5" />
                {bookmarked ? "Saved" : "Bookmark"}
              </button>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              {score ? (
                <span className="rounded-md bg-[#e8621a]/90 px-2 py-0.5 font-mono text-xs font-bold text-white">
                  {score}%
                </span>
              ) : null}
              {anime.format ? (
                <span className="rounded-md border border-white/15 bg-black/30 px-2 py-0.5 font-mono text-xs text-white/80">
                  {formatLabel(anime.format)}
                </span>
              ) : null}
              {anime.status ? (
                <span className="rounded-md border border-white/15 bg-black/30 px-2 py-0.5 font-mono text-xs text-white/80">
                  {formatLabel(anime.status)}
                </span>
              ) : null}
              {anime.seasonYear ? (
                <span className="font-mono text-xs text-white/60">{anime.seasonYear}</span>
              ) : null}
            </div>

            <GenreChips genres={genres} max={12} variant="hero" className="mt-3" />
          </div>
        </div>

        <div className="mt-5 border-t border-[var(--border)] pt-5">
          <h2 className="mb-3 font-mono text-xs font-semibold uppercase tracking-widest text-[var(--muted)]">
            Episodes
          </h2>
          <div className="max-h-[240px] overflow-y-auto rounded-xl border border-[var(--border)] bg-[#12141a] p-3">
            <div className="grid grid-cols-6 gap-1.5 sm:grid-cols-8 md:grid-cols-10 lg:grid-cols-12">
              {episodes.map((ep) => (
                <button
                  key={ep.id}
                  type="button"
                  onClick={() => playEpisode(ep, category)}
                  className={`rounded-md py-1.5 font-sans text-[12px] font-extrabold tabular-nums tracking-tight ${
                    currentEp?.number === ep.number
                      ? category === "sub"
                        ? "bg-[#e07a3a] text-black shadow-sm shadow-[#e07a3a]/30"
                        : "bg-[#3ddc84] text-black shadow-sm shadow-[#3ddc84]/30"
                      : watchedEpisodeNumbers.includes(ep.number)
                        ? "border border-white/5 bg-[#272a33] text-white/45"
                        : "bg-[#1a1d24] text-[var(--muted)] hover:text-white"
                  }`}
                >
                  {ep.number}
                </button>
              ))}
            </div>
            {episodes.length === 0 && (
              <p className="py-6 text-center font-mono text-sm text-[var(--muted)]">
                No {category} episodes
              </p>
            )}
          </div>
        </div>

        <div className="relative z-40 mt-5 space-y-3 border-t border-[var(--border)] pt-5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="mr-1 font-mono text-[10px] font-semibold uppercase tracking-widest text-[var(--muted)]">
              Audio
            </span>
            {(["sub", "dub"] as const).map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => selectCategory(c)}
                className={cn(
                  "rounded-full px-4 py-1.5 font-mono text-xs font-bold uppercase",
                  category === c
                    ? c === "sub"
                      ? "border border-[#e07a3a] bg-[#e07a3a]/20 text-[#e07a3a]"
                      : "border border-[#3ddc84] bg-[#3ddc84]/20 text-[#3ddc84]"
                    : "border border-[var(--border)] bg-[#1a1d24] text-[var(--muted)] hover:text-white"
                )}
              >
                {c}
              </button>
            ))}
          </div>
          <PlayerToolbar
            prefs={prefs}
            onToggle={togglePref}
            expanded={expanded}
            onExpand={() => setExpanded((v) => !v)}
            onPrev={goPrev}
            onNext={goNext}
            hasPrev={hasPrev}
            hasNext={hasNext}
          />
        </div>
      </section>

      <div className="mx-auto max-w-6xl px-4">
        <section className={cn("relative mt-6", expanded && "z-[60]")}>
          {expanded && (
            <div
              className="fixed inset-0 z-50 bg-black/88"
              onClick={() => setExpanded(false)}
              role="presentation"
            />
          )}

          <div
            className={cn(
              dimChrome && "relative z-30",
              expanded &&
                "fixed left-1/2 top-1/2 z-[60] w-[calc(100vw-2rem)] max-w-5xl -translate-x-1/2 -translate-y-1/2 md:w-[calc(100vw-5rem)]"
            )}
            onClick={(e) => expanded && e.stopPropagation()}
          >
            {expanded && (
              <button
                type="button"
                onClick={() => setExpanded(false)}
                className="absolute -top-10 right-0 flex items-center gap-1 font-mono text-xs text-white/70 hover:text-white"
              >
                <X className="h-4 w-4" />
                Shrink
              </button>
            )}
            <div className="relative aspect-video w-full overflow-hidden rounded-xl border border-[var(--border)] bg-black shadow-lg shadow-black/40">
              {iframeSrc ? (
                <iframe
                  ref={iframeRef}
                  src={iframeSrc}
                  title="Player"
                  className="h-full w-full border-0"
                  allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
                  allowFullScreen
                />
              ) : (
                <div className="flex aspect-video items-center justify-center text-sm text-[var(--muted)]">
                  {playerError || "Select an episode"}
                </div>
              )}
              {autoNextSecsLeft !== null && (
                <div className="absolute bottom-0 left-0 right-0 flex items-center justify-between gap-3 bg-black/80 px-4 py-2.5 backdrop-blur-sm">
                  <span className="font-mono text-xs text-white/90">
                    Next episode in{" "}
                    <span className="font-bold text-[#e8621a]">{autoNextSecsLeft}s</span>
                  </span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      clearAutoNextTimers();
                    }}
                    className="rounded border border-white/20 bg-white/10 px-3 py-1 font-mono text-[11px] font-semibold text-white hover:bg-white/20"
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>
            {expanded && currentEp && (
              <p className="mt-2 text-center font-mono text-xs text-white/70">
                Episode {currentEp.number}
                {currentEp.title ? ` — ${currentEp.title}` : ""}
              </p>
            )}
          </div>

          {currentEp && !expanded && (
            <p className="mt-2 font-mono text-xs text-[var(--foreground)]">
              Episode {currentEp.number}
              {currentEp.title ? ` — ${currentEp.title}` : ""}
              {resumeAt > 0 ? (
                <span className="ml-2 text-[var(--muted)]">
                  Resumes at {Math.floor(resumeAt / 60)}:{String(resumeAt % 60).padStart(2, "0")}
                </span>
              ) : null}
            </p>
          )}
        </section>

        {anime.description && (
          <section className={cn("mt-8 transition-opacity", dimChrome && "pointer-events-none opacity-25")}>
            <h2 className="mb-2 font-mono text-xs font-semibold uppercase tracking-widest text-[var(--muted)]">
              About
            </h2>
            <p
              className="text-sm leading-relaxed text-[var(--muted)]"
              dangerouslySetInnerHTML={{
                __html: anime.description.replace(/<br\s*\/?>/gi, " "),
              }}
            />
          </section>
        )}

        <SeasonRail seasons={seasons} currentId={id} />

        <div className={cn("transition-opacity", dimChrome && "opacity-25")}>
          <SimilarCarousel items={recs} />
        </div>
      </div>

      {dimChrome && (
        <button
          type="button"
          onClick={exitFocus}
          className="fixed bottom-4 right-4 z-[70] rounded-full border border-[var(--border)] bg-black/80 px-4 py-2 font-mono text-xs font-semibold text-white shadow-lg shadow-black/40"
        >
          Exit focus
        </button>
      )}
    </div>
  );
}

export default function AnimeDetailPage() {
  return (
    <Suspense fallback={<p className="p-8 text-center font-mono text-sm">Loading…</p>}>
      <WatchPageInner />
    </Suspense>
  );
}
