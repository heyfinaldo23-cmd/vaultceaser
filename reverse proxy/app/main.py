"""FastAPI application assembly for VaultCeaser."""

from pathlib import Path
import time
import uuid

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi import Request
from fastapi.staticfiles import StaticFiles
import structlog

from .core import _app_lifespan
from .discord_webhook import discord_logger
from .routes.collections import router as collections_router
from .routes.health import router as health_router
from .routes.metadata import router as metadata_router
from .routes.pages import router as pages_router
from .routes.proxy import router as proxy_router
from .routes.streaming import router as streaming_router

APP_ROOT = Path(__file__).resolve().parent

app = FastAPI(
    title="VaultCeaser Anime API",
    description="Unified API for anime metadata (Jikan/MAL) + streaming (Megaplay)",
    version="3.0.0",
    lifespan=_app_lifespan,
)

log = structlog.get_logger("vaultceaser.access")


@app.middleware("http")
async def log_request_timing(request: Request, call_next):
    """Emit compact access logs with latency for every request."""
    request_id = uuid.uuid4().hex[:10]
    started = time.perf_counter()
    path = request.url.path
    log.info(
        "request_start",
        request_id=request_id,
        method=request.method,
        path=path,
        query=str(request.url.query)[:240],
        client=(request.client.host if request.client else ""),
    )
    try:
        response = await call_next(request)
    except Exception as exc:
        duration_ms = round((time.perf_counter() - started) * 1000, 2)
        log.exception(
            "request_error",
            request_id=request_id,
            method=request.method,
            path=path,
            duration_ms=duration_ms,
            error=str(exc)[:240],
        )
        discord_logger.request_error(
            request_id=request_id,
            method=request.method,
            path=path,
            duration_ms=duration_ms,
            error=str(exc)[:240],
        )
        raise
    duration_ms = round((time.perf_counter() - started) * 1000, 2)
    content_type = response.headers.get("content-type", "").split(";")[0]
    log.info(
        "request_done",
        request_id=request_id,
        method=request.method,
        path=path,
        status=response.status_code,
        duration_ms=duration_ms,
        content_type=content_type,
    )
    discord_logger.request_done(
        request_id=request_id,
        method=request.method,
        path=path,
        status=response.status_code,
        duration_ms=duration_ms,
        client=(request.client.host if request.client else ""),
        content_type=content_type,
    )
    return response

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/static", StaticFiles(directory=str(APP_ROOT / "static")), name="static")
app.include_router(pages_router)
app.include_router(health_router)
app.include_router(metadata_router)
app.include_router(collections_router)
app.include_router(streaming_router)
app.include_router(proxy_router)
