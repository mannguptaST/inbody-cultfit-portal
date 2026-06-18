# index.py — Vercel serverless entry point.
# Wraps import errors so they appear as readable JSON instead of blank 500s.
import traceback

_import_error = None
try:
    from app.main import app
except Exception as _e:
    _import_error = traceback.format_exc()
    from fastapi import FastAPI
    from fastapi.responses import JSONResponse
    app = FastAPI()

    @app.get("/{full_path:path}")
    @app.post("/{full_path:path}")
    async def _error_handler(full_path: str):
        return JSONResponse(status_code=500, content={"startup_error": _import_error})
