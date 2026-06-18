# index.py — Vercel serverless entry point.
# Vercel detects the `app` ASGI object from this file and serves it.
# All routes, middleware, and startup logic live in app/main.py.
from app.main import app
