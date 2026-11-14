"""Serve the traffic simulator and its API from the same origin."""

from pathlib import Path

from fastapi.staticfiles import StaticFiles

from .main import app

FRONTEND = Path(__file__).resolve().parent.parent / "frontend"
app.mount("/", StaticFiles(directory=FRONTEND, html=True), name="frontend")
