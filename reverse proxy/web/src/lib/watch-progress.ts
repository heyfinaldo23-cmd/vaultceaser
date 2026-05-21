export type WatchCategory = "sub" | "dub" | "ssub";

export type LocalWatchProgress = {
  animeId: number;
  episodeNumber: number;
  episodeId: string;
  category: WatchCategory;
  title?: string | null;
  animeTitle?: string | null;
  poster?: string | null;
  positionSeconds: number;
  durationSeconds?: number | null;
  watchedSeconds: number;
  qualified: boolean;
  updatedAt: string;
};

export type LocalWatchProgressInput = Omit<
  LocalWatchProgress,
  "positionSeconds" | "durationSeconds" | "watchedSeconds" | "qualified" | "updatedAt"
> & {
  positionSeconds?: number | null;
  durationSeconds?: number | null;
  watchedSeconds?: number | null;
};

const KEY = "ov-watch-progress-v1";
const MAX_ITEMS = 150;
const MIN_WATCHED_SECONDS = 20;

function normalizeCategory(category: string | null | undefined): WatchCategory {
  if (category === "dub") return "dub";
  if (category === "ssub") return "ssub";
  return "sub";
}

function clampSeconds(value: number | null | undefined): number {
  if (!Number.isFinite(value ?? NaN)) return 0;
  return Math.max(0, Math.floor(value as number));
}

function storageAvailable() {
  return typeof window !== "undefined" && typeof localStorage !== "undefined";
}

function keyFor(item: Pick<LocalWatchProgress, "animeId" | "episodeNumber" | "category">) {
  return `${item.animeId}:${item.category}:${item.episodeNumber}`;
}

function readAll(): LocalWatchProgress[] {
  if (!storageAvailable()) return [];
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { items?: LocalWatchProgress[] } | LocalWatchProgress[];
    const items = Array.isArray(parsed) ? parsed : parsed.items;
    if (!Array.isArray(items)) return [];
    return items
      .filter((item) => item && Number.isFinite(item.animeId) && Number.isFinite(item.episodeNumber))
      .map((item) => ({
        ...item,
        category: normalizeCategory(item.category),
        positionSeconds: clampSeconds(item.positionSeconds),
        durationSeconds: item.durationSeconds == null ? null : clampSeconds(item.durationSeconds),
        watchedSeconds: clampSeconds(item.watchedSeconds),
        qualified: Boolean(item.qualified),
      }));
  } catch {
    return [];
  }
}

function writeAll(items: LocalWatchProgress[]) {
  if (!storageAvailable()) return;
  localStorage.setItem(
    KEY,
    JSON.stringify({
      version: 1,
      items: items
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
        .slice(0, MAX_ITEMS),
    })
  );
}

export function qualifiesForContinue(input: {
  positionSeconds?: number | null;
  durationSeconds?: number | null;
  watchedSeconds?: number | null;
}) {
  const watched = clampSeconds(input.watchedSeconds);
  const duration = clampSeconds(input.durationSeconds);
  const required =
    duration > 0
      ? Math.min(MIN_WATCHED_SECONDS, Math.max(5, Math.floor(duration * 0.03)))
      : MIN_WATCHED_SECONDS;
  return watched >= required;
}

export function upsertLocalWatchProgress(input: LocalWatchProgressInput) {
  const items = readAll();
  const next: LocalWatchProgress = {
    ...input,
    category: normalizeCategory(input.category),
    title: input.title ?? null,
    animeTitle: input.animeTitle ?? null,
    poster: input.poster ?? null,
    positionSeconds: clampSeconds(input.positionSeconds),
    durationSeconds: input.durationSeconds == null ? null : clampSeconds(input.durationSeconds),
    watchedSeconds: clampSeconds(input.watchedSeconds),
    qualified: qualifiesForContinue(input),
    updatedAt: new Date().toISOString(),
  };
  const nextKey = keyFor(next);
  const merged = [next, ...items.filter((item) => keyFor(item) !== nextKey)];
  writeAll(merged);
  return next;
}

export function getLocalWatchProgress(
  animeId: number,
  episodeNumber: number,
  category?: string | null
) {
  const cat = normalizeCategory(category);
  return readAll().find(
    (item) =>
      item.animeId === animeId &&
      item.episodeNumber === episodeNumber &&
      item.category === cat
  );
}

export function getLatestLocalWatchForAnime(animeId: number) {
  return readAll()
    .filter((item) => item.animeId === animeId)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
}

export function listLocalWatchProgressForAnime(animeId: number) {
  return readAll()
    .filter((item) => item.animeId === animeId)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

export function listQualifiedLocalWatchProgress(limit = 12) {
  const seen = new Set<number>();
  const out: LocalWatchProgress[] = [];
  for (const item of readAll().sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))) {
    if (!item.qualified || seen.has(item.animeId)) continue;
    seen.add(item.animeId);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}
