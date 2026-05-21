"""Local smoke tests for the VaultCeaser FastAPI app.

This checks route wiring and, when upstream providers cooperate, verifies that
Megaplay-only stream resolution returns an HLS playlist-like response.
"""

from __future__ import annotations

import asyncio
import os
import time
from typing import Any
from urllib.parse import urlparse

import httpx

from app.main import app


ANILIST_ID = int(os.environ.get("SMOKE_ANILIST_ID", "21"))
TIMEOUT = float(os.environ.get("SMOKE_TIMEOUT", "25"))


def _status(ok: bool) -> str:
    return "OK" if ok else "FAIL"


def _print_result(name: str, status: int | str, ms: float, detail: str = "") -> None:
    print(f"{_status(status == 200 or status == 'SKIP'):<4} {name:<42} {str(status):<5} {ms:>8.1f} ms  {detail}")


async def _request(client: httpx.AsyncClient, name: str, path: str, ok_statuses: set[int] | None = None) -> tuple[bool, Any]:
    ok_statuses = ok_statuses or {200}
    started = time.perf_counter()
    try:
        response = await client.get(path, timeout=TIMEOUT)
        ms = (time.perf_counter() - started) * 1000
        ok = response.status_code in ok_statuses
        detail = response.headers.get("content-type", "").split(";")[0]
        if not ok:
            detail = response.text[:160].replace("\n", " ")
        _print_result(name, response.status_code, ms, detail)
        return ok, response
    except Exception as exc:
        ms = (time.perf_counter() - started) * 1000
        _print_result(name, "ERR", ms, str(exc)[:160])
        return False, None


def _find_first_episode(episodes_payload: dict[str, Any]) -> tuple[str, str, int] | None:
    providers = (episodes_payload.get("episodes") or {}).get("providers") or {}
    megaplay = providers.get("megaplay") or {}
    by_category = megaplay.get("episodes") or {}
    for category in ("sub", "dub", "ssub"):
        episodes = by_category.get(category) or []
        if episodes:
            ep = episodes[0]
            episode_id = str(ep.get("original_id") or ep.get("id") or "")
            if episode_id:
                return episode_id, category, int(ep.get("number") or 1)
    return None


async def _verify_stream(client: httpx.AsyncClient) -> bool:
    ok, episodes_response = await _request(
        client,
        "episodes: megaplay list",
        f"/api/anime/{ANILIST_ID}/episodes",
        ok_statuses={200, 404},
    )
    if not ok or episodes_response is None or episodes_response.status_code != 200:
        _print_result("video: playable hls", "SKIP", 0, "No episode list to test")
        return False

    first = _find_first_episode(episodes_response.json())
    if not first:
        _print_result("video: playable hls", "SKIP", 0, "No Megaplay episodes found")
        return False

    episode_id, category, number = first
    detail = f"episode={number} category={category} id={episode_id[:48]}"
    _print_result("stream candidate", "SKIP", 0, detail)

    await _request(
        client,
        "stream iframe",
        f"/api/stream/iframe?episode_id={episode_id}&category={category}&anilist_id={ANILIST_ID}&synthetic=1",
        ok_statuses={200, 404, 502},
    )

    ok, source_response = await _request(
        client,
        "stream sources",
        f"/api/sources?episode_id={episode_id}&provider=megaplay&category={category}&anilist_id={ANILIST_ID}",
        ok_statuses={200, 404, 502},
    )
    if not ok or source_response is None or source_response.status_code != 200:
        _print_result("video: playable hls", "SKIP", 0, "Source resolution failed upstream")
        return False

    payload = source_response.json()
    streams = ((payload.get("sources") or {}).get("streams") or [])
    stream_url = streams[0].get("url") if streams else ""
    if not stream_url:
        _print_result("video: playable hls", "FAIL", 0, "No stream URL returned")
        return False

    host = urlparse(stream_url).hostname or "local"
    started = time.perf_counter()
    try:
        parsed_stream_url = urlparse(stream_url)
        if stream_url.startswith("http://testserver/"):
            playlist_path = stream_url.replace("http://testserver", "", 1)
            playlist_response = await client.get(playlist_path, timeout=TIMEOUT)
        elif stream_url.startswith("/"):
            playlist_response = await client.get(stream_url, timeout=TIMEOUT)
        elif not parsed_stream_url.scheme:
            playlist_path = stream_url
            if playlist_path.startswith("testserver/"):
                playlist_path = playlist_path[len("testserver"):]
            if not playlist_path.startswith("/"):
                playlist_path = f"/{playlist_path}"
            playlist_response = await client.get(playlist_path, timeout=TIMEOUT)
        else:
            async with httpx.AsyncClient(timeout=TIMEOUT, follow_redirects=True) as external:
                playlist_response = await external.get(stream_url)
        ms = (time.perf_counter() - started) * 1000
        body_head = playlist_response.text[:256] if playlist_response.content else ""
        looks_like_hls = "#EXTM3U" in body_head or "mpegurl" in playlist_response.headers.get("content-type", "").lower()
        _print_result(
            "video: playable hls",
            200 if playlist_response.status_code < 400 and looks_like_hls else playlist_response.status_code,
            ms,
            f"host={host} hls={looks_like_hls}",
        )
        return playlist_response.status_code < 400 and looks_like_hls
    except Exception as exc:
        ms = (time.perf_counter() - started) * 1000
        _print_result("video: playable hls", "ERR", ms, str(exc)[:160])
        return False


