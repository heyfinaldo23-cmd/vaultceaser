"""Discord webhook log bridge configured by config.json."""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
import json
import os
from pathlib import Path
from typing import Any

import httpx


DISCORD_FIELD_LIMIT = 25
DISCORD_VALUE_LIMIT = 1024


def _clean(value: Any, limit: int = DISCORD_VALUE_LIMIT) -> str:
    text = "" if value is None else str(value)
    text = text.replace("\r", " ").strip()
    if len(text) > limit:
        return text[: limit - 1] + "…"
    return text


def _field(name: str, value: Any, inline: bool = True) -> dict[str, Any]:
    return {"name": _clean(name, 256), "value": _clean(value) or "-", "inline": inline}


def _load_discord_config() -> dict[str, Any]:
    config_path = Path(os.environ.get("VAULTCEASER_CONFIG", Path(__file__).resolve().parents[1] / "config.json"))
    if not config_path.is_file():
        return {}
    try:
        with config_path.open(encoding="utf-8") as f:
            raw = json.load(f)
    except Exception:
        return {}
    cfg = raw.get("discord") if isinstance(raw, dict) else {}
    return cfg if isinstance(cfg, dict) else {}


class DiscordWebhookLogger:
    """Non-blocking Discord embed sender with basic rate-limit handling."""

    def __init__(self) -> None:
        cfg = _load_discord_config()
        self.webhook_url = str(cfg.get("webhook_url") or "").strip()
        self.username = str(cfg.get("username") or "VaultCeaser Logs").strip()
        self.log_requests = bool(cfg.get("log_requests", True))
        self.log_streams = bool(cfg.get("log_streams", True))
        self.enabled = bool(self.webhook_url) and bool(cfg.get("enabled", True))
        self._queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue(maxsize=200)
        self._task: asyncio.Task | None = None
        self._client: httpx.AsyncClient | None = None

    async def start(self) -> None:
        if not self.enabled or self._task:
            return
        self._client = httpx.AsyncClient(timeout=8.0)
        self._task = asyncio.create_task(self._worker(), name="discord_webhook_logger")

    async def stop(self) -> None:
        if not self.enabled:
            return
        if self._task:
            await self._queue.put(None)
            await self._task
            self._task = None
        if self._client:
            await self._client.aclose()
            self._client = None

    def enqueue_embed(
        self,
        *,
        title: str,
        description: str = "",
        color: int = 0x2B90D9,
        fields: list[dict[str, Any]] | None = None,
    ) -> None:
        if not self.enabled:
            return
        embed = {
            "title": _clean(title, 256),
            "description": _clean(description, 4096),
            "color": color,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "fields": (fields or [])[:DISCORD_FIELD_LIMIT],
            "footer": {"text": "VaultCeaser • server telemetry"},
        }
        payload = {"username": self.username, "embeds": [embed]}
        try:
            self._queue.put_nowait(payload)
        except asyncio.QueueFull:
            # Dropping webhook logs is better than slowing playback.
            pass

    def request_done(
        self,
        *,
        method: str,
        path: str,
        status: int,
        duration_ms: float,
        request_id: str,
        client: str,
        content_type: str,
    ) -> None:
        if not self.log_requests:
            return
        if path.startswith("/static/"):
            return
        ok = status < 400
        color = 0x2ECC71 if ok else 0xE74C3C
        title = "Request OK" if ok else "Request Failed"
        self.enqueue_embed(
            title=f"{title} • {method} {path}",
            description="HTTP request completed.",
            color=color,
            fields=[
                _field("Status", status),
                _field("Duration", f"{duration_ms:.2f} ms"),
                _field("Request ID", request_id),
                _field("Client", client or "unknown"),
                _field("Content-Type", content_type or "-"),
            ],
        )

    def request_error(
        self,
        *,
        method: str,
        path: str,
        duration_ms: float,
        request_id: str,
        error: str,
    ) -> None:
        if not self.log_requests:
            return
        self.enqueue_embed(
            title=f"Request Error • {method} {path}",
            description=_clean(error, 1200),
            color=0xE74C3C,
            fields=[
                _field("Duration", f"{duration_ms:.2f} ms"),
                _field("Request ID", request_id),
            ],
        )

    def stream_event(self, event: str, **fields: Any) -> None:
        if not self.log_streams:
            return
        color = 0xF1C40F if "resolved" in event else 0x9B59B6
        anime = fields.get("anime_title") or fields.get("anilist_id") or "Stream"
        visible_fields = [
            _field("Anime", anime, False),
            _field("Event", event),
        ]
        for key in (
            "provider",
            "category",
            "episode_id",
            "resolved_stream_id",
            "source_id",
            "stream_count",
            "track_count",
            "upstream_host",
            "first_host",
            "duration_ms",
        ):
            if key in fields and fields[key] not in (None, ""):
                visible_fields.append(_field(key.replace("_", " ").title(), fields[key]))
        self.enqueue_embed(
            title="Streaming Event",
            description="Megaplay stream telemetry.",
            color=color,
            fields=visible_fields,
        )

    async def _worker(self) -> None:
        assert self._client is not None
        while True:
            payload = await self._queue.get()
            if payload is None:
                return
            try:
                response = await self._client.post(self.webhook_url, json=payload)
                if response.status_code == 429:
                    retry_after = 1.0
                    try:
                        retry_after = float(response.json().get("retry_after", retry_after))
                    except Exception:
                        pass
                    await asyncio.sleep(min(retry_after, 10.0))
                    await self._client.post(self.webhook_url, json=payload)
            except Exception:
                # Console logs still exist; webhook failures should never break requests.
                pass


discord_logger = DiscordWebhookLogger()
