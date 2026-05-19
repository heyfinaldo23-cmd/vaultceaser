"use client";

import { useMemo, useState } from "react";
import { Pause, Play, Volume2, VolumeX } from "lucide-react";
import { cn } from "@/lib/utils";
import { youtubeTrailerEmbed } from "@/lib/anime-trailer";

type Props = {
  youtubeId: string | null;
  poster: string;
  title: string;
  className?: string;
};

export default function AnimeTrailerBackdrop({ youtubeId, poster, title, className }: Props) {
  const [paused, setPaused] = useState(false);
  const [muted, setMuted] = useState(true);

  const embedSrc = useMemo(() => {
    if (!youtubeId || paused) return null;
    return youtubeTrailerEmbed(youtubeId, { muted, autoplay: true });
  }, [youtubeId, paused, muted]);

  return (
    <div className={cn("absolute inset-0 overflow-hidden", className)}>
      {poster ? (
        <img
          src={poster}
          alt=""
          className={cn(
            "absolute inset-0 h-full w-full object-cover transition-opacity duration-500",
            embedSrc ? "opacity-40" : "opacity-100"
          )}
        />
      ) : (
        <div className="absolute inset-0 bg-[#12141a]" />
      )}

      {embedSrc ? (
        <iframe
          key={`${youtubeId}-${muted ? "m" : "u"}`}
          src={embedSrc}
          title={`${title} trailer`}
          className="pointer-events-none absolute left-1/2 top-1/2 h-[120%] w-[177%] max-w-none -translate-x-1/2 -translate-y-1/2 border-0"
          allow="autoplay; encrypted-media; picture-in-picture"
          referrerPolicy="origin"
        />
      ) : null}

      <div className="absolute inset-0 bg-gradient-to-t from-[#0a0b0d] via-[#0a0b0d]/55 to-[#0a0b0d]/30" />
      <div className="absolute inset-0 bg-gradient-to-r from-[#0a0b0d]/90 via-[#0a0b0d]/40 to-transparent" />

      {youtubeId ? (
        <div className="absolute bottom-6 right-6 z-20 flex items-center gap-2">
          <button
            type="button"
            onClick={() => setPaused((p) => !p)}
            className="flex h-10 w-10 items-center justify-center rounded-full border border-white/20 bg-black/50 text-white backdrop-blur-md transition-colors hover:border-[var(--accent)] hover:bg-black/70"
            aria-label={paused ? "Play trailer" : "Pause trailer"}
          >
            {paused ? <Play className="h-4 w-4 fill-current" /> : <Pause className="h-4 w-4" />}
          </button>
          <button
            type="button"
            onClick={() => setMuted((m) => !m)}
            className="flex h-10 w-10 items-center justify-center rounded-full border border-white/20 bg-black/50 text-white backdrop-blur-md transition-colors hover:border-[var(--accent)] hover:bg-black/70"
            aria-label={muted ? "Unmute trailer" : "Mute trailer"}
          >
            {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
          </button>
        </div>
      ) : null}
    </div>
  );
}