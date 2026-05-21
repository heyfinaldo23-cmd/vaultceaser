import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const OUT_FILE = path.join(process.cwd(), "src", "data", "static-catalog.json");
const JIKAN_BASE = "https://api.jikan.moe/v4";
const TITLE_INDEX_URL = "https://animeapi.my.id/animeApi.json";

const HOT_IDS = [
  40748, 51009, 48561, 57658, 21, 11061, 38000, 16498, 31964, 1535,
  5114, 20583, 41467, 52991, 37510, 34572, 20, 1735, 11757, 30276,
];
const HOT_QUERIES = [
  "jujutsu kaisen",
  "one piece",
  "demon slayer",
  "attack on titan",
  "my hero academia",
  "naruto",
  "bleach",
  "chainsaw man",
  "solo leveling",
  "death note",
];

const RELATION_MAP = {
  Sequel: "SEQUEL",
  Prequel: "PREQUEL",
  "Alternative version": "ALTERNATIVE",
  "Side story": "SIDE_STORY",
  "Parent story": "PARENT",
  Summary: "SUMMARY",
  SpinOff: "SPIN_OFF",
  "Spin-off": "SPIN_OFF",
  Other: "OTHER",
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchJson(url, attempts = 3) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent": "VaultCeaserStaticCatalog/1.0",
          Accept: "application/json",
        },
      });
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get("retry-after") || 0);
        await sleep(Math.max(1200, Math.min(5000, retryAfter * 1000 || 1200 + attempt * 800)));
        continue;
      }
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return res.json();
    } catch (error) {
      lastError = error;
      await sleep(900 + attempt * 800);
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError;
}

