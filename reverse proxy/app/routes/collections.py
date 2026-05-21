"""Homepage and anime collection routes."""

from fastapi import APIRouter

from .. import core as handlers

router = APIRouter()
router.add_api_route("/api/trending", handlers.get_trending, methods=["GET"])
router.add_api_route("/api/popular", handlers.get_popular, methods=["GET"])
router.add_api_route("/api/upcoming", handlers.get_upcoming, methods=["GET"])
router.add_api_route("/api/recent", handlers.get_recent, methods=["GET"])
router.add_api_route("/api/fresh", handlers.get_fresh, methods=["GET"])
router.add_api_route("/api/latest-releases", handlers.get_latest_releases, methods=["GET"])
router.add_api_route("/api/recently-completed", handlers.get_recently_completed, methods=["GET"])
router.add_api_route("/api/schedule", handlers.get_schedule, methods=["GET"])
router.add_api_route("/api/homepage", handlers.get_homepage, methods=["GET"])
