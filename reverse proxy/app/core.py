"""
VaultCeaser API core — Jikan/MAL metadata + Megaplay streaming.
All handler functions are imported by the route modules.
"""

import asyncio
from contextlib import asynccontextmanager
import hashlib
import json
import logging
import os
import re
import sqlite3
import sys
import threading
import time
import logging
from typing import Any, Dict, List, Optional, Tuple, Union
from urllib.parse import quote, unquote, urlparse, urljoin, urlencode
from pathlib import Path

try:
    import wreq as _wreq  # Chrome TLS fingerprint — only needed for anikoto: legacy episode IDs
    _WREQ_AVAILABLE = True
except ImportError:
    _wreq = None  # type: ignore
    _WREQ_AVAILABLE = False

try:
    import colorama

    colorama.just_fix_windows_console()
except Exception:
    pass

import structlog

structlog.configure(
    processors=[
        structlog.processors.add_log_level,
        structlog.processors.StackInfoRenderer(),
        structlog.dev.set_exc_info,
        structlog.processors.TimeStamper(fmt="%H:%M:%S"),
        structlog.dev.ConsoleRenderer(colors=True),
    ],
    wrapper_class=structlog.make_filtering_bound_logger(logging.INFO),
    context_class=dict,
    logger_factory=structlog.PrintLoggerFactory(file=sys.stdout),
    cache_logger_on_first_use=True,
)

log = structlog.get_logger("vaultceaser")

import httpx
import requests as sync_requests
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse, Response
from dotenv import load_dotenv
from .discord_webhook import discord_logger

load_dotenv()

# ─── config.json (streaming + global) ─────────────────────────────────────────
# Defaults follow ``bun.har`` (vidwish embed, watching.onl / cloudbuzz / livedns segments, miruro.tv pipe).
# Set env ``VAULTCEASER_CONFIG`` to a different JSON path to override location.

_DEFAULT_STREAM_CONFIG: Dict[str, Any] = {
    # bun.har shows vidwish.live as the embed origin that CDN Cloudflare accepts
    "stream_upstream_base": "https://vidwish.live",
    "anilist_url": "https://graphql.anilist.co",
    "cdn_host_suffixes": [
        # bun.har confirmed CDN hosts
        "watching.onl",
        "cloudbuzz.lol",
        "livedns.my",
        "ultracloud.cc",
        "jwpcdn.com",
        "vidwish.live",
        "megaplay.buzz",
        # research/01 index-playlist segment CDNs
        "cinewave2.site",
        "streamzone1.site",
        "mewstream.buzz",
        "orbitra.click",
        "sparqle.click",
        "glimmeron.click",
        # subtitles
        "lostproject.club",
    ],
    "embed_asset_hosts": ["vidwish.live", "megaplay.buzz"],
    # upstream: uses vidwish.live JWPlayer directly (correct player, bun.har behavior)
    # synthetic: hls.js player via /api/cdn-hls proxy (fallback if upstream fails)
    "embed_s2_mode": "upstream",
}


def _load_stream_config() -> Tuple[Dict[str, Any], str]:
    cfg: Dict[str, Any] = json.loads(json.dumps(_DEFAULT_STREAM_CONFIG))
    cfg_path = Path(os.environ.get("VAULTCEASER_CONFIG", Path(__file__).resolve().parent / "config.json"))
    resolved = str(cfg_path.resolve())
    if cfg_path.is_file():
        with cfg_path.open(encoding="utf-8") as f:
            merged = json.load(f)
        for k in _DEFAULT_STREAM_CONFIG:
            if k in merged and merged[k] is not None:
                cfg[k] = merged[k]
    return cfg, resolved


_STREAM_CFG, STREAM_CONFIG_PATH = _load_stream_config()
_DOCS_HTML_PATH = Path(__file__).resolve().parent / "docs.html"


def _embed_s2_mode() -> str:
    m = str(_STREAM_CFG.get("embed_s2_mode", "upstream")).lower().strip()
    return m if m in ("synthetic", "proxy", "upstream") else "upstream"


MEGAPLAY_BASE = str(_STREAM_CFG["stream_upstream_base"]).rstrip("/")
GET_SOURCES_ENDPOINT = f"{MEGAPLAY_BASE}/stream/getSources"
IFRAME_ENDPOINT = f"{MEGAPLAY_BASE}/stream/s-2"

# ─── Jikan (MAL) API ────────────────────────────────────────────────────────
JIKAN_BASE = "https://api.jikan.moe/v4"
# Rate limits: 3 req/s, 60 req/min — use a semaphore to stay safely under
_JIKAN_SEM = asyncio.Semaphore(2)  # max 2 concurrent Jikan requests
_JIKAN_LAST_CALL: float = 0.0
_JIKAN_MIN_INTERVAL = 0.35  # seconds between requests (~2.8/s)
_JIKAN_LOCK = asyncio.Lock()

# Simple TTL cache: key → (value, expires_at)
_jikan_cache: Dict[str, Tuple[Any, float]] = {}
_JIKAN_TTL_SHORT = 300.0    # 5 min — search results, episode lists
_JIKAN_TTL_LONG = 3600.0    # 1 hr — anime details, characters, relations


async def _jikan_get(path: str, params: Optional[dict] = None, ttl: float = _JIKAN_TTL_SHORT) -> Any:
    """Rate-limited, cached GET against Jikan v4."""
    import urllib.parse
    cache_key = path + ("?" + urllib.parse.urlencode(sorted((params or {}).items())) if params else "")
    now = time.monotonic()
    if cache_key in _jikan_cache:
        val, exp = _jikan_cache[cache_key]
        if now < exp:
            return val

    db_cache_key = f"jikan:{cache_key}"
    stale_data: Optional[Any] = None
    try:
        db_val, db_fresh = _provider_cache_get_json(db_cache_key, ttl)
        if db_val is not None:
            stale_data = db_val
            if db_fresh:
                _jikan_cache[cache_key] = (db_val, time.monotonic() + ttl)
                return db_val
    except Exception as exc:
        log.debug("jikan_disk_cache_read_failed", key=cache_key, error=str(exc)[:120])

    async with _JIKAN_LOCK:
        global _JIKAN_LAST_CALL
        elapsed = now - _JIKAN_LAST_CALL
        if elapsed < _JIKAN_MIN_INTERVAL:
            await asyncio.sleep(_JIKAN_MIN_INTERVAL - elapsed)
        _JIKAN_LAST_CALL = time.monotonic()

    async with _JIKAN_SEM:
        client = await session_manager.get_client()
        url = f"{JIKAN_BASE}{path}"
        try:
            r = await client.get(url, params=params or {}, headers={"User-Agent": USER_AGENT}, follow_redirects=True, timeout=12.0)
            if r.status_code == 429:
                await asyncio.sleep(1.0)
                r = await client.get(url, params=params or {}, headers={"User-Agent": USER_AGENT}, follow_redirects=True, timeout=12.0)
            r.raise_for_status()
            data = r.json()
        except Exception:
            if stale_data is not None:
                log.warning("jikan_using_stale_cache", key=cache_key)
                _jikan_cache[cache_key] = (stale_data, time.monotonic() + min(ttl, 60.0))
                return stale_data
            raise

    _jikan_cache[cache_key] = (data, time.monotonic() + ttl)
    try:
        _provider_cache_save_json(db_cache_key, data)
    except Exception as exc:
        log.debug("jikan_disk_cache_write_failed", key=cache_key, error=str(exc)[:120])
    return data


def _jikan_image(images: dict) -> Optional[str]:
    """Extract best available image URL from Jikan images dict."""
    webp = images.get("webp", {})
    jpg = images.get("jpg", {})
    return (webp.get("large_image_url") or jpg.get("large_image_url")
            or webp.get("image_url") or jpg.get("image_url"))


def _jikan_to_anime(item: dict) -> dict:
    """Normalise a Jikan anime object to our API shape."""
    genres = [g["name"] for g in (item.get("genres") or [])]
    themes = [t["name"] for t in (item.get("themes") or [])]
    return {
        "id": item.get("mal_id"),
        "mal_id": item.get("mal_id"),
        "title": {
            "english": item.get("title_english") or item.get("title"),
            "romaji": item.get("title"),
            "native": item.get("title_japanese"),
        },
        "coverImage": {"large": _jikan_image(item.get("images", {}))},
        "bannerImage": _jikan_image(item.get("images", {})),
        "description": item.get("synopsis"),
        "status": item.get("status"),
        "format": item.get("type"),
        "episodes": item.get("episodes"),
        "duration": item.get("duration"),
        "score": item.get("score"),
        "year": item.get("year"),
        "season": item.get("season"),
        "genres": genres + themes,
        "studios": [s["name"] for s in (item.get("studios") or [])],
        "source": item.get("source"),
        "rating": item.get("rating"),
        "rank": item.get("rank"),
        "popularity": item.get("popularity"),
        "trailer": item.get("trailer", {}).get("embed_url"),
        "airing": item.get("airing", False),
        "aired": item.get("aired", {}).get("string"),
        "broadcast": item.get("broadcast", {}).get("string"),
    }


def _dedupe_anime_results(items: List[dict]) -> List[dict]:
    """Keep first occurrence of each MAL ID; Jikan occasionally repeats entries."""
    seen: set[int] = set()
    out: List[dict] = []
    for item in items:
        mid = item.get("id") or item.get("mal_id")
        if not mid:
            continue
        if mid in seen:
            continue
        seen.add(mid)
        out.append(item)
    return out


async def _jikan_anime(mal_id: int) -> dict:
    data = await _jikan_get(f"/anime/{mal_id}", ttl=_JIKAN_TTL_LONG)
    return _jikan_to_anime(data["data"])


async def _jikan_episodes(mal_id: int) -> List[dict]:
    """Fetch all episodes for a MAL anime, handles pagination."""
    results = []
    page = 1
    while True:
        data = await _jikan_get(f"/anime/{mal_id}/episodes", {"page": page}, ttl=_JIKAN_TTL_SHORT)
        items = data.get("data") or []
        for ep in items:
            results.append({
                "id": f"mal:{mal_id}:{ep['mal_id']}",
                "number": ep["mal_id"],
                "title": ep.get("title"),
                "title_japanese": ep.get("title_japanese"),
                "aired": ep.get("aired"),
                "filler": ep.get("filler", False),
                "recap": ep.get("recap", False),
                "score": ep.get("score"),
                "thumbnail": None,
            })
        pagination = data.get("pagination", {})
        if not pagination.get("has_next_page"):
            break
        page += 1
        if page > 50:  # safety cap
            break
    return results


async def _jikan_characters(mal_id: int) -> List[dict]:
    data = await _jikan_get(f"/anime/{mal_id}/characters", ttl=_JIKAN_TTL_LONG)
    result = []
    for item in (data.get("data") or []):
        char = item.get("character", {})
        va_list = [
            {"name": v["person"]["name"], "language": v["language"]}
            for v in (item.get("voice_actors") or [])
        ]
        result.append({
            "id": char.get("mal_id"),
            "name": char.get("name"),
            "image": _jikan_image(char.get("images", {})),
            "role": item.get("role"),
            "voice_actors": va_list,
        })
    return result


async def _jikan_relations(mal_id: int) -> List[dict]:
    data = await _jikan_get(f"/anime/{mal_id}/relations", ttl=_JIKAN_TTL_LONG)
    result = []
    for item in (data.get("data") or []):
        for entry in (item.get("entry") or []):
            if entry.get("type") == "anime":
                result.append({
                    "relation": item.get("relation"),
                    "mal_id": entry.get("mal_id"),
                    "title": entry.get("name"),
                    "url": entry.get("url"),
                })
    return result


async def _jikan_recommendations(mal_id: int) -> List[dict]:
    data = await _jikan_get(f"/anime/{mal_id}/recommendations", ttl=_JIKAN_TTL_LONG)
    result = []
    for item in (data.get("data") or []):
        entry = item.get("entry", {})
        result.append({
            "mal_id": entry.get("mal_id"),
            "title": entry.get("title"),
            "image": _jikan_image(entry.get("images", {})),
            "votes": item.get("votes"),
        })
    return result


async def _jikan_search(q: str, page: int = 1, per_page: int = 20,
                        type_: Optional[str] = None, status: Optional[str] = None,
                        genres: Optional[str] = None, order_by: Optional[str] = None,
                        sort: Optional[str] = None, min_score: Optional[float] = None) -> dict:
    params: dict = {"q": q, "page": page, "limit": per_page}
    if type_:
        params["type"] = type_
    if status:
        params["status"] = status
    if genres:
        params["genres"] = genres
    if order_by:
        params["order_by"] = order_by
    if sort:
        params["sort"] = sort
    if min_score is not None:
        params["min_score"] = min_score
    data = await _jikan_get("/anime", params, ttl=_JIKAN_TTL_SHORT)
    pg = data.get("pagination", {})
    return {
        "results": _dedupe_anime_results([_jikan_to_anime(a) for a in (data.get("data") or [])]),
        "pageInfo": {
            "total": pg.get("items", {}).get("total", 0),
            "currentPage": pg.get("current_page", page),
            "hasNextPage": pg.get("has_next_page", False),
            "perPage": per_page,
        },
    }


async def _jikan_top(type_: str = "tv", filter_: Optional[str] = None,
                     page: int = 1, per_page: int = 20) -> dict:
    """Top anime from MAL — filter: airing, upcoming, bypopularity, favorite."""
    params: dict = {"type": type_, "page": page, "limit": per_page}
    if filter_:
        params["filter"] = filter_
    data = await _jikan_get("/top/anime", params, ttl=_JIKAN_TTL_SHORT)
    pg = data.get("pagination", {})
    return {
        "results": _dedupe_anime_results([_jikan_to_anime(a) for a in (data.get("data") or [])]),
        "pageInfo": {
            "total": pg.get("items", {}).get("total", 0),
            "currentPage": pg.get("current_page", page),
            "hasNextPage": pg.get("has_next_page", False),
        },
    }


async def _jikan_seasonal(year: Optional[int] = None, season: Optional[str] = None,
                           page: int = 1, per_page: int = 20) -> dict:
    """Current or specific seasonal anime."""
    if year and season:
        path = f"/seasons/{year}/{season.lower()}"
    else:
        path = "/seasons/now"
    params: dict = {"page": page, "limit": per_page}
    data = await _jikan_get(path, params, ttl=_JIKAN_TTL_SHORT)
    pg = data.get("pagination", {})
    return {
        "results": _dedupe_anime_results([_jikan_to_anime(a) for a in (data.get("data") or [])]),
        "pageInfo": {
            "total": pg.get("items", {}).get("total", 0),
            "currentPage": pg.get("current_page", page),
            "hasNextPage": pg.get("has_next_page", False),
        },
    }


async def _jikan_schedule(day: Optional[str] = None, page: int = 1, per_page: int = 25) -> dict:
    """Broadcast schedule, optionally filtered by day (monday–sunday)."""
    params: dict = {"page": page, "limit": per_page}
    if day:
        params["filter"] = day.lower()
    data = await _jikan_get("/schedules", params, ttl=_JIKAN_TTL_SHORT)
    pg = data.get("pagination", {})
    return {
        "results": _dedupe_anime_results([_jikan_to_anime(a) for a in (data.get("data") or [])]),
        "pageInfo": {
            "total": pg.get("items", {}).get("total", 0),
            "currentPage": pg.get("current_page", page),
            "hasNextPage": pg.get("has_next_page", False),
        },
    }


def _embed_asset_hosts() -> Tuple[str, ...]:
    """Hostnames embed HTML/CSS/JS may use as absolute roots (from ``config.json`` + primary upstream)."""
    raw = _STREAM_CFG.get("embed_asset_hosts")
    if not isinstance(raw, list):
        raw = []
    out: List[str] = []
    for h in raw:
        t = str(h).strip().lower()
        if t and t not in out:
            out.append(t)
    primary = (urlparse(MEGAPLAY_BASE).netloc or "").lower()
    if primary and primary not in out:
        out.insert(0, primary)
    return tuple(out)


_raw_suffixes = _STREAM_CFG.get("cdn_host_suffixes")
if not isinstance(_raw_suffixes, list) or not _raw_suffixes:
    _raw_suffixes = list(_DEFAULT_STREAM_CONFIG["cdn_host_suffixes"])
CDN_HOST_SUFFIXES = tuple(str(x).strip().lower() for x in _raw_suffixes if str(x).strip())

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/148.0.0.0 Safari/537.36"
)

# AniList genres matching AniList / browse sites
GENRES = [
    "Action", "Adventure", "Comedy", "Drama", "Ecchi", "Fantasy",
    "Horror", "Mahou Shoujo", "Mecha", "Music", "Mystery",
    "Psychological", "Romance", "Sci-Fi", "Slice of Life",
    "Sports", "Supernatural", "Thriller",
]

PROVIDERS = ["megaplay"]

# Available categories
CATEGORIES = ["sub", "dub", "ssub"]


def _normalize_stream_category(raw: Optional[str]) -> str:
    """sub | dub | ssub — unknown values fall back to sub (matches Megaplay embed paths)."""
    if not raw:
        return "sub"
    t = str(raw).strip().lower()
    return t if t in CATEGORIES else "sub"


def _cdn_url_path_is_m3u8(url: str) -> bool:
    """True if path ends with .m3u8 (query strings must not disable detection)."""
    try:
        p = (urlparse(url).path or "").lower()
    except Exception:
        return False
    return p.endswith(".m3u8")


def _cdn_host_allowed_url(url: str) -> bool:
    """Only proxy known stream/CDN hosts. Keeps /api/cdn-hls from becoming SSRF bait."""
    try:
        host = (urlparse(url).hostname or "").lower()
    except Exception:
        return False
    if not host:
        return False
    return any(host == suffix or host.endswith(f".{suffix}") for suffix in CDN_HOST_SUFFIXES)