async function jikan(pathname, params = {}) {
  const url = new URL(`${JIKAN_BASE}${pathname}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  await sleep(1100);
  return fetchJson(url);
}

function imageFrom(images = {}) {
  return (
    images.webp?.large_image_url ||
    images.jpg?.large_image_url ||
    images.webp?.image_url ||
    images.jpg?.image_url ||
    ""
  );
}

function jikanToMedia(item) {
  const image = imageFrom(item.images || {});
  const genres = [
    ...(item.genres || []),
    ...(item.themes || []),
    ...(item.demographics || []),
  ].map((entry) => entry.name).filter(Boolean);
  return {
    id: item.mal_id,
    mal_id: item.mal_id,
    title: {
      english: item.title_english || item.title || "",
      romaji: item.title || item.title_english || "",
      native: item.title_japanese || null,
    },
    coverImage: image ? { large: image, extraLarge: image } : {},
    bannerImage: image,
    description: item.synopsis || "",
    status: item.status || "",
    format: item.type || "",
    episodes: item.episodes ?? null,
    duration: item.duration || "",
    score: item.score ?? null,
    year: item.year ?? null,
    season: item.season || null,
    genres,
    studios: (item.studios || []).map((studio) => studio.name).filter(Boolean),
    source: item.source || "",
    rating: item.rating || "",
    rank: item.rank ?? null,
    popularity: item.popularity ?? null,
    trailer: item.trailer?.embed_url || "",
    airing: Boolean(item.airing),
    aired: item.aired?.string || "",
    broadcast: item.broadcast?.string || "",
    synonyms: (item.titles || []).map((title) => title.title).filter(Boolean),
    isAdult: /hentai/i.test(item.rating || ""),
  };
}

function basicToMedia(item) {
  const title = String(item.title || "").trim();
  const id = Number(item.myanimelist || item.mal || item.mal_id);
  if (!title || !Number.isFinite(id) || id <= 0) return null;
  return {
    id,
    mal_id: id,
    title: { english: title, romaji: title, native: null },
    coverImage: {},
    bannerImage: "",
    description: "",
    status: "",
    format: "",
    episodes: null,
    duration: "",
    score: null,
    year: null,
    season: null,
    genres: [],
    studios: [],
    source: "",
    rating: "",
    rank: null,
    popularity: null,
    trailer: "",
    airing: false,
    aired: "",
    broadcast: "",
    synonyms: [],
    isAdult: false,
  };
}

function mergeMedia(map, media, detailed = false) {
  if (!media?.id) return;
  const existing = map.get(media.id);
  if (!existing || detailed || !existing.coverImage?.large) {
    map.set(media.id, { ...existing, ...media, staticDetailed: Boolean(detailed || existing?.staticDetailed) });
  }
}

async function main() {
  const media = new Map();
  const sections = {
    trending: [],
    popular: [],
    upcoming: [],
    recent: [],
    fresh: [],
    recentlyCompleted: [],
  };

  try {
    const titlePayload = await fetchJson(TITLE_INDEX_URL);
    const titleItems = Array.isArray(titlePayload) ? titlePayload : Object.values(titlePayload || {});
    for (const item of titleItems) {
      const basic = basicToMedia(item);
      if (basic) mergeMedia(media, basic, false);
    }
    console.log(`Loaded ${media.size} title-index items`);
  } catch (error) {
    console.warn(`Title index failed: ${error?.message || error}`);
  }

  async function fetchList(section, pathname, params) {
    const payload = await jikan(pathname, params);
    const items = payload.data || [];
    sections[section] = items.map((item) => item.mal_id).filter(Boolean);
    for (const item of items) mergeMedia(media, jikanToMedia(item), true);
  }

  await fetchList("trending", "/top/anime", { type: "tv", filter: "airing", page: 1, limit: 24 });
  await fetchList("popular", "/top/anime", { type: "tv", filter: "bypopularity", page: 1, limit: 36 });
  await fetchList("upcoming", "/top/anime", { type: "tv", filter: "upcoming", page: 1, limit: 24 });
  await fetchList("recent", "/seasons/now", { page: 1, limit: 24 });
  await fetchList("fresh", "/top/anime", { type: "tv", filter: "airing", page: 1, limit: 36 });
  await fetchList("recentlyCompleted", "/anime", {
    q: "",
    status: "complete",
    order_by: "end_date",
    sort: "desc",
    page: 1,
    limit: 24,
  });

  for (const query of HOT_QUERIES) {
    const payload = await jikan("/anime", { q: query, page: 1, limit: 8 });
    for (const item of payload.data || []) mergeMedia(media, jikanToMedia(item), true);
  }

  for (const id of HOT_IDS) {
    try {
      const payload = await jikan(`/anime/${id}`);
      if (payload.data) mergeMedia(media, jikanToMedia(payload.data), true);
    } catch (error) {
      console.warn(`Detail ${id} failed: ${error?.message || error}`);
    }
  }

  const relationSeeds = [...new Set([
    ...HOT_IDS,
    ...sections.trending.slice(0, 12),
    ...sections.popular.slice(0, 12),
    ...sections.recent.slice(0, 12),
    ...[...media.values()]
      .filter((item) => item.staticDetailed)
      .map((item) => item.id),
  ])];
  const relationRows = new Map();
  const relatedIds = new Set();

  for (const id of relationSeeds) {
    try {
      console.log(`Relations ${id}`);
      const payload = await jikan(`/anime/${id}/relations`);
      const edges = [];
      for (const rel of payload.data || []) {
        const relationType = RELATION_MAP[rel.relation] || String(rel.relation || "").toUpperCase().replace(/[^A-Z0-9]+/g, "_");
        for (const entry of rel.entry || []) {
          if (entry.type !== "anime" || !entry.mal_id) continue;
          const relatedId = Number(entry.mal_id);
          edges.push({ relationType, id: relatedId });
          relatedIds.add(relatedId);
          if (!media.has(relatedId)) {
            mergeMedia(media, {
              id: relatedId,
              mal_id: relatedId,
              title: { english: entry.name || "", romaji: entry.name || "", native: null },
              coverImage: {},
              bannerImage: "",
              genres: [],
              studios: [],
              episodes: null,
              isAdult: false,
            }, false);
          }
        }
      }
      relationRows.set(id, edges);
    } catch (error) {
      console.warn(`Relations ${id} failed: ${error?.message || error}`);
    }
  }

  for (const id of relatedIds) {
    const existing = media.get(id);
    if (existing?.staticDetailed) continue;
    try {
      console.log(`Related detail ${id}`);
      const payload = await jikan(`/anime/${id}`);
      if (payload.data) mergeMedia(media, jikanToMedia(payload.data), true);
    } catch (error) {
      console.warn(`Related detail ${id} failed: ${error?.message || error}`);
    }
  }

  for (const [id, edges] of relationRows) {
    const item = media.get(id);
    if (!item) continue;
    item.relations = {
      edges: edges
        .map((edge) => {
          const node = media.get(edge.id);
          if (!node) return null;
          const safeNode = { ...node };
          delete safeNode.relations;
          return { relationType: edge.relationType, node: safeNode };
        })
        .filter(Boolean),
    };
  }

  const genres = [...new Set([...media.values()].flatMap((item) => item.genres || []))]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));

  const output = {
    generatedAt: new Date().toISOString(),
    media: [...media.values()].sort((a, b) => a.id - b.id),
    sections,
    genres,
  };

  await mkdir(path.dirname(OUT_FILE), { recursive: true });
  await writeFile(OUT_FILE, `${JSON.stringify(output)}\n`);
  console.log(`Wrote ${output.media.length} media entries to ${OUT_FILE}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
