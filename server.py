"""
Miruro/Megaplay Anime Streaming API - Python Backend
Combines AniList GraphQL (metadata) + Miruro pipe API (episodes/sources)
Provides RESTful endpoints for frontend consumption with proper session handling.
"""

import asyncio
import base64
from contextlib import asynccontextmanager
import gzip
import json
import logging
import os
import re
import sys
import time
import logging
from typing import Any, Dict, List, Optional, Tuple, Union
from urllib.parse import quote, unquote, urlparse, urljoin, urlencode
from pathlib import Path

import wreq as _wreq

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

load_dotenv()

# ─── config.json (streaming + global) ─────────────────────────────────────────
# Defaults follow ``bun.har`` (vidwish embed, watching.onl / cloudbuzz / livedns segments, miruro.tv pipe).
# Set env ``VAULTCEASER_CONFIG`` to a different JSON path to override location.

_DEFAULT_STREAM_CONFIG: Dict[str, Any] = {
    # Primary pipe base — change here or in config.json to swap providers without touching code.
    # If miruro.tv goes down, add a fallback under "pipe_fallback_bases".
    "miruro_base": "https://www.miruro.tv",
    # Additional pipe base URLs tried in order when primary is unavailable.
    # Same /api/secure/pipe contract required.
    "pipe_fallback_bases": [],
    # Seconds a failed pipe endpoint stays marked as dead before being retried.
    "pipe_dead_ttl": 120,
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
    # upstream: resolves numeric ID via pipe, uses vidwish.live JWPlayer directly (correct player, bun.har behavior)
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


MIRURO_BASE = str(_STREAM_CFG["miruro_base"]).rstrip("/")
MEGAPLAY_BASE = str(_STREAM_CFG["stream_upstream_base"]).rstrip("/")
ANILIST_URL = str(_STREAM_CFG["anilist_url"]).rstrip("/")
PIPE_ENDPOINT = f"{MIRURO_BASE}/api/secure/pipe"
GET_SOURCES_ENDPOINT = f"{MEGAPLAY_BASE}/stream/getSources"
IFRAME_ENDPOINT = f"{MEGAPLAY_BASE}/stream/s-2"

# ─── Pipe circuit-breaker ────────────────────────────────────────────────────
# All candidate pipe bases in priority order: primary first, then fallbacks.
_raw_fallbacks = _STREAM_CFG.get("pipe_fallback_bases") or []
PIPE_BASES: List[str] = [MIRURO_BASE] + [str(b).rstrip("/") for b in _raw_fallbacks if b]
_PIPE_DEAD_TTL: float = float(_STREAM_CFG.get("pipe_dead_ttl", 120))

# {base_url: dead_until_timestamp}  — only set when a base fails; cleared on success
_pipe_dead_until: Dict[str, float] = {}


def _pipe_bases_ordered() -> List[str]:
    """Return pipe bases with currently-alive ones first, dead ones shuffled to end."""
    now = time.monotonic()
    alive = [b for b in PIPE_BASES if _pipe_dead_until.get(b, 0) <= now]
    dead  = [b for b in PIPE_BASES if _pipe_dead_until.get(b, 0) > now]
    return alive + dead


def _mark_pipe_dead(base: str) -> None:
    _pipe_dead_until[base] = time.monotonic() + _PIPE_DEAD_TTL
    log.warning("pipe_base_marked_dead", base=base, retry_in_s=int(_PIPE_DEAD_TTL))


def _mark_pipe_alive(base: str) -> None:
    _pipe_dead_until.pop(base, None)


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

# Single logical provider: Megaplay CDN (Miruro pipe still uses key "bee" for IDs that match megaplay.buzz embeds — see research/01-streaming-pipeline.md)
MEGAPLAY_PIPE_PROVIDER = "bee"
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


# Formats matching AniList
FORMATS = ["TV", "TV_SHORT", "MOVIE", "SPECIAL", "OVA", "ONA", "MUSIC"]

# Statuses matching AniList
STATUSES = ["RELEASING", "FINISHED", "NOT_YET_RELEASED", "CANCELLED", "HIATUS"]

# Seasons
SEASONS = ["WINTER", "SPRING", "SUMMER", "FALL"]

SORT_MAP = {
    "SCORE_DESC": "SCORE_DESC",
    "POPULARITY_DESC": "POPULARITY_DESC",
    "TRENDING_DESC": "TRENDING_DESC",
    "START_DATE_DESC": "START_DATE_DESC",
    "FAVOURITES_DESC": "FAVOURITES_DESC",
    "UPDATED_AT_DESC": "UPDATED_AT_DESC",
    "SEARCH_MATCH": "SEARCH_MATCH",
}

# ─── GraphQL Fragments ───────────────────────────────────────────────────────

MEDIA_LIST_FIELDS = """
    id
    title { romaji english native }
    coverImage { large extraLarge }
    bannerImage
    format
    season
    seasonYear
    episodes
    duration
    status
    averageScore
    meanScore
    popularity
    favourites
    genres
    source
    countryOfOrigin
    isAdult
    studios(isMain: true) { nodes { name isAnimationStudio } }
    nextAiringEpisode { episode airingAt timeUntilAiring }
    startDate { year month day }
    endDate { year month day }
"""

MEDIA_FULL_FIELDS = """
    id
    idMal
    title { romaji english native }
    description(asHtml: false)
    coverImage { large extraLarge color }
    bannerImage
    format
    season
    seasonYear
    episodes
    duration
    status
    averageScore
    meanScore
    popularity
    favourites
    trending
    genres
    tags { name rank isMediaSpoiler }
    source
    countryOfOrigin
    isAdult
    hashtag
    synonyms
    siteUrl
    trailer { id site thumbnail }
    studios { nodes { id name isAnimationStudio siteUrl } }
    nextAiringEpisode { episode airingAt timeUntilAiring }
    startDate { year month day }
    endDate { year month day }
    characters(sort: [ROLE, RELEVANCE], perPage: 25) {
        edges {
            role
            node { id name { full native } image { large } }
            voiceActors(language: JAPANESE) { id name { full native } image { large } languageV2 }
        }
    }
    staff(sort: RELEVANCE, perPage: 25) {
        edges {
            role
            node { id name { full native } image { large } }
        }
    }
    relations {
        edges {
            relationType(version: 2)
            node {
                id
                title { romaji english native }
                coverImage { large }
                bannerImage
                format
                type
                status
                episodes
                meanScore
                isAdult
                seasonYear
                startDate { year month day }
            }
        }
    }
    recommendations(sort: RATING_DESC, perPage: 10) {
        nodes {
            rating
            mediaRecommendation {
                id
                title { romaji english native }
                coverImage { large }
                format
                episodes
                status
                meanScore
                averageScore
            }
        }
    }
    externalLinks { url site type }
    streamingEpisodes { title thumbnail url site }
    stats {
        scoreDistribution { score amount }
        statusDistribution { status amount }
    }
"""

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


# ─── Pipe Encoding / Decoding ────────────────────────────────────────────────

def encode_pipe_payload(path: str, method: str = "GET", query: Optional[dict] = None) -> str:
    """Encode a pipe API payload as URL-safe base64 string."""
    payload: Dict[str, Any] = {
        "path": path,
        "method": method,
        "query": query or {},
        "body": None,
        "version": "0.1.0",
    }
    encoded = base64.urlsafe_b64encode(json.dumps(payload, separators=(",", ":")).encode()).decode()
    encoded = encoded.rstrip("=")
    return encoded


def decode_pipe_response(text: str) -> Any:
    """Decode a pipe API response (URL-safe base64 -> gzip -> JSON)."""
    # Convert URL-safe base64 to standard base64
    text = text.replace("-", "+").replace("_", "/")
    # Fix base64 padding
    missing = len(text) % 4
    if missing:
        text += "=" * (4 - missing)
    # Base64 decode
    compressed = base64.b64decode(text, validate=False)
    # Gzip decompress
    decompressed = gzip.decompress(compressed)
    return json.loads(decompressed)


def _translate_id(encoded_id: str) -> str:
    """Decode a base64-encoded episode ID back to plain text."""
    try:
        decoded = base64.urlsafe_b64decode(encoded_id + "=" * (4 - len(encoded_id) % 4)).decode()
        if ":" in decoded:
            return decoded
        return encoded_id
    except Exception:
        return encoded_id


def _deep_translate(obj):
    """Recursively walk JSON and decode base64 'id' fields."""
    if isinstance(obj, dict):
        for key, value in obj.items():
            if key == "id" and isinstance(value, str):
                obj[key] = _translate_id(value)
            elif isinstance(value, (dict, list)):
                _deep_translate(value)
    elif isinstance(obj, list):
        for item in obj:
            if isinstance(item, (dict, list)):
                _deep_translate(item)


def _megaplay_only_episodes(data: dict) -> dict:
    """Expose only Megaplay-backed episode lists (pipe key `bee` → UI key `megaplay`).

    Per research/01 + research/04: Miruro uses bee category ``ssub`` for streams Megaplay exposes
    at ``/stream/s-2/{id}/sub``. If ``sub`` is empty but ``ssub`` has episodes, copy ``ssub`` → ``sub``
    so the default SUB tab matches production Miruro behavior.
    """
    out = dict(data)
    providers = data.get("providers") or {}
    bee = providers.get(MEGAPLAY_PIPE_PROVIDER)
    if not isinstance(bee, dict):
        bee = {"episodes": {"sub": [], "dub": [], "ssub": []}}
    else:
        bee = dict(bee)
        ep = bee.get("episodes")
        if isinstance(ep, dict):
            ep = dict(ep)
            sub_list = ep.get("sub")
            ssub_list = ep.get("ssub")
            if (not sub_list or (isinstance(sub_list, list) and len(sub_list) == 0)) and ssub_list:
                ep["sub"] = ssub_list
            bee["episodes"] = ep
    out["providers"] = {"megaplay": bee}
    return out


def _released_episode_counts(data: dict) -> Dict[str, int]:
    """Count released sub/dub episodes (raw pipe ``bee`` or already-normalized ``megaplay``)."""
    providers = data.get("providers") or {}
    megaplay = providers.get("megaplay")
    if isinstance(megaplay, dict):
        eps = megaplay.get("episodes") or {}
    else:
        bee = providers.get(MEGAPLAY_PIPE_PROVIDER) or {}
        eps = bee.get("episodes") if isinstance(bee, dict) else {}
    if not isinstance(eps, dict):
        eps = {}
    sub = eps.get("sub") or []
    dub = eps.get("dub") or []
    if (not sub or len(sub) == 0) and eps.get("ssub"):
        sub = eps.get("ssub") or []
    return {
        "sub": len(sub) if isinstance(sub, list) else 0,
        "dub": len(dub) if isinstance(dub, list) else 0,
    }


async def _pipe_sources_bee(
    episode_id: str,
    category: str,
    anilist_id: int,
) -> Any:
    """Miruro pipe sources via Megaplay provider (``bee`` + ``ssub``/``dub``) — bun.har flow."""
    pipe_cat = "ssub" if _normalize_stream_category(category) == "sub" else _normalize_stream_category(category)
    q: Dict[str, Any] = {
        "episodeId": episode_id,
        "provider": MEGAPLAY_PIPE_PROVIDER,
        "category": pipe_cat,
        "ttl": 86400,
    }
    return await call_pipe(
        "sources",
        "GET",
        q,
        referer=f"{MIRURO_BASE}/watch/{anilist_id}",
    )


_EP_COUNTS_CACHE: Dict[int, Tuple[float, Dict[str, int]]] = {}
_EP_COUNTS_CACHE_TTL = 300.0

# ─── Anikoto (anikototv.to) caches ──────────────────────────────────────────

ANIKOTO_BASE = "https://anikototv.to"
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

_anikoto_http_client: Optional[Any] = None  # wreq.Client, typed as Any to avoid import-time binding


async def _fetch_released_counts(anilist_id: int, refresh: bool = False) -> Dict[str, int]:
    now = time.monotonic()
    cached = _EP_COUNTS_CACHE.get(anilist_id)
    if not refresh and cached and (now - cached[0]) < _EP_COUNTS_CACHE_TTL:
        return cached[1]
    try:
        data = await call_pipe(
            "episodes",
            "GET",
            {"anilistId": anilist_id},
            referer=f"{MIRURO_BASE}/watch/{anilist_id}",
        )
        counts = _released_episode_counts(data)
    except Exception as e:
        log.debug("episode_counts_failed", anilist_id=anilist_id, error=str(e)[:80])
        return cached[1] if cached else {"sub": 0, "dub": 0}
    _EP_COUNTS_CACHE[anilist_id] = (time.monotonic(), counts)
    return counts


async def _anikoto_get_counts(anilist_id: int, cache_only: bool = False) -> Optional[Dict[str, int]]:
    """Return sub/dub counts from Anikoto, using cache whenever possible.

    cache_only=True: only reads cache, never fires network requests.
    Returns None if resolution fails so the caller can keep the Miruro result.
    """
    now = time.monotonic()
    # Fast path: anikoto_id + episode list both cached
    id_entry = _ANIKOTO_ID_CACHE.get(anilist_id)
    if id_entry and (now - id_entry[0]) < _ANIKOTO_ID_CACHE_TTL:
        anikoto_id = id_entry[1]
        if anikoto_id is None:
            return None  # previously resolved as not-found
        ep_entry = _ANIKOTO_EP_CACHE.get(anikoto_id)
        if ep_entry and (now - ep_entry[0]) < _ANIKOTO_EP_CACHE_TTL:
            eps = ep_entry[1]
            return {
                "sub": sum(1 for e in eps if e.get("sub")),
                "dub": sum(1 for e in eps if e.get("dub")),
            }

    if cache_only:
        return None  # caller doesn't want to block on network

    # Slow path: full resolution (title lookup → search → episode list)
    try:
        title = await _get_anilist_title(anilist_id)
        if not title:
            return None
        anikoto_id = await _anikoto_resolve_id(anilist_id, title)
        if not anikoto_id:
            return None
        eps = await _anikoto_get_episodes(anikoto_id)
        if not eps:
            return None
        return {
            "sub": sum(1 for e in eps if e.get("sub")),
            "dub": sum(1 for e in eps if e.get("dub")),
        }
    except Exception as e:
        log.debug("anikoto_counts_failed", anilist_id=anilist_id, error=str(e)[:80])
        return None


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
    return f"{MIRURO_BASE}/"


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
    src_items = list(raw.get("sources") or [])
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


# ─── Pipe API Caller ─────────────────────────────────────────────────────────

async def call_pipe(
    path: str,
    method: str = "GET",
    query: Optional[dict] = None,
    referer: str = f"{MIRURO_BASE}/",
) -> Any:
    """Make a proxied call to the pipe API, automatically falling back through PIPE_BASES on failure."""
    client = await session_manager.get_client()
    encoded = encode_pipe_payload(path, method, query)
    last_exc: Exception = RuntimeError("No pipe bases configured")

    for base in _pipe_bases_ordered():
        url = f"{base}/api/secure/pipe?e={encoded}"
        # Adjust Referer/Origin to match the base we're hitting
        ref = referer.replace(MIRURO_BASE, base) if MIRURO_BASE in referer else referer
        headers = {
            "User-Agent": USER_AGENT,
            "Accept": "*/*",
            "Accept-Language": "en-US,en;q=0.9",
            "Accept-Encoding": "gzip, deflate, br, zstd",
            "Referer": ref,
            "Origin": base,
            "Sec-Fetch-Site": "same-origin",
            "Sec-Fetch-Mode": "cors",
            "Sec-Fetch-Dest": "empty",
            "Priority": "u=1, i",
        }
        try:
            resp = await client.get(url, headers=headers)
            resp.raise_for_status()
            text = resp.text.strip()
            if not text:
                raise ValueError("Empty response body")
            data = decode_pipe_response(text)
            _deep_translate(data)
            _mark_pipe_alive(base)
            if base != MIRURO_BASE:
                log.info("pipe_fallback_used", base=base, path=path)
            return data
        except (httpx.HTTPStatusError, httpx.RequestError, ValueError,
                json.JSONDecodeError, gzip.BadGzipFile, base64.binascii.Error) as e:
            status = getattr(getattr(e, "response", None), "status_code", 0)
            log.warning("pipe_base_failed", base=base, path=path, error=str(e)[:120], status=status)
            # 4xx errors from the pipe itself (bad query, auth) — don't mark base as dead
            if isinstance(e, httpx.HTTPStatusError) and 400 <= status < 500:
                raise HTTPException(status_code=status, detail=f"Upstream error: {e.response.text[:200]}")
            _mark_pipe_dead(base)
            last_exc = e

    # All bases exhausted
    raise HTTPException(status_code=502, detail=f"All pipe sources unavailable: {str(last_exc)[:200]}")


# ─── Anikoto HTTP helpers ────────────────────────────────────────────────────


def _get_anikoto_client() -> "_wreq.Client":
    """Lazy shared wreq Client (Chrome TLS fingerprint → avoids bot detection on anikoto)."""
    global _anikoto_http_client
    if _anikoto_http_client is None:
        _anikoto_http_client = _wreq.Client(emulation=_wreq.Emulation.Chrome128)
    return _anikoto_http_client


def _ak_url(path: str, **params) -> str:
    """Build an anikoto URL. wreq doesn't honour params= kwargs, embed them in the URL."""
    return f"{ANIKOTO_BASE}{path}?{urlencode(params)}" if params else f"{ANIKOTO_BASE}{path}"


_AK_HDRS = {
    "Accept": "*/*",
    "X-Requested-With": "XMLHttpRequest",
    "Referer": f"{ANIKOTO_BASE}/",
}


async def _get_anilist_title(anilist_id: int) -> Optional[str]:
    """Lightweight AniList title lookup (english → romaji). Cached."""
    cached = _ANIKOTO_TITLE_CACHE.get(anilist_id)
    if cached:
        return cached
    try:
        data = await anilist_query(
            "query($id:Int!){Media(id:$id,type:ANIME){title{english romaji}}}",
            {"id": anilist_id},
        )
        t = (data.get("Media") or {}).get("title") or {}
        result = t.get("english") or t.get("romaji") or ""
        if result:
            _ANIKOTO_TITLE_CACHE[anilist_id] = result
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
        title = await _get_anilist_title(anilist_id)
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


def _anikoto_episodes_to_response(anilist_id: int, episodes: List[Dict]) -> Dict:
    """Convert anikoto episode list → standard /api/anime/{id}/episodes response shape."""
    sub_eps, dub_eps = [], []
    for ep in episodes:
        oid = f"anikoto:{ep['anikoto_ep_id']}"
        base = {
            "id": oid,
            "original_id": oid,
            "number": ep["number"],
            "title": ep.get("title") or f"Episode {ep['number']}",
        }
        if ep["sub"]:
            sub_eps.append(dict(base))
        if ep["dub"]:
            dub_eps.append(dict(base))
    return {
        "id": anilist_id,
        "episodes": {
            "providers": {
                "megaplay": {"episodes": {"sub": sub_eps, "dub": dub_eps, "ssub": []}}
            }
        },
        "released": {"sub": len(sub_eps), "dub": len(dub_eps)},
    }


# ─── Anikoto search / synthetic ID helpers ───────────────────────────────────

import hashlib as _hashlib

def _slug_to_synthetic_id(slug: str) -> int:
    """Stable 9-digit int in range 900_000_000–998_999_999 for an anikoto slug."""
    h = int(_hashlib.sha256(slug.encode()).hexdigest()[:7], 16) % 99_000_000
    return 900_000_000 + h


def _is_synthetic(anilist_id: int) -> bool:
    return 900_000_000 <= anilist_id < 999_000_000


def _anikoto_parse_search_html(html: str) -> List[Dict]:
    """Parse /ajax/anime/search HTML → list of minimal media-card dicts."""
    results: List[Dict] = []
    blocks = re.findall(
        r'<a[^>]+href="(?:https://anikototv\.to)?/watch/([^"]+)"[^>]*>(.*?)</a>',
        html,
        re.S,
    )
    for slug, inner in blocks:
        slug = slug.split("/")[0]  # strip /ep-N if present
        en_name_m  = re.search(r'class="name d-title"[^>]*data-jp="([^"]*)"[^>]*>([^<]+)', inner)
        if not en_name_m:
            continue
        jp_title = en_name_m.group(1).strip()
        en_title = en_name_m.group(2).strip()
        img_m    = re.search(r'<img[^>]+src="([^"]+)"', inner)
        poster   = img_m.group(1) if img_m else ""
        dots     = re.findall(r'class="dot[^"]*"[^>]*>([^<]+)', inner)
        year_m   = re.search(r"\b(19|20)\d{2}\b", inner)
        year     = int(year_m.group(0)) if year_m else None
        fmt      = "TV"
        for d in dots:
            d = d.strip()
            if d in ("TV", "MOVIE", "OVA", "ONA", "SPECIAL", "TV_SHORT"):
                fmt = d
                break
        synthetic_id = _slug_to_synthetic_id(slug)
        _ANIKOTO_SLUG_CACHE[synthetic_id] = slug
        results.append({
            "id": synthetic_id,
            "title": {"english": en_title, "romaji": jp_title, "native": jp_title},
            "coverImage": {"large": poster, "extraLarge": poster},
            "bannerImage": None,
            "format": fmt,
            "seasonYear": year,
            "status": "RELEASING",
            "averageScore": None,
            "meanScore": None,
            "episodes": None,
            "duration": None,
            "genres": [],
            "isAdult": False,
            "nextAiringEpisode": None,
            "_anikoto_slug": slug,
        })
    return results


async def _anikoto_search(keyword: str) -> List[Dict]:
    """Search anikoto → parsed card list. Cached 10 min."""
    key = keyword.lower().strip()
    now = time.monotonic()
    cached = _AK_SEARCH_CACHE.get(key)
    if cached and (now - cached[0]) < _AK_SEARCH_CACHE_TTL:
        return cached[1]
    try:
        client = _get_anikoto_client()
        r = await client.get(_ak_url("/ajax/anime/search", keyword=keyword), headers=_AK_HDRS)
        r.raise_for_status()
        payload = await r.json()
        result_val = payload.get("result")
        html = result_val.get("html", "") if isinstance(result_val, dict) else (result_val or "")
        results = _anikoto_parse_search_html(html)
        _AK_SEARCH_CACHE[key] = (now, results)
        log.debug("anikoto_search_results", keyword=keyword, count=len(results))
        return results
    except Exception as e:
        log.debug("anikoto_search_failed", keyword=keyword, error=str(e)[:80])
        return []


_ANIKOTO_WATCH_META_TTL = 3600.0  # 1 h


async def _anikoto_watch_meta(slug: str) -> Optional[Dict]:
    """Fetch anikoto watch page for a slug → parse full media metadata dict."""
    # Check cache by synthetic id
    sid = _slug_to_synthetic_id(slug)
    now = time.monotonic()
    cached = _ANIKOTO_META_CACHE.get(sid)
    if cached and (now - cached[0]) < _ANIKOTO_WATCH_META_TTL:
        return cached[1]
    try:
        client = _get_anikoto_client()
        r = await client.get(f"{ANIKOTO_BASE}/watch/{slug}", headers={"Referer": f"{ANIKOTO_BASE}/"})
        r.raise_for_status()
        text = await r.text()

        # Numeric anikoto ID
        id_m = re.search(r'id="watch-main"[^>]+data-id="(\d+)"', text)
        anikoto_id = int(id_m.group(1)) if id_m else None

        # Titles
        h1_m   = re.search(r'class="title d-title"[^>]*data-jp="([^"]*)"[^>]*>\s*([^<]+)', text)
        jp_title = h1_m.group(1).strip() if h1_m else slug
        en_title = h1_m.group(2).strip() if h1_m else slug
        aliases  = re.search(r'class="names[^"]*"[^>]*>\s*([^<]+)', text)
        synonym_str = aliases.group(1).strip() if aliases else ""
        synonyms = [s.strip() for s in re.split(r"[;,]", synonym_str) if s.strip()]

        # Poster / banner
        poster_m = re.search(r'<img[^>]+itemprop="image"[^>]+src="([^"]+)"', text)
        poster   = poster_m.group(1) if poster_m else ""
        banner_m = re.search(r"url\('([^']+)'\)", text)
        banner   = banner_m.group(1) if banner_m else None

        # OG image fallback
        og_m  = re.search(r'property="og:image" content="([^"]+)"', text)
        if not poster and og_m:
            poster = og_m.group(1)

        # Meta fields from .bmeta
        bmeta = re.search(r'class="bmeta"(.*?)class="brating"', text, re.S)
        bmeta_txt = bmeta.group(1) if bmeta else ""

        def _bmeta_val(label: str) -> Optional[str]:
            m = re.search(rf'{re.escape(label)}:\s*<span[^>]*>(.*?)</span>', bmeta_txt, re.S)
            if not m:
                return None
            return re.sub(r"<[^>]+>", "", m.group(1)).strip()

        fmt_raw    = (_bmeta_val("Type") or "TV").upper().replace(" ", "_")
        status_raw = _bmeta_val("Status") or ""
        status_map = {"Finished Airing": "FINISHED", "Currently Airing": "RELEASING",
                      "Not yet Aired": "NOT_YET_RELEASED"}
        status     = status_map.get(status_raw, "RELEASING")

        premiered  = _bmeta_val("Premiered") or ""
        season_m   = re.search(r"(WINTER|SPRING|SUMMER|FALL)", premiered.upper())
        season     = season_m.group(1) if season_m else None
        year_m2    = re.search(r"\b(19|20)\d{2}\b", premiered)
        year       = int(year_m2.group(0)) if year_m2 else None

        ep_cnt_m   = _bmeta_val("Episodes")
        ep_count   = int(ep_cnt_m) if ep_cnt_m and ep_cnt_m.isdigit() else None
        dur_m      = _bmeta_val("Duration") or ""
        dur_min_m  = re.search(r"(\d+)", dur_m)
        duration   = int(dur_min_m.group(1)) if dur_min_m else None

        genres = re.findall(r'href="[^"]+/genre/[^"]+"[^>]*>\s*([^<]+)', bmeta_txt)
        genres = [g.strip() for g in genres]

        # Score
        score_m = re.search(r'data-score="([^"]+)"', text)
        score   = float(score_m.group(1)) * 10 if score_m and score_m.group(1) != "0" else None

        meta: Dict = {
            "id": sid,
            "title": {"english": en_title, "romaji": jp_title, "native": jp_title},
            "synonyms": synonyms,
            "coverImage": {"large": poster, "extraLarge": poster},
            "bannerImage": banner,
            "format": fmt_raw,
            "season": season,
            "seasonYear": year,
            "status": status,
            "episodes": ep_count,
            "duration": duration,
            "genres": genres,
            "averageScore": score,
            "meanScore": score,
            "isAdult": False,
            "nextAiringEpisode": None,
            "startDate": {"year": year, "month": None, "day": None},
            "_anikoto_slug": slug,
            "_anikoto_id": anikoto_id,
        }
        _ANIKOTO_META_CACHE[sid] = (now, meta)
        if anikoto_id:
            _ANIKOTO_SLUG_CACHE[sid] = slug
            # Also store as anikoto_id → meta for episode resolution
            _ANIKOTO_ID_CACHE[sid] = (now, anikoto_id)
            _ANIKOTO_TITLE_CACHE[sid] = en_title
        return meta
    except Exception as e:
        log.warning("anikoto_watch_meta_failed", slug=slug, error=str(e)[:120])
        return None


# ─── AniList GraphQL ─────────────────────────────────────────────────────────

async def anilist_query(query: str, variables: Optional[dict] = None) -> dict:
    """Execute an AniList GraphQL query and return the data."""
    body: Dict[str, Any] = {"query": query}
    if variables:
        body["variables"] = variables

    headers = {
        "User-Agent": USER_AGENT,
        "Content-Type": "application/json",
        "Accept": "application/json",
    }

    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.post(ANILIST_URL, json=body, headers=headers)
        payload = resp.json() if resp.content else {}
        if resp.status_code != 200:
            error_detail = payload.get("errors") or payload.get("error") or resp.text[:200]
            log.error("anilist_http_error", status=resp.status_code, detail=str(error_detail)[:300])
            raise HTTPException(status_code=502, detail=f"AniList error: {error_detail}")
        if payload.get("errors"):
            error_detail = payload["errors"]
            log.error("anilist_gql_error", detail=str(error_detail)[:300])
            raise HTTPException(status_code=502, detail=f"AniList error: {error_detail}")
        return payload.get("data", {})


def _megaplay_getsources_headers(referer: str) -> Dict[str, str]:
    """Megaplay returns 403 JSON unless the request looks like the in-page XHR."""
    return {
        "User-Agent": USER_AGENT,
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": referer,
        "Origin": MEGAPLAY_BASE,
        "X-Requested-With": "XMLHttpRequest",
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
        "Priority": "u=1, i",
    }


def _cdn_host_allowed_url(url: str) -> bool:
    try:
        host = (urlparse(url).hostname or "").lower()
    except Exception:
        return False
    return any(host == s or host.endswith("." + s) for s in CDN_HOST_SUFFIXES)


def _cdn_upstream_fetch_headers() -> Dict[str, str]:
    """What Cloudflare/CDN expects for XHR from the configured stream site (vidwish / megaplay)."""
    return {
        "User-Agent": USER_AGENT,
        "Accept": "*/*",
        "Origin": MEGAPLAY_BASE,
        "Referer": f"{MEGAPLAY_BASE}/",
        "Sec-Fetch-Site": "cross-site",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Dest": "empty",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br, zstd",
        "Priority": "u=1, i",
        "sec-ch-ua": '"Chromium";v="148", "Google Chrome";v="148", "Not/A)Brand";v="99"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
    }


def _rewrap_media_urls_in_obj(obj: Any, api_base: str) -> Any:
    """Point CDN media URLs at /api/cdn-hls so playback uses server-side Referer/Origin."""
    if isinstance(obj, dict):
        return {k: _rewrap_media_urls_in_obj(v, api_base) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_rewrap_media_urls_in_obj(x, api_base) for x in obj]
    if isinstance(obj, str) and obj.startswith("http") and _cdn_host_allowed_url(obj):
        return f"{api_base}/api/cdn-hls?u={quote(obj, safe='')}"
    return obj


def _maybe_rewrap_media(obj: Any, rewrite_base: Optional[str]) -> Any:
    if not rewrite_base:
        return obj
    return _rewrap_media_urls_in_obj(obj, rewrite_base)


def _collect_http_urls(obj: Any, bucket: List[str], limit: int = 32) -> None:
    if len(bucket) >= limit:
        return
    if isinstance(obj, dict):
        for v in obj.values():
            _collect_http_urls(v, bucket, limit)
    elif isinstance(obj, list):
        for x in obj:
            _collect_http_urls(x, bucket, limit)
    elif isinstance(obj, str) and obj.startswith("http"):
        if obj not in bucket:
            bucket.append(obj)


def _log_stream_urls_from_payload(tag: str, payload: Any, **ctx: Any) -> None:
    """Log HTTP URLs embedded in a sources/getSources JSON payload (which CDN the upstream picked)."""
    if not isinstance(payload, dict):
        return
    urls: List[str] = []
    _collect_http_urls(payload, urls, 32)
    log.info("stream_payload_urls", tag=tag, url_count=len(urls), sample_urls=urls[:12], **ctx)


def _rewrite_m3u8_for_cdn_proxy(body: str, playlist_url: str, api_base: str, cdn_referer: str = "") -> str:
    """Rewrite segment/variant URLs in playlists to absolute /api/cdn-hls?u=... URLs.

    Browsers resolve relative URLs against the request URL path; ``.../api/cdn-hls?u=...`` makes
    ``index-f1.m3u8`` resolve to ``/api/index-f1.m3u8`` (wrong). Every media reference must become
    an absolute URL (proxy or direct https). Also rewrite ``URI="..."`` on #EXT-X-* lines.

    ``cdn_referer`` is forwarded from the original request's ``r=`` param so segment/variant URLs
    carry the same per-CDN Referer that was used to fetch the master playlist.
    """

    def prox(abs_u: str) -> str:
        if not _cdn_host_allowed_url(abs_u):
            return abs_u
        p = f"{api_base}/api/cdn-hls?u={quote(abs_u, safe='')}"
        if cdn_referer:
            p += f"&r={quote(cdn_referer, safe='')}"
        return p

    def resolve_to_absolute(href: str) -> str:
        h = href.strip()
        if h.startswith("http://") or h.startswith("https://"):
            return h
        # Do NOT append "/" after ``.../master.m3u8`` — that makes urljoin treat the playlist as a
        # directory and yields ``.../master.m3u8/index-*.m3u8`` (404 "Not a directory" on origin).
        return urljoin(playlist_url, h)

    def href_for_playlist(href: str) -> str:
        """Never return a bare relative path — hls.js would resolve it under ``/api/``."""
        h = href.strip()
        if not h or h.startswith("#"):
            return h
        resolved = resolve_to_absolute(h)
        if resolved.startswith("http://") or resolved.startswith("https://"):
            if _cdn_host_allowed_url(resolved):
                return prox(resolved)
            return resolved
        return h

    def rewrite_stream_inf_trailing_variant(line: str) -> str:
        """Some masters put ``index-*.m3u8`` as the last comma field with no ``URI=``."""
        st = line.strip()
        if not st.startswith("#EXT-X-STREAM-INF") or "URI=" in st.upper():
            return line
        parts = st.rsplit(",", 1)
        if len(parts) < 2:
            return line
        last = parts[1].strip()
        if not re.fullmatch(r"[A-Za-z0-9._-]+\.m3u8", last):
            return line
        return parts[0] + "," + href_for_playlist(last)

    def rewrite_uri_attrs(line: str) -> str:
        """Rewrite URI= on #EXT-X-* tags (double/single-quoted or bare *.m3u8 / *.mpd)."""

        def repl_dq(m: re.Match) -> str:
            return f'URI="{href_for_playlist(m.group(1))}"'

        def repl_sq(m: re.Match) -> str:
            return f'URI="{href_for_playlist(m.group(1))}"'

        def repl_bare(m: re.Match) -> str:
            return f'URI="{href_for_playlist(m.group(1))}"'

        line = re.sub(r'URI\s*=\s*"([^"]+)"', repl_dq, line, flags=re.I)
        line = re.sub(r"URI\s*=\s*'([^']+)'", repl_sq, line, flags=re.I)
        line = re.sub(
            r"URI\s*=\s*([^\",\s][^,\s]*\.(?:m3u8|mpd))\b",
            repl_bare,
            line,
            flags=re.I,
        )
        return line

    out: List[str] = []
    for raw_line in body.splitlines():
        line = rewrite_uri_attrs(raw_line)
        st = line.strip()
        if st.startswith("#EXT-X-STREAM-INF"):
            line = rewrite_stream_inf_trailing_variant(line)
            st = line.strip()
        if not st or st.startswith("#"):
            out.append(line)
            continue
        out.append(href_for_playlist(st))
    sep = "\n"
    if body.endswith("\n"):
        return sep.join(out) + "\n"
    return sep.join(out)


# ─── Megaplay Source Fetching ────────────────────────────────────────────────

async def get_megaplay_sources(
    source_id: str,
    category: str = "sub",
    anilist_id: Optional[int] = None,
    rewrite_base: Optional[str] = None,
) -> dict:
    """Fetch streaming sources: megaplay getSources for numeric ids; Miruro pipe (bee+ttl) for slug ids."""
    eid = unquote(str(source_id))
    if not re.fullmatch(r"\d+", eid):
        if anilist_id is None:
            raise HTTPException(
                status_code=400,
                detail="anilist_id is required when episode id is not a plain megaplay numeric id",
            )
        pipe_cat = "ssub" if category == "sub" else category
        q: Dict[str, Any] = {
            "episodeId": eid,
            "provider": MEGAPLAY_PIPE_PROVIDER,
            "category": pipe_cat,
            "ttl": 86400,
        }
        out = await call_pipe("sources", "GET", q, referer=f"{MIRURO_BASE}/watch/{anilist_id}")
        _log_stream_urls_from_payload(
            "miruro_pipe_sources",
            out,
            episode_id=eid,
            category=category,
            anilist_id=anilist_id,
            pipe_category=pipe_cat,
        )
        return _pipe_sources_as_megaplay_json(out, rewrite_base or "")

    client = await session_manager.get_client()
    url = f"{GET_SOURCES_ENDPOINT}?id={quote(eid, safe='')}"
    referer = f"{MEGAPLAY_BASE}/stream/s-2/{eid}/{category}"
    headers = _megaplay_getsources_headers(referer)

    try:
        resp = await client.get(url, headers=headers)
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
        if e.response.status_code == 404 and anilist_id is not None:
            pipe_cat = "ssub" if category == "sub" else category
            q = {
                "episodeId": eid,
                "provider": MEGAPLAY_PIPE_PROVIDER,
                "category": pipe_cat,
                "ttl": 86400,
            }
            out = await call_pipe("sources", "GET", q, referer=f"{MIRURO_BASE}/watch/{anilist_id}")
            _log_stream_urls_from_payload(
                "miruro_pipe_sources_fallback",
                out,
                episode_id=eid,
                category=category,
                anilist_id=anilist_id,
                after_megaplay_status=e.response.status_code,
            )
            return _pipe_sources_as_megaplay_json(out, rewrite_base or "")
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
    log.info(
        "app_startup",
        stream_upstream=MEGAPLAY_BASE,
        miruro=MIRURO_BASE,
        anilist=ANILIST_URL,
        embed_s2_mode=_embed_s2_mode(),
        config_path=STREAM_CONFIG_PATH,
    )
    await session_manager.get_client()
    yield
    await session_manager.close()


app = FastAPI(
    title="VaultCeaser Anime API",
    description="Unified API for anime metadata (AniList) + streaming (Miruro/Megaplay)",
    version="2.0.0",
    lifespan=_app_lifespan,
)

# CORS - allow all origins for frontend access
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ─── Root Endpoint ───────────────────────────────────────────────────────────

@app.get("/")
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


@app.get("/docs.html")
async def serve_docs_html():
    """Human-readable API reference (mirrors ``docs.html`` in the repo root)."""
    if not _DOCS_HTML_PATH.is_file():
        raise HTTPException(status_code=404, detail="docs.html not found")
    return FileResponse(_DOCS_HTML_PATH, media_type="text/html; charset=utf-8")


@app.get("/health")
async def health():
    return {"status": "ok", "version": "2.0.0"}


# ─── Genres ──────────────────────────────────────────────────────────────────

@app.get("/api/genres")
async def get_genres():
    """Return list of available anime genres matching AniList/Miruro."""
    return {
        "genres": GENRES,
        "formats": FORMATS,
        "statuses": STATUSES,
        "seasons": SEASONS,
        "providers": PROVIDERS,
        "categories": CATEGORIES,
    }


# ─── Search ──────────────────────────────────────────────────────────────────

@app.get("/api/search")
async def search_anime(
    q: str = Query("", description="Search query"),
    page: int = Query(1, ge=1, description="Page number"),
    per_page: int = Query(20, ge=1, le=50, alias="perPage", description="Results per page"),
    genre: Optional[str] = Query(None, description="Filter by genre (comma-separated)"),
    format: Optional[str] = Query(None, description="Filter by format: TV, MOVIE, OVA, etc."),
    status: Optional[str] = Query(None, description="Filter by status: RELEASING, FINISHED, etc."),
    year: Optional[int] = Query(None, description="Filter by release year"),
    season: Optional[str] = Query(None, description="Filter by season: WINTER, SPRING, SUMMER, FALL"),
    sort: str = Query("SEARCH_MATCH", description="Sort order"),
):
    """Search anime with filters via AniList GraphQL."""
    sort_key = SORT_MAP.get(sort, "SEARCH_MATCH")
    if not q and sort_key == "SEARCH_MATCH":
        sort_key = "POPULARITY_DESC"
    args = ["type: ANIME", "isAdult: false", f"sort: [{sort_key}]"]
    variables: Dict[str, Any] = {"page": page, "perPage": per_page}
    var_types = ["$page: Int", "$perPage: Int"]

    if q:
        args.append("search: $search")
        variables["search"] = q
        var_types.append("$search: String")

    if genre:
        args.append("genre_in: $genreIn")
        variables["genreIn"] = [g.strip() for g in genre.split(",") if g.strip()]
        var_types.append("$genreIn: [String]")

    if format:
        args.append("format_in: $formatIn")
        variables["formatIn"] = [f.strip().upper() for f in format.split(",") if f.strip()]
        var_types.append("$formatIn: [MediaFormat]")

    if status:
        args.append("status_in: $statusIn")
        variables["statusIn"] = [s.strip().upper() for s in status.split(",") if s.strip()]
        var_types.append("$statusIn: [MediaStatus]")

    if year:
        args.append("seasonYear: $seasonYear")
        variables["seasonYear"] = year
        var_types.append("$seasonYear: Int")

    if season:
        args.append("season: $season")
        variables["season"] = season.upper()
        var_types.append("$season: MediaSeason")

    gql = f"""
    query ({', '.join(var_types)}) {{
        Page(page: $page, perPage: $perPage) {{
            pageInfo {{ total currentPage lastPage hasNextPage perPage }}
            media({', '.join(args)}) {{
                {MEDIA_LIST_FIELDS}
            }}
        }}
    }}
    """
    # Run AniList + Anikoto searches in parallel (Anikoto only when keyword given)
    anilist_task = asyncio.create_task(anilist_query(gql, variables))
    anikoto_task = asyncio.create_task(_anikoto_search(q)) if q else None

    data = await anilist_task
    page_data = data.get("Page", {})
    page_info = page_data.get("pageInfo", {})
    anilist_results: List[Dict] = page_data.get("media", [])

    merged = list(anilist_results)
    if anikoto_task:
        ak_results = await anikoto_task
        # Build normalized title set from AniList results for dedup
        def _norm(t: str) -> str:
            return re.sub(r"[^a-z0-9]", "", t.lower())
        anilist_titles = set()
        for m in anilist_results:
            t = m.get("title") or {}
            for v in (t.get("english"), t.get("romaji"), t.get("native")):
                if v:
                    anilist_titles.add(_norm(v))
        for ak in ak_results:
            t = ak.get("title") or {}
            en = _norm(t.get("english") or "")
            ro = _norm(t.get("romaji") or "")
            if en not in anilist_titles and ro not in anilist_titles:
                merged.append(ak)

    return {
        "page": page_info.get("currentPage", page),
        "perPage": page_info.get("perPage", per_page),
        "total": page_info.get("total", 0),
        "hasNextPage": page_info.get("hasNextPage", False),
        "results": merged,
    }


# ─── Suggestions ─────────────────────────────────────────────────────────────

@app.get("/api/suggestions")
async def search_suggestions(
    q: str = Query(..., min_length=1, description="Search query for autocomplete"),
):
    """Lightweight search for autocomplete dropdowns."""
    gql = """
    query ($search: String) {
        Page(page: 1, perPage: 8) {
            media(search: $search, type: ANIME, sort: SEARCH_MATCH, isAdult: false) {
                id
                title { romaji english }
                coverImage { large }
                format
                status
                isAdult
                genres
                startDate { year }
                episodes
            }
        }
    }
    """
    anilist_task = asyncio.create_task(anilist_query(gql, {"search": q}))
    anikoto_task = asyncio.create_task(_anikoto_search(q))
    data = await anilist_task
    ak_cards = await anikoto_task

    def _norm(t: str) -> str:
        return re.sub(r"[^a-z0-9]", "", t.lower())

    results = []
    seen_titles: set = set()
    for item in data.get("Page", {}).get("media", []):
        if item.get("isAdult"):
            continue
        genres = item.get("genres") or []
        if "Hentai" in genres or "Erotica" in genres:
            continue
        title = item.get("title", {})
        en = title.get("english") or title.get("romaji", "")
        seen_titles.add(_norm(en))
        seen_titles.add(_norm(title.get("romaji", "")))
        results.append({
            "id": item["id"],
            "title": en,
            "title_romaji": title.get("romaji", ""),
            "poster": item.get("coverImage", {}).get("large", ""),
            "format": item.get("format"),
            "status": item.get("status"),
            "year": (item.get("startDate") or {}).get("year"),
            "episodes": item.get("episodes"),
            "isAdult": False,
            "genres": genres,
        })
    # Append Anikoto-only results (not already in AniList)
    for ak in ak_cards[:5]:
        t = ak.get("title") or {}
        en = t.get("english") or t.get("romaji") or ""
        ro = t.get("romaji") or ""
        if _norm(en) in seen_titles or _norm(ro) in seen_titles:
            continue
        results.append({
            "id": ak["id"],
            "title": en,
            "title_romaji": ro,
            "poster": (ak.get("coverImage") or {}).get("large", ""),
            "format": ak.get("format"),
            "status": ak.get("status"),
            "year": ak.get("seasonYear"),
            "episodes": ak.get("episodes"),
            "isAdult": False,
            "genres": [],
        })
    return {"results": results}


# ─── Filter / Browse ─────────────────────────────────────────────────────────

@app.get("/api/filter")
async def filter_anime(
    genre: Optional[str] = Query(None, description="Genre: Action, Romance, Comedy, etc. (comma-separated)"),
    tag: Optional[str] = Query(None, description="Tag: Isekai, Time Skip, etc."),
    year: Optional[int] = Query(None, description="Release year, e.g. 2025"),
    season: Optional[str] = Query(None, description="WINTER, SPRING, SUMMER, FALL"),
    format: Optional[str] = Query(None, description="TV, MOVIE, OVA, ONA, SPECIAL"),
    status: Optional[str] = Query(None, description="RELEASING, FINISHED, NOT_YET_RELEASED"),
    sort: str = Query("POPULARITY_DESC", description="Sort order"),
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=50, alias="perPage"),
):
    """Advanced anime filter matching Miruro's browse page capabilities."""
    args = ["type: ANIME", "isAdult: false", f"sort: [{SORT_MAP.get(sort, 'POPULARITY_DESC')}]"]
    variables: Dict[str, Any] = {"page": page, "perPage": per_page}
    var_types = ["$page: Int", "$perPage: Int"]

    if genre:
        genres = [g.strip() for g in genre.split(",") if g.strip()]
        if len(genres) > 1:
            args.append("genre_in: $genreIn")
            variables["genreIn"] = genres
            var_types.append("$genreIn: [String]")
        elif genres:
            args.append("genre: $genre")
            variables["genre"] = genres[0]
            var_types.append("$genre: String")
    if tag:
        args.append("tag: $tag")
        variables["tag"] = tag
        var_types.append("$tag: String")
    if year:
        args.append("seasonYear: $seasonYear")
        variables["seasonYear"] = year
        var_types.append("$seasonYear: Int")
    if season:
        args.append("season: $season")
        variables["season"] = season.upper()
        var_types.append("$season: MediaSeason")
    if format:
        fmts = [f.strip().upper() for f in format.split(",") if f.strip()]
        if len(fmts) > 1:
            args.append("format_in: $formatIn")
            variables["formatIn"] = fmts
            var_types.append("$formatIn: [MediaFormat]")
        elif fmts:
            args.append("format: $format")
            variables["format"] = fmts[0]
            var_types.append("$format: MediaFormat")
    if status:
        sts = [s.strip().upper() for s in status.split(",") if s.strip()]
        if len(sts) > 1:
            args.append("status_in: $statusIn")
            variables["statusIn"] = sts
            var_types.append("$statusIn: [MediaStatus]")
        elif sts:
            args.append("status: $status")
            variables["status"] = sts[0]
            var_types.append("$status: MediaStatus")

    gql = f"""
    query ({', '.join(var_types)}) {{
        Page(page: $page, perPage: $perPage) {{
            pageInfo {{ total currentPage lastPage hasNextPage perPage }}
            media({', '.join(args)}) {{
                {MEDIA_LIST_FIELDS}
            }}
        }}
    }}
    """
    data = await anilist_query(gql, variables)
    page_data = data.get("Page", {})
    page_info = page_data.get("pageInfo", {})

    return {
        "page": page_info.get("currentPage", page),
        "perPage": page_info.get("perPage", per_page),
        "total": page_info.get("total", 0),
        "hasNextPage": page_info.get("hasNextPage", False),
        "results": page_data.get("media", []),
    }


