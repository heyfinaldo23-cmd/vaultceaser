"use client";

import { useCallback, useEffect, useRef, useState, Suspense } from "react";
import { useParams, useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Bookmark } from "lucide-react";
import GenreChips from "@/components/GenreChips";
import EpisodeCountBadges from "@/components/EpisodeCountBadges";
import NativeHlsPlayer, { type NativePlayerProgress, type NativeHlsPlayerHandle } from "@/components/NativeHlsPlayer";
import PlayerToolbar from "@/components/PlayerToolbar";
import SeasonRail, { type SeasonEntry } from "@/components/SeasonRail";
import { type AnimeMedia, type EpisodeData, normalizeScore, mediaYear } from "@/lib/api";
import { isBlockedAnime } from "@/lib/anime-filters";
import { formatLabel } from "@/lib/format-labels";
import { animeTitle } from "@/lib/anime-title";
import { clientApi } from "@/lib/client-api";
import { useAuth } from "@/components/AuthProvider";
import { loadPlayerPrefs, savePlayerPrefs, type PlayerPrefs } from "@/lib/player-prefs";
import { otakubox, cardToMedia, buildSeasonChain, findNextInChain, type OtakuEpisode } from "@/lib/otakubox";
import {
  getLatestLocalWatchForAnime,
  getLocalWatchProgress,
  listLocalWatchProgressForAnime,
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
  const playerRef = useRef<NativeHlsPlayerHandle>(null);
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
    // Load from local progress immediately — works without auth
    const local = listLocalWatchProgressForAnime(id);
    const qualifiedNums = local.filter((w) => w.qualified).map((w) => w.episodeNumber);
    if (qualifiedNums.length) {
      const maxLocal = Math.max(...qualifiedNums);
      setWatchedEpisodeNumbers(Array.from({ length: maxLocal }, (_, i) => i + 1));
    }

    if (!user) return;
    clientApi.getWatch()
      .then((r) => {
        const maxWatched = Math.max(0, ...r.items.filter((w) => w.animeId === id).map((w) => w.episodeNumber));
        if (maxWatched > 0) setWatchedEpisodeNumbers(Array.from({ length: maxWatched }, (_, i) => i + 1));
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

    setPlayerSourceId(ep.id);
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

    const toEpData = (ep: OtakuEpisode): EpisodeData => ({
      id: ep.id,
      number: parseInt(ep.episode_num) || 0,
      title: ep.title || `Episode ${ep.episode_num}`,
      original_id: ep.id,
    });

    const [detailRes, epRes, relRes] = await Promise.allSettled([
      otakubox.getShow(id),
      otakubox.getEpisodes(id),
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
      if (isBlockedAnime(media)) { router.replace("/browse"); return; }
      setAnime(media);

      setEpCounts({ sub: show.sub_count, dub: show.dub_count });

      let subList: EpisodeData[] = [];
      let dubList: EpisodeData[] = [];

      if (epRes.status === "fulfilled") {
        subList = epRes.value.filter((e) => e.has_sub).map(toEpData);
        dubList = epRes.value.filter((e) => e.has_dub).map(toEpData);
      }

      if (!subList.length && show.episode_count > 0) {
        subList = Array.from({ length: show.episode_count }, (_, i) => ({
          id: `ani:${id}:${i + 1}`,
          number: i + 1,
          title: `Episode ${i + 1}`,
          original_id: `ani:${id}:${i + 1}`,
        }));
      }

      setMegaplayEps({ sub: subList, dub: dubList.length ? dubList : subList });

      if (relRes.status === "fulfilled") {
        const { nodes, edges } = relRes.value;
        const chainNodes = buildSeasonChain(id, nodes, edges);
        if (chainNodes.length > 1) {
          const nextId = findNextInChain(id, edges);
          setSeasons(chainNodes.map((n) => ({
            id: n.anilist_id,
            label: n.title,
            title: n.title,
            image: n.cover,
            format: n.type,
            isCurrent: n.anilist_id === id,
            isNext: n.anilist_id === nextId,
          })));
        }
      }

      const cat = searchParams.get("cat") === "dub" ? "dub" : "sub";
      const playList = cat === "dub" ? (dubList.length ? dubList : subList) : subList;
      setCategory(cat);
      setEpisodes(playList);

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
    setExpanded((prev) => !prev);
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
      {/* ── Main grid: player (left) + episode sidebar (right) ── */}
      <div className={cn(
        "mx-auto px-2 sm:px-3 transition-all duration-200",
        expanded ? "mt-0 max-w-full" : "mt-3 max-w-7xl"
      )}>
        <div className={cn("flex gap-3 xl:gap-4", expanded ? "flex-col" : "flex-col xl:flex-row")}>

          {/* ── Left col: player + controls ── */}
          <div className="min-w-0 flex-1">
            {/* Breadcrumb */}
            <nav className="mb-2 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest text-white/40">
              <Link href="/" className="hover:text-[var(--accent)]">Home</Link>
              <span>/</span>
              <Link href={`/anime/${id}`} className="max-w-[180px] truncate hover:text-[var(--accent)]">{title}</Link>
              <span>/</span>
              <span className="text-white/60">Watch</span>
            </nav>

            {/* Player */}
            <div
              ref={playerShellRef}
              className="relative aspect-video w-full overflow-hidden rounded-xl border border-[var(--border)] bg-black shadow-2xl shadow-black/50"
            >
              {playerSourceId ? (
                <NativeHlsPlayer
                  ref={playerRef}
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
                <div className="flex h-full items-center justify-center font-mono text-sm text-[var(--muted)]">
                  {playerError || "Select an episode to start"}
                </div>
              )}
              {autoNextSecsLeft !== null && (
                <div className="absolute bottom-0 left-0 right-0 flex items-center justify-between gap-2 bg-black/80 px-3 py-2.5 backdrop-blur-sm">
                  <span className="font-mono text-xs text-white/90">
                    Next episode in <span className="font-bold text-[#e8621a]">{autoNextSecsLeft}s</span>
                  </span>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); clearAutoNextTimers(); }}
                    className="rounded border border-white/20 bg-white/10 px-3 py-1 font-mono text-[11px] font-semibold text-white hover:bg-white/20"
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>

            {/* Now-playing label */}
            {currentEp && (
              <div className="mt-2 flex items-center justify-between px-0.5">
                <p className="font-mono text-xs text-white/70">
                  <span className="mr-1.5 rounded bg-[#e8621a]/80 px-1.5 py-0.5 text-[9px] font-bold text-white">
                    EP {currentEp.number}
                  </span>
                  {currentEp.title}
                </p>
                {resumeAt > 0 && (
                  <span className="font-mono text-[10px] text-white/40">
                    {Math.floor(resumeAt / 60)}:{String(resumeAt % 60).padStart(2, "0")}
                  </span>
                )}
              </div>
            )}

            {/* Controls: audio + toolbar */}
            <div className={cn(
              "mt-3 rounded-xl border border-white/10 bg-[#0d0f14]/90 p-3",
              dimChrome && "pointer-events-none opacity-20"
            )}>
              <div className="mb-2.5 flex flex-wrap items-center gap-2">
                <span className="mr-1 font-mono text-[10px] font-semibold uppercase tracking-widest text-[var(--muted)]">Audio</span>
                {(["sub", "dub"] as const).map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => selectCategory(c)}
                    className={cn(
                      "rounded-full px-3 py-1 font-mono text-[11px] font-bold uppercase",
                      category === c
                        ? c === "sub"
                          ? "border border-[#e07a3a] bg-[#e07a3a]/15 text-[#e07a3a]"
                          : "border border-[#3ddc84] bg-[#3ddc84]/15 text-[#3ddc84]"
                        : "border border-white/10 bg-[#171a21] text-[var(--muted)] hover:text-white"
                    )}
                  >
                    {c}
                  </button>
                ))}
                <div className="flex-1" />
                <button
                  type="button"
                  onClick={toggleBookmark}
                  className={cn(
                    "flex items-center gap-1.5 rounded-lg border px-3 py-1.5 font-mono text-xs font-medium transition-colors",
                    bookmarked
                      ? "border-[var(--accent)] bg-[var(--accent)]/15 text-[var(--accent)]"
                      : "border-white/20 bg-transparent text-white/60 hover:border-[var(--accent)] hover:text-white"
                  )}
                >
                  <Bookmark className="h-3.5 w-3.5" />
                  {bookmarked ? "Saved" : "Bookmark"}
                </button>
              </div>
              <PlayerToolbar
                prefs={prefs}
                onToggle={togglePref}
                expanded={expanded}
                onExpand={toggleExpandedPlayer}
                onPrev={goPrev}
                onNext={goNext}
                hasPrev={hasPrev}
                hasNext={hasNext}
                onSeekBack={() => playerRef.current?.seekBy(-10)}
                onSeekForward={() => playerRef.current?.seekBy(10)}
              />
            </div>
          </div>

          {/* ── Right col: anime info + episode list ── */}
          <div className={cn(
            "xl:shrink-0",
            expanded ? "w-full" : "xl:w-[300px]",
            dimChrome && "pointer-events-none opacity-20"
          )}>
            {/* Anime info card */}
            <div className="relative overflow-hidden rounded-xl border border-white/10">
              {banner && (
                <img src={banner} alt="" className="absolute inset-0 h-full w-full object-cover opacity-20" />
              )}
              <div className="relative bg-gradient-to-b from-transparent via-[#0d0f14]/70 to-[#0d0f14] p-3">
                <Link href={`/anime/${id}`} className="group block">
                  <h1 className="font-display line-clamp-2 text-base font-bold leading-tight text-white group-hover:text-[#e8621a] sm:text-lg">
                    {title}
                  </h1>
                </Link>
                <EpisodeCountBadges subCount={epCounts.sub} dubCount={epCounts.dub} total={plannedEps} format={anime.format} className="mt-1.5" />
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {score ? <span className="rounded-md bg-[#e8621a]/90 px-2 py-0.5 font-mono text-xs font-bold text-white">{score}%</span> : null}
                  {anime.format ? <span className="rounded-md border border-white/15 bg-black/30 px-2 py-0.5 font-mono text-xs text-white/70">{formatLabel(anime.format)}</span> : null}
                  {anime.status ? <span className="rounded-md border border-white/15 bg-black/30 px-2 py-0.5 font-mono text-xs text-white/70">{formatLabel(anime.status)}</span> : null}
                  {(anime.seasonYear ?? mediaYear(anime)) ? <span className="font-mono text-xs text-white/50">{anime.seasonYear ?? mediaYear(anime)}</span> : null}
                </div>
                <GenreChips genres={genres} max={6} variant="hero" className="mt-2" />
              </div>
            </div>

            {/* Episode grid */}
            <div className="mt-3 rounded-xl border border-white/10 bg-[#0d0f14]/90 p-3">
              <div className="mb-2 flex items-center justify-between">
                <h2 className="font-mono text-[10px] font-semibold uppercase tracking-widest text-[var(--muted)]">Episodes</h2>
                {currentEp && <span className="font-mono text-[10px] text-white/45">EP {currentEp.number}</span>}
              </div>
              <div className="max-h-[min(360px,40vh)] overflow-y-auto pr-0.5 xl:max-h-[min(500px,52vh)]">
                <div className="grid grid-cols-[repeat(auto-fill,minmax(2.5rem,1fr))] gap-1.5">
                  {episodes.map((ep, i) => (
                    <button
                      key={`${ep.id}-${ep.number}-${i}`}
                      type="button"
                      onClick={() => playEpisode(ep, category)}
                      className={cn(
                        "rounded-md py-1.5 font-sans text-[12px] font-extrabold tabular-nums tracking-tight transition-colors",
                        currentEp?.number === ep.number
                          ? category === "sub"
                            ? "bg-[#e07a3a] text-black shadow-sm shadow-[#e07a3a]/30"
                            : "bg-[#3ddc84] text-black shadow-sm shadow-[#3ddc84]/30"
                          : watchedEpisodeNumbers.includes(ep.number)
                            ? "border border-white/5 bg-white/[0.06] text-white/30"
                            : "bg-[#171a21] text-[var(--muted)] hover:bg-white/10 hover:text-white"
                      )}
                    >
                      {ep.number}
                    </button>
                  ))}
                </div>
                {episodes.length === 0 && (
                  <p className="py-6 text-center font-mono text-sm text-[var(--muted)]">No {category} episodes</p>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Info section ── */}
      <div className={cn(
        "mx-auto mt-6 max-w-7xl px-3 sm:px-4",
        dimChrome && "pointer-events-none opacity-20"
      )}>
        {anime.description && (
          <section className="mb-6">
            <h2 className="mb-2 font-mono text-xs font-semibold uppercase tracking-widest text-[var(--muted)]">About</h2>
            <p
              className="text-sm leading-relaxed text-[var(--muted)]"
              dangerouslySetInnerHTML={{ __html: anime.description.replace(/<br\s*\/?>/gi, " ") }}
            />
          </section>
        )}
        <SeasonRail seasons={seasons} currentId={id} />
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
