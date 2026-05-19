import type { AnimeMedia } from "@/lib/api";

/** YouTube embed URL for hero backdrop (autoplay, loop, no chrome). */
export function youtubeTrailerEmbed(
  trailerId: string,
  opts: { muted?: boolean; autoplay?: boolean } = {}
): string {
  const muted = opts.muted !== false ? 1 : 0;
  const autoplay = opts.autoplay !== false ? 1 : 0;
  const params = new URLSearchParams({
    autoplay: String(autoplay),
    mute: String(muted),
    controls: "0",
    modestbranding: "1",
    rel: "0",
    playsinline: "1",
    loop: "1",
    playlist: trailerId,
    enablejsapi: "1",
    origin: typeof window !== "undefined" ? window.location.origin : "",
  });
  return `https://www.youtube.com/embed/${trailerId}?${params}`;
}

export function resolveTrailer(anime: AnimeMedia): {
  youtubeId: string | null;
  thumbnail: string | null;
} {
  const t = anime.trailer;
  if (t?.id && (t.site === "youtube" || !t.site)) {
    return {
      youtubeId: t.id,
      thumbnail: t.thumbnail || null,
    };
  }
  return { youtubeId: null, thumbnail: null };
}

export function formatAnimeDate(
  d?: { year?: number; month?: number; day?: number } | null
): string | null {
  if (!d?.year) return null;
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  if (d.month && d.day) return `${months[d.month - 1]} ${d.day}, ${d.year}`;
  if (d.month) return `${months[d.month - 1]} ${d.year}`;
  return String(d.year);
}