def _cdn_upstream_fetch_headers() -> Dict[str, str]:
    return {
        "User-Agent": USER_AGENT,
        "Accept": "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "Origin": MEGAPLAY_BASE,
        "Referer": f"{MEGAPLAY_BASE}/",
    }


def _cdn_proxy_url(url: str, api_base: str, cdn_referer: str = "") -> str:
    if not api_base:
        return url
    target = str(url or "").strip()
    if not target.startswith(("http://", "https://")):
        return url
    if not _cdn_host_allowed_url(target):
        return url
    qs = {"u": target}
    if cdn_referer:
        qs["r"] = cdn_referer
    return f"{api_base.rstrip('/')}/api/cdn-hls?{urlencode(qs)}"


def _rewrite_m3u8_for_cdn_proxy(body: str, playlist_base: str, api_base: str, cdn_referer: str = "") -> str:
    """Rewrite playlist URIs so hls.js requests variants/segments through our CDN proxy."""
    def proxied(raw_url: str) -> str:
        if raw_url.startswith(("data:", "blob:")):
            return raw_url
        return _cdn_proxy_url(urljoin(playlist_base, raw_url), api_base, cdn_referer)

    out: List[str] = []
    for line in body.splitlines():
        rewritten = re.sub(r'URI="([^"]+)"', lambda m: f'URI="{proxied(m.group(1))}"', line)
        stripped = rewritten.strip()
        if stripped and not stripped.startswith("#"):
            rewritten = proxied(stripped)
        out.append(rewritten)
    return "\n".join(out) + ("\n" if body.endswith("\n") else "")


def _maybe_rewrap_media(raw: dict, rewrite_base: Optional[str]) -> dict:
    """Wrap Megaplay media URLs with /api/cdn-hls for same-origin HLS playback."""
    if not rewrite_base or not isinstance(raw, dict):
        return raw
    out = json.loads(json.dumps(raw))

    def ref_for(item: dict) -> str:
        headers = item.get("headers") if isinstance(item.get("headers"), dict) else {}
        ref = item.get("referer") or item.get("referrer") or headers.get("Referer") or headers.get("referer")
        return str(ref).rstrip("/") if ref else MEGAPLAY_BASE

    sources = out.get("sources")
    source_items = sources if isinstance(sources, list) else [sources] if isinstance(sources, dict) else []
    for item in source_items:
        if not isinstance(item, dict):
            continue
        ref = ref_for(item)
        for key in ("file", "url"):
            if item.get(key):
                item[key] = _cdn_proxy_url(str(item[key]), rewrite_base, ref)

    streams = out.get("streams")
    if isinstance(streams, list):
        for item in streams:
            if not isinstance(item, dict):
                continue
            ref = ref_for(item)
            for key in ("file", "url"):
                if item.get(key):
                    item[key] = _cdn_proxy_url(str(item[key]), rewrite_base, ref)

    tracks = out.get("tracks")
    if isinstance(tracks, list):
        for track in tracks:
            if not isinstance(track, dict):
                continue
            ref = ref_for(track)
            for key in ("file", "url"):
                if track.get(key):
                    track[key] = _cdn_proxy_url(str(track[key]), rewrite_base, ref)
    return out


def _log_stream_urls_from_payload(event: str, payload: dict, **fields: Any) -> None:
    """Best-effort stream diagnostics. Logging must never break playback."""
    try:
        sources = payload.get("sources") if isinstance(payload, dict) else None
        if isinstance(sources, dict):
            sources = [sources]
        urls = []
        for item in sources or []:
            if isinstance(item, dict):
                url = item.get("file") or item.get("url")
                if url:
                    urls.append(str(url)[:180])
        log.info(event, source_count=len(urls), first_source=urls[0] if urls else "", **fields)
    except Exception:
        return


# Formats matching AniList
FORMATS = ["TV", "TV_SHORT", "MOVIE", "SPECIAL", "OVA", "ONA", "MUSIC"]

# Statuses matching AniList
STATUSES = ["RELEASING", "FINISHED", "NOT_YET_RELEASED", "CANCELLED", "HIATUS"]

# Seasons
SEASONS = ["WINTER", "SPRING", "SUMMER", "FALL"]

# ─── Session Manager ─────────────────────────────────────────────────────────


class SessionManager:
    """Manages HTTP sessions with cookie persistence for Miruro/Megaplay."""

    def __init__(self):
        self._client: Optional[httpx.AsyncClient] = None
        self._last_refresh = 0
        self._lock = asyncio.Lock()
        self._refresh_interval = 300  # 5 minutes

    async def get_client(self) -> httpx.AsyncClient:
        """Get or create the HTTP client with proper headers and cookie jar."""
        if self._client is None or time.time() - self._last_refresh > self._refresh_interval:
            async with self._lock:
                if self._client is not None:
                    await self._client.aclose()
                self._client = await self._create_client()
                self._last_refresh = time.time()
        return self._client

    async def _create_client(self) -> httpx.AsyncClient:
        """Create a new HTTP client with a fresh session."""
        client = httpx.AsyncClient(
            cookies={},
            follow_redirects=True,
            timeout=30.0,
            limits=httpx.Limits(max_keepalive_connections=10, max_connections=20),
        )
        # httpx client used only for AniList + other non-Anikoto requests
        return client

    async def close(self):
        if self._client:
            await self._client.aclose()
            self._client = None


session_manager = SessionManager()


async def _upstream_get(
    client: httpx.AsyncClient,
    url: str,
    *,
    attempts: int = 3,
    retry_delay: float = 0.35,
    **kwargs: Any,
) -> httpx.Response:
    """Small retry wrapper for flaky streaming upstreams. Keep attempts low."""
    last_exc: Optional[Exception] = None
    for attempt in range(max(1, attempts)):
        try:
            resp = await client.get(url, **kwargs)
            if resp.status_code not in (408, 429, 500, 502, 503, 504):
                return resp
            last_exc = httpx.HTTPStatusError(
                f"Retryable upstream status {resp.status_code}",
                request=resp.request,
                response=resp,
            )
            if attempt == attempts - 1:
                return resp
        except (httpx.TimeoutException, httpx.NetworkError, httpx.RemoteProtocolError) as exc:
            last_exc = exc
            if attempt == attempts - 1:
                raise
        await asyncio.sleep(retry_delay * (2 ** attempt))
    if last_exc:
        raise last_exc
    raise RuntimeError("upstream retry failed without response")



_CACHE_DB_PATH = Path(os.environ.get("VAULTCEASER_CACHE_DB", Path(__file__).resolve().parent.parent / "data" / "provider_cache.sqlite"))
_CACHE_DB_LOCK = threading.RLock()
_CACHE_DB_READY = False

_EP_COUNTS_CACHE: Dict[int, Tuple[float, Dict[str, int]]] = {}
_EP_COUNTS_CACHE_TTL = 300.0
_EP_COUNTS_REFRESH_TASKS: Dict[int, asyncio.Task] = {}
_EP_COUNTS_BACKGROUND_SEM = asyncio.Semaphore(2)
_ANIME_INDEX_TASK: Optional[asyncio.Task] = None
_ANIME_INDEX_TTL = 86400.0
_MAL_EPISODES_CACHE: Dict[int, Tuple[float, Dict[str, Any]]] = {}
_MAL_EPISODES_CACHE_TTL = 300.0

# ─── Anikoto (anikototv.to) caches ──────────────────────────────────────────

ANIKOTO_BASE = "https://anikototv.to"
ANIKOTO_API_BASE = "https://anikotoapi.site"
MAPPER_BASE  = "https://mapper.mewcdn.online/api/mal"
# Synthetic AniList IDs for anime only on Anikoto (900_000_000 + anikoto_numeric_id)
ANIKOTO_SYNTHETIC_BASE = 900_000_000
# anilist_id → (timestamp, anikoto_numeric_id | None)
_ANIKOTO_ID_CACHE:      Dict[int, Tuple[float, Optional[int]]] = {}
# anikoto_numeric_id → (timestamp, parsed_episode_list)
_ANIKOTO_EP_CACHE:      Dict[int, Tuple[float, List[Dict]]] = {}
# anikoto_ep_id → data_ids blob (side-effect of episode-list fetch; needed for stream resolution)
_ANIKOTO_EP_DATA_IDS:   Dict[int, str] = {}
# link_id → (timestamp, megaplay_url | None)
_ANIKOTO_STREAM_CACHE:  Dict[str, Tuple[float, Optional[str]]] = {}
# anilist_id → title (populated lazily to avoid repeated AniList title-only queries)
_ANIKOTO_TITLE_CACHE:   Dict[int, str] = {}
# search query (lower) → (timestamp, list of media cards)
_AK_SEARCH_CACHE:       Dict[str, Tuple[float, List[Dict]]] = {}
# anikoto_id → slug (for watch-page fetches)
_ANIKOTO_SLUG_CACHE:    Dict[int, str] = {}
# anikoto_id → (timestamp, full media dict for detail pages)
_ANIKOTO_META_CACHE:    Dict[int, Tuple[float, Dict]] = {}

_ANIKOTO_ID_CACHE_TTL    = 86400.0   # 24 h — numeric IDs are stable
_AK_SEARCH_CACHE_TTL     = 600.0     # 10 min
_ANIKOTO_EP_CACHE_TTL    = 900.0     # 15 min — longer to survive homepage refresh cadence
_ANIKOTO_STREAM_CACHE_TTL = 3600.0   # 1 h

_anikoto_http_client: Optional[Any] = None  # wreq.Client (Chrome TLS fingerprint)


def _provider_cache_conn() -> sqlite3.Connection:
    _CACHE_DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(_CACHE_DB_PATH)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=3000")
    return conn


def _provider_cache_init() -> None:
    global _CACHE_DB_READY
    if _CACHE_DB_READY:
        return
    with _CACHE_DB_LOCK:
        if _CACHE_DB_READY:
            return
        with _provider_cache_conn() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS episode_counts (
                    mal_id INTEGER PRIMARY KEY,
                    sub_count INTEGER NOT NULL DEFAULT 0,
                    dub_count INTEGER NOT NULL DEFAULT 0,
                    updated_at REAL NOT NULL
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS mal_anikoto_ids (
                    mal_id INTEGER PRIMARY KEY,
                    anikoto_id INTEGER,
                    updated_at REAL NOT NULL
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS api_cache (
                    cache_key TEXT PRIMARY KEY,
                    value_json TEXT NOT NULL,
                    updated_at REAL NOT NULL
                )
                """
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS api_cache_updated_idx ON api_cache (updated_at)"
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS anime_title_index (
                    mal_id INTEGER PRIMARY KEY,
                    title TEXT NOT NULL,
                    poster TEXT NOT NULL DEFAULT '',
                    search_text TEXT NOT NULL,
                    updated_at REAL NOT NULL
                )
                """
            )
            try:
                conn.execute("ALTER TABLE anime_title_index ADD COLUMN poster TEXT NOT NULL DEFAULT ''")
            except sqlite3.OperationalError:
                pass
            conn.execute(
                "CREATE INDEX IF NOT EXISTS anime_title_index_search_idx ON anime_title_index (search_text)"
            )
        _CACHE_DB_READY = True


def _provider_cache_load() -> None:
    _provider_cache_init()
    now = time.monotonic()
    wall_now = time.time()
    with _CACHE_DB_LOCK:
        with _provider_cache_conn() as conn:
            for mal_id, sub_count, dub_count, updated_at in conn.execute(
                "SELECT mal_id, sub_count, dub_count, updated_at FROM episode_counts"
            ):
                age = max(0.0, wall_now - float(updated_at))
                _EP_COUNTS_CACHE[int(mal_id)] = (
                    now - age,
                    {"sub": int(sub_count), "dub": int(dub_count)},
                )
            for mal_id, anikoto_id, updated_at in conn.execute(
                "SELECT mal_id, anikoto_id, updated_at FROM mal_anikoto_ids"
            ):
                age = max(0.0, wall_now - float(updated_at))
                _mal_anikoto_id_cache[int(mal_id)] = (
                    now - age,
                    int(anikoto_id) if anikoto_id is not None else None,
                )


def _provider_cache_save_episode_counts(mal_id: int, counts: Dict[str, int]) -> None:
    with _CACHE_DB_LOCK:
        with _provider_cache_conn() as conn:
            conn.execute(
                """
                INSERT INTO episode_counts (mal_id, sub_count, dub_count, updated_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(mal_id) DO UPDATE SET
                    sub_count=excluded.sub_count,
                    dub_count=excluded.dub_count,
                    updated_at=excluded.updated_at
                """,
                (int(mal_id), int(counts.get("sub") or 0), int(counts.get("dub") or 0), time.time()),
            )


def _provider_cache_save_mal_anikoto_id(mal_id: int, anikoto_id: Optional[int]) -> None:
    # Do not persist misses for a whole deploy cycle; upstream search misses can be random.
    if anikoto_id is None:
        return
    with _CACHE_DB_LOCK:
        with _provider_cache_conn() as conn:
            conn.execute(
                """
                INSERT INTO mal_anikoto_ids (mal_id, anikoto_id, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(mal_id) DO UPDATE SET
                    anikoto_id=excluded.anikoto_id,
                    updated_at=excluded.updated_at
                """,
                (int(mal_id), int(anikoto_id), time.time()),
            )


def _provider_cache_get_json(cache_key: str, ttl: float) -> Tuple[Optional[Any], bool]:
    """Return (value, is_fresh). Stale values are useful when upstream is slow/down."""
    _provider_cache_init()
    with _CACHE_DB_LOCK:
        with _provider_cache_conn() as conn:
            row = conn.execute(
                "SELECT value_json, updated_at FROM api_cache WHERE cache_key = ?",
                (cache_key,),
            ).fetchone()
    if not row:
        return None, False
    try:
        value = json.loads(row[0])
    except Exception:
        return None, False
    return value, (time.time() - float(row[1])) < ttl


def _provider_cache_save_json(cache_key: str, value: Any) -> None:
    _provider_cache_init()
    with _CACHE_DB_LOCK:
        with _provider_cache_conn() as conn:
            conn.execute(
                """
                INSERT INTO api_cache (cache_key, value_json, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(cache_key) DO UPDATE SET
                    value_json=excluded.value_json,
                    updated_at=excluded.updated_at
                """,
                (cache_key, json.dumps(value, separators=(",", ":")), time.time()),
            )


def _title_index_search(query: str, limit: int = 8) -> List[Dict[str, Any]]:
    q = re.sub(r"[^a-z0-9]+", " ", query.lower()).strip()
    if len(q) < 2:
        return []
    like = f"%{q}%"
    _provider_cache_init()
    with _CACHE_DB_LOCK:
        with _provider_cache_conn() as conn:
            rows = conn.execute(
                """
                SELECT mal_id, title, COALESCE(poster, '')
                FROM anime_title_index
                WHERE search_text LIKE ?
                ORDER BY
                    CASE
                        WHEN search_text = ? THEN 0
                        WHEN search_text LIKE ? THEN 1
                        ELSE 2
                    END,
                    length(title) ASC
                LIMIT ?
                """,
                (like, q, f"{q}%", int(limit)),
            ).fetchall()
    return [
        {
            "id": int(mal_id),
            "title": str(title),
            "title_romaji": str(title),
            "poster": str(poster or ""),
            "coverImage": {"large": str(poster or "")} if poster else {},
            "isAdult": False,
            "genres": [],
        }
        for mal_id, title, poster in rows
    ]


def _title_index_poster(item: dict) -> str:
    for key in ("poster", "image", "img", "thumbnail", "cover", "picture", "cover_image"):
        val = item.get(key)
        if isinstance(val, str) and val.startswith(("http://", "https://")):
            return val
        if isinstance(val, dict):
            nested = val.get("large") or val.get("url") or val.get("image_url")
            if isinstance(nested, str) and nested.startswith(("http://", "https://")):
                return nested
    images = item.get("images")
    if isinstance(images, dict):
        return _jikan_image(images) or ""
    return ""


def _title_index_is_fresh() -> bool:
    _provider_cache_init()
    with _CACHE_DB_LOCK:
        with _provider_cache_conn() as conn:
            row = conn.execute(
                "SELECT MAX(updated_at), COUNT(*), COUNT(NULLIF(poster, '')) FROM anime_title_index"
            ).fetchone()
    if not row or not row[0] or int(row[1] or 0) < 1000:
        return False
    if int(row[2] or 0) < 100:
        return False
    return (time.time() - float(row[0])) < _ANIME_INDEX_TTL


async def _refresh_title_index_background() -> None:
    global _ANIME_INDEX_TASK
    try:
        client = await session_manager.get_client()
        r = await client.get("https://animeapi.my.id/animeApi.json", headers={"User-Agent": USER_AGENT}, follow_redirects=True, timeout=30.0)
        r.raise_for_status()
        payload = r.json()
        items = payload if isinstance(payload, list) else list(payload.values()) if isinstance(payload, dict) else []
        now = time.time()
        rows: List[Tuple[int, str, str, str, float]] = []
        for item in items:
            if not isinstance(item, dict):
                continue
            mal_id = item.get("myanimelist") or item.get("mal") or item.get("mal_id")
            title = item.get("title")
            if not mal_id or not title:
                continue
            try:
                mid = int(mal_id)
            except Exception:
                continue
            title_s = str(title).strip()
            poster = _title_index_poster(item)
            search_text = re.sub(r"[^a-z0-9]+", " ", title_s.lower()).strip()
            if title_s and search_text:
                rows.append((mid, title_s, poster, search_text, now))
        if not rows:
            return
        with _CACHE_DB_LOCK:
            with _provider_cache_conn() as conn:
                conn.executemany(
                    """
                    INSERT INTO anime_title_index (mal_id, title, poster, search_text, updated_at)
                    VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT(mal_id) DO UPDATE SET
                        title=excluded.title,
                        poster=excluded.poster,
                        search_text=excluded.search_text,
                        updated_at=excluded.updated_at
                    """,
                    rows,
                )
        log.info("anime_title_index_refreshed", count=len(rows))
    except Exception as exc:
        log.warning("anime_title_index_refresh_failed", error=str(exc)[:120])
    finally:
        _ANIME_INDEX_TASK = None


def _schedule_title_index_refresh() -> None:
    global _ANIME_INDEX_TASK
    if _title_index_is_fresh():
        return
    if _ANIME_INDEX_TASK and not _ANIME_INDEX_TASK.done():
        return
    _ANIME_INDEX_TASK = asyncio.create_task(_refresh_title_index_background())


def _megaplay_proxy_referer(request: Request, upstream_path: str) -> str:
    """Referer Megaplay expects: miruro for embed page; s-2 page URL for getSources (research/01)."""
    client_ref = request.headers.get("referer") or ""
    m = re.search(r"/api/mp/stream/s-2/([^/]+)/([^/?#]+)", client_ref)
    if m:
        eid, cat = unquote(m.group(1)), unquote(m.group(2))
        return f"{MEGAPLAY_BASE}/stream/s-2/{eid}/{cat}"
    if "getSources" in upstream_path:
        qid = request.query_params.get("id") or request.query_params.get("episodeId")
        if qid:
            qid = unquote(qid)
            explicit = request.query_params.get("category") or request.query_params.get("cat")
            if explicit is not None and str(explicit).strip() != "":
                cat_guess = _normalize_stream_category(explicit)
            else:
                cat_guess = "sub"
                m2 = re.search(r"/api/mp/stream/s-2/[^/]+/([^/?#]+)", client_ref)
                if m2:
                    cat_guess = _normalize_stream_category(m2.group(1))
            return f"{MEGAPLAY_BASE}/stream/s-2/{qid}/{cat_guess}"
    return f"{MEGAPLAY_BASE}/"


def _megaplay_getsources_headers(referer: str) -> Dict[str, str]:
    origin = f"{urlparse(MEGAPLAY_BASE).scheme}://{urlparse(MEGAPLAY_BASE).netloc}"
    return {
        "User-Agent": USER_AGENT,
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": referer,
        "Origin": origin,
        "X-Requested-With": "XMLHttpRequest",
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Dest": "empty",
    }


_MEGAPLAY_SOURCES_ID_CACHE: Dict[str, Tuple[float, Optional[str]]] = {}
_MEGAPLAY_SOURCES_ID_TTL = 3600.0


async def _megaplay_realid_to_sources_id(realid: str, category: str = "sub") -> Optional[str]:
    """
    Megaplay embed URLs expose one ID, but /stream/getSources often needs the
    inner data-id from the embed HTML. Supports numeric s-2 IDs and mal_X_Y.
    """
    raw = str(realid or "").strip()
    cat = _normalize_stream_category(category)
    if not raw:
        return None

    cache_key = f"{raw}:{cat}"
    now = time.monotonic()
    cached = _MEGAPLAY_SOURCES_ID_CACHE.get(cache_key)
    if cached is not None and (now - cached[0]) < _MEGAPLAY_SOURCES_ID_TTL:
        return cached[1]

    if raw.startswith("mal_"):
        parts = raw.split("_", 2)
        if len(parts) != 3 or not parts[1].isdigit() or not parts[2].isdigit():
            return None
        embed_url = f"{MEGAPLAY_BASE}/stream/mal/{parts[1]}/{parts[2]}/{cat}"
    else:
        embed_url = f"{MEGAPLAY_BASE}/stream/s-2/{quote(raw, safe='')}/{cat}"

    try:
        client = await session_manager.get_client()
        r = await _upstream_get(
            client,
            embed_url,
            headers={
                "User-Agent": USER_AGENT,
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Referer": f"{MEGAPLAY_BASE}/",
                "Origin": MEGAPLAY_BASE,
            },
            timeout=12.0,
        )
        r.raise_for_status()
        match = re.search(r'\bdata-id=["\']?(\d+)', r.text)
        out = match.group(1) if match else (raw if raw.isdigit() else None)
        _MEGAPLAY_SOURCES_ID_CACHE[cache_key] = (now, out)
        return out
    except Exception as exc:
        log.warning("megaplay_sources_id_resolve_failed", realid=raw, category=cat, error=str(exc)[:120])
        _MEGAPLAY_SOURCES_ID_CACHE[cache_key] = (now, None)
        return None


def _rewrite_megaplay_html(body: str, public_base: str) -> str:
    """Point upstream player asset URLs at our reverse proxy."""
    prefix = public_base.rstrip("/") + "/api/mp/"
    for host in _embed_asset_hosts():
        body = body.replace(f"https://{host}/", prefix)
        body = body.replace(f"http://{host}/", prefix)
        body = body.replace(f"//{host}/", prefix)
    if re.search(r"<head[^>]*>", body, flags=re.I):
        body = re.sub(
            r"(<head[^>]*>)",
            r'\1<base href="' + prefix + '">',
            body,
            count=1,
            flags=re.I,
        )
    body = _rewrite_megaplay_site_root_attrs(body)
    return body


def _rewrite_megaplay_site_root_attrs(body: str) -> str:
    """Megaplay uses href/src like /lib/... — <base> does NOT apply; prefix /api/mp/ (skip if already done)."""

    def repl(m) -> str:
        attr, quote, path = m.group(1), m.group(2), m.group(3)
        if path.startswith(("/api/mp", "//", "http:", "https:", "data:", "blob:")):
            return m.group(0)
        if not path.startswith(
            ("/lib/", "/stream/", "/assets/", "/static/", "/domains", "/fonts/", "/favicon")
        ):
            return m.group(0)
        return f"{attr}={quote}/api/mp{path}"

    return re.sub(r"\b(src|href)=(['\"])(/[^'\"<>\s]+)", repl, body, flags=re.I)


def _rewrite_megaplay_css(body: str) -> str:
    """Same root-absolute URL issue inside stylesheets (url(/lib/...))."""
    for host in _embed_asset_hosts():
        body = body.replace(f"https://{host}/", "/api/mp/")
        body = body.replace(f"http://{host}/", "/api/mp/")
        body = body.replace(f"//{host}/", "/api/mp/")
    body = re.sub(
        r"url\(\s*(['\"]?)/(?!api/mp/)((?:lib|stream|assets|static|domains|fonts)/[^)]*)\)",
        r"url(\1/api/mp/\2)",
        body,
        flags=re.I,
    )
    return body


def _rewrite_megaplay_js(body: str) -> str:
    """Obfuscated player often hardcodes /stream/, /lib/ string fragments."""
    for host in _embed_asset_hosts():
        body = body.replace(f"https://{host}/", "/api/mp/")
        body = body.replace(f"http://{host}/", "/api/mp/")
        body = body.replace(f"//{host}/", "/api/mp/")
    for seg in ("lib", "stream", "assets", "static", "domains", "fonts"):
        body = body.replace(f'"/{seg}/', f'"/api/mp/{seg}/')
        body = body.replace(f"'/{seg}/", f"'/api/mp/{seg}/")
        body = body.replace(f'"/{seg}?', f'"/api/mp/{seg}?')
        body = body.replace(f"'/{seg}?", f"'/api/mp/{seg}?")
    return body


_HOP_BY_HOP = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
}


