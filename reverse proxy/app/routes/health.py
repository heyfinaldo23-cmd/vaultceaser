"""Health and diagnostics routes."""

from fastapi import APIRouter

from .. import core as handlers

router = APIRouter()
router.add_api_route("/health", handlers.health, methods=["GET"])
router.add_api_route("/api/health", handlers.health_check, methods=["GET"])
