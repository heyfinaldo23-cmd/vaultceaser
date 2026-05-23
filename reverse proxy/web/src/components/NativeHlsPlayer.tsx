"use client";

import { useEffect, useImperativeHandle, useRef, useState, forwardRef } from "react";
import Hls from "hls.js";
import {
  Captions,
  Maximize2,
  Pause,
  Play,
  Settings2,
  Volume2,
  VolumeX,
  Gauge,
} from "lucide-react";

type StreamCategory = "sub" | "dub";

export type NativePlayerProgress = {
  currentTime: number;
  duration: number | null;
};

type SourceItem = {
  file?: string;
  url?: string;
  label?: string;
  kind?: string;
  srclang?: string;
  lang?: string;
  default?: boolean;
};

type SkipRange = {
  start?: number | string;
  from?: number | string;
  begin?: number | string;
  end?: number | string;
  to?: number | string;
};

type SourcesPayload = {
  sources?: SourceItem[] | SourceItem;
  tracks?: SourceItem[];
  intro?: SkipRange;
  outro?: SkipRange;
  error?: string;
  detail?: string;
};

type CaptionPrefs = {
  size: number;
  text: string;
  background: "none" | "soft" | "solid";
  shadow: boolean;
};

type CaptionOption = {
  key: string;
  label: string;
};

type QualityLevel = {
  index: number;
  label: string;
};

type Props = {
  sourceId: string;
  category: StreamCategory;
  resumeAt: number;
  autoPlay: boolean;
  autoSkip: boolean;
  onReady?: (progress: NativePlayerProgress) => void;
  onProgress?: (progress: NativePlayerProgress) => void;
  onEnded?: () => void;
  onError?: (message: string) => void;
};

export type NativeHlsPlayerHandle = {
  seekBy: (delta: number) => void;
};

const CAPTION_PREFS_KEY = "ov-caption-prefs";
const NEKOS_CATS = ["nod", "wave", "think", "happy", "smile", "bored"];

const DEFAULT_CAPTION_PREFS: CaptionPrefs = {
  size: 115,
  text: "#ffffff",
  background: "soft",
  shadow: true,
};

function normalizeSources(raw: SourcesPayload["sources"]): SourceItem[] {
  if (!raw) return [];
  return Array.isArray(raw) ? raw : [raw];
}

