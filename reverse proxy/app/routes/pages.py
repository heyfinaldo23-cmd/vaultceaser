"""HTML and documentation routes."""

from fastapi import APIRouter
from fastapi.responses import HTMLResponse

from .. import core as handlers

router = APIRouter()
router.add_api_route("/", handlers.root, methods=["GET", "HEAD"])
router.add_api_route("/docs.html", handlers.serve_docs_html, methods=["GET"])
router.add_api_route(
    "/watch/{mal_id}",
    handlers.watch_anime,
    methods=["GET"],
    response_class=HTMLResponse,
)
router.add_api_route(
    "/api/embed",
    handlers.embed_player,
    methods=["GET"],
    response_class=HTMLResponse,
)