def _filter_response_headers(headers: dict) -> dict:
    out: Dict[str, str] = {}
    for key, value in headers.items():
        lk = key.lower()
        if lk in _HOP_BY_HOP or lk in ("content-encoding", "content-length"):
            continue
        out[key] = value
    return out


def _normalize_megaplay_sources_payload(raw: dict) -> dict:
    """Shape similar to Miruro pipe `sources` for players expecting `streams` array."""
    if not isinstance(raw, dict):
        raw = {}
    # Megaplay may return sources as a dict {"file":"..."} instead of a list
    _src = raw.get("sources")
    if isinstance(_src, dict) and _src.get("file"):
        _src = [_src]
    src_items = list(_src or [])
    if not src_items:
        for s in raw.get("streams") or []:
            if isinstance(s, dict):
                u = s.get("file") or s.get("url")
                if u:
                    src_items.append({"file": u})
    streams: List[dict] = []
    for item in src_items:
        if isinstance(item, dict) and item.get("file"):
            streams.append({
                "type": "hls",
                "url": item["file"],
                "quality": "auto",
                "isActive": True,
            })
    return {
        "streams": streams,
        "tracks": raw.get("tracks") or [],
        "intro": raw.get("intro") or {},
        "outro": raw.get("outro") or {},
        "server": raw.get("server", 0),
    }


def _inject_source_slugs(data: dict, anilist_id: int) -> dict:
    """Transform episode IDs into simplified path-based slugs.
    Preserves the original ID under 'original_id' for use with the sources API.
    """
    providers = data.get("providers", {})
    for provider_name, provider_data in providers.items():
        if not isinstance(provider_data, dict):
            continue
        episodes = provider_data.get("episodes", {})
        if not isinstance(episodes, dict):
            if isinstance(episodes, list):
                provider_data["episodes"] = {"sub": episodes}
                episodes = provider_data["episodes"]
            else:
                continue
        for category, ep_list in episodes.items():
            if not isinstance(ep_list, list):
                continue
            for ep in ep_list:
                if not isinstance(ep, dict):
                    continue
                if "id" in ep and "number" in ep:
                    orig_id = ep["id"]
                    prefix = orig_id.split(":")[0] if ":" in orig_id else orig_id
                    ep["id"] = f"watch/{provider_name}/{anilist_id}/{category}/{prefix}-{ep['number']}"
                    # Preserve original ID for source fetching
                    ep["original_id"] = orig_id
    return data


# ─── Sync HTTP Helper (requests library) ────────────────────────────────────

def sync_fetch_url(url: str, headers: Optional[dict] = None) -> dict:
    """Synchronous HTTP GET using the `requests` library.
    Used for quick health checks and fallback operations.
    """
    try:
        resp = sync_requests.get(
            url,
            headers=headers or {"User-Agent": USER_AGENT},
            timeout=10,
        )
        resp.raise_for_status()
        return {"status": resp.status_code, "data": resp.text[:500]}
    except Exception as e:
        return {"status": 0, "error": str(e)}

# ─── Anikoto HTTP helpers ────────────────────────────────────────────────────


def _get_anikoto_client():
    """Lazy shared wreq Client (Chrome TLS fingerprint → avoids bot detection on anikoto)."""
    global _anikoto_http_client
    if not _WREQ_AVAILABLE:
        raise RuntimeError("wreq not installed; anikoto: episode IDs not supported")
    if _anikoto_http_client is None:
        _anikoto_http_client = _wreq.Client(emulation=_wreq.Emulation.Chrome128)
    return _anikoto_http_client


def _ak_url(path: str, **params) -> str:
    """Build an anikoto URL with query params embedded in the string."""
    return f"{ANIKOTO_BASE}{path}?{urlencode(params)}" if params else f"{ANIKOTO_BASE}{path}"


_AK_HDRS = {
    "Accept": "*/*",
    "X-Requested-With": "XMLHttpRequest",
    "Referer": f"{ANIKOTO_BASE}/",
}


async def _get_anime_title(mal_id: int) -> Optional[str]:
    """MAL title lookup via Jikan. Cached in _ANIKOTO_TITLE_CACHE for backward compat."""
    cached = _ANIKOTO_TITLE_CACHE.get(mal_id)
    if cached:
        return cached
    try:
        data = await _jikan_get(f"/anime/{mal_id}", ttl=_JIKAN_TTL_LONG)
        item = data.get("data") or {}
        result = item.get("title_english") or item.get("title") or ""
        if result:
            _ANIKOTO_TITLE_CACHE[mal_id] = result
        return result or None
    except Exception:
        return None


async def _anikoto_resolve_id(anilist_id: int, title: str) -> Optional[int]:
    """
    AniList ID → anikoto numeric ID via title search + watch page parse.
    Cached for 24 h. Returns None if the anime can't be found on anikoto.
    """
    now = time.monotonic()
    cached = _ANIKOTO_ID_CACHE.get(anilist_id)
    if cached is not None and (now - cached[0]) < _ANIKOTO_ID_CACHE_TTL:
        return cached[1]

    client = _get_anikoto_client()
    anikoto_id: Optional[int] = None
    try:
        r = await client.get(_ak_url("/ajax/anime/search", keyword=title), headers=_AK_HDRS)
        r.raise_for_status()
        payload = await r.json()
        result_val = payload.get("result")
        html_blob = result_val.get("html", "") if isinstance(result_val, dict) else (result_val or "")
        slug_m = re.search(r'href="(?:https://anikototv\.to)?/watch/([^/"]+)"', html_blob)
        if slug_m:
            slug = slug_m.group(1)
            wp = await client.get(_ak_url(f"/watch/{slug}"), headers={"Referer": f"{ANIKOTO_BASE}/"})
            wp.raise_for_status()
            wp_text = await wp.text()
            id_m = re.search(r'data-id="(\d+)"', wp_text)
            if id_m:
                anikoto_id = int(id_m.group(1))
    except Exception as e:
        log.debug("anikoto_resolve_id_error", anilist_id=anilist_id, title=title, error=str(e)[:100])

    _ANIKOTO_ID_CACHE[anilist_id] = (time.monotonic(), anikoto_id)
    if anikoto_id:
        log.info("anikoto_id_resolved", anilist_id=anilist_id, anikoto_id=anikoto_id)
    else:
        log.debug("anikoto_id_not_found", anilist_id=anilist_id, title=title)
    return anikoto_id


def _parse_html_attr(tag: str, attr: str) -> Optional[str]:
    """Extract a single attribute value from an HTML opening tag string."""
    m = re.search(rf'{re.escape(attr)}="([^"]*)"', tag)
    return m.group(1) if m else None


async def _anikoto_get_episodes(anikoto_id: int) -> List[Dict]:
    """
    Fetch and parse the episode list for an anikoto numeric ID.
    Populates _ANIKOTO_EP_DATA_IDS as a side effect (needed for stream resolution).
    Cached for 5 min.
    """
    now = time.monotonic()
    cached = _ANIKOTO_EP_CACHE.get(anikoto_id)
    if cached is not None and (now - cached[0]) < _ANIKOTO_EP_CACHE_TTL:
        return cached[1]

    client = _get_anikoto_client()
    r = await client.get(
        _ak_url(f"/ajax/episode/list/{anikoto_id}", vrf=""),
        headers={**_AK_HDRS, "Referer": f"{ANIKOTO_BASE}/watch/"},
    )
    r.raise_for_status()
    payload = await r.json()
    html = payload.get("result") or ""

    episodes: List[Dict] = []
    for m in re.finditer(r"<a\b[^>]+data-id=\"\d+\"[^>]*>", html):
        tag = m.group(0)
        ep_id_s  = _parse_html_attr(tag, "data-id")
        num_s    = _parse_html_attr(tag, "data-num")
        sub_s    = _parse_html_attr(tag, "data-sub")
        dub_s    = _parse_html_attr(tag, "data-dub")
        data_ids = _parse_html_attr(tag, "data-ids")
        if not (ep_id_s and num_s and data_ids):
            continue
        ep_id = int(ep_id_s)
        num   = int(num_s)
        sub   = (sub_s or "0") != "0"
        dub   = (dub_s or "0") != "0"
        after = html[m.end(): m.end() + 300]
        t_m = re.search(r'class="d-title"[^>]*>([^<]+)<', after)
        title = t_m.group(1).strip() if t_m else f"Episode {num}"
        episodes.append({
            "number": num, "anikoto_ep_id": ep_id, "data_ids": data_ids,
            "sub": sub, "dub": dub, "title": title,
        })
        _ANIKOTO_EP_DATA_IDS[ep_id] = data_ids

    episodes.sort(key=lambda x: x["number"])
    _ANIKOTO_EP_CACHE[anikoto_id] = (time.monotonic(), episodes)
    log.debug("anikoto_episodes_fetched", anikoto_id=anikoto_id, count=len(episodes))
    return episodes


async def _anikoto_api_get_episodes(anikoto_id: int) -> List[Dict]:
    """Fast JSON episode list from anikotoapi.site; falls back to HTML scraper on failure."""
    cache_key = f"anikotoapi:series:{anikoto_id}"
    cached, fresh = _provider_cache_get_json(cache_key, _ANIKOTO_EP_CACHE_TTL)
    if cached is not None and fresh:
        payload = cached
    else:
        payload = None
        client = await session_manager.get_client()
        try:
            r = await client.get(
                f"{ANIKOTO_API_BASE}/series/{anikoto_id}",
                headers={"User-Agent": USER_AGENT},
                follow_redirects=True,
                timeout=12.0,
            )
            r.raise_for_status()
            payload = r.json()
            _provider_cache_save_json(cache_key, payload)
        except Exception:
            if cached is not None:
                payload = cached
            else:
                raise

    rows = ((payload or {}).get("data") or {}).get("episodes") or []
    episodes: List[Dict] = []
    for row in rows:
        try:
            number = int(row.get("number") or 0)
        except Exception:
            number = 0
        if number <= 0:
            continue
        embed_id = str(row.get("episode_embed_id") or "").strip()
        embed_url = row.get("embed_url") or {}
        sub_url = str(embed_url.get("sub") or "")
        dub_url = str(embed_url.get("dub") or "")
        episodes.append({
            "number": number,
            "anikoto_ep_id": int(row.get("id") or 0),
            "episode_embed_id": embed_id or None,
            "data_ids": "",
            "sub": bool(sub_url),
            "dub": bool(dub_url),
            "title": row.get("title") or f"Episode {number}",
        })
    episodes.sort(key=lambda x: x["number"])
    return episodes