function numeric(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeRange(raw?: SkipRange): { start: number; end: number } | null {
  if (!raw) return null;
  const start = numeric(raw.start ?? raw.from ?? raw.begin);
  const end = numeric(raw.end ?? raw.to);
  if (start == null || end == null || end <= start) return null;
  return { start, end };
}

function captionKey(label: string, language = ""): string {
  return `${label.trim().toLowerCase()}|${language.trim().toLowerCase()}`;
}

function isEnglishCaption(label = "", language = ""): boolean {
  const haystack = `${label} ${language}`.toLowerCase();
  return /\b(en|eng|english)\b/.test(haystack);
}

function clearTracks(video: HTMLVideoElement) {
  for (const track of Array.from(video.querySelectorAll("track"))) {
    track.remove();
  }
}

function addTracks(video: HTMLVideoElement, tracks: SourceItem[] = []) {
  clearTracks(video);
  const options: CaptionOption[] = [];
  let preferredKey = "";
  tracks.forEach((track, index) => {
    const src = track.file || track.url;
    if (!src) return;
    const kind = String(track.kind || "subtitles").toLowerCase();
    if (kind !== "subtitles" && kind !== "captions") return;

    const el = document.createElement("track");
    el.kind = kind === "captions" ? "captions" : "subtitles";
    el.label = String(track.label || `Subtitles ${index + 1}`).replace(/[<>]/g, "");
    const lang = track.srclang || track.lang || "";
    if (lang) el.srclang = String(lang).slice(0, 12);
    el.src = src;
    el.default = false;
    video.appendChild(el);
    const key = captionKey(el.label, el.srclang);
    options.push({ key, label: el.label });
    if (!preferredKey && (track.default || isEnglishCaption(el.label, el.srclang))) preferredKey = key;
  });
  return { options, preferredKey: preferredKey || options[0]?.key || "" };
}

function loadCaptionPrefs(): CaptionPrefs {
  if (typeof window === "undefined") return DEFAULT_CAPTION_PREFS;
  try {
    const raw = localStorage.getItem(CAPTION_PREFS_KEY);
    if (!raw) return DEFAULT_CAPTION_PREFS;
    return { ...DEFAULT_CAPTION_PREFS, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_CAPTION_PREFS;
  }
}

function saveCaptionPrefs(next: CaptionPrefs): CaptionPrefs {
  if (typeof window !== "undefined") {
    localStorage.setItem(CAPTION_PREFS_KEY, JSON.stringify(next));
  }
  return next;
}

function formatTime(seconds: number | null | undefined): string {
  if (!seconds || !Number.isFinite(seconds) || seconds < 0) return "0:00";
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  return `${m}:${String(r).padStart(2, "0")}`;
}

function cueToText(cue: TextTrackCue): string {
  const raw = String((cue as TextTrackCue & { text?: string }).text || "");
  return raw
    .replace(/<[^>]+>/g, "")
    .replace(/\r/g, "")
    .trim();
}

const NativeHlsPlayer = forwardRef<NativeHlsPlayerHandle, Props>(function NativeHlsPlayer({
  sourceId,
  category,
  resumeAt,
  autoPlay,
  autoSkip,
  onReady,
  onProgress,
  onEnded,
  onError,
}, ref) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const autoSkipRef = useRef(autoSkip);
  const captionsEnabledRef = useRef(true);
  const selectedCaptionKeyRef = useRef("");
  const resumeAtRef = useRef(resumeAt);
  const progressPostedAtRef = useRef(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [currentTime, setCurrentTime] = useState(0);
  const [durationSeconds, setDurationSeconds] = useState<number | null>(null);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [captionsEnabled, setCaptionsEnabled] = useState(true);
  const [captionPrefs, setCaptionPrefs] = useState<CaptionPrefs>(DEFAULT_CAPTION_PREFS);
  const [captionPanelOpen, setCaptionPanelOpen] = useState(false);
  const [activeCaption, setActiveCaption] = useState("");
  const [captionOptions, setCaptionOptions] = useState<CaptionOption[]>([]);
  const [selectedCaptionKey, setSelectedCaptionKey] = useState("");
  const [hlsLevels, setHlsLevels] = useState<QualityLevel[]>([]);
  const [hlsLevel, setHlsLevel] = useState(-1);
  const [qualityPanelOpen, setQualityPanelOpen] = useState(false);
  const [loadingGif, setLoadingGif] = useState<string | null>(null);

  // Fetch loading gif once on mount
  useEffect(() => {
    const cat = NEKOS_CATS[Math.floor(Math.random() * NEKOS_CATS.length)];
    fetch(`https://nekos.best/api/v2/${cat}?amount=1`)
      .then((r) => r.json())
      .then((d) => {
        const url = d?.results?.[0]?.url as string | undefined;
        if (url) setLoadingGif(url);
      })
      .catch(() => null);
  }, []);

  const cueBackground =
    captionPrefs.background === "solid"
      ? "rgba(0,0,0,0.88)"
      : captionPrefs.background === "soft"
        ? "rgba(0,0,0,0.58)"
        : "transparent";
  const cueShadow = captionPrefs.shadow
    ? "0 2px 3px #000, 0 0 7px #000, 0 0 12px #000"
    : "none";

  useEffect(() => {
    autoSkipRef.current = autoSkip;
  }, [autoSkip]);

  useEffect(() => {
    setCaptionPrefs(loadCaptionPrefs());
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.volume = volume;
    video.muted = muted;
  }, [muted, volume]);

  useEffect(() => {
    captionsEnabledRef.current = captionsEnabled;
    const video = videoRef.current;
    if (!video) return;
    for (const track of Array.from(video.textTracks)) {
      const key = captionKey(track.label, track.language);
      track.mode = captionsEnabled && key === selectedCaptionKeyRef.current ? "hidden" : "disabled";
    }
    if (!captionsEnabled) setActiveCaption("");
  }, [captionsEnabled, sourceId]);

  const selectCaption = (key: string) => {
    selectedCaptionKeyRef.current = key;
    setSelectedCaptionKey(key);
    const video = videoRef.current;
    if (!video) return;
    for (const track of Array.from(video.textTracks)) {
      track.mode = captionsEnabledRef.current && captionKey(track.label, track.language) === key ? "hidden" : "disabled";
    }
    setActiveCaption("");
  };

  const selectLevel = (level: number) => {
    setHlsLevel(level);
    if (hlsRef.current) {
      hlsRef.current.currentLevel = level;
    }
    setQualityPanelOpen(false);
  };

  useEffect(() => {
    resumeAtRef.current = resumeAt;
  }, [resumeAt, sourceId, category]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !sourceId) return;

    const abort = new AbortController();
    const initialResumeAt = Math.max(0, resumeAtRef.current || 0);
    let hls: Hls | null = null;
    let cancelled = false;
    let intro: { start: number; end: number } | null = null;
    let outro: { start: number; end: number } | null = null;
    let didResume = false;
    let endedSent = false;

    // Reset quality state on new source
    hlsRef.current = null;
    setHlsLevels([]);
    setHlsLevel(-1);

    const duration = () => (Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null);
    const progress = (): NativePlayerProgress => ({
      currentTime: Number(video.currentTime || 0),
      duration: duration(),
    });
    const updateCaption = () => {
      if (!captionsEnabledRef.current) {
        setActiveCaption("");
        return;
      }
      const tracks = Array.from(video.textTracks);
      let selected = tracks.find((track) => captionKey(track.label, track.language) === selectedCaptionKeyRef.current);
      if (!selected) {
        selected = tracks.find((track) => isEnglishCaption(track.label, track.language)) || tracks[0];
        if (selected) {
          const key = captionKey(selected.label, selected.language);
          selectedCaptionKeyRef.current = key;
          setSelectedCaptionKey(key);
        }
      }
      for (const track of tracks) {
        track.mode = track === selected ? "hidden" : "disabled";
      }
      const active = selected?.activeCues;
      if (active?.length) {
        const text = Array.from(active).map(cueToText).filter(Boolean).join("\n");
        setActiveCaption(text);
        return;
      }
      setActiveCaption("");
    };
    const reportError = (message: string) => {
      if (cancelled) return;
      setError(message);
      setLoading(false);
      onError?.(message);
    };
    const tryResume = () => {
      if (didResume || initialResumeAt <= 0) return;
      const d = duration();
      if (d && initialResumeAt >= d - 4) return;
      try {
        video.currentTime = initialResumeAt;
        didResume = true;
      } catch {
        // Some HLS engines reject early seeks until enough metadata is loaded.
      }
    };
    const tryPlay = async () => {
      if (!autoPlay || cancelled) return;
      try {
        await video.play();
        if (!cancelled) setAutoplayBlocked(false);
      } catch {
        if (!cancelled) setAutoplayBlocked(true);
      }
    };
    const maybeSkip = () => {
      if (!autoSkipRef.current || video.seeking) return;
      const d = duration();
      if (!d) return;
      const t = Number(video.currentTime || 0);
      for (const range of [intro, outro]) {
        if (!range) continue;
        if (t >= range.start - 0.35 && t < range.end - 0.5) {
          video.currentTime = Math.min(range.end + 0.05, Math.max(0, d - 0.35));
          return;
        }
      }
    };
    const notifyEnded = () => {
      if (endedSent) return;
      endedSent = true;
      onEnded?.();
    };
    const handleLoadedMetadata = () => {
      tryResume();
      setLoading(false);
      setDurationSeconds(duration());
      updateCaption();
      onReady?.(progress());
      void tryPlay();
    };
    const handleTimeUpdate = () => {
      maybeSkip();
      setCurrentTime(Number(video.currentTime || 0));
      setDurationSeconds(duration());
      updateCaption();
      const now = Date.now();
      if (now - progressPostedAtRef.current >= 1000) {
        progressPostedAtRef.current = now;
        onProgress?.(progress());
      }
      const d = duration();
      if (d && video.currentTime >= d - 1.5) notifyEnded();
    };
    const handlePlay = () => setPlaying(true);
    const handlePause = () => setPlaying(false);
    const handleVolumeChange = () => {
      setMuted(video.muted);
      setVolume(video.volume);
    };

    setLoading(true);
    setError("");
    setAutoplayBlocked(false);
    setPlaying(false);
    setCurrentTime(0);
    setDurationSeconds(null);
    setActiveCaption("");
    setCaptionOptions([]);
    setSelectedCaptionKey("");
    selectedCaptionKeyRef.current = "";
    video.pause();
    video.removeAttribute("src");
    video.load();
    clearTracks(video);
    progressPostedAtRef.current = 0;

    video.addEventListener("loadedmetadata", handleLoadedMetadata);
    video.addEventListener("timeupdate", handleTimeUpdate);
    video.addEventListener("ended", notifyEnded);
    video.addEventListener("play", handlePlay);
    video.addEventListener("pause", handlePause);
    video.addEventListener("volumechange", handleVolumeChange);

    const load = async () => {
      try {
        const qs = new URLSearchParams({
          id: sourceId,
          category,
          _: String(Date.now()),
        });
        const res = await fetch(`/api/mp/stream/getSources?${qs}`, {
          cache: "no-store",
          signal: abort.signal,
        });
        if (!res.ok) throw new Error(`getSources HTTP ${res.status}`);
        const data = (await res.json()) as SourcesPayload;
        if (data.error || data.detail) throw new Error(String(data.error || data.detail));

        const source = normalizeSources(data.sources).find((item) => item.file || item.url);
        const file = source?.file || source?.url;
        if (!file) throw new Error("No playable HLS source found");

        intro = normalizeRange(data.intro);
        outro = normalizeRange(data.outro);
        const addedTracks = addTracks(video, data.tracks || []);
        setCaptionOptions(addedTracks.options);
        selectedCaptionKeyRef.current = addedTracks.preferredKey;
        setSelectedCaptionKey(addedTracks.preferredKey);
        window.setTimeout(() => {
          for (const track of Array.from(video.textTracks)) {
            track.mode = captionsEnabledRef.current && captionKey(track.label, track.language) === selectedCaptionKeyRef.current ? "hidden" : "disabled";
          }
          updateCaption();
        }, 0);

        if (Hls.isSupported()) {
          hls = new Hls({ enableWorker: true });
          hlsRef.current = hls;
          hls.loadSource(file);
          hls.attachMedia(video);
          hls.on(Hls.Events.MANIFEST_PARSED, (_evt, hlsData) => {
            // Populate quality levels
            const levels: QualityLevel[] = hlsData.levels.map(
              (l: { height?: number; bitrate?: number }, i: number) => ({
                index: i,
                label: l.height ? `${l.height}p` : `Level ${i + 1}`,
              })
            );
            if (levels.length > 1) {
              setHlsLevels(levels);
              setHlsLevel(-1);
            }
            tryResume();
            void tryPlay();
          });
          hls.on(Hls.Events.ERROR, (_event, details) => {
            if (details.fatal) reportError(`Playback error: ${details.details || details.type}`);
          });
          return;
        }

        if (video.canPlayType("application/vnd.apple.mpegurl")) {
          video.src = file;
          video.load();
          return;
        }

        throw new Error("HLS is not supported in this browser");
      } catch (e) {
        if (!abort.signal.aborted) reportError(e instanceof Error ? e.message : String(e));
      }
    };

    void load();

    return () => {
      cancelled = true;
      abort.abort();
      video.removeEventListener("loadedmetadata", handleLoadedMetadata);
      video.removeEventListener("timeupdate", handleTimeUpdate);
      video.removeEventListener("ended", notifyEnded);
      video.removeEventListener("play", handlePlay);
      video.removeEventListener("pause", handlePause);
      video.removeEventListener("volumechange", handleVolumeChange);
      hls?.destroy();
      hlsRef.current = null;
      clearTracks(video);
    };
  }, [autoPlay, category, onEnded, onError, onProgress, onReady, sourceId]);

  useEffect(() => {
    if (!playing || captionPanelOpen || qualityPanelOpen) {
      setControlsVisible(true);
      return;
    }
    const timer = window.setTimeout(() => setControlsVisible(false), 2600);
    return () => window.clearTimeout(timer);
  }, [captionPanelOpen, qualityPanelOpen, controlsVisible, playing]);

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      void video.play().then(() => setAutoplayBlocked(false));
    } else {
      video.pause();
    }
  };

  const seekToPercent = (percent: number) => {
    const video = videoRef.current;
    if (!video || !durationSeconds) return;
    const next = Math.max(0, Math.min(durationSeconds, (percent / 100) * durationSeconds));
    video.currentTime = next;
    setCurrentTime(next);
  };

  const toggleMute = () => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
  };

  const setPlayerVolume = (nextVolume: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.volume = Math.max(0, Math.min(1, nextVolume));
    video.muted = nextVolume === 0;
  };

  const requestFullscreen = () => {
    const el = videoRef.current?.parentElement;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void el.requestFullscreen?.().catch(() => {});
  };

  const updateCaptionPrefs = (patch: Partial<CaptionPrefs>) => {
    setCaptionPrefs((prev) => saveCaptionPrefs({ ...prev, ...patch }));
  };

  useImperativeHandle(ref, () => ({
    seekBy: (delta: number) => {
      const video = videoRef.current;
      if (!video) return;
      video.currentTime = Math.max(0, Math.min(video.duration || 0, video.currentTime + delta));
    },
  }));

  const progressPercent = durationSeconds ? Math.min(100, Math.max(0, (currentTime / durationSeconds) * 100)) : 0;

  const currentQualityLabel =
    hlsLevel === -1 ? "Auto" : (hlsLevels.find((l) => l.index === hlsLevel)?.label ?? "Quality");

  return (
    <div
      className="group relative h-full w-full overflow-hidden bg-black"
      onMouseMove={() => setControlsVisible(true)}
      onMouseLeave={() => playing && !captionPanelOpen && !qualityPanelOpen && setControlsVisible(false)}
    >
      <style>{`
        .ov-native-video::cue {
          font-size: ${captionPrefs.size}%;
          color: ${captionPrefs.text};
          background-color: ${cueBackground};
          text-shadow: ${cueShadow};
          line-height: 1.35;
        }
      `}</style>
      <video
        ref={videoRef}
        className="ov-native-video h-full w-full bg-black object-contain"
        playsInline
        crossOrigin="anonymous"
      />

      {/* Loading overlay with nekos gif */}
      {loading && !error ? (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/60">
          {loadingGif ? (
            <img
              src={loadingGif}
              alt="loading"
              className="h-20 w-20 rounded-full object-cover ring-2 ring-white/10"
            />
          ) : (
            <div className="h-20 w-20 animate-pulse rounded-full bg-white/10" />
          )}
          <p className="font-mono text-xs text-white/55">Loading stream…</p>
        </div>
      ) : null}

      {autoplayBlocked && !error ? (
        <button
          type="button"
          onClick={togglePlay}
          className="absolute inset-0 flex items-center justify-center bg-black/20 font-mono text-xs font-semibold text-white"
        >
          <span className="rounded-full border border-white/15 bg-black/65 px-4 py-2 backdrop-blur-sm">Play</span>
        </button>
      ) : null}
      {error ? (
        <div className="absolute inset-0 flex items-center justify-center bg-black p-4 text-center font-mono text-sm text-red-200">
          {error}
        </div>
      ) : null}
      {captionsEnabled && activeCaption ? (
        <div className={`pointer-events-none absolute inset-x-4 flex justify-center text-center transition-[bottom] duration-150 ${controlsVisible || !playing ? "bottom-14" : "bottom-5"}`}>
          <span
            className="max-w-[92%] whitespace-pre-line rounded px-2 py-1 font-semibold leading-snug"
            style={{
              color: captionPrefs.text,
              backgroundColor: cueBackground,
              textShadow: cueShadow,
              fontSize: `${captionPrefs.size}%`,
            }}
          >
            {activeCaption}
          </span>
        </div>
      ) : null}

      {/* Quality panel */}
      {qualityPanelOpen && (
        <div className="absolute bottom-12 right-2 w-[min(88vw,200px)] rounded-lg border border-white/10 bg-black/90 p-2 text-white shadow-xl backdrop-blur-md">
          <p className="mb-1.5 px-1 font-mono text-[9px] font-bold uppercase tracking-widest text-white/50">Quality</p>
          <button
            type="button"
            onClick={() => selectLevel(-1)}
            className={`w-full rounded-md px-3 py-1.5 text-left font-mono text-[11px] font-semibold transition-colors ${hlsLevel === -1 ? "bg-[#e8621a]/20 text-[#e8621a]" : "text-white/70 hover:bg-white/10 hover:text-white"}`}
          >
            Auto (ABR)
          </button>
          {[...hlsLevels].reverse().map((lvl) => (
            <button
              key={lvl.index}
              type="button"
              onClick={() => selectLevel(lvl.index)}
              className={`w-full rounded-md px-3 py-1.5 text-left font-mono text-[11px] font-semibold transition-colors ${hlsLevel === lvl.index ? "bg-[#e8621a]/20 text-[#e8621a]" : "text-white/70 hover:bg-white/10 hover:text-white"}`}
            >
              {lvl.label}
            </button>
          ))}
        </div>
      )}

      {/* Caption settings panel */}
      {captionPanelOpen && (
        <div className="absolute bottom-12 right-2 w-[min(88vw,260px)] rounded-lg border border-white/10 bg-black/82 p-3 text-white shadow-xl shadow-black/40 backdrop-blur-md">
          <div className="mb-2 flex items-center justify-between">
            <p className="font-mono text-[10px] font-bold uppercase tracking-widest text-white/60">Captions</p>
            <button type="button" onClick={() => setCaptionPanelOpen(false)} className="font-mono text-[10px] text-white/45 hover:text-white">Close</button>
          </div>
          <label className="block font-mono text-[10px] text-white/60">
            Language
            <select
              value={selectedCaptionKey}
              onChange={(e) => selectCaption(e.currentTarget.value)}
              className="mb-3 mt-1 w-full rounded-md border border-white/10 bg-black/70 px-2 py-1.5 text-white"
            >
              {captionOptions.length ? (
                captionOptions.map((option) => (
                  <option key={option.key} value={option.key}>{option.label}</option>
                ))
              ) : (
                <option value="">Auto</option>
              )}
            </select>
          </label>
          <label className="block font-mono text-[10px] text-white/60">
            Size: {captionPrefs.size}%
            <input
              type="range"
              min={80}
              max={180}
              step={5}
              value={captionPrefs.size}
              onChange={(e) => updateCaptionPrefs({ size: Number(e.currentTarget.value) })}
              className="mt-1 h-1 w-full accent-[#e8621a]"
            />
          </label>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <label className="font-mono text-[10px] text-white/60">
              Text
              <select
                value={captionPrefs.text}
                onChange={(e) => updateCaptionPrefs({ text: e.currentTarget.value })}
                className="mt-1 w-full rounded-md border border-white/10 bg-black/70 px-2 py-1.5 text-white"
              >
                <option value="#ffffff">White</option>
                <option value="#ffe66d">Yellow</option>
                <option value="#9ee7ff">Cyan</option>
                <option value="#ffb0d2">Pink</option>
              </select>
            </label>
            <label className="font-mono text-[10px] text-white/60">
              Backdrop
              <select
                value={captionPrefs.background}
                onChange={(e) => updateCaptionPrefs({ background: e.currentTarget.value as CaptionPrefs["background"] })}
                className="mt-1 w-full rounded-md border border-white/10 bg-black/70 px-2 py-1.5 text-white"
              >
                <option value="none">None</option>
                <option value="soft">Soft</option>
                <option value="solid">Solid</option>
              </select>
            </label>
          </div>
          <button
            type="button"
            onClick={() => updateCaptionPrefs({ shadow: !captionPrefs.shadow })}
            className={`mt-3 w-full rounded-md border px-2 py-1.5 font-mono text-[10px] font-semibold ${
              captionPrefs.shadow ? "border-[#e8621a]/50 bg-[#e8621a]/15 text-[#e8621a]" : "border-white/10 bg-white/5 text-white/65"
            }`}
          >
            Shadow {captionPrefs.shadow ? "on" : "off"}
          </button>
        </div>
      )}

      {/* Controls bar */}
      <div
        className={`absolute inset-x-0 bottom-0 px-2 pb-2 transition-opacity duration-150 ${
          controlsVisible || !playing ? "opacity-100" : "opacity-0"
        }`}
      >
        <input
          type="range"
          min={0}
          max={100}
          value={progressPercent}
          onChange={(e) => seekToPercent(Number(e.currentTarget.value))}
          className="mb-1 h-1 w-full cursor-pointer accent-[#e8621a]"
          aria-label="Seek"
        />
        <div className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-black/62 px-2 py-1.5 shadow-lg shadow-black/25 backdrop-blur-sm">
          <button
            type="button"
            onClick={togglePlay}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-white/90 hover:bg-white/10"
            aria-label={playing ? "Pause" : "Play"}
          >
            {playing ? <Pause className="h-4 w-4 fill-current" /> : <Play className="h-4 w-4 fill-current" />}
          </button>
          <span className="w-20 shrink-0 font-mono text-[10px] text-white/65">
            {formatTime(currentTime)} / {formatTime(durationSeconds)}
          </span>
          <button
            type="button"
            onClick={toggleMute}
            className="hidden h-7 w-7 items-center justify-center rounded-md text-white/65 hover:bg-white/10 hover:text-white sm:flex"
            aria-label={muted ? "Unmute" : "Mute"}
          >
            {muted || volume === 0 ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
          </button>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={muted ? 0 : volume}
            onChange={(e) => setPlayerVolume(Number(e.currentTarget.value))}
            className="hidden h-1 w-16 accent-white sm:block"
            aria-label="Volume"
          />
          <div className="min-w-0 flex-1" />

          {/* Quality selector button */}
          {hlsLevels.length > 0 && (
            <button
              type="button"
              onClick={() => { setQualityPanelOpen((v) => !v); setCaptionPanelOpen(false); }}
              className={`flex h-7 items-center gap-1 rounded-md px-2 font-mono text-[10px] font-semibold ${
                qualityPanelOpen ? "bg-white/15 text-white" : "text-white/55 hover:bg-white/10 hover:text-white"
              }`}
            >
              <Gauge className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">{currentQualityLabel}</span>
            </button>
          )}

          {/* CC toggle */}
          <button
            type="button"
            onClick={() => setCaptionsEnabled((v) => !v)}
            className={`flex h-7 items-center gap-1 rounded-md px-2 font-mono text-[10px] font-semibold ${
              captionsEnabled ? "bg-white/15 text-white" : "text-white/55 hover:bg-white/10 hover:text-white"
            }`}
          >
            <Captions className="h-3.5 w-3.5" /> CC
          </button>

          {/* Caption style button */}
          <button
            type="button"
            onClick={() => { setCaptionPanelOpen((v) => !v); setQualityPanelOpen(false); }}
            className="flex h-7 items-center gap-1 rounded-md px-2 font-mono text-[10px] font-semibold text-white/60 hover:bg-white/10 hover:text-white"
          >
            <Settings2 className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Style</span>
          </button>

          {/* Browser fullscreen */}
          <button
            type="button"
            onClick={requestFullscreen}
            className="flex h-7 w-7 items-center justify-center rounded-md text-white/65 hover:bg-white/10 hover:text-white"
            aria-label="Fullscreen"
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
});

export default NativeHlsPlayer;