# ─── Spotlight (Hero Section) ────────────────────────────────────────────────

@app.get("/api/spotlight")
async def get_spotlight():
    """Get top 10 trending anime for hero carousel."""
    gql = f"""
    query {{
        Page(page: 1, perPage: 10) {{
            media(sort: [TRENDING_DESC, POPULARITY_DESC], type: ANIME) {{
                {MEDIA_LIST_FIELDS}
            }}
        }}
    }}
    """
    data = await anilist_query(gql)
    return {"results": data.get("Page", {}).get("media", [])}


# ─── Collection Endpoints ────────────────────────────────────────────────────

_WARMUP_SEM = asyncio.Semaphore(4)  # cap concurrent Anikoto resolutions during background warmup


async def _warm_anikoto_for_media_list(media_list: List[Dict]) -> None:
    """Background task: pre-resolve Anikoto IDs + episode counts for a batch of AniList media.

    Populates _ANIKOTO_TITLE_CACHE, _ANIKOTO_ID_CACHE, and _ANIKOTO_EP_CACHE so that
    subsequent /api/episode-counts calls return real sub/dub counts immediately.
    """
    now = time.monotonic()

    async def warm_one(media: Dict) -> None:
        anilist_id = media.get("id")
        if not anilist_id:
            return
        # Skip if already warm (both ID and episode cache valid)
        id_entry = _ANIKOTO_ID_CACHE.get(anilist_id)
        if id_entry and (now - id_entry[0]) < _ANIKOTO_ID_CACHE_TTL:
            ak_id = id_entry[1]
            if ak_id is None:
                return  # previously confirmed not on anikoto
            ep_entry = _ANIKOTO_EP_CACHE.get(ak_id)
            if ep_entry and (now - ep_entry[0]) < _ANIKOTO_EP_CACHE_TTL:
                return  # already warm
        # Seed title cache from the AniList response (saves an AniList API call later)
        title_obj = media.get("title") or {}
        title = title_obj.get("english") or title_obj.get("romaji")
        if title and anilist_id not in _ANIKOTO_TITLE_CACHE:
            _ANIKOTO_TITLE_CACHE[anilist_id] = title
        async with _WARMUP_SEM:
            await _anikoto_get_counts(anilist_id)  # full resolve; populates all caches

    await asyncio.gather(*[warm_one(m) for m in media_list], return_exceptions=True)


