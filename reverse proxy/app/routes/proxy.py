"""Reverse proxy routes for player and CDN traffic."""

from fastapi import APIRouter

from .. import core as handlers

router = APIRouter()
router.add_api_route("/api/cdn-hls", handlers.cdn_hls_proxy, methods=["GET", "HEAD", "OPTIONS"])
router.add_api_route("/api/mp/{path:path}", handlers.megaplay_reverse_proxy, methods=["GET", "HEAD", "OPTIONS"])
