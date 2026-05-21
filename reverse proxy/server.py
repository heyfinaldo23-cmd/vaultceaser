"""Compatibility entrypoint for the VaultCeaser FastAPI app."""

from pathlib import Path
from typing import Any, Dict
import sys

from app.main import app


if __name__ == "__main__":
    import uvicorn

    use_reload = "--reload" in sys.argv
    root = Path(__file__).resolve().parent
    kw: Dict[str, Any] = {
        "host": "0.0.0.0",
        "port": 8080,
        "reload": use_reload,
        "log_level": "info",
        "use_colors": False,
    }
    if use_reload:
        kw["reload_dirs"] = [str(root)]
        kw["reload_excludes"] = ["**/node_modules/**", "**/.git/**"]

    print(
        "VaultCeaser API - http://127.0.0.1:8080  "
        + ("(reload on - watching project files)" if use_reload else "(reload off - use: py server.py --reload)"),
        flush=True,
    )
    uvicorn.run("app.main:app", **kw)