async def _fetch_collection(sort_type: str, status: Optional[str] = None, page: int = 1, per_page: int = 20):
    """Internal helper for fetching collections."""
    status_filter = f', status: {status}' if status else ""
    gql = f"""
    query ($page: Int, $perPage: Int) {{
        Page(page: $page, perPage: $perPage) {{
            pageInfo {{ total currentPage lastPage hasNextPage perPage }}
            media(type: ANIME, sort: [{sort_type}]{status_filter}) {{
                {MEDIA_LIST_FIELDS}
            }}
        }}
    }}
    """
    data = await anilist_query(gql, {"page": page, "perPage": per_page})
    page_data = data.get("Page", {})
    page_info = page_data.get("pageInfo", {})
    results = page_data.get("media", [])
    # Fire background Anikoto warmup so episode-counts cache is hot by the time the
    # frontend requests /api/episode-counts for the cards we just returned.
    asyncio.create_task(_warm_anikoto_for_media_list(results))
    return {
        "page": page_info.get("currentPage", page),
        "perPage": page_info.get("perPage", per_page),
        "total": page_info.get("total", 0),
        "hasNextPage": page_info.get("hasNextPage", False),
        "results": results,
    }


@app.get("/api/trending")
async def get_trending(page: int = Query(1, ge=1), per_page: int = Query(20, ge=1, le=50)):
    return await _fetch_collection("TRENDING_DESC", page=page, per_page=per_page)