async def _anikoto_get_link_id(data_ids: str, category: str) -> Optional[str]:
    """
    POST to /ajax/server/list with data_ids.
    Returns the link-id for Vidstream-2 (preferred) or any server of the requested category.
    """
    client = _get_anikoto_client()
    r = await client.get(
        _ak_url("/ajax/server/list", servers=data_ids),
        headers={**_AK_HDRS, "Referer": f"{ANIKOTO_BASE}/watch/"},
    )
    r.raise_for_status()
    payload = await r.json()
    html = payload.get("result") or ""

    cat = category if category in ("sub", "dub") else "sub"
    type_m = re.search(rf'data-type="{re.escape(cat)}"[^>]*>(.*?)</div>', html, re.S)
    if not type_m:
        return None
    block = type_m.group(1)
    # Prefer Vidstream-2 (sv-id e54); fall back to first available link
    pref = re.search(r'<li\b[^>]*data-sv-id="e54"[^>]*data-link-id="([^"]+)"', block)
    if pref:
        return pref.group(1)
    any_m = re.search(r'data-link-id="([^"]+)"', block)
    return any_m.group(1) if any_m else None


async def _anikoto_get_stream_url(link_id: str) -> Optional[str]:
    """Call /ajax/server?get={link_id} → megaplay URL. Cached 1 h."""
    now = time.monotonic()
    cached = _ANIKOTO_STREAM_CACHE.get(link_id)
    if cached is not None and (now - cached[0]) < _ANIKOTO_STREAM_CACHE_TTL:
        return cached[1]

    client = _get_anikoto_client()
    r = await client.get(
        _ak_url("/ajax/server", get=link_id),
        headers={**_AK_HDRS, "Referer": f"{ANIKOTO_BASE}/watch/"},
    )
    r.raise_for_status()
    data   = await r.json()
    result = data.get("result")
    url    = result.get("url") if isinstance(result, dict) else None
    _ANIKOTO_STREAM_CACHE[link_id] = (time.monotonic(), url)
    return url


async def _anikoto_full_stream(anilist_id: int, anikoto_ep_id: int, category: str) -> Optional[str]:
    """
    Full anikoto stream chain: data_ids → server list → link_id → megaplay URL.
    If data_ids aren't cached (server restart / direct call), re-fetches the episode list.
    Returns None on any failure so caller can fall back to miruro.
    """
    data_ids = _ANIKOTO_EP_DATA_IDS.get(anikoto_ep_id)
    if not data_ids and anilist_id:
        title = await _get_anime_title(anilist_id)
        if title:
            aid = await _anikoto_resolve_id(anilist_id, title)
            if aid:
                await _anikoto_get_episodes(aid)
                data_ids = _ANIKOTO_EP_DATA_IDS.get(anikoto_ep_id)
    if not data_ids:
        return None
    try:
        link_id = await _anikoto_get_link_id(data_ids, category)
        if not link_id:
            return None
        return await _anikoto_get_stream_url(link_id)
    except Exception as e:
        log.warning("anikoto_stream_failed", anikoto_ep_id=anikoto_ep_id,
                    category=category, error=str(e)[:120])
        return None


# ── Mapper-based MAL-ID stream resolution ─────────────────────────────────────
_mapper_cache: Dict[str, tuple] = {}
_MAPPER_TTL = 3600  # 1 h
_mal_anikoto_id_cache: Dict[int, Tuple[float, Optional[int]]] = {}


async def _mal_to_anikoto_id(mal_id: int) -> Optional[int]:
    """MAL ID → anikoto numeric anime ID via title search. Uses regular httpx (no wreq)."""
    now = time.monotonic()
    hit = _mal_anikoto_id_cache.get(mal_id)
    # Positive IDs are stable; negative lookups are short-lived because upstream
    # search can randomly miss/timeout and caching None for a day makes streams look broken.
    if hit and hit[1] is not None and (now - hit[0]) < 86400:
        return hit[1]
    if hit and hit[1] is None and (now - hit[0]) < 300:
        return None

    anikoto_id: Optional[int] = None
    try:
        raw = await _jikan_get(f"/anime/{mal_id}", ttl=_JIKAN_TTL_LONG)
        raw_info = raw.get("data") or {}
        norm_info = _jikan_to_anime(raw_info)
        title_obj = norm_info.get("title") or {}
        title_candidates = [
            title_obj.get("english"),
            title_obj.get("romaji"),
            raw_info.get("title"),
            raw_info.get("title_english"),
            raw_info.get("title_japanese"),
            *(raw_info.get("titles") or []),
        ]
        titles: List[str] = []
        for t in title_candidates:
            if isinstance(t, dict):
                t = t.get("title")
            if isinstance(t, str) and t.strip() and t.strip() not in titles:
                titles.append(t.strip())
        if not titles:
            _mal_anikoto_id_cache[mal_id] = (now, None)
            return None

        client = await session_manager.get_client()
        headers = {**_AK_HDRS, "Referer": f"{ANIKOTO_BASE}/"}

        def norm_title(value: str) -> str:
            return re.sub(r"[^a-z0-9]+", "", value.lower())

        async def filter_once(title: str) -> Optional[int]:
            r = await client.get(f"{ANIKOTO_BASE}/filter?keyword={quote(title)}",
                                 headers=headers, timeout=15.0)
            r.raise_for_status()
            html = r.text
            wanted = norm_title(title)
            matches: List[Tuple[int, int]] = []
            for item_m in re.finditer(r'<div class="item\b.*?(?=<div class="item\b|<div class="pre-pagination|$)', html, re.S):
                block = item_m.group(0)
                id_m = re.search(r'data-tip="(\d+)"', block)
                name_m = re.search(r'class="name d-title"[^>]*>([^<]+)<', block)
                if not id_m:
                    continue
                text_norm = norm_title(name_m.group(1) if name_m else "")
                score = 10
                if text_norm == wanted:
                    score = 100
                elif text_norm.startswith(wanted) or wanted.startswith(text_norm):
                    score = 80
                elif wanted and wanted in text_norm:
                    score = 60
                matches.append((score, int(id_m.group(1))))
            if matches:
                matches.sort(key=lambda x: x[0], reverse=True)
                return matches[0][1] if matches[0][0] >= 80 else None
            return None

        async def ajax_search_slug(title: str) -> Optional[str]:
            r = await client.get(f"{ANIKOTO_BASE}/ajax/anime/search?keyword={quote(title)}",
                                 headers=headers, timeout=10.0)
            r.raise_for_status()
            payload = r.json()
            result_val = payload.get("result")
            html_blob = result_val.get("html", "") if isinstance(result_val, dict) else (result_val or "")
            anchors: List[Tuple[int, str]] = []
            wanted = norm_title(title)
            for a_m in re.finditer(r'<a\b[^>]*href="(?:https://anikototv\.to)?/watch/([^/"]+)"[^>]*>(.*?)</a>', html_blob, re.S):
                slug = a_m.group(1)
                text = re.sub(r"<[^>]+>", " ", a_m.group(2))
                text_norm = norm_title(text)
                score = 0
                if text_norm == wanted:
                    score = 100
                elif text_norm.startswith(wanted) or wanted.startswith(text_norm):
                    score = 80
                elif wanted and wanted in text_norm:
                    score = 60
                anchors.append((score, slug))
            if anchors:
                anchors.sort(key=lambda x: x[0], reverse=True)
                return anchors[0][1] if anchors[0][0] >= 80 else None
            return None

        for title in titles:
            direct_id = await filter_once(title)
            if direct_id:
                anikoto_id = direct_id
                break
            slug = await ajax_search_slug(title)
            if not slug:
                continue
            wp = await client.get(f"{ANIKOTO_BASE}/watch/{slug}",
                                  headers={"Referer": f"{ANIKOTO_BASE}/", "User-Agent": USER_AGENT},
                                  timeout=10.0)
            id_m = re.search(r'data-id="(\d+)"', wp.text)
            if id_m:
                anikoto_id = int(id_m.group(1))
                break
    except Exception as e:
        log.warning("mal_to_anikoto_id_failed", mal_id=mal_id, error=str(e)[:100])

    _mal_anikoto_id_cache[mal_id] = (time.monotonic(), anikoto_id)
    if anikoto_id:
        _provider_cache_save_mal_anikoto_id(mal_id, anikoto_id)
        log.info("mal_anikoto_resolved", mal_id=mal_id, anikoto_id=anikoto_id)
    return anikoto_id


async def _mapper_resolve_stream(mal_id: int, ep_num: int, category: str) -> Optional[str]:
    """
    Resolve (MAL ID, episode, category) to a vidwish /stream/s-2/{id}/{cat} URL.

    Chain:
      1. MAL ID -> anikoto anime ID  (title search)
      2. anikoto episode list       -> data_ids + data-timestamp per episode
      3. mapper.mewcdn.online       -> link_id  (uses real timestamp)
         fallback: anikoto /ajax/server/list -> link_id
      4. anikototv /ajax/server?get -> vidwish URL
    """
    cache_key = f"{mal_id}:{ep_num}:{category}"
    now = time.monotonic()
    hit = _mapper_cache.get(cache_key)
    if hit and (now - hit[0]) < _MAPPER_TTL:
        return hit[1]

    try:
        client = await session_manager.get_client()
        ak_headers = {**_AK_HDRS, "Referer": f"{ANIKOTO_BASE}/watch/"}

        # Step 1: MAL ID -> anikoto ID
        anikoto_id = await _mal_to_anikoto_id(mal_id)
        if not anikoto_id:
            log.warning("mapper_no_anikoto_id", mal_id=mal_id)
            _mapper_cache[cache_key] = (time.monotonic(), None)
            return None

        # Step 2: episode list -> data_ids + timestamp
        r = await client.get(f"{ANIKOTO_BASE}/ajax/episode/list/{anikoto_id}?vrf=",
                             headers=ak_headers, timeout=10.0)
        r.raise_for_status()
        ep_html = r.json().get("result", "")

        data_ids: Optional[str] = None
        timestamp: Optional[str] = None
        for m in re.finditer(r"<a\b[^>]+data-id=\"\d+\"[^>]*>", ep_html):
            tag = m.group(0)
            num_s = _parse_html_attr(tag, "data-num")
            if num_s and int(num_s) == ep_num:
                data_ids  = _parse_html_attr(tag, "data-ids")
                timestamp = _parse_html_attr(tag, "data-timestamp")
                break

        if not data_ids:
            log.warning("mapper_no_data_ids", mal_id=mal_id, ep=ep_num)
            _mapper_cache[cache_key] = (time.monotonic(), None)
            return None

        cat_key = "dub" if category == "dub" else "sub"
        cat_norm = category if category in ("sub", "dub") else "sub"
        link_id: Optional[str] = None

        # Step 3: native anikoto server list FIRST — always gives vidwish URLs
        r2 = await client.get(f"{ANIKOTO_BASE}/ajax/server/list?servers={data_ids}",
                              headers=ak_headers, timeout=10.0)
        r2.raise_for_status()
        sl_html = r2.json().get("result", "")
        type_m = re.search(rf'data-type="{cat_norm}"[^>]*>(.*?)</div>', sl_html, re.S)
        if type_m:
            block = type_m.group(1)
            # prefer Vidstream-2 (e54) → vidwish, else first available
            pref = re.search(r'data-sv-id="e54"[^>]*data-link-id="([^"]+)"', block)
            link_id = pref.group(1) if pref else None
            if not link_id:
                any_m = re.search(r'data-link-id="([^"]+)"', block)
                link_id = any_m.group(1) if any_m else None

        # Step 4: mapper fallback if anikoto list had nothing
        if not link_id and timestamp:
            mapper_url = f"{MAPPER_BASE}/{mal_id}/{ep_num}/{timestamp}"
            mr = await client.get(mapper_url,
                                  headers={"Referer": f"{ANIKOTO_BASE}/", "User-Agent": USER_AGENT},
                                  timeout=10.0)
            if mr.status_code == 200:
                mdata = mr.json()
                mdata.pop("status", None)
                for _srv, srv_data in mdata.items():
                    if isinstance(srv_data, dict):
                        url_val = (srv_data.get(cat_key) or {}).get("url")
                        if not url_val and cat_key == "dub":
                            url_val = (srv_data.get("sub") or {}).get("url")
                        if url_val:
                            link_id = url_val
                            break

        if not link_id:
            log.warning("mapper_no_link_id", mal_id=mal_id, ep=ep_num, cat=category)
            _mapper_cache[cache_key] = (time.monotonic(), None)
            return None

        # Step 5: anikoto server resolve -> actual stream URL
        r3 = await client.get(f"{ANIKOTO_BASE}/ajax/server?get={link_id}",
                               headers=ak_headers, timeout=10.0)
        r3.raise_for_status()
        result = r3.json().get("result")
        stream_url = result.get("url") if isinstance(result, dict) else None
        _mapper_cache[cache_key] = (time.monotonic(), stream_url)
        if stream_url:
            log.info("mapper_resolved", mal_id=mal_id, ep=ep_num, cat=category, url=stream_url)
        return stream_url

    except Exception as exc:
        log.warning("mapper_resolve_failed", mal_id=mal_id, ep=ep_num, cat=category,
                    error=str(exc)[:120])
        _mapper_cache[cache_key] = (time.monotonic(), None)
        return None


async def get_megaplay_sources(
    source_id: str,
    category: str = "sub",
    anilist_id: Optional[int] = None,
    rewrite_base: Optional[str] = None,
) -> dict:
    """Fetch streaming sources: direct getSources for numeric ids; anikoto stream chain for anikoto: ids."""
    eid = unquote(str(source_id))

    # anikoto: prefix — resolve via anikoto stream chain → fetch s-2 HTML → get getSources data-id
    if str(eid).startswith("anikoto:") or not re.fullmatch(r"\d+", eid):
        if not str(eid).startswith("anikoto:"):
            raise HTTPException(
                status_code=400,
                detail="Non-numeric episode IDs must use anikoto: prefix or be a plain numeric megaplay id",
            )
        if anilist_id is None:
            raise HTTPException(
                status_code=400,
                detail="anilist_id is required for anikoto: episode ids",
            )
        parts = eid.split(":", 2)
        if not (len(parts) >= 2 and parts[1].isdigit()):
            raise HTTPException(status_code=400, detail="Invalid anikoto: episode id format")
        anikoto_ep_id = int(parts[1])
        stream_url = await _anikoto_full_stream(anilist_id, anikoto_ep_id, category)
        if not stream_url:
            raise HTTPException(status_code=404, detail="Anikoto stream not found for this episode")
        # Extract realid from the s-2 URL (e.g. megaplay.buzz/stream/s-2/169837/sub)
        m = re.search(r"/stream/s-2/(\d+)/", stream_url)
        if not m:
            raise HTTPException(status_code=502, detail="Could not extract numeric id from anikoto stream url")
        realid = m.group(1)
        # Fetch the s-2 page to get data-id (which getSources actually needs)
        data_id = await _megaplay_realid_to_sources_id(realid, category)
        numeric_id = data_id or realid  # fall back to realid if data-id parse fails
        eid = numeric_id  # fall through to the direct getSources call below

    client = await session_manager.get_client()
    url = f"{GET_SOURCES_ENDPOINT}?id={quote(eid, safe='')}"
    referer = f"{MEGAPLAY_BASE}/stream/s-2/{eid}/{category}"
    headers = _megaplay_getsources_headers(referer)

    try:
        resp = await _upstream_get(client, url, headers=headers, timeout=12.0)
        resp.raise_for_status()
        out = resp.json()
        _log_stream_urls_from_payload(
            "upstream_getsources_ok",
            out,
            episode_id=eid,
            category=category,
            get_sources_url=url,
        )
        return _maybe_rewrap_media(out, rewrite_base)
    except httpx.HTTPStatusError as e:
        log.error("megaplay_sources_http_error", error=str(e), status=e.response.status_code)
        raise HTTPException(status_code=e.response.status_code, detail="Failed to fetch streaming sources")
    except HTTPException:
        raise
    except Exception as e:
        log.error("megaplay_sources_error", error=str(e))
        raise HTTPException(status_code=502, detail=str(e)[:200])


# ─── FastAPI Application ─────────────────────────────────────────────────────


@asynccontextmanager
async def _app_lifespan(_app: FastAPI):
    await discord_logger.start()
    _provider_cache_load()
    _schedule_title_index_refresh()
    log.info(
        "app_startup",
        stream_upstream=MEGAPLAY_BASE,
        embed_s2_mode=_embed_s2_mode(),
        config_path=STREAM_CONFIG_PATH,
        provider_cache=str(_CACHE_DB_PATH),
    )
    await session_manager.get_client()
    yield
    await session_manager.close()
    await discord_logger.stop()




# ─── Root Endpoint ───────────────────────────────────────────────────────────

async def root():
    return {
        "name": "VaultCeaser Anime API",
        "version": "2.0.0",
        "description": "Anime metadata (AniList GraphQL) + streaming (Miruro pipe + Megaplay)",
        "endpoints": {
            # Search & Discovery
            "/api/genres": "List all available anime genres",
            "/api/search": "Search anime by query with genre filter",
            "/api/filter": "Advanced filter (genre, year, season, format, status)",
            "/api/suggestions": "Lightweight autocomplete search",
            "/api/spotlight": "Top trending/popular anime for hero section",
            # Collections
            "/api/trending": "Trending anime (paginated)",
            "/api/popular": "Most popular anime (paginated)",
            "/api/upcoming": "Upcoming anime (paginated)",
            "/api/recent": "Currently airing anime (paginated)",
            "/api/schedule": "Airing schedule with timestamps",
            "/api/homepage": "All homepage sections in one request",
            # Anime Details
            "/api/anime/{id}": "Full anime info (metadata + characters + relations)",
            "/api/anime/{id}/characters": "Paginated character list with voice actors",
            "/api/anime/{id}/relations": "Related media (sequels, prequels, etc.)",
            "/api/anime/{id}/recommendations": "Community recommendations",
            # Streaming
            "/api/episode-counts": "Batch released sub/dub counts (Megaplay)",
            "/api/anime/{id}/episodes": "Episode list with streaming slugs",
            "/api/anime/{id}/stream": "Episodes with embedded streaming URLs",
            "/api/sources": "Get streaming sources (m3u8) for an episode",
            "/api/stream/url": "Direct m3u8 streaming URL",
            "/api/stream/iframe": "Megaplay iframe URL (depends on embed_s2_mode: upstream vs /api/mp/)",
            "/api/mp/{path}": "Reverse proxy to stream embed host (vidwish / megaplay) + assets",
            "/api/cdn-hls": "Proxy m3u8/segments with Megaplay Referer (Cloudflare-friendly)",
            "/api/pipe": "Direct pipe proxy (advanced)",
            # Health
            "/health": "Health check",
            "/api/health": "Pipe bases + circuit breaker status",
            "/docs.html": "Static API & architecture reference (same as repo docs.html)",
        },
    }


