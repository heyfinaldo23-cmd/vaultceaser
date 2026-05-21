"""Streaming source and episode routes."""

from fastapi import APIRouter

from .. import core as handlers

router = APIRouter()
router.add_api_route("/api/episode-counts", handlers.batch_episode_counts, methods=["GET"])
router.add_api_route("/api/anime/{mal_id}/episodes", handlers.get_anime_episodes, methods=["GET"])
router.add_api_route("/api/anime/{mal_id}/stream", handlers.get_anime_stream, methods=["GET"])
router.add_api_route("/api/sources", handlers.get_sources, methods=["GET"])
router.add_api_route("/api/stream/url", handlers.get_streaming_url, methods=["GET"])
router.add_api_route("/api/stream/iframe", handlers.get_streaming_iframe, methods=["GET"])