@app.get("/api/popular")
async def get_popular(page: int = Query(1, ge=1), per_page: int = Query(20, ge=1, le=50)):
    return await _fetch_collection("POPULARITY_DESC", page=page, per_page=per_page)


@app.get("/api/upcoming")
async def get_upcoming(page: int = Query(1, ge=1), per_page: int = Query(20, ge=1, le=50)):
    return await _fetch_collection("POPULARITY_DESC", "NOT_YET_RELEASED", page=page, per_page=per_page)


@app.get("/api/recent")
async def get_recent(page: int = Query(1, ge=1), per_page: int = Query(20, ge=1, le=50)):
    return await _fetch_collection("START_DATE_DESC", "RELEASING", page=page, per_page=per_page)


@app.get("/api/fresh")
async def get_fresh(page: int = Query(1, ge=1), per_page: int = Query(20, ge=1, le=50)):
    """Fresh Additions — anime sorted by last DB update (UPDATED_AT_DESC), any status."""
    return await _fetch_collection("UPDATED_AT_DESC", page=page, per_page=per_page)


@app.get("/api/latest-releases")
async def get_latest_releases(page: int = Query(1, ge=1), per_page: int = Query(20, ge=1, le=50)):
    """Latest Releases — recently started airing (RELEASING, START_DATE_DESC)."""
    return await _fetch_collection("START_DATE_DESC", "RELEASING", page=page, per_page=per_page)