async def serve_docs_html():
    """Human-readable API reference (mirrors ``docs.html`` in the repo root)."""
    if not _DOCS_HTML_PATH.is_file():
        raise HTTPException(status_code=404, detail="docs.html not found")
    return FileResponse(_DOCS_HTML_PATH, media_type="text/html; charset=utf-8")


async def health():
    return {"status": "ok", "version": "2.0.0"}


# ─── Genres ──────────────────────────────────────────────────────────────────

async def get_genres():
    """Return list of available anime genres/formats/etc."""
    return {
        "genres": GENRES,
        "formats": FORMATS,
        "statuses": STATUSES,
        "seasons": SEASONS,
        "providers": PROVIDERS,
        "categories": CATEGORIES,
    }


# ─── Jikan helpers shared by browse endpoints ────────────────────────────────

# MAL genre name → numeric ID (most common genres)
_JIKAN_GENRE_IDS: Dict[str, int] = {
    "Action": 1, "Adventure": 2, "Comedy": 4, "Drama": 8, "Fantasy": 10,
    "Horror": 14, "Mystery": 7, "Romance": 22, "Sci-Fi": 24, "Slice of Life": 36,
    "Sports": 30, "Supernatural": 37, "Suspense": 41, "Ecchi": 9,
    "Mecha": 18, "Music": 19, "Psychological": 40, "Thriller": 41,
    "Historical": 13, "Kids": 15, "Military": 38, "Parody": 20, "Police": 39,
    "School": 23, "Super Power": 31, "Vampire": 32, "Yaoi": 33, "Yuri": 26,
    "Isekai": 62, "Demons": 6, "Game": 11, "Magic": 16, "Martial Arts": 17,
    "Samurai": 21, "Space": 29, "Cars": 3,
}

_JIKAN_STATUS_MAP = {
    "RELEASING": "airing", "FINISHED": "complete", "NOT_YET_RELEASED": "upcoming",
    "airing": "airing", "complete": "complete", "upcoming": "upcoming",
}

_JIKAN_TYPE_MAP = {
    "TV": "tv", "MOVIE": "movie", "OVA": "ova", "ONA": "ona", "SPECIAL": "special",
    "tv": "tv", "movie": "movie", "ova": "ova", "ona": "ona", "special": "special",
}

# For browse/sort, map legacy AniList sort names to (order_by, sort_dir)
_JIKAN_ORDER_MAP: Dict[str, Tuple[Optional[str], str]] = {
    "POPULARITY_DESC": ("popularity", "asc"),
    "POPULARITY_ASC": ("popularity", "desc"),
    "TRENDING_DESC": ("members", "desc"),
    "SCORE_DESC": ("score", "desc"),
    "SCORE_ASC": ("score", "asc"),
    "SEARCH_MATCH": ("members", "desc"),
    "UPDATED_AT_DESC": ("members", "desc"),
    "START_DATE_DESC": ("start_date", "desc"),
    "START_DATE_ASC": ("start_date", "asc"),
    "END_DATE_DESC": ("end_date", "desc"),
    "END_DATE_ASC": ("end_date", "asc"),
}


def _genres_to_ids(genre_str: Optional[str]) -> Optional[str]:
    """Convert comma-separated genre names to comma-separated MAL genre IDs."""
    if not genre_str:
        return None
    ids = []
    for g in genre_str.split(","):
        g = g.strip()
        gid = _JIKAN_GENRE_IDS.get(g)
        if gid:
            ids.append(str(gid))
    return ",".join(ids) if ids else None


# ─── Search ──────────────────────────────────────────────────────────────────

async def search_anime(
    q: str = Query("", description="Search query"),
    page: int = Query(1, ge=1, description="Page number"),
    per_page: int = Query(20, ge=1, le=50, alias="perPage", description="Results per page"),
    genre: Optional[str] = Query(None, description="Genre filter (comma-separated names)"),
    format: Optional[str] = Query(None, description="Format: TV, MOVIE, OVA, etc."),
    status: Optional[str] = Query(None, description="Status: RELEASING, FINISHED, NOT_YET_RELEASED"),
    year: Optional[int] = Query(None, description="Release year"),
    season: Optional[str] = Query(None, description="Season: WINTER, SPRING, SUMMER, FALL"),
    sort: str = Query("SEARCH_MATCH", description="Sort order"),
):
    """Search anime via Jikan (MAL). Covers all anime including Netflix originals."""
    ob, sd = _JIKAN_ORDER_MAP.get(sort, ("members", "desc"))
    jikan_status = _JIKAN_STATUS_MAP.get((status or "").upper())
    jikan_type = _JIKAN_TYPE_MAP.get((format or "").upper())
    genre_ids = _genres_to_ids(genre)
    result = await _jikan_search(
        q=q, page=page, per_page=per_page,
        type_=jikan_type, status=jikan_status,
        genres=genre_ids, order_by=ob, sort=sd,
    )
    return {
        "page": result["pageInfo"]["currentPage"],
        "perPage": per_page,
        "total": result["pageInfo"]["total"],
        "hasNextPage": result["pageInfo"]["hasNextPage"],
        "results": result["results"],
    }


# ─── Suggestions ─────────────────────────────────────────────────────────────

async def search_suggestions(
    q: str = Query(..., min_length=1, description="Search query for autocomplete"),
):
    """Autocomplete from local title index; never blocks on external APIs."""
    _schedule_title_index_refresh()
    return {"results": _title_index_search(q, limit=8)}


# ─── Filter / Browse ─────────────────────────────────────────────────────────

async def filter_anime(
    genre: Optional[str] = Query(None, description="Genre (comma-separated names): Action, Romance, etc."),
    tag: Optional[str] = Query(None, description="Tag (mapped to genre when possible)"),
    year: Optional[int] = Query(None, description="Release year"),
    season: Optional[str] = Query(None, description="WINTER, SPRING, SUMMER, FALL"),
    format: Optional[str] = Query(None, description="TV, MOVIE, OVA, ONA, SPECIAL"),
    status: Optional[str] = Query(None, description="RELEASING, FINISHED, NOT_YET_RELEASED"),
    sort: str = Query("POPULARITY_DESC", description="Sort order"),
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=50, alias="perPage"),
):
    """Advanced anime filter via Jikan (MAL)."""
    ob, sd = _JIKAN_ORDER_MAP.get(sort, ("popularity", "asc"))
    jikan_status = _JIKAN_STATUS_MAP.get((status or "").upper())
    jikan_type = _JIKAN_TYPE_MAP.get((format or "").upper())
    # Combine genre + tag into genre IDs (tag is treated as genre when it maps)
    combined = ",".join(filter(None, [genre, tag]))
    genre_ids = _genres_to_ids(combined) if combined else None

    if year and season and not genre_ids and not jikan_status and not jikan_type:
        # Use seasonal endpoint for year+season browsing — it's better suited
        result = await _jikan_seasonal(year=year, season=season.lower(), page=page, per_page=per_page)
    else:
        params: dict = {"page": page, "limit": per_page}
        if jikan_type:
            params["type"] = jikan_type
        if jikan_status:
            params["status"] = jikan_status
        if genre_ids:
            params["genres"] = genre_ids
        if ob:
            params["order_by"] = ob
            params["sort"] = sd
        if year:
            params["start_date"] = f"{year}-01-01"
            params["end_date"] = f"{year}-12-31"
        data = await _jikan_get("/anime", params, ttl=_JIKAN_TTL_SHORT)
        pg = data.get("pagination", {})
        result = {
            "results": [_jikan_to_anime(a) for a in (data.get("data") or [])],
            "pageInfo": {
                "total": pg.get("items", {}).get("total", 0),
                "currentPage": pg.get("current_page", page),
                "hasNextPage": pg.get("has_next_page", False),
            },
        }

    return {
        "page": result["pageInfo"]["currentPage"],
        "perPage": per_page,
        "total": result["pageInfo"]["total"],
        "hasNextPage": result["pageInfo"]["hasNextPage"],
        "results": result["results"],
    }


# ─── Spotlight (Hero Section) ────────────────────────────────────────────────

async def get_spotlight():
    """Top 10 currently airing anime for hero carousel."""
    result = await _jikan_top(type_="tv", filter_="airing", page=1, per_page=10)
    return {"results": result["results"]}


# ─── Collection Endpoints ────────────────────────────────────────────────────

async def _fetch_collection(sort_type: str, status: Optional[str] = None, page: int = 1, per_page: int = 20):
    """Internal helper — kept for homepage compatibility, backed by Jikan."""
    jikan_filter = _JIKAN_STATUS_MAP.get(status or "", None) if status else None
    ob, sd = _JIKAN_ORDER_MAP.get(sort_type, ("popularity", "asc"))
    if jikan_filter == "airing":
        result = await _jikan_top(type_="tv", filter_="airing", page=page, per_page=per_page)
    elif jikan_filter == "upcoming":
        result = await _jikan_top(type_="tv", filter_="upcoming", page=page, per_page=per_page)
    elif ob == "start_date":
        result = await _jikan_seasonal(page=page, per_page=per_page)
    else:
        result = await _jikan_top(type_="tv", filter_="bypopularity", page=page, per_page=per_page)
    return {
        "page": result["pageInfo"]["currentPage"],
        "perPage": per_page,
        "total": result["pageInfo"]["total"],
        "hasNextPage": result["pageInfo"]["hasNextPage"],
        "results": result["results"],
    }


async def get_trending(page: int = Query(1, ge=1), per_page: int = Query(20, ge=1, le=50)):
    result = await _jikan_top(type_="tv", filter_="airing", page=page, per_page=per_page)
    return {"page": result["pageInfo"]["currentPage"], "perPage": per_page,
            "total": result["pageInfo"]["total"], "hasNextPage": result["pageInfo"]["hasNextPage"],
            "results": result["results"]}


async def get_popular(page: int = Query(1, ge=1), per_page: int = Query(20, ge=1, le=50)):
    result = await _jikan_top(type_="tv", filter_="bypopularity", page=page, per_page=per_page)
    return {"page": result["pageInfo"]["currentPage"], "perPage": per_page,
            "total": result["pageInfo"]["total"], "hasNextPage": result["pageInfo"]["hasNextPage"],
            "results": result["results"]}


async def get_upcoming(page: int = Query(1, ge=1), per_page: int = Query(20, ge=1, le=50)):
    result = await _jikan_top(type_="tv", filter_="upcoming", page=page, per_page=per_page)
    return {"page": result["pageInfo"]["currentPage"], "perPage": per_page,
            "total": result["pageInfo"]["total"], "hasNextPage": result["pageInfo"]["hasNextPage"],
            "results": result["results"]}


async def get_recent(page: int = Query(1, ge=1), per_page: int = Query(20, ge=1, le=50)):
    """Currently airing — seasonal."""
    result = await _jikan_seasonal(page=page, per_page=per_page)
    return {"page": result["pageInfo"]["currentPage"], "perPage": per_page,
            "total": result["pageInfo"]["total"], "hasNextPage": result["pageInfo"]["hasNextPage"],
            "results": result["results"]}

# /api/latest-releases is an alias for /api/recent
get_latest_releases = get_recent


async def get_fresh(page: int = Query(1, ge=1), per_page: int = Query(20, ge=1, le=50)):
    """Fresh additions — recently updated by member count."""
    result = await _jikan_top(type_="tv", filter_="airing", page=page, per_page=per_page)
    return {"page": result["pageInfo"]["currentPage"], "perPage": per_page,
            "total": result["pageInfo"]["total"], "hasNextPage": result["pageInfo"]["hasNextPage"],
            "results": result["results"]}


async def get_recently_completed(page: int = Query(1, ge=1), per_page: int = Query(20, ge=1, le=50)):
    """Recently finished anime."""
    result = await _jikan_search(q="", page=page, per_page=per_page,
                                 status="complete", order_by="end_date", sort="desc")
    return {"page": result["pageInfo"]["currentPage"], "perPage": per_page,
            "total": result["pageInfo"]["total"], "hasNextPage": result["pageInfo"]["hasNextPage"],
            "results": result["results"]}


# ─── Schedule ────────────────────────────────────────────────────────────────

async def get_schedule(
    page: int = Query(1, ge=1),
    per_page: int = Query(25, ge=1, le=50),
    day: Optional[str] = Query(None, description="Day filter: monday–sunday"),
):
    """Broadcast schedule from MAL via Jikan."""
    result = await _jikan_schedule(day=day, page=page, per_page=per_page)
    return {"page": result["pageInfo"]["currentPage"], "perPage": per_page,
            "total": result["pageInfo"]["total"], "hasNextPage": result["pageInfo"]["hasNextPage"],
            "results": result["results"]}


# ─── Anime Full Info ─────────────────────────────────────────────────────────

async def get_anime_info(mal_id: int):
    """Get comprehensive anime info by MAL ID."""
    try:
        media = await _jikan_anime(mal_id)
    except Exception:
        raise HTTPException(status_code=404, detail="Anime not found")
    return {
        "id": mal_id,
        "info": media,
        "streaming": {
            "has_episodes": bool(media.get("episodes")),
            "total_episodes": media.get("episodes") or 0,
            "status": media.get("status"),
            "episodes_url": f"/api/anime/{mal_id}/episodes",
            "stream_url": f"/api/anime/{mal_id}/stream",
        },
    }


# ─── Anime Characters ────────────────────────────────────────────────────────

async def get_anime_characters(mal_id: int):
    """Character list with voice actors from MAL."""
    try:
        chars = await _jikan_characters(mal_id)
    except Exception:
        raise HTTPException(status_code=404, detail="Anime not found")
    return {"total": len(chars), "characters": chars}


# ─── Anime Relations ─────────────────────────────────────────────────────────

async def get_anime_relations(mal_id: int):
    """Related anime (sequels, prequels, side stories, etc.) from MAL."""
    try:
        relations = await _jikan_relations(mal_id)
    except Exception:
        raise HTTPException(status_code=404, detail="Anime not found")
    return {"id": mal_id, "relations": relations}


# ─── Anime Recommendations ───────────────────────────────────────────────────

async def get_anime_recommendations(mal_id: int):
    """Community recommendations from MAL."""
    try:
        recs = await _jikan_recommendations(mal_id)
    except Exception:
        raise HTTPException(status_code=404, detail="Anime not found")
    return {"total": len(recs), "recommendations": recs}


# ─── Episode counts ──────────────────────────────────────────────────────────


async def _resolve_episode_counts(mal_id: int, refresh: bool = True) -> Dict[str, int]:
    ep_resp = await _fast_episode_payload(mal_id, refresh=refresh)
    eps = ep_resp.get("providers", {}).get("megaplay", {}).get("episodes", {})
    return {
        "sub": len(eps.get("sub") or []),
        "dub": len(eps.get("dub") or []),
    }


async def _refresh_episode_counts_background(mal_id: int) -> None:
    try:
        async with _EP_COUNTS_BACKGROUND_SEM:
            counts = await asyncio.wait_for(_resolve_episode_counts(mal_id, refresh=True), timeout=25.0)
        # Persist only useful provider/Jikan fallback results. A provider miss
        # should not poison the cache as "confirmed no episodes".
        if (counts.get("sub") or 0) > 0 or (counts.get("dub") or 0) > 0:
            _EP_COUNTS_CACHE[mal_id] = (time.monotonic(), counts)
            _provider_cache_save_episode_counts(mal_id, counts)
    except Exception as exc:
        log.debug("episode_counts_background_failed", mal_id=mal_id, error=str(exc)[:120])
    finally:
        _EP_COUNTS_REFRESH_TASKS.pop(mal_id, None)


def _schedule_episode_counts_refresh(mal_id: int) -> None:
    task = _EP_COUNTS_REFRESH_TASKS.get(mal_id)
    if task and not task.done():
        return
    _EP_COUNTS_REFRESH_TASKS[mal_id] = asyncio.create_task(_refresh_episode_counts_background(mal_id))


async def batch_episode_counts(
    ids: str = Query(..., description="Comma-separated MAL IDs (max 50)"),
    refresh: bool = Query(False, description="Compatibility no-op; use warm=true to refresh cache"),
    warm: bool = Query(False, description="Schedule a background provider refresh"),
    blocking: bool = Query(False, description="Wait for live provider refresh; never use from browser grids"),
):
    """Released sub/dub counts for browse/home cards.

    Normal calls are cache-only and never touch upstream providers. This keeps
    homepage traffic from stampeding Jikan/Anikoto. Use warm=true from an admin
    job if you want background refreshes.
    """
    id_list: List[int] = [int(p) for p in ids.split(",") if p.strip().isdigit()][:50]
    if not id_list:
        return {"counts": {}}

    sem = asyncio.Semaphore(2)

    async def one(mid: int) -> Tuple[int, Dict[str, int]]:
        now = time.monotonic()
        cached = _EP_COUNTS_CACHE.get(mid)
        if cached and not blocking:
            if warm and (now - cached[0]) >= _EP_COUNTS_CACHE_TTL:
                _schedule_episode_counts_refresh(mid)
            return mid, cached[1]

        # Homepage/browse calls must be cheap. Missing cache returns unknown
        # immediately; provider warming is explicit to avoid upstream 429s.
        if not blocking:
            if warm:
                _schedule_episode_counts_refresh(mid)
            return mid, {"sub": 0, "dub": 0}

        async with sem:
            try:
                counts = await asyncio.wait_for(_resolve_episode_counts(mid, refresh=True), timeout=25.0)
                if (counts.get("sub") or 0) > 0 or (counts.get("dub") or 0) > 0:
                    _provider_cache_save_episode_counts(mid, counts)
                _EP_COUNTS_CACHE[mid] = (time.monotonic(), counts)
                return mid, counts
            except Exception:
                if cached:
                    return mid, cached[1]
                return mid, {"sub": 0, "dub": 0}

    pairs = await asyncio.gather(*[one(i) for i in id_list])
    return {"counts": {str(mid): counts for mid, counts in pairs}}


