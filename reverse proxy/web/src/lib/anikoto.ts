/**
 * Client-side HTML parsers for Anikoto content.
 * All parsing runs in the browser via DOMParser.
 * Never exposes the Anikoto domain to callers — they just use /api/meta-proxy.
 */

export interface AkSearchResult {
  title: string;
  native: string;
  slug: string;
  poster: string;
  type: string;
  year: string;
  score: string;
}

export interface AkEpisodeEntry {
  num: number;
  title: string;
  anikotoEpId: number;
  hasSub: boolean;
  hasDub: boolean;
}

export interface AkEpisodeData {
  /** MAL ID extracted from data-mal on episode anchors */
  malId: number | null;
  subCount: number;
  dubCount: number;
  episodes: AkEpisodeEntry[];
}

export interface AkWatchInfo {
  anikotoId: number;
  title: string;
  description: string;
  genres: string[];
  type: string;
  score: number;
  episodeCount: number | null;
  status: string;
  hasDub: boolean;
  hasSub: boolean;
}

export interface AkHomeItem {
  title: string;
  native: string;
  slug: string;
  poster: string;
  anikotoId: number | null;
  subCount: number;
  dubCount: number;
  totalCount: number | null;
  type: string;
  href: string;
}

// ─── helpers ────────────────────────────────────────────────────────────────