@app.get("/api/recently-completed")
async def get_recently_completed(page: int = Query(1, ge=1), per_page: int = Query(20, ge=1, le=50)):
    """Recently Completed — finished anime ordered by end date descending."""
    gql = f"""
    query ($page: Int, $perPage: Int) {{
        Page(page: $page, perPage: $perPage) {{
            pageInfo {{ total currentPage lastPage hasNextPage perPage }}
            media(type: ANIME, status: FINISHED, sort: END_DATE_DESC, isAdult: false) {{
                {MEDIA_LIST_FIELDS}
            }}
        }}
    }}
    """
    data = await anilist_query(gql, {"page": page, "perPage": per_page})
    page_data = data.get("Page", {})
    page_info = page_data.get("pageInfo", {})
    results = [m for m in page_data.get("media", []) if m]
    return {
        "page": page_info.get("currentPage", page),
        "perPage": page_info.get("perPage", per_page),
        "total": page_info.get("total", 0),
        "hasNextPage": page_info.get("hasNextPage", False),
        "results": results,
    }


# ─── Schedule ────────────────────────────────────────────────────────────────

@app.get("/api/schedule")
async def get_schedule(
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=50),
):
    """Get upcoming airing schedule with UNIX timestamps."""
    gql = f"""
    query ($page: Int, $perPage: Int) {{
        Page(page: $page, perPage: $perPage) {{
            pageInfo {{ total currentPage lastPage hasNextPage perPage }}
            airingSchedules(notYetAired: true, sort: TIME) {{
                episode
                airingAt
                timeUntilAiring
                media {{
                    {MEDIA_LIST_FIELDS}
                }}
            }}
        }}
    }}
    """
    data = await anilist_query(gql, {"page": page, "perPage": per_page})
    page_data = data.get("Page", {})
    page_info = page_data.get("pageInfo", {})

    results = []
    for item in page_data.get("airingSchedules", []):
        entry = item.get("media", {})
        entry["next_episode"] = item.get("episode")
        entry["airingAt"] = item.get("airingAt")
        entry["timeUntilAiring"] = item.get("timeUntilAiring")
        results.append(entry)

    return {
        "page": page_info.get("currentPage", page),
        "perPage": page_info.get("perPage", per_page),
        "total": page_info.get("total", 0),
        "hasNextPage": page_info.get("hasNextPage", False),
        "results": results,
    }


# ─── Anime Full Info ─────────────────────────────────────────────────────────

@app.get("/api/anime/{anilist_id}")
async def get_anime_info(anilist_id: Union[int, str]):
    """Get comprehensive anime info by AniList ID (or synthetic Anikoto ID) + streaming data."""
    anilist_id = int(anilist_id)

    # ── Synthetic Anikoto ID path ─────────────────────────────────────────────
    if _is_synthetic(anilist_id):
        slug = _ANIKOTO_SLUG_CACHE.get(anilist_id)
        if not slug:
            raise HTTPException(status_code=404, detail="Anime not found (unknown synthetic ID)")
        media = await _anikoto_watch_meta(slug)
        if not media:
            raise HTTPException(status_code=404, detail="Anime not found on Anikoto")
        return {
            "id": anilist_id,
            "info": media,
            "streaming": {
                "has_episodes": True,
                "total_episodes": media.get("episodes") or 0,
                "status": media.get("status"),
                "episodes_url": f"/api/anime/{anilist_id}/episodes",
                "stream_url": f"/api/anime/{anilist_id}/stream",
            },
        }

    # ── Normal AniList ID path ────────────────────────────────────────────────
    gql = f"""
    query ($id: Int) {{
        Media(id: $id, type: ANIME) {{
            {MEDIA_FULL_FIELDS}
        }}
    }}
    """
    meta_data = await anilist_query(gql, {"id": anilist_id})
    media = meta_data.get("Media")
    if not media:
        raise HTTPException(status_code=404, detail="Anime not found")

    title_cache_val = (
        (media.get("title") or {}).get("english")
        or (media.get("title") or {}).get("romaji")
        or ""
    )
    if title_cache_val:
        _ANIKOTO_TITLE_CACHE[anilist_id] = title_cache_val

    streaming_info = {
        "has_episodes": False,
        "total_episodes": media.get("episodes") or media.get("nextAiringEpisode", {}).get("episode", 0) or 0,
        "status": media.get("status"),
        "episodes_url": f"/api/anime/{anilist_id}/episodes",
        "stream_url": f"/api/anime/{anilist_id}/stream",
    }

    return {
        "id": anilist_id,
        "info": media,
        "streaming": streaming_info,
    }


# ─── Anime Characters ────────────────────────────────────────────────────────

@app.get("/api/anime/{anilist_id}/characters")
async def get_anime_characters(
    anilist_id: int,
    page: int = Query(1, ge=1),
    per_page: int = Query(25, ge=1, le=50),
):
    """Get paginated character list with voice actors."""
    gql = """
    query ($id: Int, $page: Int, $perPage: Int) {
        Media(id: $id, type: ANIME) {
            id
            title { romaji english }
            characters(sort: [ROLE, RELEVANCE], page: $page, perPage: $perPage) {
                pageInfo { total currentPage lastPage hasNextPage perPage }
                edges {
                    role
                    node {
                        id
                        name { full native userPreferred }
                        image { large medium }
                        description
                        gender
                        dateOfBirth { year month day }
                        age
                        favourites
                        siteUrl
                    }
                    voiceActors {
                        id
                        name { full native }
                        image { large }
                        languageV2
                    }
                }
            }
        }
    }
    """
    data = await anilist_query(gql, {"id": anilist_id, "page": page, "perPage": per_page})
    media = data.get("Media")
    if not media:
        raise HTTPException(status_code=404, detail="Anime not found")

    chars = media.get("characters", {})
    page_info = chars.get("pageInfo", {})
    return {
        "page": page_info.get("currentPage", page),
        "perPage": page_info.get("perPage", per_page),
        "total": page_info.get("total", 0),
        "hasNextPage": page_info.get("hasNextPage", False),
        "characters": chars.get("edges", []),
    }


# ─── Anime Relations ─────────────────────────────────────────────────────────

@app.get("/api/anime/{anilist_id}/relations")
async def get_anime_relations(anilist_id: int):
    """Get all related anime (sequels, prequels, side stories, etc.)."""
    gql = """
    query ($id: Int) {
        Media(id: $id, type: ANIME) {
            id
            title { romaji english }
            relations {
                edges {
                    relationType(version: 2)
                    node {
                        id
                        title { romaji english native }
                        coverImage { large }
                        bannerImage
                        format
                        type
                        status
                        episodes
                        chapters
                        meanScore
                        averageScore
                        popularity
                        startDate { year month day }
                    }
                }
            }
        }
    }
    """
    data = await anilist_query(gql, {"id": anilist_id})
    media = data.get("Media")
    if not media:
        raise HTTPException(status_code=404, detail="Anime not found")
    return {
        "id": media["id"],
        "title": media["title"],
        "relations": media.get("relations", {}).get("edges", []),
    }


# ─── Anime Recommendations ───────────────────────────────────────────────────