def _episode_payload_item(mal_id: int, number: int, title: Optional[str] = None, **extra: Any) -> Dict[str, Any]:
    item: Dict[str, Any] = {
        "id": f"mal:{mal_id}:{number}",
        "number": number,
        "title": title or f"Episode {number}",
        "original_id": f"mal:{mal_id}:{number}",
    }
    item.update({k: v for k, v in extra.items() if v is not None})
    return item


async def _fast_episode_payload(mal_id: int, refresh: bool = False) -> Dict[str, Any]:
    """Fast episode payload using the stream provider list first, Jikan only as fallback."""
    now = time.monotonic()
    cached = _MAL_EPISODES_CACHE.get(mal_id)
    if cached and not refresh and (now - cached[0]) < _MAL_EPISODES_CACHE_TTL:
        return cached[1]

    sub_list: List[Dict[str, Any]] = []
    dub_list: List[Dict[str, Any]] = []

    anikoto_id = await _mal_to_anikoto_id(mal_id)
    if anikoto_id:
        try:
            try:
                provider_eps = await _anikoto_api_get_episodes(anikoto_id)
            except Exception as exc:
                log.debug("anikoto_api_episode_list_failed", mal_id=mal_id, anikoto_id=anikoto_id, error=str(exc)[:120])
                provider_eps = await _anikoto_get_episodes(anikoto_id)
            for e in provider_eps:
                number = int(e.get("number") or 0)
                if number <= 0:
                    continue
                item = _episode_payload_item(
                    mal_id,
                    number,
                    e.get("title"),
                    provider_episode_id=e.get("episode_embed_id") or e.get("anikoto_ep_id"),
                )
                if e.get("sub"):
                    sub_list.append(item)
                if e.get("dub"):
                    dub_list.append(item)
            # Some providers do not mark flags reliably; if we parsed rows, expose them as sub.
            if provider_eps and not sub_list:
                sub_list = [
                    _episode_payload_item(mal_id, int(e["number"]), e.get("title"), provider_episode_id=e.get("anikoto_ep_id"))
                    for e in provider_eps
                    if int(e.get("number") or 0) > 0
                ]
        except Exception as exc:
            log.warning("provider_episode_list_failed", mal_id=mal_id, anikoto_id=anikoto_id, error=str(exc)[:120])

    if not sub_list:
        try:
            data = await _jikan_get(f"/anime/{mal_id}", ttl=_JIKAN_TTL_LONG)
            total = int(data.get("data", {}).get("episodes") or 0)
        except Exception:
            total = 0
        if total > 0:
            sub_list = [_episode_payload_item(mal_id, n) for n in range(1, total + 1)]

    payload = {
        "id": mal_id,
        "providers": {
            "megaplay": {
                "episodes": {
                    "sub": sub_list,
                    "dub": dub_list,
                    "ssub": sub_list,
                }
            }
        },
        "released": {"sub": len(sub_list), "dub": len(dub_list)},
    }
    _MAL_EPISODES_CACHE[mal_id] = (time.monotonic(), payload)
    return payload


async def get_anime_episodes(mal_id: int):
    """Fast episode list with mal:{mal_id}:{episode} IDs for iframe streaming."""
    payload = await _fast_episode_payload(mal_id)
    eps = payload.get("providers", {}).get("megaplay", {}).get("episodes", {})
    if not (eps.get("sub") or eps.get("dub") or eps.get("ssub")):
        raise HTTPException(status_code=404, detail="Episodes not found")
    return payload


# ─── Episodes with Streaming URLs (one-stop, Anikoto-backed) ─────────────────

async def get_anime_stream(
    mal_id: int,
    provider: str = Query("megaplay", description="Streaming provider (megaplay only)"),
    category: str = Query("sub", description="sub, dub, or ssub"),
    episode_number: Optional[int] = Query(None, description="Specific episode number (omit for all)"),
):
    """Episodes with streaming URLs — uses mal: episode IDs against megaplay MAL endpoint."""
    ep_resp = await get_anime_episodes(mal_id)
    providers = ep_resp.get("providers", {})
    episodes = providers.get("megaplay", {}).get("episodes", {}).get(category, [])

    if not episodes:
        raise HTTPException(status_code=404, detail=f"No episodes found for category '{category}'")

    if episode_number is not None:
        episodes = [ep for ep in episodes if ep.get("number") == episode_number]
        if not episodes:
            raise HTTPException(status_code=404, detail=f"Episode {episode_number} not found")

    return {
        "id": mal_id,
        "provider": "megaplay",
        "category": category,
        "total_episodes": len(episodes),
        "episodes": episodes,
    }


def _make_episode_slug(ep: dict, provider: str, anilist_id: int, category: str) -> str:
    """Build a human-readable slug from episode data."""
    orig_id = ep.get("id", "")
    prefix = orig_id.split(":")[0] if ":" in orig_id else orig_id
    ep_num = ep.get("number", 1)
    return f"watch/{provider}/{anilist_id}/{category}/{prefix}-{ep_num}"


async def _fetch_single_source_raw(anilist_id: int, episode: dict, provider: str, category: str) -> dict:
    """Fetch streaming source for a single episode using raw (pre-slug) episode ID."""
    try:
        episode_id = episode.get("id", "")
        if provider == "megaplay":
            raw = await get_megaplay_sources(str(episode_id), category=category, anilist_id=anilist_id)
            streams = _normalize_megaplay_sources_payload(raw).get("streams") or []
            if streams:
                return {
                    "success": True,
                    "url": streams[0].get("url", ""),
                    "subtitles": raw.get("tracks", []),
                    "intro": raw.get("intro", {}),
                    "outro": raw.get("outro", {}),
                }
            return {"success": False, "error": "No sources found"}
        return {"success": False, "error": f"Unsupported provider {provider!r}; use megaplay"}
    except Exception as e:
        return {"success": False, "error": str(e)}


# ─── Sources ─────────────────────────────────────────────────────────────────

async def get_sources(
    request: Request,
    episode_id: str = Query(..., description="Megaplay episode ID (numeric / pipe id from bee)"),
    provider: str = Query("megaplay", description="Must be megaplay"),
    anilist_id: int = Query(..., description="AniList anime ID"),
    category: str = Query("sub", description="sub, dub, or ssub"),
):
    """Get M3U8 streaming sources for an episode via upstream ``/stream/getSources``."""
    if provider != "megaplay":
        raise HTTPException(status_code=400, detail="Only provider=megaplay is supported")
    base = str(request.base_url).rstrip("/")
    raw = await get_megaplay_sources(
        episode_id,
        category=category,
        anilist_id=anilist_id,
        rewrite_base=base,
    )
    return {
        "id": anilist_id,
        "provider": provider,
        "category": category,
        "sources": _normalize_megaplay_sources_payload(raw),
    }


# ─── Direct Streaming URL (m3u8) ─────────────────────────────────────────────

async def get_streaming_url(
    request: Request,
    episode_id: str = Query(..., description="Episode ID from sources endpoint"),
    provider: str = Query("megaplay", description="Provider"),
    category: str = Query("sub", description="Category"),
    anilist_id: int = Query(0, description="AniList anime ID (unused for megaplay)"),
):
    """Get the direct m3u8 streaming URL for direct player use."""
    if provider != "megaplay":
        raise HTTPException(status_code=400, detail="Only provider=megaplay is supported")

    base = str(request.base_url).rstrip("/")
    data = await get_megaplay_sources(
        episode_id,
        category=category,
        anilist_id=anilist_id if anilist_id else None,
        rewrite_base=base,
    )
    norm = _normalize_megaplay_sources_payload(data)
    sources = norm.get("streams") or []

    if not sources:
        raise HTTPException(status_code=404, detail="No streaming sources found")

    source_url = sources[0].get("url", "")
    if not source_url:
        raise HTTPException(status_code=404, detail="No streaming URL in response")

    tracks = norm.get("tracks", [])
    intro = norm.get("intro", {})
    outro = norm.get("outro", {})

    return {
        "url": source_url,
        "type": "hls",
        "tracks": tracks,
        "intro": intro,
        "outro": outro,
        "server": norm.get("server", 0),
    }


def _synthetic_megaplay_embed_html(episode_id: str, category: str) -> str:
    """Minimal same-origin player when ``embed_s2_mode`` is ``synthetic`` (hls.js + TextTracks from getSources)."""
    ep = json.dumps(episode_id)
    cat = json.dumps(_normalize_stream_category(category))
    return (
        _SYNTHETIC_MEGAPLAY_EMBED_TEMPLATE
        .replace("__EP_JSON__", ep)
        .replace("__CAT_JSON__", cat)
    )


_SYNTHETIC_MEGAPLAY_EMBED_TEMPLATE = """<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Stream</title>
<script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
<style>html,body{margin:0;height:100%;background:#000;color:#ccc;font:14px system-ui,sans-serif}
#v{width:100%;height:100%;object-fit:contain}#err{padding:16px;line-height:1.5}</style>
</head><body>
<video id="v" controls playsinline crossorigin="anonymous"></video>
<div id="err" style="display:none"></div>
<script>
const EP_ID = __EP_JSON__;
const CATEGORY = __CAT_JSON__;
const errEl = document.getElementById('err');
const v = document.getElementById('v');
const search = new URLSearchParams(location.search);
let autoSkipEnabled = search.get('autoskip') === '1';
const resumeSeconds = Math.max(0, Number(search.get('t') || '0') || 0);
let activeIntro = null;
let activeOutro = null;
let didResume = false;
let lastProgressPostAt = 0;

function fail(msg) {
  errEl.style.display = 'block';
  errEl.textContent = msg;
  v.style.display = 'none';
  try { parent.postMessage({ type: 'vaultceaser:player-error', message: msg }, '*'); } catch (e) {}
}
function post(type, extra) {
  try {
    parent.postMessage(Object.assign({
      type: type,
      currentTime: Number(v.currentTime || 0),
      duration: Number(v.duration || 0)
    }, extra || {}), '*');
  } catch (e) {}
}
function numeric(value) {
  var n = Number(value);
  return isFinite(n) ? n : null;
}
function rangeFrom(raw) {
  if (!raw || typeof raw !== 'object') return null;
  var start = numeric(raw.start);
  if (start === null) start = numeric(raw.from);
  if (start === null) start = numeric(raw.begin);
  var end = numeric(raw.end);
  if (end === null) end = numeric(raw.to);
  if (start === null || end === null || end <= start) return null;
  return { start: start, end: end };
}
function tryResume() {
  if (didResume || !resumeSeconds) return;
  if (v.duration && resumeSeconds >= v.duration - 4) return;
  try {
    v.currentTime = resumeSeconds;
    didResume = true;
    post('vaultceaser:player-resumed', { currentTime: resumeSeconds });
  } catch (e) {}
}
function applyAutoSkip() {
  if (!autoSkipEnabled || !v.duration || v.seeking) return;
  var t = Number(v.currentTime || 0);
  [activeIntro, activeOutro].forEach(function(r) {
    if (!r) return;
    if (t >= r.start - 0.35 && t < r.end - 0.5) {
      var next = Math.min(r.end + 0.05, Math.max(0, v.duration - 0.35));
      if (next > t) {
        v.currentTime = next;
        post('vaultceaser:player-skipped', { skippedTo: next });
      }
    }
  });
}
function attachTracks(videoEl, data) {
  (data.tracks || []).forEach(function(t, i) {
    var src = t.file || t.url;
    if (!src) return;
    var kind = String(t.kind || 'subtitles').toLowerCase();
    if (kind !== 'subtitles' && kind !== 'captions') return;
    var TK = document.createElement('track');
    TK.kind = (kind === 'captions') ? 'captions' : 'subtitles';
    TK.label = String(t.label || ('Subtitles ' + (i + 1))).replace(/</g, '');
    var lang = t.srclang || t.lang || '';
    if (lang) TK.srclang = String(lang).slice(0, 12);
    TK.src = src;
    if (t.default) TK.default = true;
    videoEl.appendChild(TK);
  });
}
function createHlsWithCdnBaseFix() {
  var Base = Hls.DefaultConfig && Hls.DefaultConfig.loader;
  if (!Base) return new Hls({ enableWorker: false });
  class FixUrlLoader extends Base {
    load(context, config, callbacks) {
      var oc = callbacks.onSuccess;
      var wrapped = Object.assign({}, callbacks, {
        onSuccess: function(response, stats, ctx, networkDetails) {
          try {
            if (response && response.url && response.url.indexOf('/api/cdn-hls') !== -1) {
              var pu = new URL(response.url, location.origin);
              var inner = pu.searchParams.get('u');
              if (inner) response = Object.assign({}, response, { url: decodeURIComponent(inner) });
            }
          } catch (e) {}
          oc(response, stats, ctx, networkDetails);
        },
      });
      super.load(context, config, wrapped);
    }
  }
  return new Hls({ enableWorker: false, loader: FixUrlLoader });
}
const qs = new URLSearchParams({ id: EP_ID });
const aid = new URLSearchParams(location.search).get('aid');
if (aid) qs.set('aid', aid);
qs.set('category', CATEGORY);
fetch(location.origin + '/api/mp/stream/getSources?' + qs.toString(), { credentials: 'omit' })
  .then(function(r) { if (!r.ok) throw new Error('getSources HTTP ' + r.status); return r.json(); })
  .then(function(data) {
    var src = data.sources;
    if (src && !Array.isArray(src)) src = [src];
    var file = (src && src[0] && src[0].file) || '';
    if (!file) { fail('No stream in getSources response'); return; }
    activeIntro = rangeFrom(data.intro);
    activeOutro = rangeFrom(data.outro);
    attachTracks(v, data);
    var tracks = data.tracks || [];
    var preferHls = (file.indexOf('/api/cdn-hls') !== -1) || tracks.length > 0;
    if (!preferHls && v.canPlayType('application/vnd.apple.mpegurl')) {
      v.src = file;
      v.play().catch(function(){});
      return;
    }
    if (window.Hls && Hls.isSupported()) {
      var hls = createHlsWithCdnBaseFix();
      hls.loadSource(file);
      hls.attachMedia(v);
      hls.on(Hls.Events.MANIFEST_PARSED, function() { tryResume(); v.play().catch(function(){}); });
      hls.on(Hls.Events.ERROR, function(_, d) {
        if (d && d.fatal) fail('Playback error: ' + (d.type || '') + ' ' + (d.details || ''));
      });
      return;
    }
    if (v.canPlayType('application/vnd.apple.mpegurl')) {
      v.src = file;
      v.play().catch(function(){});
      return;
    }
    fail('HLS not supported in this browser');
  })
  .catch(function(e) { fail(e.message || String(e)); });
var endedSent = false;
function notifyEnded() {
  if (endedSent) return;
  endedSent = true;
  try { parent.postMessage({ type: 'vaultceaser:episode-ended' }, '*'); } catch (e) {}
}
window.addEventListener('message', function(event) {
  var data = event.data || {};
  if (data.type === 'vaultceaser:set-auto-skip') {
    autoSkipEnabled = !!data.enabled;
  }
  if (data.type === 'vaultceaser:seek' && isFinite(Number(data.seconds))) {
    v.currentTime = Math.max(0, Number(data.seconds));
  }
});
v.addEventListener('loadedmetadata', function() {
  tryResume();
  post('vaultceaser:player-ready');
});
v.addEventListener('ended', notifyEnded);
v.addEventListener('timeupdate', function() {
  applyAutoSkip();
  var now = Date.now();
  if (now - lastProgressPostAt >= 1000) {
    lastProgressPostAt = now;
    post('vaultceaser:timeupdate');
  }
  if (v.duration && !isNaN(v.duration) && v.currentTime >= v.duration - 1.5) notifyEnded();
});
</script>
</body></html>"""


def _iframe_category_from_referer(request: Request) -> str:
    """Last path segment of s-2 embed URL: sub | dub | ssub."""
    ref = request.headers.get("referer") or ""
    mim = re.search(r"/api/mp/stream/s-2/[^/]+/([^/?#]+)", ref)
    if not mim:
        mim = re.search(r"/stream/s-2/[^/]+/([^/?#]+)", ref)
    return _normalize_stream_category(mim.group(1) if mim else None)


def _resolve_embed_category(request: Request) -> str:
    """Prefer explicit ``category`` query (synthetic embed always sends it); else Referer s-2 path."""
    return _normalize_stream_category(
        request.query_params.get("category") or request.query_params.get("cat")
    ) if (
        request.query_params.get("category") or request.query_params.get("cat")
    ) else _iframe_category_from_referer(request)


