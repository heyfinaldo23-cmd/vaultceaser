"""Anime metadata and discovery routes."""

from fastapi import APIRouter
from fastapi.responses import HTMLResponse

from .. import core as handlers

router = APIRouter()
router.add_api_route("/api/genres", handlers.get_genres, methods=["GET"])
router.add_api_route("/api/search", handlers.search_anime, methods=["GET"])
router.add_api_route("/api/suggestions", handlers.search_suggestions, methods=["GET"])
router.add_api_route("/api/filter", handlers.filter_anime, methods=["GET"])
router.add_api_route("/api/spotlight", handlers.get_spotlight, methods=["GET"])
router.add_api_route("/api/anime/{mal_id}", handlers.get_anime_info, methods=["GET"])
router.add_api_route("/api/anime/{mal_id}/characters", handlers.get_anime_characters, methods=["GET"])
router.add_api_route("/api/anime/{mal_id}/relations", handlers.get_anime_relations, methods=["GET"])
router.add_api_route("/api/anime/{mal_id}/recommendations", handlers.get_anime_recommendations, methods=["GET"])