async def main() -> int:
    print(f"VaultCeaser smoke test | anilist_id={ANILIST_ID} | timeout={TIMEOUT}s")
    print(f"{'STAT':<4} {'CHECK':<42} {'HTTP':<5} {'TIME':>11}  DETAIL")
    print("-" * 90)

    transport = httpx.ASGITransport(app=app)
    failures = 0
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver", follow_redirects=False) as client:
        checks = [
            ("root", "/"),
            ("health", "/health"),
            ("api health", "/api/health"),
            ("genres", "/api/genres"),
            ("search", "/api/search?q=naruto&page=1&per_page=2"),
            ("suggestions", "/api/suggestions?q=naruto"),
            ("filter", "/api/filter?genre=Action&page=1&per_page=2"),
            ("spotlight", "/api/spotlight"),
            ("trending", "/api/trending?per_page=2"),
            ("popular", "/api/popular?per_page=2"),
            ("upcoming", "/api/upcoming?per_page=2"),
            ("recent", "/api/recent?per_page=2"),
            ("fresh", "/api/fresh?per_page=2"),
            ("latest releases", "/api/latest-releases?per_page=2"),
            ("recently completed", "/api/recently-completed?per_page=2"),
            ("schedule", "/api/schedule?per_page=2"),
            ("anime info", f"/api/anime/{ANILIST_ID}"),
            ("characters", f"/api/anime/{ANILIST_ID}/characters?per_page=2"),
            ("relations", f"/api/anime/{ANILIST_ID}/relations"),
            ("recommendations", f"/api/anime/{ANILIST_ID}/recommendations?per_page=2"),
            ("episode counts", f"/api/episode-counts?ids={ANILIST_ID}"),
            ("watch page", f"/watch/{ANILIST_ID}"),
            ("static watch js", "/static/watch.js"),
            ("static embed js", "/static/embed.js"),
            ("synthetic embed page", f"/api/mp/stream/s-2/smoke/sub?synthetic=1&aid={ANILIST_ID}"),
        ]
        for name, path in checks:
            ok, _ = await _request(client, name, path, ok_statuses={200, 307})
            failures += 0 if ok else 1
        stream_ok = await _verify_stream(client)
        if not stream_ok:
            failures += 1

    print("-" * 90)
    print(f"Result: {'PASS' if failures == 0 else 'FAIL'} ({failures} failed or skipped critical checks)")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