async def _megaplay_proxy_get_sources(request: Request, path: str) -> Response:
    """Megaplay getSources — resolves numeric ids directly; anikoto: ids via anikoto stream chain."""
    api_base = str(request.base_url).rstrip("/")
    raw_id = request.query_params.get("id") or request.query_params.get("episodeId")
    if not raw_id:
        raise HTTPException(status_code=400, detail="Missing id")
    eid = unquote(str(raw_id))
    aid_q = request.query_params.get("aid")
    anilist_id: Optional[int] = int(aid_q) if aid_q is not None and str(aid_q).isdigit() else None
    iframe_cat = _resolve_embed_category(request)

    async def via_anikoto() -> Optional[str]:
        """Resolve non-numeric episode id to a getSources numeric data-id via anikoto stream chain."""
        if str(eid).startswith("anikoto:") and anilist_id is not None:
            parts = eid.split(":", 2)
            if len(parts) >= 2 and parts[1].isdigit():
                anikoto_ep_id = int(parts[1])
                stream_url = await _anikoto_full_stream(anilist_id, anikoto_ep_id, iframe_cat)
                if stream_url:
                    m_rid = re.search(r"/stream/s-2/(\d+)/", stream_url)
                    if m_rid:
                        return await _megaplay_realid_to_sources_id(m_rid.group(1), iframe_cat)
        if str(eid).startswith("mal:"):
            parts = eid.split(":", 3)
            if len(parts) >= 3 and parts[1].isdigit() and parts[2].isdigit():
                mal_id, ep_num = parts[1], parts[2]
                data_id = await _megaplay_realid_to_sources_id(f"mal_{mal_id}_{ep_num}", iframe_cat)
                if not data_id:
                    # Fetch the mal/ embed page HTML to get data-id
                    try:
                        client = await session_manager.get_client()
                        embed_url = f"{MEGAPLAY_BASE}/stream/mal/{mal_id}/{ep_num}/{iframe_cat}"
                        r = await client.get(embed_url, headers={"User-Agent": USER_AGENT, "Referer": f"{MEGAPLAY_BASE}/"}, follow_redirects=True)
                        m = re.search(r'data-id="(\d+)"', r.text)
                        if m:
                            data_id = m.group(1)
                    except Exception:
                        pass
                if not data_id:
                    stream_url = await _mapper_resolve_stream(int(mal_id), int(ep_num), iframe_cat)
                    m_stream = re.search(r"/stream/s-2/([^/?#]+)/", stream_url or "")
                    if m_stream:
                        realid = unquote(m_stream.group(1))
                        data_id = await _megaplay_realid_to_sources_id(realid, iframe_cat)
                        if not data_id and realid.isdigit():
                            data_id = realid
                return data_id
        return None

    if not re.fullmatch(r"\d+", eid):
        sources_id = await via_anikoto()
        if not sources_id:
            raise HTTPException(status_code=404, detail="Could not resolve episode to a numeric sources id")
        eid = sources_id

    referer = _megaplay_proxy_referer(request, path)
    url = f"{GET_SOURCES_ENDPOINT}?id={quote(eid, safe='')}"
    client = await session_manager.get_client()
    r = await _upstream_get(client, url, headers=_megaplay_getsources_headers(referer), timeout=12.0)
    if r.status_code == 200:
        j = r.json()
        _log_stream_urls_from_payload(
            "embed_getsources_direct",
            j,
            episode_id=eid,
            iframe_category=iframe_cat,
            get_sources_url=url,
        )
        return JSONResponse(
            content=_maybe_rewrap_media(j, api_base),
            headers={"Cache-Control": "no-store, max-age=0"},
        )
    return Response(
        content=r.content,
        status_code=r.status_code,
        media_type="application/json",
        headers={"Cache-Control": "no-store, max-age=0"},
    )


async def cdn_hls_proxy(
    request: Request,
    u: str = Query(..., description="URL-encoded absolute CDN URL (m3u8 or segment)"),
    cdn_ref: Optional[str] = Query(None, alias="r", description="Per-stream Referer/Origin base (from pipe stream entry)"),
):
    """Fetch HLS from CDNs with correct per-CDN Referer (embedded from pipe sources via r= param)."""
    if request.method == "OPTIONS":
        return Response(status_code=204)
    target = unquote(u)
    if not target.startswith("http://") and not target.startswith("https://"):
        raise HTTPException(status_code=400, detail="Invalid URL")
    up_host = (urlparse(target).hostname or "")
    up_path = (urlparse(target).path or "")[:200]
    log.info(
        "cdn_hls_request",
        method=request.method,
        upstream_host=up_host,
        path_preview=up_path,
        has_range=bool(request.headers.get("range")),
        cdn_referer_override=cdn_ref or "",
    )
    if not _cdn_host_allowed_url(target):
        log.warning("cdn_hls_blocked_not_allowlisted", upstream_host=up_host, target_preview=target[:280])
        raise HTTPException(status_code=400, detail="CDN host not allowlisted")
    hdr = _cdn_upstream_fetch_headers()
    if cdn_ref:
        ref_base = unquote(cdn_ref).rstrip("/")
        hdr["Origin"] = ref_base
        hdr["Referer"] = f"{ref_base}/"
    # Range on .m3u8 → 206 + truncated body; hls.js then mis-resolves relative variant URLs as /api/index-*.m3u8
    rng = request.headers.get("range")
    if rng and not _cdn_url_path_is_m3u8(target):
        hdr["Range"] = rng
    client = await session_manager.get_client()
    if request.method == "HEAD":
        pr = await client.head(target, headers=hdr, follow_redirects=True)
        log.info("cdn_hls_head", upstream_host=up_host, status=pr.status_code)
        return Response(status_code=pr.status_code, headers=_filter_response_headers(dict(pr.headers)))
    r = await _upstream_get(client, target, headers=hdr, timeout=20.0)
    ct = (r.headers.get("content-type") or "").lower()
    head = (r.content[:4096] if r.content else b"").decode("utf-8", errors="ignore")
    peek = ""
    if r.content and len(r.content) < 8000:
        peek = r.content.decode("utf-8", errors="ignore")
    is_pl = _cdn_url_path_is_m3u8(target) or "mpegurl" in ct or head.lstrip().startswith("#EXTM3U")
    cf_ray = r.headers.get("cf-ray") or r.headers.get("CF-Ray") or ""
    log.info(
        "cdn_hls_upstream",
        upstream_host=up_host,
        status=r.status_code,
        final_url=str(r.url) if getattr(r, "url", None) else "",
        content_type_snip=ct[:120],
        is_playlist=is_pl,
        response_bytes=len(r.content or b""),
        cf_ray=cf_ray,
    )
    if r.status_code in (401, 403):
        deny_preview = peek[:600] if peek else (r.text[:600] if hasattr(r, "text") and r.text else "")
        log.warning("cdn_hls_denied", upstream_host=up_host, status=r.status_code, body_preview=deny_preview)
    # After redirects, relative URIs in the playlist are resolved against the final URL, not the original ``u=``.
    playlist_base = str(r.url) if getattr(r, "url", None) else target
    api_base = str(request.base_url).rstrip("/")
    extra: Dict[str, str] = {}
    for name in ("Content-Range", "Accept-Ranges"):
        if name in r.headers:
            extra[name] = r.headers[name]
    if is_pl and r.status_code in (200, 206):
        new_body = _rewrite_m3u8_for_cdn_proxy(r.text, playlist_base, api_base, cdn_referer=cdn_ref or "").encode("utf-8")
        extra["Content-Length"] = str(len(new_body))
        return Response(
            content=new_body,
            status_code=200,
            media_type="application/vnd.apple.mpegurl",
            headers=extra,
        )
    fh = _filter_response_headers(dict(r.headers))
    for k in list(fh.keys()):
        if k.lower() in ("content-length", "content-type"):
            fh.pop(k, None)
    fh["Content-Length"] = str(len(r.content))
    # VTT subtitles served as application/octet-stream by CDN; browser rejects <track> unless text/vtt
    if (urlparse(target).path or "").lower().endswith(".vtt"):
        fh["Content-Type"] = "text/vtt; charset=utf-8"
    elif ct:
        fh["Content-Type"] = ct.split(";")[0].strip()
    fh.update(extra)
    return Response(content=r.content, status_code=r.status_code, headers=fh)


# ─── Iframe Embed ────────────────────────────────────────────────────────────


async def _anikoto_resolve_stream_id(
    episode_id: str,
    category: str,
    anilist_id: int,
) -> Optional[str]:
    """Resolve anikoto: episode id → numeric vidwish/megaplay stream id.

    If episode_id is already numeric, passes through. Otherwise extracts the
    numeric realid from the megaplay s-2 URL returned by the anikoto stream chain.
    """
    if re.fullmatch(r"\d+", str(episode_id)):
        return str(episode_id)
    if str(episode_id).startswith("anikoto:"):
        parts = str(episode_id).split(":", 2)
        if len(parts) >= 2 and parts[1].isdigit():
            anikoto_ep_id = int(parts[1])
            url = await _anikoto_full_stream(anilist_id, anikoto_ep_id, category)
            if url:
                m = re.search(r"/stream/s-2/(\d+)/", url)
                if m:
                    return m.group(1)
    return None


async def _megaplay_proxy_upstream_asset(request: Request, path: str) -> Response:
    """GET/HEAD a path on ``MEGAPLAY_BASE`` with embed headers; rewrite HTML/CSS/JS for /api/mp/ origin."""
    target = f"{MEGAPLAY_BASE}/{path}"
    if request.url.query:
        target = f"{target}?{request.url.query}"
    referer = _megaplay_proxy_referer(request, path)
    if "getSources" in path:
        fwd_headers = _megaplay_getsources_headers(referer)
    else:
        fwd_headers = {
            "User-Agent": USER_AGENT,
            "Accept": request.headers.get("accept", "*/*"),
            "Accept-Language": request.headers.get("accept-language", "en-US,en;q=0.9"),
            "Referer": referer,
            "Origin": MEGAPLAY_BASE,
        }
    client = await session_manager.get_client()
    if request.method == "HEAD":
        r = await client.head(target, headers=fwd_headers, follow_redirects=True)
        return Response(
            status_code=r.status_code,
            headers=_filter_response_headers(dict(r.headers)),
        )
    r = await client.get(target, headers=fwd_headers, follow_redirects=True)
    public_base = str(request.base_url).rstrip("/")
    ct = r.headers.get("content-type") or ""
    ct_lower = ct.lower()
    hdrs = _filter_response_headers(dict(r.headers))
    hdrs = {k: v for k, v in hdrs.items() if k.lower() != "content-type"}

    if "text/html" in ct_lower:
        text = _rewrite_megaplay_html(r.text, public_base)
        body = text.encode("utf-8")
        hdrs["Content-Length"] = str(len(body))
        return Response(
            content=body,
            status_code=r.status_code,
            media_type="text/html; charset=utf-8",
            headers=hdrs,
        )

    if r.status_code == 200 and "text/css" in ct_lower:
        text = _rewrite_megaplay_css(r.text)
        body = text.encode("utf-8")
        hdrs["Content-Length"] = str(len(body))
        return Response(
            content=body,
            status_code=r.status_code,
            media_type=ct.split(";")[0].strip() or "text/css",
            headers=hdrs,
        )

    if r.status_code == 200 and ("javascript" in ct_lower or "ecmascript" in ct_lower):
        text = _rewrite_megaplay_js(r.text)
        body = text.encode("utf-8")
        hdrs["Content-Length"] = str(len(body))
        return Response(
            content=body,
            status_code=r.status_code,
            media_type=ct.split(";")[0].strip() or "application/javascript",
            headers=hdrs,
        )

    hdrs["Content-Length"] = str(len(r.content))
    return Response(
        content=r.content,
        status_code=r.status_code,
        media_type=ct.split(";")[0].strip() if ct else None,
        headers=hdrs,
    )


async def megaplay_reverse_proxy(path: str, request: Request):
    """Reverse-proxy Megaplay APIs/assets. ``embed_s2_mode`` controls ``stream/s-2`` (see ``config.json``)."""
    if request.method == "OPTIONS":
        return Response(status_code=204)

    # ── stream/mal/{mal_id}/{ep}/{cat} — resolve via anikoto then redirect ──────
    m_mal = re.match(r"^stream/mal/(\d+)/(\d+)/(sub|dub|ssub)$", path)
    if m_mal:
        mal_id_r = int(m_mal.group(1))
        ep_num_r = int(m_mal.group(2))
        cat_r    = m_mal.group(3)
        stream_url = await _mapper_resolve_stream(mal_id_r, ep_num_r, cat_r)
        if stream_url:
            # vidwish /stream/s-2/ → proxy through /api/mp/
            m_s2 = re.search(r"/(stream/s-2/\d+/[^/?&#]+)", stream_url)
            if m_s2:
                loc = f"/api/mp/{m_s2.group(1)}"
                if request.url.query:
                    loc = f"{loc}?{request.url.query}"
                return RedirectResponse(loc, status_code=302)
            # any other embeddable URL → redirect directly
            if request.url.query:
                sep = "&" if "?" in stream_url else "?"
                stream_url = f"{stream_url}{sep}{request.url.query}"
            return RedirectResponse(stream_url, status_code=302)
        direct_url = f"{MEGAPLAY_BASE}/stream/mal/{mal_id_r}/{ep_num_r}/{cat_r}"
        if request.url.query:
            direct_url = f"{direct_url}?{request.url.query}"
        return RedirectResponse(direct_url, status_code=302)

    m_s2 = re.match(r"^stream/s-2/(.+)/([^/]+)$", path)
    if m_s2:
        force_synthetic = str(request.query_params.get("synthetic", "")).lower() in (
            "1",
            "true",
            "yes",
            "on",
        )
        mode = "synthetic" if force_synthetic else _embed_s2_mode()
        ep_raw, cat_raw = unquote(m_s2.group(1)), unquote(m_s2.group(2))
        if mode == "synthetic":
            if request.method == "HEAD":
                return Response(status_code=200, media_type="text/html")
            return HTMLResponse(
                content=_synthetic_megaplay_embed_html(ep_raw, cat_raw),
                headers={"Cache-Control": "no-store, max-age=0"},
            )
        if mode == "upstream":
            # vidwish JW player only works with numeric /stream/s-2/{id}/… (bun.har)
            play_id = ep_raw if re.fullmatch(r"\d+", ep_raw) else None
            if not play_id:
                aid_q = request.query_params.get("aid")
                if aid_q and str(aid_q).isdigit():
                    play_id = await _anikoto_resolve_stream_id(
                        ep_raw, cat_raw, int(aid_q)
                    )
            if play_id:
                loc = f"{MEGAPLAY_BASE}/stream/s-2/{play_id}/{cat_raw}"
                if request.url.query:
                    loc = f"{loc}?{request.url.query}"
                return RedirectResponse(loc, status_code=307)
            if request.method == "HEAD":
                return Response(status_code=200, media_type="text/html")
            return HTMLResponse(
                content=_synthetic_megaplay_embed_html(ep_raw, cat_raw),
                headers={"Cache-Control": "no-store, max-age=0"},
            )
        # proxy — fall through to full upstream fetch/rewrite

    if request.method == "HEAD" and "getSources" in path:
        return Response(status_code=200, media_type="application/json")

    if request.method == "GET" and "getSources" in path:
        return await _megaplay_proxy_get_sources(request, path)

    return await _megaplay_proxy_upstream_asset(request, path)


