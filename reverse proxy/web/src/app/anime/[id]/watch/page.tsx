"use client";

import { useCallback, useEffect, useRef, useState, Suspense } from "react";
import { useParams, useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Bookmark, X } from "lucide-react";
import GenreChips from "@/components/GenreChips";
import EpisodeCountBadges from "@/components/EpisodeCountBadges";
import NativeHlsPlayer, { type NativePlayerProgress } from "@/components/NativeHlsPlayer";
import PlayerToolbar from "@/components/PlayerToolbar";
import SeasonRail, { type SeasonEntry } from "@/components/SeasonRail";
import SimilarCarousel from "@/components/SimilarCarousel";
import { api, type AnimeMedia, type EpisodeData, normalizeScore, mediaYear } from "@/lib/api";
import { isBlockedAnime, filterAnimeList } from "@/lib/anime-filters";
import { formatLabel } from "@/lib/format-labels";
import { animeTitle } from "@/lib/anime-title";
import { clientApi } from "@/lib/client-api";
import { useAuth } from "@/components/AuthProvider";
import { loadPlayerPrefs, savePlayerPrefs, type PlayerPrefs } from "@/lib/player-prefs";
import { fetchEpisodeCounts, rememberEpisodeCounts } from "@/lib/episode-counts";
import { buildSeasonList, enrichSeasonCounts } from "@/lib/seasons-from-relations";
import { getAnikotoEpCounts, getCachedEpCounts, getCachedSlug, akFetchEpisodeList } from "@/lib/anikoto-cache";
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
  const [playerSourceId, setPlayerSourceId] = useState("");
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
  const episodesRef = useRef<EpisodeData[]>([]);
  const animeRef = useRef<AnimeMedia | null>(null);
  const prefsRef = useRef<PlayerPrefs>(prefs);
  const userRef = useRef(user);
  const playerShellRef = useRef<HTMLDivElement>(null);
  const lastPlayerTimeRef = useRef(0);
  const lastPlayerRawTimeRef = useRef(0);
  const lastTickAtRef = useRef(0);
  const watchedSecondsRef = useRef(0);
  const watchedRemainderRef = useRef(0);
  const playerDurationSecondsRef = useRef<number | null>(null);
  const lastSavedProgressRef = useRef("");
  const lastSyncedProgressRef = useRef("");
  const playerCanReportRef = useRef(false);
  const [autoNextSecsLeft, setAutoNextSecsLeft] = useState<number | null>(null);
  const autoNextDelayRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoNextTickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => { setPrefs(loadPlayerPrefs()); }, []);
  useEffect(() => { prefsRef.current = prefs; }, [prefs]);
  useEffect(() => { userRef.current = user; }, [user]);
  useEffect(() => { categoryRef.current = category; }, [category]);
  useEffect(() => { currentEpRef.current = currentEp; }, [currentEp]);
  useEffect(() => { episodesRef.current = episodes; }, [episodes]);
  useEffect(() => { animeRef.current = anime; }, [anime]);
  useEffect(() => { watchedSecondsRef.current = watchedSeconds; }, [watchedSeconds]);
  useEffect(() => { playerDurationSecondsRef.current = playerDurationSeconds; }, [playerDurationSeconds]);

  useEffect(() => {
    if (!user) { setWatchedEpisodeNumbers([]); return; }
    clientApi.getWatch()
      .then((r) => {
        const maxWatched = Math.max(0, ...r.items.filter((w) => w.animeId === id).map((w) => w.episodeNumber));
        setWatchedEpisodeNumbers(Array.from({ length: maxWatched }, (_, i) => i + 1));
      })
      .catch(() => {});
  }, [user, id]);

  const clearAutoNextTimers = useCallback(() => {
    if (autoNextDelayRef.current) { clearTimeout(autoNextDelayRef.current); autoNextDelayRef.current = null; }
    if (autoNextTickRef.current) { clearInterval(autoNextTickRef.current); autoNextTickRef.current = null; }
    setAutoNextSecsLeft(null);
  }, []);

  const persistProgress = useCallback((options?: {
    positionSeconds?: number | null;
    durationSeconds?: number | null;
    watchedSeconds?: number | null;
    force?: boolean;
  }) => {
    const ep = currentEpRef.current;
    if (!ep) return null;
    const eid = ep.original_id || ep.id;
    const positionSeconds = Math.max(0, Math.floor(options?.positionSeconds ?? lastPlayerTimeRef.current ?? 0));
    const durationSeconds = options?.durationSeconds ?? playerDurationSecondsRef.current ?? null;
    const nextWatchedSeconds = Math.max(watchedSecondsRef.current, Math.floor(options?.watchedSeconds ?? watchedSecondsRef.current ?? 0));
    const progressKey = `${ep.number}:${categoryRef.current}:${positionSeconds}:${nextWatchedSeconds}`;
    if (!options?.force && progressKey === lastSavedProgressRef.current) return null;
    lastSavedProgressRef.current = progressKey;
    watchedSecondsRef.current = nextWatchedSeconds;
    setWatchedSeconds(nextWatchedSeconds);
    if (durationSeconds != null) { playerDurationSecondsRef.current = durationSeconds; setPlayerDurationSeconds(durationSeconds); }
    return upsertLocalWatchProgress({
      animeId: id, episodeNumber: ep.number, episodeId: eid,
      category: categoryRef.current, title: ep.title,
      animeTitle: animeRef.current ? animeTitle(animeRef.current) : null,
      poster: animeRef.current?.coverImage?.large ?? animeRef.current?.coverImage?.extraLarge ?? null,
      positionSeconds, durationSeconds, watchedSeconds: nextWatchedSeconds,
    });
  }, [id]);

  const syncQualifiedProgress = useCallback((options?: {
    positionSeconds?: number | null;
    durationSeconds?: number | null;
    watchedSeconds?: number | null;
    force?: boolean;
  }) => {
    if (!userRef.current) return;
    const ep = currentEpRef.current;
    if (!ep) return;
    const positionSeconds = Math.max(0, Math.floor(options?.positionSeconds ?? lastPlayerTimeRef.current ?? 0));
    const durationSeconds = options?.durationSeconds ?? playerDurationSecondsRef.current ?? null;
    const nextWatchedSeconds = Math.max(watchedSecondsRef.current, Math.floor(options?.watchedSeconds ?? watchedSecondsRef.current ?? 0));
    if (!qualifiesForContinue({ positionSeconds, durationSeconds, watchedSeconds: nextWatchedSeconds })) return;
    const eid = ep.original_id || ep.id;
    const syncKey = `${ep.number}:${categoryRef.current}:${Math.floor(positionSeconds / 10)}:${Math.floor(nextWatchedSeconds / 10)}`;
    if (!options?.force && syncKey === lastSyncedProgressRef.current) return;
    lastSyncedProgressRef.current = syncKey;
    setWatchedEpisodeNumbers((prev) => [...new Set([...prev, ...Array.from({ length: ep.number }, (_, i) => i + 1)])]);
    void clientApi.saveWatch({ animeId: id, episodeNumber: ep.number, episodeId: eid, category: categoryRef.current, title: ep.title }).catch(() => {});
  }, [id]);

  const playEpisode = useCallback(async (ep: EpisodeData, streamCategory: "sub" | "dub") => {
    clearAutoNextTimers();
    setCurrentEp(ep);
    setPlayerError("");
    setPlayerSourceId("");
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

    setPlayerSourceId(`mal:${id}:${ep.number}`);
  }, [clearAutoNextTimers, id]);

  const selectCategory = useCallback((nextCategory: "sub" | "dub") => {
    if (nextCategory === category) return;
    if (!megaplayEps) { setCategory(nextCategory); return; }
    const list = nextCategory === "dub" ? megaplayEps.dub || [] : megaplayEps.sub || [];
    const nextEpisode = (currentEp && list.find((ep) => ep.number === currentEp.number)) || list[0];
    setCategory(nextCategory);
    setEpisodes(list);
    setExpanded(false);
    if (nextEpisode) { void playEpisode(nextEpisode, nextCategory); }
    else { setCurrentEp(null); setPlayerSourceId(""); setPlayerError(""); }
  }, [category, currentEp, megaplayEps, playEpisode]);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    setSeasons([]);
    setRecs([]);

    // Show cached Anikoto counts immediately (before async load completes)
    const preCached = getCachedEpCounts(id);
    if (preCached && (preCached.sub > 0 || preCached.dub > 0)) {
      setEpCounts(preCached);
    }

    // If anikotoId is cached, fetch episode list in parallel with main load
    const cachedSlug = getCachedSlug(id);
    const akParallelPromise = cachedSlug
      ? akFetchEpisodeList(cachedSlug.anikotoId).catch(() => null)
      : Promise.resolve(null);

    const [detailRes, epRes, recRes, akParallelRes] = await Promise.allSettled([
      api.getAnime(id),
      api.getEpisodes(id),
      api.getRecommendations(id, 1, 12),
      akParallelPromise,
    ]);

    if (detailRes.status === "rejected") {
      setLoadError(detailRes.reason instanceof Error ? detailRes.reason.message : "Anime not found");
      setAnime(null);
      setLoading(false);
      return;
    }

    try {
      const info = detailRes.value.info;
      if (isBlockedAnime(info)) { router.replace("/browse"); return; }
      setAnime(info);

      let subList: EpisodeData[] = [];
      let dubList: EpisodeData[] = [];
      let releasedSub = 0;
      let releasedDub = 0;

      if (epRes.status === "fulfilled") {
        const meg = epRes.value.providers?.megaplay?.episodes ?? {};
        subList = (meg.sub ?? []) as EpisodeData[];
        dubList = (meg.dub ?? []) as EpisodeData[];
        releasedSub = epRes.value.released?.sub ?? 0;
        releasedDub = epRes.value.released?.dub ?? 0;
      }

      // Build synthetic sub list from episode count when backend hasn't indexed yet
      const totalEps = info.episodes ?? 0;
      if (!subList.length && totalEps > 0) {
        subList = Array.from({ length: totalEps }, (_, i) => ({
          id: `mal:${id}:${i + 1}`,
          number: i + 1,
          title: `Episode ${i + 1}`,
        }));
      }

      // Dub playlist: use real dub episodes from provider, do NOT fall back to sub list
      // (showing sub episodes as dub would be wrong — we just show count from released)
      let subN = Math.max(subList.length, releasedSub);
      let dubN = Math.max(dubList.length, releasedDub);

      setMegaplayEps({ sub: subList, dub: dubList.length ? dubList : subList });

      // Merge with parallel Anikoto result if available (cached anikotoId path)
      if (akParallelRes.status === "fulfilled" && akParallelRes.value) {
        const ak = akParallelRes.value;
        subN = Math.max(subN, ak.subCount);
        dubN = Math.max(dubN, ak.dubCount);
        // Build synthetic dub list if backend had none
        if (ak.dubCount > 0 && !dubList.length) {
          const synthDub: EpisodeData[] = Array.from({ length: ak.dubCount }, (_, i) => ({
            id: `mal:${id}:${i + 1}`,
            number: i + 1,
            title: `Episode ${i + 1}`,
          }));
          setMegaplayEps({ sub: subList, dub: synthDub });
        }
      }

      setEpCounts({ sub: subN, dub: dubN });
      if (subN > 0 || dubN > 0) rememberEpisodeCounts({ [id]: { sub: subN, dub: dubN } });

      // First visit (no cached slug): resolve in background
      if (!cachedSlug) {
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
          if (akCounts.dub > 0 && dubList.length === 0) {
            const synthDub: EpisodeData[] = Array.from({ length: akCounts.dub }, (_, i) => ({
              id: `mal:${id}:${i + 1}`,
              number: i + 1,
              title: `Episode ${i + 1}`,
            }));
            setMegaplayEps((prev) => prev ? { ...prev, dub: synthDub } : prev);
          }
        }).catch(() => {});
      }

      const cat = searchParams.get("cat") === "dub" ? "dub" : "sub";
      const playList = cat === "dub" ? (dubList.length ? dubList : subList) : subList;
      setCategory(cat);
      setEpisodes(playList);

      if (recRes.status === "fulfilled") {
        setRecs(filterAnimeList((recRes.value.recommendations || []).map((r) => r.mediaRecommendation).filter(Boolean)));
      }

      // BFS through relations for season rail
      const allEdges = [...(info.relations?.edges || [])];
      const seen = new Set<number>([id]);
      for (const e of allEdges) if (e.node?.id) seen.add(e.node.id);
      let frontier = allEdges.filter((e) => ["SEQUEL", "PREQUEL"].includes(e.relationType || "") && e.node?.id).map((e) => e.node!.id);
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
            if (["SEQUEL", "PREQUEL"].includes(edge.relationType || "")) nextFrontier.push(edge.node.id);
          }
        }
        frontier = nextFrontier;
      }
      const fullSeasons = buildSeasonList(info, { edges: allEdges });
      if (fullSeasons.length) {
        const seasonCounts = await fetchEpisodeCounts(fullSeasons.map((s) => s.id));
        setSeasons(enrichSeasonCounts(fullSeasons, { ...seasonCounts, [id]: { sub: subN, dub: dubN } }));
      }

      const epNum = Number(searchParams.get("ep"));
      const p = loadPlayerPrefs();
      if (epNum && playList.length) {
        const found = playList.find((ep: EpisodeData) => ep.number === epNum);
        if (found) await playEpisode(found, cat);
      } else {
        const latest = getLatestLocalWatchForAnime(id);
        const latestCat = latest?.category === "dub" ? "dub" : "sub";
        const latestList = latestCat === "dub" ? (dubList.length ? dubList : subList) : subList;
        const latestEpisode = latest ? latestList.find((ep: EpisodeData) => ep.number === latest.episodeNumber) : null;
        if (latestEpisode) { setCategory(latestCat); setEpisodes(latestList); await playEpisode(latestEpisode, latestCat); }
        else if (p.autoPlay && playList.length) await playEpisode(playList[0], cat);
      }
    } catch (e) {
      console.error(e);
      setLoadError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [id, router, searchParams, playEpisode]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!user) return;
    clientApi.getBookmarks().then((r) => setBookmarked(r.items.some((b) => b.animeId === id))).catch(() => {});
  }, [user, id]);

  useEffect(() => {
    if (loading || !episodes.length || currentEp) return;
    if (!prefs.autoPlay) return;
    if (Number(searchParams.get("ep"))) return;
    void playEpisode(episodes[0], categoryRef.current);
  }, [loading, episodes, currentEp, prefs.autoPlay, searchParams, playEpisode]);

  useEffect(() => {
    if (!user || !currentEp) return;
    const save = () => { const p = persistProgress({ force: true }); if (!p?.qualified) return; clientApi.saveWatchBeacon({ animeId: id, episodeNumber: currentEp.number, episodeId: currentEp.original_id || currentEp.id, category, title: currentEp.title }); };
    window.addEventListener("pagehide", save);
    window.addEventListener("beforeunload", save);
    return () => { window.removeEventListener("pagehide", save); window.removeEventListener("beforeunload", save); };
  }, [category, currentEp, id, persistProgress, user]);

  const toggleBookmark = async () => {
    if (!user) { router.push("/login"); return; }
    if (!anime) return;
    try {
      if (bookmarked) { await clientApi.removeBookmark(id); setBookmarked(false); }
      else { await clientApi.addBookmark({ animeId: id, titleEnglish: anime.title?.english, titleRomaji: anime.title?.romaji, poster: anime.coverImage?.large }); setBookmarked(true); }
    } catch (e) { console.error(e); }
  };

  const togglePref = (key: keyof PlayerPrefs) => { setPrefs((prev) => savePlayerPrefs({ [key]: !prev[key] })); };

  const currentIndex = currentEp ? episodes.findIndex((e) => e.number === currentEp.number) : -1;
  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex >= 0 && currentIndex < episodes.length - 1;
  const goPrev = useCallback(() => {
    const list = episodesRef.current;
    const ep = currentEpRef.current;
    if (!ep) return;
    const idx = list.findIndex((e) => e.number === ep.number);
    if (idx > 0) void playEpisode(list[idx - 1], categoryRef.current);
  }, [playEpisode]);
  const goNext = useCallback(() => {
    const list = episodesRef.current;
    const ep = currentEpRef.current;
    if (!ep) return;
    const idx = list.findIndex((e) => e.number === ep.number);
    if (idx >= 0 && idx < list.length - 1) void playEpisode(list[idx + 1], categoryRef.current);
  }, [playEpisode]);
  const goNextRef = useRef(goNext);
  useEffect(() => { goNextRef.current = goNext; }, [goNext]);
  const hasNextRef = useRef(hasNext);
  useEffect(() => { hasNextRef.current = hasNext; }, [hasNext]);

  const toggleExpandedPlayer = useCallback(() => {
    if (expanded) {
      setExpanded(false);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
      return;
    }
    setExpanded(true);
    const el = playerShellRef.current;
    if (el?.requestFullscreen) void el.requestFullscreen().catch(() => {});
  }, [expanded]);

  useEffect(() => {
    const onFullscreenChange = () => {
      if (!document.fullscreenElement) setExpanded(false);
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

  const handlePlayerReady = useCallback((data: NativePlayerProgress) => {
    playerCanReportRef.current = true;
    clearAutoNextTimers();
    const rawPosition = Math.max(0, Number(data.currentTime || 0) || 0);
    const duration = data.duration && Number.isFinite(data.duration) && data.duration > 0 ? Math.floor(data.duration) : null;
    lastTickAtRef.current = Date.now();
    lastPlayerTimeRef.current = Math.floor(rawPosition);
    lastPlayerRawTimeRef.current = rawPosition;
    if (duration != null) { playerDurationSecondsRef.current = duration; setPlayerDurationSeconds(duration); }
  }, [clearAutoNextTimers]);

  const handlePlayerProgress = useCallback((data: NativePlayerProgress) => {
    playerCanReportRef.current = true;
    clearAutoNextTimers();
    const rawPosition = Math.max(0, Number(data.currentTime || 0) || 0);
    const position = Math.floor(rawPosition);
    const duration = data.duration && Number.isFinite(data.duration) && data.duration > 0 ? Math.floor(data.duration) : null;
    const now = Date.now();
    let nextWatchedSeconds = watchedSecondsRef.current;
    if (lastTickAtRef.current && rawPosition > lastPlayerRawTimeRef.current) {
      const deltaWall = Math.max(0, Math.min(5, (now - lastTickAtRef.current) / 1000));
      const deltaVideo = Math.max(0, Math.min(5, rawPosition - lastPlayerRawTimeRef.current));
      watchedRemainderRef.current += Math.min(deltaWall || deltaVideo, deltaVideo || deltaWall);
      const wholeSeconds = Math.floor(watchedRemainderRef.current);
      if (wholeSeconds > 0) { nextWatchedSeconds += wholeSeconds; watchedRemainderRef.current -= wholeSeconds; }
    }
    lastTickAtRef.current = now;
    lastPlayerTimeRef.current = position;
    lastPlayerRawTimeRef.current = rawPosition;
    setResumeAt(position);
    persistProgress({ positionSeconds: position, durationSeconds: duration, watchedSeconds: nextWatchedSeconds });
    syncQualifiedProgress({ positionSeconds: position, durationSeconds: duration, watchedSeconds: nextWatchedSeconds });
  }, [clearAutoNextTimers, persistProgress, syncQualifiedProgress]);

  const handlePlayerEnded = useCallback(() => {
    const duration = playerDurationSecondsRef.current;
    const position = duration && duration > 0 ? Math.max(0, duration - 1) : lastPlayerTimeRef.current;
    persistProgress({ positionSeconds: position, durationSeconds: duration, watchedSeconds: Math.max(watchedSecondsRef.current, 60), force: true });
    syncQualifiedProgress({ positionSeconds: position, durationSeconds: duration, watchedSeconds: Math.max(watchedSecondsRef.current, 60), force: true });
    if (prefsRef.current.autoNext && hasNextRef.current) goNextRef.current();
  }, [persistProgress, syncQualifiedProgress]);

  useEffect(() => {
    clearAutoNextTimers();
    if (!playerSourceId || !currentEp || !prefs.autoNext || !hasNext || playerCanReportRef.current) return;
    const COUNTDOWN_SECS = 30;
    const durationRaw = anime?.duration;
    const episodeMins = typeof durationRaw === "number" ? durationRaw : parseInt(String(durationRaw ?? "24")) || 24;
    const delaySecs = Math.max(episodeMins * 60 - COUNTDOWN_SECS - resumeAt, 10);
    autoNextDelayRef.current = setTimeout(() => {
      setAutoNextSecsLeft(COUNTDOWN_SECS);
      autoNextTickRef.current = setInterval(() => {
        setAutoNextSecsLeft((prev) => {
          if (prev === null || prev <= 1) { clearInterval(autoNextTickRef.current!); autoNextTickRef.current = null; goNextRef.current(); return null; }
          return prev - 1;
        });
      }, 1000);
    }, delaySecs * 1000);
    return clearAutoNextTimers;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playerSourceId, currentEp?.number, hasNext, prefs.autoNext, resumeAt, anime?.duration, clearAutoNextTimers]);

  useEffect(() => {
    if (!playerSourceId || !currentEp) return;
    const save = () => { persistProgress({ force: true }); };
    window.addEventListener("pagehide", save);
    window.addEventListener("beforeunload", save);
    return () => { window.removeEventListener("pagehide", save); window.removeEventListener("beforeunload", save); };
  }, [currentEp, playerSourceId, persistProgress]);

  const dimChrome = prefs.focus && !!playerSourceId && !expanded;
  const exitFocus = useCallback(() => { setPrefs((prev) => savePlayerPrefs({ ...prev, focus: false })); }, []);
  useEffect(() => {
    if (!dimChrome) return;
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === "Escape") exitFocus(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dimChrome, exitFocus]);

  if (loading) return <p className="p-8 text-center font-mono text-sm text-[var(--muted)]">Loading…</p>;
  if (!anime) return <p className="p-8 text-center font-mono text-sm text-[var(--muted)]">{loadError || "Not found"}</p>;

  const title = animeTitle(anime);
  const banner = anime.bannerImage || anime.coverImage?.extraLarge || anime.coverImage?.large || "";
  const plannedEps = anime.episodes ?? null;
  const score = normalizeScore(anime);
  const genres = anime.genres || [];

  return (
    <div className="pb-10">
      <section className={cn("relative mx-auto mt-3 max-w-6xl overflow-hidden rounded-2xl border border-white/10 bg-[#0d0f14]/88 p-2 shadow-2xl shadow-black/30 transition-opacity sm:p-3", dimChrome && "opacity-25")}>
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(224,122,58,0.14),transparent_34%),linear-gradient(180deg,rgba(255,255,255,0.04),transparent_45%)]" />
        <div className="relative aspect-[16/9] min-h-[190px] max-h-[300px] w-full overflow-hidden rounded-xl bg-[var(--card)] sm:aspect-[21/8] sm:min-h-[185px]">
          {banner ? <img src={banner} alt="" className="h-full w-full object-cover" /> : null}
          <div className="absolute inset-0 bg-gradient-to-t from-[#0a0b0d] via-[#0a0b0d]/70 to-transparent" />
          <div className="absolute inset-0 bg-gradient-to-r from-[#0a0b0d]/80 via-transparent to-transparent" />
          <div className="absolute bottom-0 left-0 right-0 p-3 sm:p-5">
            <nav className="mb-2 font-mono text-[10px] uppercase tracking-widest text-white/50">
              <Link href="/" className="hover:text-[var(--accent)]">Home</Link>
              <span className="mx-1.5">/</span>
              <Link href={`/anime/${id}`} className="hover:text-[var(--accent)]">{title}</Link>
              <span className="mx-1.5">/</span>
              <span className="text-white/70">Watch</span>
            </nav>
            <div className="flex flex-wrap items-end justify-between gap-2 sm:gap-3">
              <div className="min-w-0 flex-1">
                <h1 className="font-display text-xl font-bold tracking-tight text-white sm:text-3xl md:text-[2.35rem]">{title}</h1>
                <EpisodeCountBadges subCount={epCounts.sub} dubCount={epCounts.dub} total={plannedEps} format={anime.format} className="mt-2" />
              </div>
              <button type="button" onClick={toggleBookmark} className={`flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-1.5 font-mono text-xs font-medium backdrop-blur-md transition-colors ${bookmarked ? "border-[var(--accent)] bg-[var(--accent)]/15 text-[var(--accent)]" : "border-white/20 bg-black/40 text-white hover:border-[var(--accent)]"}`}>
                <Bookmark className="h-3.5 w-3.5" />{bookmarked ? "Saved" : "Bookmark"}
              </button>
            </div>
            <div className="mt-3 flex max-h-16 flex-wrap items-center gap-1.5 overflow-hidden sm:max-h-none sm:gap-2">
              {score ? <span className="rounded-md bg-[#e8621a]/90 px-2 py-0.5 font-mono text-xs font-bold text-white">{score}%</span> : null}
              {anime.format ? <span className="rounded-md border border-white/15 bg-black/30 px-2 py-0.5 font-mono text-xs text-white/80">{formatLabel(anime.format)}</span> : null}
              {anime.status ? <span className="rounded-md border border-white/15 bg-black/30 px-2 py-0.5 font-mono text-xs text-white/80">{formatLabel(anime.status)}</span> : null}
              {(anime.seasonYear ?? mediaYear(anime)) ? <span className="font-mono text-xs text-white/60">{anime.seasonYear ?? mediaYear(anime)}</span> : null}
            </div>
            <GenreChips genres={genres} max={12} variant="hero" className="mt-3" />
          </div>
        </div>

        <div className="relative mt-3 rounded-xl border border-white/10 bg-black/20 p-3 backdrop-blur-sm">
          <div className="mb-2 flex items-center justify-between gap-3">
            <h2 className="font-mono text-[10px] font-semibold uppercase tracking-widest text-[var(--muted)]">Episodes</h2>
            {currentEp ? <span className="font-mono text-[10px] text-white/45">Now playing EP {currentEp.number}</span> : null}
          </div>
          <div className="max-h-[148px] overflow-y-auto pr-1">
            <div className="grid grid-cols-[repeat(auto-fill,minmax(2.25rem,1fr))] gap-1.5">
              {episodes.map((ep, i) => (
                <button key={`${ep.id}-${ep.number}-${i}`} type="button" onClick={() => playEpisode(ep, category)}
                  className={`rounded-md py-1.5 font-sans text-[12px] font-extrabold tabular-nums tracking-tight transition-colors ${currentEp?.number === ep.number ? category === "sub" ? "bg-[#e07a3a] text-black shadow-sm shadow-[#e07a3a]/30" : "bg-[#3ddc84] text-black shadow-sm shadow-[#3ddc84]/30" : watchedEpisodeNumbers.includes(ep.number) ? "border border-white/5 bg-white/10 text-white/45" : "bg-[#171a21] text-[var(--muted)] hover:bg-white/10 hover:text-white"}`}>
                  {ep.number}
                </button>
              ))}
            </div>
            {episodes.length === 0 && <p className="py-6 text-center font-mono text-sm text-[var(--muted)]">No {category} episodes</p>}
          </div>
        </div>

        <div className="relative z-40 mt-3 rounded-xl border border-white/10 bg-black/20 p-3 backdrop-blur-sm">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <span className="mr-1 font-mono text-[10px] font-semibold uppercase tracking-widest text-[var(--muted)]">Audio</span>
            {(["sub", "dub"] as const).map((c) => (
              <button key={c} type="button" onClick={() => selectCategory(c)}
                className={cn("rounded-full px-3 py-1 font-mono text-[11px] font-bold uppercase sm:px-3.5", category === c ? c === "sub" ? "border border-[#e07a3a] bg-[#e07a3a]/15 text-[#e07a3a]" : "border border-[#3ddc84] bg-[#3ddc84]/15 text-[#3ddc84]" : "border border-white/10 bg-[#171a21] text-[var(--muted)] hover:text-white")}>
                {c}
              </button>
            ))}
          </div>
          <PlayerToolbar prefs={prefs} onToggle={togglePref} expanded={expanded} onExpand={toggleExpandedPlayer} onPrev={goPrev} onNext={goNext} hasPrev={hasPrev} hasNext={hasNext} />
        </div>
      </section>

      <div className="mx-auto max-w-6xl px-3 sm:px-4">
        <section className={cn("relative mt-6", expanded && "z-[60]")}>
          {expanded && <div className="fixed inset-0 z-50 bg-black/88" onClick={() => setExpanded(false)} role="presentation" />}
          <div ref={playerShellRef} className={cn(dimChrome && "relative z-30", expanded && "fixed left-1/2 top-1/2 z-[60] w-[calc(100vw-1rem)] max-w-5xl -translate-x-1/2 -translate-y-1/2 sm:w-[calc(100vw-2rem)] md:w-[calc(100vw-5rem)]")} onClick={(e) => expanded && e.stopPropagation()}>
            {expanded && <button type="button" onClick={() => setExpanded(false)} className="absolute -top-10 right-0 flex items-center gap-1 font-mono text-xs text-white/70 hover:text-white"><X className="h-4 w-4" />Shrink</button>}
            <div className="relative aspect-video w-full overflow-hidden rounded-lg border border-[var(--border)] bg-black shadow-lg shadow-black/40 sm:rounded-xl">
              {playerSourceId ? (
                <NativeHlsPlayer
                  sourceId={playerSourceId}
                  category={category}
                  resumeAt={resumeAt}
                  autoPlay={prefs.autoPlay}
                  autoSkip={prefs.autoSkip}
                  onReady={handlePlayerReady}
                  onProgress={handlePlayerProgress}
                  onEnded={handlePlayerEnded}
                  onError={setPlayerError}
                />
              ) : (
                <div className="flex aspect-video items-center justify-center text-sm text-[var(--muted)]">{playerError || "Select an episode"}</div>
              )}
              {autoNextSecsLeft !== null && (
                <div className="absolute bottom-0 left-0 right-0 flex items-center justify-between gap-2 bg-black/80 px-3 py-2.5 backdrop-blur-sm sm:gap-3 sm:px-4">
                  <span className="font-mono text-xs text-white/90">Next episode in <span className="font-bold text-[#e8621a]">{autoNextSecsLeft}s</span></span>
                  <button type="button" onClick={(e) => { e.stopPropagation(); clearAutoNextTimers(); }} className="rounded border border-white/20 bg-white/10 px-3 py-1 font-mono text-[11px] font-semibold text-white hover:bg-white/20">Cancel</button>
                </div>
              )}
            </div>
            {expanded && currentEp && <p className="mt-2 text-center font-mono text-xs text-white/70">Episode {currentEp.number}{currentEp.title ? ` — ${currentEp.title}` : ""}</p>}
          </div>
          {currentEp && !expanded && (
            <p className="mt-2 font-mono text-xs text-[var(--foreground)]">
              Episode {currentEp.number}{currentEp.title ? ` — ${currentEp.title}` : ""}
              {resumeAt > 0 ? <span className="ml-2 text-[var(--muted)]">Resumes at {Math.floor(resumeAt / 60)}:{String(resumeAt % 60).padStart(2, "0")}</span> : null}
            </p>
          )}
        </section>

        {anime.description && (
          <section className={cn("mt-8 transition-opacity", dimChrome && "pointer-events-none opacity-25")}>
            <h2 className="mb-2 font-mono text-xs font-semibold uppercase tracking-widest text-[var(--muted)]">About</h2>
            <p className="text-sm leading-relaxed text-[var(--muted)]" dangerouslySetInnerHTML={{ __html: anime.description.replace(/<br\s*\/?>/gi, " ") }} />
          </section>
        )}
        <SeasonRail seasons={seasons} currentId={id} />
        <div className={cn("transition-opacity", dimChrome && "opacity-25")}><SimilarCarousel items={recs} /></div>
      </div>

      {dimChrome && (
        <button type="button" onClick={exitFocus} className="fixed bottom-4 right-4 z-[70] rounded-full border border-[var(--border)] bg-black/80 px-4 py-2 font-mono text-xs font-semibold text-white shadow-lg shadow-black/40">
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