function parseDoc(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

function slugFromUrl(href: string): string {
  const m = href.match(/\/watch\/([^/?#]+)/);
  return m ? m[1] : "";
}

function textOf(el: Element | null): string {
  return el?.textContent?.trim() ?? "";
}

function intAttr(el: Element | null, attr: string): number {
  return parseInt((el as HTMLElement | null)?.dataset?.[attr] ?? "0", 10) || 0;
}

// ─── search ──────────────────────────────────────────────────────────────────

/**
 * Parses /ajax/anime/search response.
 * Input: the JSON string returned by Anikoto — OR just the inner HTML string.
 */
export function parseSearchJson(raw: string): AkSearchResult[] {
  let html = raw;
  try {
    const obj = JSON.parse(raw) as {
      status?: number;
      result?: { html?: string } | string;
    };
    const r = obj.result;
    html = typeof r === "string" ? r : (r?.html ?? raw);
  } catch {
    // already HTML
  }
  return parseSearchHtml(html);
}

export function parseSearchHtml(html: string): AkSearchResult[] {
  const doc = parseDoc(html);
  return Array.from(doc.querySelectorAll("a.item")).map((a) => {
    const href = a.getAttribute("href") ?? "";
    const slug = slugFromUrl(href);
    const title = textOf(a.querySelector(".name, .d-title"));
    const native = (a.querySelector(".name, .d-title") as HTMLElement | null)?.dataset?.jp ?? "";
    const poster = a.querySelector("img")?.getAttribute("src") ?? "";
    const dots = Array.from(a.querySelectorAll(".meta .dot"));
    // dot[0]=rating, dot[1]=score, dot[2]=type, dot[3]=year  (search popup layout)
    const score = textOf(dots[1]).replace(/[^\d.]/g, "");
    const type = textOf(dots[2]);
    const year = textOf(dots[3]);
    return { title, native, slug, poster, type, year, score };
  });
}

// ─── episode list ─────────────────────────────────────────────────────────────

/**
 * Parses /ajax/episode/list/{anikotoId} response.
 * Input: the JSON string returned by Anikoto — OR just the inner HTML string.
 */
export function parseEpisodeListJson(raw: string): AkEpisodeData {
  let html = raw;
  try {
    const obj = JSON.parse(raw) as { status?: number; result?: string | { html?: string } };
    const r = obj.result;
    html = typeof r === "string" ? r : (r?.html ?? raw);
  } catch {
    // already HTML
  }
  return parseEpisodeListHtml(html);
}

export function parseEpisodeListHtml(html: string): AkEpisodeData {
  const doc = parseDoc(html);
  const anchors = Array.from(doc.querySelectorAll("a[data-num]")) as HTMLElement[];

  let malId: number | null = null;
  const episodes: AkEpisodeEntry[] = anchors.map((el) => {
    const num = parseInt(el.dataset.num ?? "0", 10);
    const anikotoEpId = parseInt(el.dataset.id ?? "0", 10);
    const hasSub = el.dataset.sub === "1";
    const hasDub = el.dataset.dub === "1";
    const title =
      el.closest("li")?.getAttribute("title") ??
      textOf(el.querySelector(".d-title")) ??
      "";
    const mal = parseInt(el.dataset.mal ?? "0", 10);
    if (mal && !malId) malId = mal;
    return { num, title, anikotoEpId, hasSub, hasDub };
  });

  const subCount = episodes.filter((e) => e.hasSub).length;
  const dubCount = episodes.filter((e) => e.hasDub).length;

  return { malId, subCount, dubCount, episodes };
}

// ─── watch page ───────────────────────────────────────────────────────────────

/**
 * Parses the full HTML of a /watch/{slug} page.
 */
export function parseWatchPage(html: string): AkWatchInfo | null {
  const doc = parseDoc(html);
  const main = doc.querySelector("#watch-main") as HTMLElement | null;
  if (!main) return null;

  const anikotoId = parseInt(main.dataset.id ?? "0", 10);
  if (!anikotoId) return null;

  // Title: strip "Anime … - Anikoto" wrapper
  const rawTitle = doc.title ?? "";
  const title = rawTitle
    .replace(/ - Anikoto.*$/i, "")
    .replace(/^Anime\s+/i, "")
    .trim();

  const description = textOf(doc.querySelector(".synopsis, .description"));

  const metaDivs = Array.from(doc.querySelectorAll(".bmeta .meta div"));
  const getMeta = (label: string) => {
    const div = metaDivs.find((d) => d.textContent?.includes(label));
    return textOf(div?.querySelector("span") ?? null);
  };

  const type = getMeta("Type:");
  const status = getMeta("Status:");
  const epsText = getMeta("Episodes:");
  const episodeCount = epsText && epsText !== "?" ? parseInt(epsText, 10) || null : null;

  const genres: string[] = Array.from(
    doc.querySelectorAll(".bmeta .meta span a[href*='/genre/']")
  )
    .map((a) => textOf(a))
    .filter(Boolean);

  const ratingEl = doc.querySelector("#w-rating") as HTMLElement | null;
  const score = parseFloat(ratingEl?.dataset?.score ?? "0") || 0;

  const hasDub = !!doc.querySelector(".meta.icons .dub, .ep-status.dub");
  const hasSub = !!doc.querySelector(".meta.icons .sub, .ep-status.sub");

  return { anikotoId, title, description, genres, type, score, episodeCount, status, hasDub, hasSub };
}

// ─── home page ────────────────────────────────────────────────────────────────

function parseHomeItems(section: Element | null): AkHomeItem[] {
  if (!section) return [];
  return Array.from(section.querySelectorAll(".item")).map((item) => {
    const posterEl = item.querySelector(".ani.poster, .poster[data-tip]") as HTMLElement | null;
    const anikotoId = posterEl ? parseInt(posterEl.dataset.tip ?? "0", 10) || null : null;

    // href: prefer the watch link on poster anchor, fall back to .name link
    const watchAnchor =
      posterEl?.querySelector("a[href*='/watch/']") ??
      item.querySelector("a[href*='/watch/']");
    const href = watchAnchor?.getAttribute("href") ?? "";
    const slug = slugFromUrl(href);

    const poster = item.querySelector("img")?.getAttribute("src") ?? "";

    const nameEl = item.querySelector("a.name, .name.d-title, a.d-title") as HTMLElement | null;
    const title = textOf(nameEl);
    const native = nameEl?.dataset?.jp ?? "";

    const subCount = parseInt(textOf(item.querySelector(".ep-status.sub span")), 10) || 0;
    const dubCount = parseInt(textOf(item.querySelector(".ep-status.dub span")), 10) || 0;
    const totalText = textOf(item.querySelector(".ep-status.total span"));
    const totalCount = totalText ? parseInt(totalText, 10) || null : null;

    const typeEl = item.querySelector(".meta .right, .meta .dot:last-child");
    const type = textOf(typeEl);

    return { title, native, slug, poster, anikotoId, subCount, dubCount, totalCount, type, href };
  });
}

function parseSpotlightItems(doc: Document): AkHomeItem[] {
  const slides = Array.from(doc.querySelectorAll(".swiper-slide.item, #slider .item"));
  return slides.map((slide) => {
    const a = slide.querySelector(".actions a[href*='/watch/']");
    const href = a?.getAttribute("href") ?? "";
    const slug = slugFromUrl(href);

    const titleEl = slide.querySelector(".title.d-title, h2.d-title") as HTMLElement | null;
    const title = textOf(titleEl);
    const native = titleEl?.dataset?.jp ?? "";

    const bgStyle = (slide.querySelector(".image div") as HTMLElement | null)?.style?.backgroundImage ?? "";
    const posterMatch = bgStyle.match(/url\(['"]?([^'"]+)['"]?\)/);
    const poster = posterMatch?.[1] ?? "";

    const hasDub = !!slide.querySelector(".dub.fa-microphone, i.dub");
    const hasSub = !!slide.querySelector(".sub.fa-closed-captioning, i.sub");

    return {
      title, native, slug, poster,
      anikotoId: null, // slider doesn't expose data-tip
      subCount: hasSub ? 1 : 0,
      dubCount: hasDub ? 1 : 0,
      totalCount: null,
      type: "",
      href,
    };
  });
}

export function parseHomeHtml(html: string): {
  spotlight: AkHomeItem[];
  recent: AkHomeItem[];
  trending: AkHomeItem[];
} {
  const doc = parseDoc(html);

  const spotlight = parseSpotlightItems(doc);

  // "Recently Added" section — Anikoto uses #recently-added or a generic grid
  const recentSection =
    doc.querySelector("#recently-added .body") ??
    doc.querySelector("section[data-name='recently-added'] .body") ??
    doc.querySelector(".ani-block");

  // "Trending" or top-anime section
  const trendingSection =
    doc.querySelector("#top-anime .tab-content[data-name='day']") ??
    doc.querySelector("#trending .body");

  return {
    spotlight,
    recent: parseHomeItems(recentSection),
    trending: parseHomeItems(trendingSection),
  };
}

// ─── score normalizer ─────────────────────────────────────────────────────────

/** Convert Anikoto's 10-point MAL score to AniList-style 100-point score */
export function akScoreTo100(score: number): number {
  return Math.round(score * 10);
}