async def get_streaming_iframe(
    request: Request,
    episode_id: str = Query(..., description="Episode ID for the iframe"),
    category: str = Query("sub", description="Category: sub, dub, ssub"),
    anilist_id: Optional[int] = Query(None, alias="anilist_id", description="AniList id for slug episode ids"),
    aid: Optional[int] = Query(None, description="Alias for anilist_id"),
    synthetic: bool = Query(False, description="Force the same-origin hls.js player"),
):
    """Iframe URL — resolves mal:, anikoto:, and numeric episode IDs."""
    base = str(request.base_url).rstrip("/")
    cat_norm = _normalize_stream_category(category)
    aid_val = anilist_id if anilist_id is not None else aid

    # ── ep:NUMBER with mal_id context → rewrite to mal: format ───────────────
    if str(episode_id).startswith("ep:"):
        ep_num_str = str(episode_id)[3:]
        if ep_num_str.isdigit() and aid_val is not None:
            episode_id = f"mal:{aid_val}:{ep_num_str}"

    extra_query = {
        key: value
        for key, value in request.query_params.items()
        if key not in {"episode_id", "category", "anilist_id", "aid", "_", "synthetic"}
    }

    def attach_query(url: str, extra: Optional[Dict[str, Any]] = None) -> str:
        qs = {k: v for k, v in {**extra_query, **(extra or {})}.items() if v is not None}
        if not qs:
            return url
        return f"{url}{'&' if '?' in url else '?'}{urlencode(qs)}"

    # ── mal:{mal_id}:{ep_num} — direct megaplay MAL endpoint ─────────────────
    if str(episode_id).startswith("mal:"):
        parts = str(episode_id).split(":", 3)
        if len(parts) >= 3 and parts[1].isdigit() and parts[2].isdigit():
            mal_id, ep_num = parts[1], parts[2]
            upstream = f"{MEGAPLAY_BASE}/stream/mal/{mal_id}/{ep_num}/{cat_norm}"
            iframe_url = attach_query(upstream)
            return {
                "embed_s2_mode": "upstream",
                "iframe_url": iframe_url,
                "resolved_stream_id": None,
                "upstream_iframe_url": upstream,
                "upstream_iframe_numeric_only": False,
                "category": cat_norm,
                "episode_id": episode_id,
                "embed_html": (
                    f'<iframe src="{iframe_url}" allowfullscreen="" '
                    f'scrolling="no" style="width:100%;height:100%;border:none;overflow:hidden;">'
                    f"</iframe>"
                ),
            }

    # ── Anikoto episode IDs (format: "anikoto:{ep_id}") ──────────────────────
    if str(episode_id).startswith("anikoto:"):
        parts = str(episode_id).split(":", 2)
        if len(parts) >= 2 and parts[1].isdigit():
            anikoto_ep_id = int(parts[1])
            url = await _anikoto_full_stream(aid_val or 0, anikoto_ep_id, cat_norm)
            if url:
                if synthetic:
                    stream_m = re.search(r"/stream/s-2/([^/?#]+)/([^/?#]+)", url)
                    if stream_m:
                        resolved_ep = quote(unquote(stream_m.group(1)), safe="")
                        resolved_cat = _normalize_stream_category(unquote(stream_m.group(2)))
                        iframe_url = attach_query(
                            f"{base}/api/mp/stream/s-2/{resolved_ep}/{resolved_cat}",
                            {
                                "aid": str(aid_val) if aid_val is not None else None,
                                "synthetic": "1",
                            },
                        )
                        return {
                            "embed_s2_mode": "synthetic",
                            "iframe_url": iframe_url,
                            "resolved_stream_id": unquote(stream_m.group(1)),
                            "upstream_iframe_url": url,
                            "upstream_iframe_numeric_only": False,
                            "category": resolved_cat,
                            "episode_id": episode_id,
                            "embed_html": (
                                f'<iframe src="{iframe_url}" allowfullscreen="" '
                                f'scrolling="no" style="width:100%;height:100%;border:none;overflow:hidden;">'
                                f"</iframe>"
                            ),
                        }
                log.debug("stream_source_anikoto", anikoto_ep_id=anikoto_ep_id, category=cat_norm)
                return {
                    "embed_s2_mode": "anikoto",
                    "iframe_url": url,
                    "resolved_stream_id": None,
                    "upstream_iframe_url": url,
                    "upstream_iframe_numeric_only": False,
                    "category": cat_norm,
                    "episode_id": episode_id,
                    "embed_html": (
                        f'<iframe src="{url}" allowfullscreen="" '
                        f'scrolling="no" style="width:100%;height:100%;border:none;overflow:hidden;">'
                        f"</iframe>"
                    ),
                }
            log.warning("anikoto_stream_miss", anikoto_ep_id=anikoto_ep_id, category=cat_norm)
            raise HTTPException(status_code=404, detail="Stream not found for this episode")

    # ── Megaplay direct flow (legacy numeric IDs, kept for compatibility) ──────
    eid_proxied = quote(str(episode_id), safe="")
    eid_upstream = quote(str(episode_id), safe=":/-._~=")
    raw_megaplay = f"{IFRAME_ENDPOINT}/{eid_upstream}/{category}"
    mode = _embed_s2_mode()
    effective_mode = "synthetic" if synthetic else mode
    numeric = bool(re.fullmatch(r"\d+", str(episode_id)))
    synthetic_extra = {}
    if aid_val is not None:
        synthetic_extra["aid"] = str(aid_val)
    if effective_mode == "synthetic":
        synthetic_extra["synthetic"] = "1"
    play_id = str(episode_id)
    resolved_numeric = numeric
    if effective_mode == "upstream" and not numeric and aid_val is not None:
        nid = await _anikoto_resolve_stream_id(play_id, category, int(aid_val))
        if nid:
            play_id = nid
            resolved_numeric = True
    if effective_mode == "upstream" and resolved_numeric:
        iframe_url = attach_query(f"{IFRAME_ENDPOINT}/{play_id}/{category}", {"aid": str(aid_val)} if aid_val is not None else None)
    else:
        iframe_url = attach_query(
            f"{base}/api/mp/stream/s-2/{eid_proxied}/{category}",
            synthetic_extra,
        )
    return {
        "embed_s2_mode": effective_mode,
        "iframe_url": iframe_url,
        "resolved_stream_id": play_id if resolved_numeric else None,
        "upstream_iframe_url": raw_megaplay,
        "upstream_iframe_numeric_only": not resolved_numeric,
        "category": category,
        "episode_id": episode_id,
        "embed_html": (
            f'<iframe src="{iframe_url}" allowfullscreen="" '
            f'scrolling="no" style="width:100%;height:100%;border:none;overflow:hidden;">'
            f"</iframe>"
        ),
    }


# ─── Homepage (All Sections) ─────────────────────────────────────────────────

async def health_check():
    """Check liveness of streaming upstream and metadata API."""
    async def probe(name: str, url: str) -> dict:
        async with httpx.AsyncClient(timeout=6.0, follow_redirects=True) as hc:
            try:
                t0 = time.monotonic()
                r = await hc.head(url, headers={"User-Agent": USER_AGENT, "Accept": "*/*"})
                latency_ms = int((time.monotonic() - t0) * 1000)
                return {"name": name, "url": url,
                        "status": "ok" if r.status_code < 500 else "error",
                        "http": r.status_code, "latency_ms": latency_ms}
            except Exception as e:
                return {"name": name, "url": url, "status": "down", "error": str(e)[:120]}

    results = list(await asyncio.gather(
        probe("megaplay", MEGAPLAY_BASE),
        probe("jikan", "https://api.jikan.moe/v4"),
    ))
    overall = "ok" if any(r["status"] == "ok" for r in results) else "degraded"
    return {
        "status": overall,
        "upstreams": results,
        "config": STREAM_CONFIG_PATH,
        "embed_s2_mode": _embed_s2_mode(),
        "stream_upstream_base": MEGAPLAY_BASE,
    }


async def get_homepage():
    """Get all homepage sections in one request (trending, popular, movies, upcoming, recent, schedule)."""
    tasks = {
        "trending": _fetch_collection("TRENDING_DESC", page=1, per_page=12),
        "popular": _fetch_collection("POPULARITY_DESC", page=1, per_page=12),
        "upcoming": _fetch_collection("POPULARITY_DESC", "NOT_YET_RELEASED", page=1, per_page=12),
        "recent": _fetch_collection("START_DATE_DESC", "RELEASING", page=1, per_page=12),
    }

    results = await asyncio.gather(*tasks.values(), return_exceptions=True)
    result_map = {}
    for i, key in enumerate(tasks.keys()):
        r = results[i]
        result_map[key] = r if not isinstance(r, Exception) else {"results": []}

    return {
        "trending_airing": result_map["trending"],
        "popular_upcoming": result_map["upcoming"],
        "recent_episodes": result_map["recent"],
        "all_time_popular": result_map["popular"],
        "top_movies": [],
        "schedule": [],
    }


# ─── Streaming Player (HTML) ────────────────────────────────────────────────

PLAYER_HTML_TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>VaultCeaser</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0a0a0f;--surface:#12121a;--surface2:#1a1a26;--surface3:#252535;--accent:#1abbd6;--accent2:#e06c9f;--text:#e8e8f0;--text2:#8888a0}
body{background:var(--bg);color:var(--text);font-family:-apple-system,'Segoe UI',system-ui,sans-serif;min-height:100vh}
.app{display:grid;grid-template-columns:1fr 360px;min-height:100vh}
@media(max-width:900px){.app{grid-template-columns:1fr}}
.player-section{position:sticky;top:0;height:100vh;display:flex;flex-direction:column;background:#000}
.player-wrapper{flex:1;position:relative;background:#000;overflow:hidden}
.player-placeholder{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;color:var(--text2)}
.player-placeholder svg{width:64px;height:64px;margin-bottom:12px;opacity:0.4}
.player-placeholder h2{font-size:1.2rem;font-weight:500}
.player-placeholder p{font-size:0.85rem;margin-top:4px}
.player-frame{width:100%;height:100%;border:0;background:#000;display:none}
.player-bar{padding:10px 16px;background:var(--surface);border-top:1px solid var(--surface2);display:none;align-items:center;gap:10px}
.ep-badge{background:var(--accent);color:#000;font-size:0.7rem;font-weight:700;padding:2px 8px;border-radius:4px;flex-shrink:0}
.ep-label{font-size:0.88rem;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sidebar{background:var(--surface);border-left:1px solid var(--surface2);overflow-y:auto;display:flex;flex-direction:column}
.anime-header{padding:18px;border-bottom:1px solid var(--surface2)}
.anime-header .backdrop{position:relative;border-radius:8px;overflow:hidden;margin-bottom:12px}
.anime-header .backdrop img{width:100%;height:130px;object-fit:cover}
.anime-header .backdrop .ov{position:absolute;inset:0;background:linear-gradient(0deg,var(--surface) 0%,transparent 60%)}
.anime-header .row{display:flex;gap:12px;align-items:flex-start}
.anime-header .poster{width:54px;height:76px;border-radius:6px;object-fit:cover;flex-shrink:0;margin-top:-36px;position:relative;border:2px solid var(--surface)}
.anime-header .info{flex:1;min-width:0}
.anime-header h1{font-size:0.95rem;font-weight:600;line-height:1.3}
.anime-header .sub{font-size:0.72rem;color:var(--text2);margin-top:2px}
.meta{display:flex;flex-wrap:wrap;gap:5px;margin-top:7px}
.meta span{background:var(--surface2);padding:2px 7px;border-radius:10px;font-size:0.68rem;color:var(--text2)}
.meta .score{background:var(--accent2);color:#fff}
.ep-section{padding:14px 16px;flex:1}
.section-hd{font-size:0.75rem;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--text2);margin-bottom:10px;display:flex;align-items:center;gap:6px}
.cat-bar{display:flex;gap:5px;margin-bottom:10px;flex-wrap:wrap;align-items:center}
.cat-label{font-size:0.7rem;font-weight:700;letter-spacing:.06em;color:var(--accent);margin-right:4px}
.cat-btn{background:var(--surface2);color:var(--text2);border:1px solid transparent;padding:3px 10px;border-radius:5px;font-size:0.72rem;cursor:pointer;transition:all .15s}
.cat-btn:hover{border-color:var(--accent)}
.cat-btn.active{background:var(--accent);color:#000;border-color:var(--accent);font-weight:600}
.ep-list{display:flex;flex-direction:column;gap:4px}
.ep-item{padding:9px 10px;border-radius:7px;cursor:pointer;transition:all .15s;border:1px solid transparent}
.ep-item:hover{background:var(--surface2)}
.ep-item.active{background:var(--surface2);border-color:var(--accent)}
.ep-num{font-size:0.68rem;font-weight:700;color:var(--accent)}
.ep-name{font-size:0.8rem;font-weight:500;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ep-air{font-size:0.63rem;color:var(--text2);margin-top:2px}
.sk{animation:pulse 1.5s ease-in-out infinite;background:var(--surface2);border-radius:4px}
@keyframes pulse{0%,100%{opacity:.6}50%{opacity:1}}
.sidebar::-webkit-scrollbar{width:5px}
.sidebar::-webkit-scrollbar-thumb{background:var(--surface3);border-radius:3px}
</style>
</head>
<body>
<div class="app">
  <div class="player-section">
    <div class="player-wrapper" id="playerWrapper">
      <div class="player-placeholder" id="placeholder">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/><path d="M15.5 12l-5-3v6l5-3z"/></svg>
        <h2>Select an episode</h2>
        <p>Choose an episode from the list to start watching</p>
      </div>
      <iframe id="playerFrame" class="player-frame" title="Stream"
        allow="autoplay; fullscreen; encrypted-media; picture-in-picture" allowfullscreen
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"></iframe>
    </div>
    <div class="player-bar" id="playerBar">
      <span class="ep-badge" id="epBadge"></span>
      <span class="ep-label" id="epLabel"></span>
    </div>
  </div>

  <div class="sidebar">
    <div class="anime-header" id="animeHeader">
      <div class="sk" style="height:130px;border-radius:8px;margin-bottom:12px"></div>
      <div class="row">
        <div class="sk" style="width:54px;height:76px;border-radius:6px;margin-top:-36px;flex-shrink:0"></div>
        <div class="info">
          <div class="sk" style="height:13px;width:75%;margin-bottom:7px;border-radius:3px"></div>
          <div class="sk" style="height:11px;width:45%;border-radius:3px"></div>
        </div>
      </div>
    </div>
    <div class="ep-section">
      <div class="section-hd">Episodes <span style="font-weight:400" id="epCount"></span></div>
      <div class="cat-bar" id="catBar"></div>
      <div class="ep-list" id="epList">
        <div class="sk" style="height:50px;margin-bottom:4px"></div>
        <div class="sk" style="height:50px;margin-bottom:4px"></div>
        <div class="sk" style="height:50px"></div>
      </div>
    </div>
  </div>
</div>

<script>
const MAL_ID = {{MAL_ID}};
let cat = 'sub';
let allEps = {};

const placeholder = document.getElementById('placeholder');
const playerFrame = document.getElementById('playerFrame');
const playerBar   = document.getElementById('playerBar');
const epBadge     = document.getElementById('epBadge');
const epLabel     = document.getElementById('epLabel');
const epList      = document.getElementById('epList');
const catBar      = document.getElementById('catBar');
const epCount     = document.getElementById('epCount');

function epToSrc(id, category) {
  const p = id.split(':');
  if (p[0] === 'mal' && p[1] && p[2]) return `/api/mp/stream/mal/${p[1]}/${p[2]}/${category}`;
  if (/^\d+$/.test(id)) return `/api/mp/stream/s-2/${id}/${category}`;
  return null;
}

async function loadAnime() {
  try {
    const d = await fetch(`/api/anime/${MAL_ID}`).then(r=>r.json());
    renderHeader(d.info);
  } catch(e) {}
}

function renderHeader(i) {
  const h = document.getElementById('animeHeader');
  const title = i.title?.english || i.title?.romaji || '';
  const banner = i.bannerImage || i.coverImage?.large || '';
  const poster = i.coverImage?.large || '';
  document.title = title ? `VaultCeaser — ${title}` : 'VaultCeaser';
  h.innerHTML = `
    <div class="backdrop">
      <img src="${banner}" alt="" onerror="this.style.display='none'">
      <div class="ov"></div>
    </div>
    <div class="row">
      <img class="poster" src="${poster}" alt="" onerror="this.style.display='none'">
      <div class="info">
        <h1>${title}</h1>
        <div class="sub">${i.title?.native||''}</div>
        <div class="meta">
          ${i.score?`<span class="score">★ ${i.score}</span>`:''}
          ${i.format?`<span>${i.format}</span>`:''}
          ${i.year?`<span>${i.year}</span>`:''}
          ${i.episodes?`<span>${i.episodes} ep</span>`:''}
          ${(i.genres||[]).slice(0,3).map(g=>`<span>${g}</span>`).join('')}
        </div>
      </div>
    </div>`;
}

async function loadEpisodes() {
  try {
    const d = await fetch(`/api/anime/${MAL_ID}/episodes`).then(r=>r.json());
    allEps = d.providers?.megaplay?.episodes || {};
    renderCatBar();
    renderEpList();
  } catch(e) {}
}

function renderCatBar() {
  catBar.innerHTML = `<span class="cat-label">PLAYBACK</span>` +
    ['sub','dub','ssub'].map(c=>`<button type="button" class="cat-btn${c===cat?' active':''}" data-c="${c}">${c.toUpperCase()}</button>`).join('');
  catBar.querySelectorAll('.cat-btn').forEach(b=>{
    b.addEventListener('click',()=>{
      cat=b.dataset.c;
      catBar.querySelectorAll('.cat-btn').forEach(x=>x.classList.remove('active'));
      b.classList.add('active');
      playerFrame.src='about:blank';
      playerFrame.style.display='none';
      placeholder.style.display='flex';
      playerBar.style.display='none';
      renderEpList();
    });
  });
}

function renderEpList() {
  const eps = allEps[cat] || [];
  epCount.textContent = `(${eps.length})`;
  if (!eps.length) { epList.innerHTML = '<p style="color:var(--text2);padding:16px;font-size:0.82rem">No episodes for this category.</p>'; return; }
  epList.innerHTML = eps.map(ep=>`
    <div class="ep-item" data-id="${ep.id}" data-n="${ep.number}" data-t="${(ep.title||'').replace(/"/g,'&quot;')}">
      <div class="ep-num">EP ${ep.number}</div>
      <div class="ep-name">${ep.title||`Episode ${ep.number}`}</div>
      ${ep.aired?`<div class="ep-air">${ep.aired}</div>`:''}
    </div>`).join('');
  epList.querySelectorAll('.ep-item').forEach(el=>el.addEventListener('click',()=>play(el)));
}

function play(el) {
  const src = epToSrc(el.dataset.id, cat);
  if (!src) return;
  epList.querySelectorAll('.ep-item').forEach(e=>e.classList.remove('active'));
  el.classList.add('active');
  placeholder.style.display='none';
  playerFrame.style.display='block';
  playerFrame.src=src;
  epBadge.textContent=`EP ${el.dataset.n}`;
  epLabel.textContent=el.dataset.t||`Episode ${el.dataset.n}`;
  playerBar.style.display='flex';
}

loadAnime();
loadEpisodes();
</script>
</body>
</html>
"""


async def watch_anime(mal_id: int):
    """Full watch page for a given MAL ID."""
    html = PLAYER_HTML_TEMPLATE.replace("{{MAL_ID}}", str(mal_id))
    return HTMLResponse(content=html)


async def embed_player(
    mal_id: int = Query(..., description="MAL anime ID"),
    ep: int = Query(1, description="Episode number"),
    cat: str = Query("sub", description="sub, dub, or ssub"),
):
    """
    Minimal iframe-embed page. Drop this into any website:

        <iframe src="https://yourserver/api/embed?mal_id=21&ep=1&cat=sub"
                allowfullscreen allow="autoplay; fullscreen; picture-in-picture"
                style="width:100%;aspect-ratio:16/9;border:none"></iframe>
    """
    cat_norm = _normalize_stream_category(cat)
    stream_src = f"/api/mp/stream/mal/{mal_id}/{ep}/{cat_norm}"
    html = f"""<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>*{{margin:0;padding:0;box-sizing:border-box}}html,body{{width:100%;height:100%;background:#000;overflow:hidden}}iframe{{width:100%;height:100%;border:none}}</style>
</head><body>
<iframe src="{stream_src}"
  allow="autoplay; fullscreen; encrypted-media; picture-in-picture" allowfullscreen
  sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox">
</iframe>
</body></html>"""
    return HTMLResponse(content=html)


# ─── Direct Pipe Proxy ───────────────────────────────────────────────────────

# /api/pipe removed — Miruro pipe no longer used.


# ─── Entry Point ─────────────────────────────────────────────────────────────