@app.get("/api/anime/{anilist_id}/recommendations")
async def get_anime_recommendations(
    anilist_id: int,
    page: int = Query(1, ge=1),
    per_page: int = Query(10, ge=1, le=25),
):
    """Get community recommendations for an anime."""
    gql = """
    query ($id: Int, $page: Int, $perPage: Int) {
        Media(id: $id, type: ANIME) {
            id
            title { romaji english }
            recommendations(sort: RATING_DESC, page: $page, perPage: $perPage) {
                pageInfo { total currentPage lastPage hasNextPage perPage }
                nodes {
                    rating
                    mediaRecommendation {
                        id
                        title { romaji english native }
                        coverImage { large extraLarge }
                        bannerImage
                        format
                        episodes
                        status
                        meanScore
                        averageScore
                        popularity
                        genres
                        startDate { year }
                    }
                }
            }
        }
    }
    """
    data = await anilist_query(gql, {"id": anilist_id, "page": page, "perPage": per_page})
    media = data.get("Media")
    if not media:
        raise HTTPException(status_code=404, detail="Anime not found")

    recs = media.get("recommendations", {})
    page_info = recs.get("pageInfo", {})
    return {
        "page": page_info.get("currentPage", page),
        "perPage": page_info.get("perPage", per_page),
        "total": page_info.get("total", 0),
        "hasNextPage": page_info.get("hasNextPage", False),
        "recommendations": recs.get("nodes", []),
    }


# ─── Episode counts (Anikoto-only) ───────────────────────────────────────────

@app.get("/api/episode-counts")
async def batch_episode_counts(
    ids: str = Query(..., description="Comma-separated AniList IDs (max 50)"),
    refresh: bool = Query(False, description="Bypass the short episode-count cache"),
):
    """Released sub/dub episode counts from Anikoto (for browse/home cards)."""
    id_list: List[int] = []
    for part in ids.split(","):
        part = part.strip()
        if part.isdigit():
            id_list.append(int(part))
    id_list = id_list[:50]
    if not id_list:
        return {"counts": {}}

    sem = asyncio.Semaphore(8)

    async def one(aid: int) -> Tuple[int, Dict[str, int]]:
        async with sem:
            # Cache-only fast path first; background warmup pre-populates caches.
            ak = await _anikoto_get_counts(aid, cache_only=not refresh)
            if ak:
                return aid, ak
            # If cache empty, do a live Anikoto fetch (limited concurrency)
            ak = await _anikoto_get_counts(aid, cache_only=False)
            return aid, ak or {"sub": 0, "dub": 0}

    pairs = await asyncio.gather(*[one(i) for i in id_list])
    return {"counts": {str(aid): counts for aid, counts in pairs}}


@app.get("/api/anime/{anilist_id}/episodes")
async def get_anime_episodes(anilist_id: Union[int, str]):
    """Get episode list — Anikoto only (synthetic and real AniList IDs both supported)."""
    anilist_id = int(anilist_id)
    empty = {
        "providers": {
            "megaplay": {"episodes": {"sub": [], "dub": [], "ssub": []}},
        },
    }

    # ── Synthetic Anikoto ID path ─────────────────────────────────────────
    if _is_synthetic(anilist_id):
        slug = _ANIKOTO_SLUG_CACHE.get(anilist_id)
        if slug:
            meta = await _anikoto_watch_meta(slug)
            ak_id = (meta or {}).get("_anikoto_id")
            if ak_id:
                eps = await _anikoto_get_episodes(ak_id)
                if eps:
                    return _anikoto_episodes_to_response(anilist_id, eps)
        return {"id": anilist_id, "episodes": empty, "released": {"sub": 0, "dub": 0}}

    # ── Normal AniList ID → Anikoto resolution ────────────────────────────
    try:
        title = await _get_anilist_title(anilist_id)
        if title:
            anikoto_id = await _anikoto_resolve_id(anilist_id, title)
            if anikoto_id:
                eps = await _anikoto_get_episodes(anikoto_id)
                if eps:
                    log.info("episodes_source_anikoto", anilist_id=anilist_id,
                             anikoto_id=anikoto_id, count=len(eps))
                    return _anikoto_episodes_to_response(anilist_id, eps)
    except Exception as e:
        log.warning("anikoto_episodes_error", anilist_id=anilist_id, error=str(e)[:120])

    return {"id": anilist_id, "episodes": empty, "released": {"sub": 0, "dub": 0}}


# ─── Episodes with Streaming URLs (one-stop, Anikoto-backed) ─────────────────

@app.get("/api/anime/{anilist_id}/stream")
async def get_anime_stream(
    anilist_id: Union[int, str],
    provider: str = Query("megaplay", description="Streaming provider (Megaplay only)"),
    category: str = Query("sub", description="sub, dub, or ssub"),
    episode_number: Optional[int] = Query(None, description="Specific episode number (omit for all)"),
):
    """Get episodes with pre-resolved streaming URLs in one request (Anikoto-backed)."""
    anilist_id = int(anilist_id)

    # Fetch episodes via the same Anikoto path as /episodes endpoint
    ep_resp = await get_anime_episodes(anilist_id)
    data = ep_resp.get("episodes", {}) if isinstance(ep_resp, dict) else {}
    if hasattr(ep_resp, "body"):
        import json as _json
        data = _json.loads(ep_resp.body).get("episodes", {})  # JSONResponse case
    providers = data.get("providers", {})
    provider_data = providers.get("megaplay", {})
    episodes = provider_data.get("episodes", {}).get(category, [])

    if not episodes:
        raise HTTPException(
            status_code=404,
            detail=f"No episodes found for category '{category}'",
        )

    if episode_number is not None:
        episodes = [ep for ep in episodes if ep.get("number") == episode_number]
        if not episodes:
            raise HTTPException(status_code=404, detail=f"Episode {episode_number} not found")

    return {
        "id": anilist_id,
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

@app.get("/api/sources")
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

@app.get("/api/stream/url")
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
    var file = (data.sources && data.sources[0] && data.sources[0].file) || '';
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


def _pipe_sources_as_megaplay_json(data: Any, api_base: str = "") -> dict:
    """Normalize Miruro pipe `sources`/`streams` + `subtitles` payload → getSources JSON shape.

    Pipe uses 'streams' (not 'sources') with per-entry 'referer' and 'subtitles' (not 'tracks').
    We embed the per-stream referer in the /api/cdn-hls proxy URL as ``&r=<encoded>`` so the
    CDN gets the exact Origin/Referer it whitelists (cinewave2/streamzone→megaplay, watching.onl→vidwish).
    """
    if not isinstance(data, dict):
        return {"sources": [], "tracks": [], "intro": {}, "outro": {}, "server": 0}

    def prox_with_ref(url: str, stream_ref: str) -> str:
        """Wrap a CDN URL in /api/cdn-hls with its per-stream referer embedded."""
        if not api_base or not _cdn_host_allowed_url(url):
            return url
        p = f"{api_base}/api/cdn-hls?u={quote(url, safe='')}"
        if stream_ref:
            p += f"&r={quote(stream_ref.rstrip('/'), safe='')}"
        return p

    def norm_tracks(raw: list, default_referer: str = MEGAPLAY_BASE) -> list:
        out = []
        for t in raw:
            if not isinstance(t, dict):
                continue
            url = t.get("file") or t.get("url") or ""
            if not url:
                continue
            ref = (t.get("referer") or "").rstrip("/") or default_referer
            entry = {
                "file": prox_with_ref(url, ref) if api_base else url,
                "kind": t.get("kind", "subtitles"),
                "label": t.get("label", ""),
            }
            if t.get("srclang") or t.get("lang") or t.get("language"):
                entry["srclang"] = t.get("srclang") or t.get("lang") or t.get("language", "")
            if t.get("default"):
                entry["default"] = True
            out.append(entry)
        return out

    # Case 1: already a getSources-shaped payload (direct megaplay numeric ID response)
    src = data.get("sources")
    if isinstance(src, list) and src and isinstance(src[0], dict) and src[0].get("file"):
        tracks = norm_tracks(data.get("tracks") or data.get("subtitles") or [], default_referer="https://megaplay.buzz")
        return {
            "sources": src,
            "tracks": tracks,
            "intro": data.get("intro", {}),
            "outro": data.get("outro", {}),
            "server": data.get("server", 0),
        }

    # Case 2: pipe response — uses 'streams' with 'url' + 'referer' + 'type', and 'subtitles'
    # CDN preference: watching.onl/cloudbuzz/livedns streams (vidwish.live ecosystem) first;
    # cinewave2/streamzone (megaplay.buzz ecosystem) as fallback. Both work via proxy but
    # watching.onl is the preferred CDN per bun.har.
    _PREF_CDN = ("watching.onl", "cloudbuzz.lol", "livedns.my", "ultracloud.cc", "mewstream.buzz")

    def _stream_sort_key(s: dict) -> int:
        try:
            host = (urlparse(s.get("url") or s.get("file") or "").hostname or "").lower()
        except Exception:
            host = ""
        return 0 if any(host == d or host.endswith("." + d) for d in _PREF_CDN) else 1

    raw_streams = [s for s in (data.get("streams") or []) if isinstance(s, dict)]
    hls_streams = [s for s in raw_streams if s.get("type") != "embed" and "m3u8" in (s.get("url") or s.get("file") or "")]
    hls_streams.sort(key=_stream_sort_key)

    sources: List[dict] = []
    for s in hls_streams:
        url = s.get("url") or s.get("file") or ""
        stream_ref = (s.get("referer") or "").rstrip("/")
        sources.append({"file": prox_with_ref(url, stream_ref) if api_base else url})

    # Keep embed-type entries (they carry the numeric megaplay ID used by resolveMegaplayNumericStreamId)
    embeds = [
        {"url": s.get("url") or s.get("file"), "type": "embed",
         "referer": s.get("referer", ""), "server": s.get("server", "")}
        for s in raw_streams
        if s.get("type") == "embed" and (s.get("url") or s.get("file"))
    ]

    # Subtitles from lostproject.club need megaplay.buzz referer (403 with vidwish.live)
    _SUB_REFERER = "https://megaplay.buzz"
    raw_subs = data.get("subtitles") or data.get("tracks") or []
    tracks = norm_tracks(raw_subs, default_referer=_SUB_REFERER)

    return {
        "sources": sources,
        "tracks": tracks,
        "embeds": embeds,
        "intro": data.get("intro", {}),
        "outro": data.get("outro", {}),
        "server": data.get("server", 0),
    }


async def _megaplay_proxy_get_sources(request: Request, path: str) -> Response:
    """Megaplay getSources only resolves numeric ids; slug ids (anikoto:…) need Miruro pipe (bee + ttl)."""
    api_base = str(request.base_url).rstrip("/")
    raw_id = request.query_params.get("id") or request.query_params.get("episodeId")
    if not raw_id:
        raise HTTPException(status_code=400, detail="Missing id")
    eid = unquote(str(raw_id))
    aid_q = request.query_params.get("aid")
    anilist_id: Optional[int] = int(aid_q) if aid_q is not None and str(aid_q).isdigit() else None
    iframe_cat = _resolve_embed_category(request)

    async def via_pipe() -> dict:
        if anilist_id is None:
            raise HTTPException(
                status_code=400,
                detail="Missing aid query param (AniList id) for composite episode ids",
            )
        pipe_cat = "ssub" if iframe_cat == "sub" else iframe_cat
        q: Dict[str, Any] = {
            "episodeId": eid,
            "provider": MEGAPLAY_PIPE_PROVIDER,
            "category": pipe_cat,
            "ttl": 86400,
        }
        ref_watch = f"{MIRURO_BASE}/watch/{anilist_id}"
        return await call_pipe("sources", "GET", q, referer=ref_watch)

    if not re.fullmatch(r"\d+", eid):
        if anilist_id is None:
            raise HTTPException(
                status_code=400,
                detail="Missing aid query param (AniList id) for composite episode ids",
            )
        data = await via_pipe()
        _log_stream_urls_from_payload(
            "embed_getsources_pipe_slug",
            data,
            episode_id=eid,
            iframe_category=iframe_cat,
            anilist_id=anilist_id,
        )
        return JSONResponse(
            content=_pipe_sources_as_megaplay_json(data, api_base),
            headers={"Cache-Control": "no-store, max-age=0"},
        )

    referer = _megaplay_proxy_referer(request, path)
    url = f"{GET_SOURCES_ENDPOINT}?id={quote(eid, safe='')}"
    client = await session_manager.get_client()
    r = await client.get(url, headers=_megaplay_getsources_headers(referer), follow_redirects=True)
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
    if anilist_id is not None:
        data = await via_pipe()
        _log_stream_urls_from_payload(
            "embed_getsources_pipe_fallback",
            data,
            episode_id=eid,
            iframe_category=iframe_cat,
            anilist_id=anilist_id,
            after_direct_status=r.status_code,
        )
        return JSONResponse(
            content=_pipe_sources_as_megaplay_json(data, api_base),
            headers={"Cache-Control": "no-store, max-age=0"},
        )
    return Response(
        content=r.content,
        status_code=r.status_code,
        media_type="application/json",
        headers={"Cache-Control": "no-store, max-age=0"},
    )


@app.api_route("/api/cdn-hls", methods=["GET", "HEAD", "OPTIONS"])
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
    r = await client.get(target, headers=hdr, follow_redirects=True)
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


async def _resolve_upstream_numeric_stream_id(
    episode_id: str,
    category: str,
    anilist_id: int,
) -> Optional[str]:
    """Resolve slug episode id → numeric vidwish stream id via Miruro pipe (bun.har flow)."""
    if re.fullmatch(r"\d+", str(episode_id)):
        return str(episode_id)
    try:
        data = await _pipe_sources_bee(episode_id, category, anilist_id)
        for emb in _pipe_sources_as_megaplay_json(data, "").get("embeds") or []:
            url = emb.get("url") or ""
            m = re.search(r"/stream/s-2/(\d+)/", url)
            if m:
                return m.group(1)
        m = re.search(r"stream/s-2/(\d+)/", json.dumps(data))
        return m.group(1) if m else None
    except Exception as e:
        log.warning(
            "resolve_numeric_stream_id",
            episode_id=str(episode_id)[:48],
            anilist_id=anilist_id,
            error=str(e)[:160],
        )
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


@app.api_route("/api/mp/{path:path}", methods=["GET", "HEAD", "OPTIONS"])
async def megaplay_reverse_proxy(path: str, request: Request):
    """Reverse-proxy Megaplay APIs/assets. ``embed_s2_mode`` controls ``stream/s-2`` (see ``config.json``)."""
    if request.method == "OPTIONS":
        return Response(status_code=204)

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
                    play_id = await _resolve_upstream_numeric_stream_id(
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


@app.get("/api/stream/iframe")
async def get_streaming_iframe(
    request: Request,
    episode_id: str = Query(..., description="Episode ID for the iframe"),
    category: str = Query("sub", description="Category: sub, dub, ssub"),
    anilist_id: Optional[int] = Query(None, alias="anilist_id", description="AniList id for slug episode ids"),
    aid: Optional[int] = Query(None, description="Alias for anilist_id"),
    synthetic: bool = Query(False, description="Force the same-origin hls.js player"),
):
    """Iframe URL — tries anikoto stream chain for ``anikoto:`` episode IDs, falls back to Miruro/Megaplay."""
    base = str(request.base_url).rstrip("/")
    cat_norm = _normalize_stream_category(category)
    aid_val = anilist_id if anilist_id is not None else aid
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
        nid = await _resolve_upstream_numeric_stream_id(play_id, category, int(aid_val))
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

@app.get("/api/health")
async def health_check():
    """Check liveness of all configured pipe sources and overall system status."""
    now = time.monotonic()

    async def probe(base: str) -> dict:
        dead_until = _pipe_dead_until.get(base, 0)
        currently_dead = dead_until > now
        # Use a fresh isolated client — no session cookies, no shared state.
        # Only check reachability of the base URL (HEAD). If that's up, the pipe is up.
        # We do NOT run a full pipe decode here to avoid false-positives from decode errors.
        async with httpx.AsyncClient(timeout=6.0, follow_redirects=True) as hc:
            try:
                t0 = time.monotonic()
                r = await hc.head(base, headers={"User-Agent": USER_AGENT, "Accept": "*/*"})
                latency_ms = int((time.monotonic() - t0) * 1000)
                # Any HTTP response (including 4xx) means the host is up
                reachable = r.status_code < 600
                status = "ok" if reachable else "error"
                if reachable:
                    _mark_pipe_alive(base)
                return {"base": base, "status": status, "http": r.status_code,
                        "latency_ms": latency_ms, "circuit_open": currently_dead}
            except Exception as e:
                return {"base": base, "status": "down", "error": str(e)[:120],
                        "circuit_open": currently_dead}

    results = list(await asyncio.gather(*[probe(b) for b in PIPE_BASES]))
    overall = "ok" if any(r["status"] == "ok" for r in results) else "degraded"
    return {
        "status": overall,
        "pipe_sources": results,
        "config": STREAM_CONFIG_PATH,
        "embed_s2_mode": _embed_s2_mode(),
        "stream_upstream_base": MEGAPLAY_BASE,
        "pipe_dead_ttl_s": int(_PIPE_DEAD_TTL),
    }


@app.get("/api/homepage")
async def get_homepage():
    """Get all homepage sections in one request (trending, popular, movies, upcoming, finished, schedule)."""
    import calendar
    import datetime

    now = datetime.datetime.utcnow()
    start_of_week = int(datetime.datetime(now.year, now.month, now.day).timestamp())
    end_of_week = start_of_week + 7 * 24 * 3600

    # Fetch AniList collections
    anilist_tasks = {
        "trending": _fetch_collection("TRENDING_DESC", page=1, per_page=12),
        "popular": _fetch_collection("POPULARITY_DESC", page=1, per_page=12),
        "upcoming": _fetch_collection("POPULARITY_DESC", "NOT_YET_RELEASED", page=1, per_page=12),
        "recent": _fetch_collection("START_DATE_DESC", "RELEASING", page=1, per_page=12),
    }

    # Fetch Miruro pipe homepage data
    pipe_tasks = []

    # Trending airing from Miruro
    pipe_tasks.append(call_pipe("search/browse", "GET", {
        "type": "ANIME", "status": "RELEASING",
        "sort": "TRENDING_DESC", "page": 1, "perPage": 12,
    }))

    # Popular upcoming
    pipe_tasks.append(call_pipe("search/browse", "GET", {
        "type": "ANIME", "status": "NOT_YET_RELEASED",
        "sort": "POPULARITY_DESC", "page": 1, "perPage": 12,
    }))

    # Top movies
    pipe_tasks.append(call_pipe("search", "GET", {
        "format": "MOVIE", "sort": "SCORE_DESC",
        "limit": 12, "offset": 0,
    }))

    # Schedule from Miruro
    pipe_tasks.append(call_pipe("schedule", "GET", {
        "startAt": start_of_week,
        "endAt": end_of_week,
        "sort": ["TIME"],
    }))

    # Run all tasks
    anilist_results = await asyncio.gather(*anilist_tasks.values(), return_exceptions=True)
    pipe_results = await asyncio.gather(*pipe_tasks, return_exceptions=True)

    anilist_result_map = {}
    for i, key in enumerate(anilist_tasks.keys()):
        result = anilist_results[i]
        anilist_result_map[key] = result if not isinstance(result, Exception) else {"results": []}

    return {
        # AniList-based sections
        "trending_airing": anilist_result_map["trending"],
        "popular_upcoming": anilist_result_map["upcoming"],
        "recent_episodes": anilist_result_map["recent"],
        "all_time_popular": anilist_result_map["popular"],
        # Miruro pipe-based sections
        "top_movies": pipe_results[2] if not isinstance(pipe_results[2], Exception) else [],
        "schedule": pipe_results[3] if not isinstance(pipe_results[3], Exception) else [],
    }


# ─── Streaming Player (HTML) ────────────────────────────────────────────────

PLAYER_HTML_TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>VaultCeaser - Watch</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
:root { --bg: #0a0a0f; --surface: #12121a; --surface2: #1a1a26; --surface3: #252535; --accent: #1abbd6; --accent2: #e06c9f; --text: #e8e8f0; --text2: #8888a0; }
body { background: var(--bg); color: var(--text); font-family: -apple-system, 'Segoe UI', system-ui, sans-serif; min-height: 100vh; }

/* Layout */
.app { display: grid; grid-template-columns: 1fr 380px; min-height: 100vh; }
@media (max-width: 900px) { .app { grid-template-columns: 1fr; } }

/* Player */
.player-section { position: sticky; top: 0; height: 100vh; display: flex; flex-direction: column; background: #000; }
.player-wrapper { flex: 1; position: relative; background: #000; display: flex; align-items: center; justify-content: center; overflow: hidden; }
.player-wrapper video { width: 100%; height: 100%; object-fit: contain; }
.player-placeholder { text-align: center; color: var(--text2); }
.player-placeholder svg { width: 64px; height: 64px; margin-bottom: 12px; opacity: 0.4; }
.player-placeholder h2 { font-size: 1.2rem; font-weight: 500; }
.player-placeholder p { font-size: 0.85rem; margin-top: 4px; }
.player-info { padding: 12px 20px; background: var(--surface); border-top: 1px solid var(--surface2); display: flex; align-items: center; gap: 12px; }
.player-info .ep-title { flex: 1; font-size: 0.9rem; font-weight: 500; }
.player-info .ep-num { background: var(--accent); color: #000; font-size: 0.7rem; font-weight: 700; padding: 2px 8px; border-radius: 4px; }
.quality-selector { display: none; }

/* Sidebar */
.sidebar { background: var(--surface); border-left: 1px solid var(--surface2); overflow-y: auto; display: flex; flex-direction: column; }

/* Anime Header */
.anime-header { padding: 20px; border-bottom: 1px solid var(--surface2); }
.anime-header .backdrop { position: relative; border-radius: 8px; overflow: hidden; margin-bottom: 12px; }
.anime-header .backdrop img { width: 100%; height: 140px; object-fit: cover; }
.anime-header .backdrop .overlay { position: absolute; inset: 0; background: linear-gradient(0deg, var(--surface) 0%, transparent 60%); }
.anime-header .title-row { display: flex; gap: 12px; align-items: flex-start; }
.anime-header .poster { width: 56px; height: 80px; border-radius: 6px; object-fit: cover; flex-shrink: 0; margin-top: -40px; position: relative; border: 2px solid var(--surface); }
.anime-header .info { flex: 1; min-width: 0; }
.anime-header .info h1 { font-size: 1rem; font-weight: 600; line-height: 1.3; }
.anime-header .info .subtitle { font-size: 0.75rem; color: var(--text2); margin-top: 2px; }
.anime-header .meta { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.anime-header .meta span { background: var(--surface2); padding: 2px 8px; border-radius: 10px; font-size: 0.7rem; color: var(--text2); }
.anime-header .meta .score { background: var(--accent2); color: #fff; }

/* Episode List */
.episode-section { padding: 16px 20px; flex: 1; }
.episode-section .section-title { font-size: 0.8rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text2); margin-bottom: 12px; display: flex; align-items: center; gap: 8px; }
.episode-section .section-title .count { color: var(--text2); font-weight: 400; }

.provider-bar { display: flex; gap: 6px; margin-bottom: 12px; flex-wrap: wrap; }
.provider-bar .cat-btn { background: var(--surface2); color: var(--text2); border: 1px solid transparent; padding: 4px 12px; border-radius: 6px; font-size: 0.75rem; cursor: pointer; transition: all 0.15s; }
.provider-bar .cat-btn:hover { border-color: var(--accent); }
.provider-bar .cat-btn.active { background: var(--accent); color: #000; border-color: var(--accent); font-weight: 600; }
.provider-bar .mp-label { font-size: 0.72rem; font-weight: 700; letter-spacing: 0.06em; color: var(--accent); }

.episode-list { display: flex; flex-direction: column; gap: 6px; }
.episode-item { display: flex; gap: 10px; padding: 10px; border-radius: 8px; cursor: pointer; transition: all 0.15s; border: 1px solid transparent; }
.episode-item:hover { background: var(--surface2); }
.episode-item.active { background: var(--surface2); border-color: var(--accent); }
.episode-item .thumb { width: 100px; height: 56px; border-radius: 4px; object-fit: cover; flex-shrink: 0; background: var(--surface2); }
.episode-item .ep-info { flex: 1; min-width: 0; }
.episode-item .ep-info .ep-number { font-size: 0.7rem; font-weight: 700; color: var(--accent); }
.episode-item .ep-info .ep-name { font-size: 0.82rem; font-weight: 500; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.episode-item .ep-info .ep-desc { font-size: 0.72rem; color: var(--text2); margin-top: 2px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.episode-item .ep-info .ep-air { font-size: 0.65rem; color: var(--text2); margin-top: 1px; }
.episode-item .loading-indicator { width: 16px; height: 16px; border: 2px solid var(--surface3); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.6s linear infinite; margin: auto; display: none; }
.episode-item.loading .loading-indicator { display: block; }

@keyframes spin { to { transform: rotate(360deg); } }

/* Loading skeleton */
.skeleton { animation: pulse 1.5s ease-in-out infinite; background: var(--surface2); border-radius: 4px; }
@keyframes pulse { 0%, 100% { opacity: 0.6; } 50% { opacity: 1; } }
.skeleton-text { height: 14px; margin-bottom: 8px; width: 70%; }
.skeleton-text.short { width: 40%; }

/* Scrollbar */
.sidebar::-webkit-scrollbar { width: 6px; }
.sidebar::-webkit-scrollbar-track { background: transparent; }
.sidebar::-webkit-scrollbar-thumb { background: var(--surface3); border-radius: 3px; }
</style>
</head>
<body>
<script type="application/json" id="vault-player-cfg">{{PLAYER_CFG_JSON}}</script>
<div class="app" id="app">
  <!-- Player Side -->
  <div class="player-section">
    <div class="player-wrapper" id="playerWrapper">
      <div class="player-placeholder" id="placeholder">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/><path d="M15.5 12l-5-3v6l5-3z"/></svg>
        <h2>Select an episode</h2>
        <p>Click an episode from the list to start watching</p>
      </div>
      <iframe id="megaplayFrame" title="Stream" allow="autoplay; fullscreen; encrypted-media; picture-in-picture" allowfullscreen
        style="display:none;width:100%;height:100%;border:0;background:#000"></iframe>
      <video id="videoPlayer" style="display:none" controls playsinline></video>
    </div>
    <div class="player-info" id="playerInfo" style="display:none">
      <span class="ep-num" id="currentEpNum"></span>
      <span class="ep-title" id="currentEpTitle"></span>
    </div>
  </div>

  <!-- Sidebar -->
  <div class="sidebar" id="sidebar">
    <div class="anime-header" id="animeHeader">
      <div class="skeleton" style="height:140px;border-radius:8px;margin-bottom:12px"></div>
      <div class="title-row">
        <div class="skeleton" style="width:56px;height:80px;border-radius:6px;margin-top:-40px;flex-shrink:0"></div>
        <div class="info">
          <div class="skeleton skeleton-text"></div>
          <div class="skeleton skeleton-text short"></div>
        </div>
      </div>
    </div>
    <div class="episode-section">
      <div class="section-title">Episodes <span class="count" id="epCount"></span></div>
      <div class="provider-bar" id="providerBar"></div>
      <div class="episode-list" id="episodeList">
        <div class="skeleton" style="height:76px;border-radius:8px;margin-bottom:6px"></div>
        <div class="skeleton" style="height:76px;border-radius:8px;margin-bottom:6px"></div>
        <div class="skeleton" style="height:76px;border-radius:8px;margin-bottom:6px"></div>
      </div>
    </div>
  </div>
</div>

<script>
const PLAYER_CFG = JSON.parse(document.getElementById('vault-player-cfg').textContent);
const ANILIST_ID = {{ANILIST_ID}};
let currentProvider = 'megaplay';
let currentCategory = 'sub';
let animeData = null;

const placeholder = document.getElementById('placeholder');
const playerInfo = document.getElementById('playerInfo');
const currentEpNum = document.getElementById('currentEpNum');
const currentEpTitle = document.getElementById('currentEpTitle');
const episodeList = document.getElementById('episodeList');
const providerBar = document.getElementById('providerBar');
const epCount = document.getElementById('epCount');
const megaplayFrame = document.getElementById('megaplayFrame');

async function loadAnime() {
  try {
    const res = await fetch(`/api/anime/${ANILIST_ID}`);
    const data = await res.json();
    renderHeader(data.info);
    animeData = data.info;
  } catch(e) {
    console.error('Failed to load anime:', e);
  }
}

function renderHeader(info) {
  const header = document.getElementById('animeHeader');
  const title = info.title?.english || info.title?.romaji || 'Unknown';
  const native = info.title?.native || '';
  const banner = info.bannerImage || info.coverImage?.extraLarge || info.coverImage?.large;
  const poster = info.coverImage?.large || '';
  const genres = info.genres || [];
  const score = info.averageScore || info.meanScore;
  const seasonYear = info.seasonYear || '';
  const format = info.format || '';
  const episodes = info.episodes || (info.nextAiringEpisode?.episode ?? '?');

  document.title = `VaultCeaser - ${title}`;

  header.innerHTML = `
    <div class="backdrop">
      <img src="${banner || poster}" alt="" onerror="this.style.display='none'">
      <div class="overlay"></div>
    </div>
    <div class="title-row">
      <img class="poster" src="${poster}" alt="${title}" onerror="this.style.display='none'">
      <div class="info">
        <h1>${title}</h1>
        <div class="subtitle">${native}</div>
        <div class="meta">
          ${score ? `<span class="score">★ ${score}%</span>` : ''}
          ${format ? `<span>${format}</span>` : ''}
          ${seasonYear ? `<span>${seasonYear}</span>` : ''}
          <span>${episodes} ep</span>
          ${genres.slice(0,3).map(g => `<span>${g}</span>`).join('')}
        </div>
      </div>
    </div>
  `;
}

async function loadEpisodes() {
  try {
    const res = await fetch(`/api/anime/${ANILIST_ID}/episodes`);
    const data = await res.json();
    const providers = data.episodes?.providers || {};
    renderProviderBar();
    renderEpisodesForProvider(currentProvider, currentCategory, providers);
    return providers;
  } catch(e) {
    console.error('Failed to load episodes:', e);
    return {};
  }
}

async function renderEpisodesForProvider(provider, category, providers) {
  const pData = providers[provider];
  if (!pData) {
    episodeList.innerHTML = '<p style="color:var(--text2);padding:20px">No Megaplay (bee) episode list for this title.</p>';
    epCount.textContent = '';
    return;
  }
  const eps = pData.episodes?.[category] || [];
  epCount.textContent = `(${eps.length})`;

  episodeList.innerHTML = eps.map(ep => `
    <div class="episode-item" data-id="${ep.original_id || ep.id}" data-number="${ep.number}" data-title="${(ep.title || '').replace(/"/g,'&quot;')}" data-image="${ep.image || ''}" data-desc="${(ep.description || '').replace(/"/g,'&quot;')}" data-air="${ep.airDate || ''}">
      <img class="thumb" src="${ep.image || ''}" alt="" onerror="this.style.background='var(--surface2)'">
      <div class="ep-info">
        <div class="ep-number">EPISODE ${ep.number}</div>
        <div class="ep-name">${ep.title || `Episode ${ep.number}`}</div>
        <div class="ep-desc">${(ep.description || '').substring(0,100)}</div>
        <div class="ep-air">${ep.airDate || ''}</div>
      </div>
      <div class="loading-indicator"></div>
    </div>
  `).join('');

  document.querySelectorAll('.episode-item').forEach(el => {
    el.addEventListener('click', () => { playEpisode(el).catch((e) => console.error(e)); });
  });
}

function renderProviderBar() {
  const cats = ['sub', 'dub', 'ssub'];
  providerBar.innerHTML = `
    <div style="display:flex;gap:8px;flex-wrap:wrap;width:100%;align-items:center">
      <span class="mp-label">PLAYBACK</span>
      <div style="display:flex;gap:4px;margin-left:auto;">
        ${cats.map(c => `<button type="button" class="cat-btn ${c === currentCategory ? 'active' : ''}" data-cat="${c}">${c.toUpperCase()}</button>`).join('')}
      </div>
    </div>
  `;

  providerBar.querySelectorAll('.cat-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      providerBar.querySelectorAll('.cat-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentCategory = btn.dataset.cat;
      megaplayFrame.src = 'about:blank';
      megaplayFrame.style.display = 'none';
      placeholder.style.display = 'block';
      playerInfo.style.display = 'none';
      await refreshEpisodes();
    });
  });
}

async function refreshEpisodes() {
  const res = await fetch(`/api/anime/${ANILIST_ID}/episodes`);
  const data = await res.json();
  renderProviderBar();
  renderEpisodesForProvider(currentProvider, currentCategory, data.episodes?.providers || {});
}

async function resolveMegaplayNumericStreamId(episodeId, category) {
  if (/^\d+$/.test(episodeId)) return episodeId;
  try {
    const qs = new URLSearchParams({ id: episodeId, aid: String(ANILIST_ID), category });
    const r = await fetch('/api/mp/stream/getSources?' + qs.toString());
    if (!r.ok) return null;
    const blob = JSON.stringify(await r.json());
    const m = blob.match(/stream\/s-2\/(\d+)\//);
    return m ? m[1] : null;
  } catch (e) {
    return null;
  }
}

async function playEpisode(el) {
  const episodeId = el.dataset.id;
  const number = el.dataset.number;
  const title = el.dataset.title || `Episode ${number}`;

  document.querySelectorAll('.episode-item').forEach(e => e.classList.remove('active'));
  el.classList.add('active');

  currentEpNum.textContent = `EP ${number}`;
  currentEpTitle.textContent = title;
  playerInfo.style.display = 'flex';

  el.classList.add('loading');

  placeholder.style.display = 'none';
  megaplayFrame.style.display = 'block';
  const eidProxied = encodeURIComponent(episodeId);
  const aidQ = 'aid=' + ANILIST_ID;
  let src;
  if (PLAYER_CFG.embedS2Mode === 'upstream' && /^\d+$/.test(episodeId)) {
    src = PLAYER_CFG.megaplayOrigin + '/stream/s-2/' + encodeURI(episodeId) + '/' + currentCategory + '?' + aidQ;
  } else if (PLAYER_CFG.embedS2Mode === 'upstream') {
    const nid = await resolveMegaplayNumericStreamId(episodeId, currentCategory);
    if (nid) {
      src = PLAYER_CFG.megaplayOrigin + '/stream/s-2/' + nid + '/' + currentCategory + '?' + aidQ;
    } else {
      src = '/api/mp/stream/s-2/' + eidProxied + '/' + currentCategory + '?' + aidQ;
    }
  } else {
    src = '/api/mp/stream/s-2/' + eidProxied + '/' + currentCategory + '?' + aidQ;
  }
  megaplayFrame.src = src;

  el.classList.remove('loading');
}

loadAnime();
loadEpisodes();
</script>
</body>
</html>
"""


@app.get("/watch/{anilist_id}", response_class=HTMLResponse)
async def watch_anime(anilist_id: int):
    """Serve an embedded HTML player page for watching anime."""
    cfg = {"megaplayOrigin": MEGAPLAY_BASE, "embedS2Mode": _embed_s2_mode()}
    html = (
        PLAYER_HTML_TEMPLATE.replace("{{ANILIST_ID}}", str(anilist_id)).replace(
            "{{PLAYER_CFG_JSON}}", json.dumps(cfg, separators=(",", ":"))
        )
    )
    return HTMLResponse(content=html)


# ─── Direct Pipe Proxy ───────────────────────────────────────────────────────

# /api/pipe removed — Miruro pipe no longer used.


# ─── Entry Point ─────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import sys
    import uvicorn
    from pathlib import Path

    use_reload = "--reload" in sys.argv
    _root = Path(__file__).resolve().parent
    kw: Dict[str, Any] = {
        "host": "0.0.0.0",
        "port": 8080,
        "reload": use_reload,
        "log_level": "info",
        "use_colors": False,  # Windows consoles often print raw ESC sequences as garbage (←[32m)
    }
    if use_reload:
        kw["reload_dirs"] = [str(_root)]
        kw["reload_excludes"] = ["**/node_modules/**", "**/.git/**"]

    print(
        "VaultCeaser API — http://127.0.0.1:8080  "
        + ("(reload on — watching project files)" if use_reload else "(reload off — use: py server.py --reload)"),
        flush=True,
    )
    uvicorn.run("server:app", **kw)
