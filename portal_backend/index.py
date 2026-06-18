# index.py — Minimal debug version to isolate Vercel startup crash
import os
import sys
import traceback

_errors = []

# Step 1: Can we import FastAPI at all?
try:
    from fastapi import FastAPI
    from fastapi.responses import JSONResponse
    _errors.append("fastapi: OK")
except Exception as e:
    _errors.append(f"fastapi FAILED: {e}")

# Step 2: Can we import our app?
_app_error = None
try:
    from app.main import app
    _errors.append("app.main: OK")
except Exception as e:
    _app_error = traceback.format_exc()
    _errors.append(f"app.main FAILED: {e}")

# If app import failed, serve a diagnostic FastAPI app
if _app_error:
    app = FastAPI()

    @app.get("/{full_path:path}")
    @app.post("/{full_path:path}")
    async def _diag(full_path: str = ""):
        return JSONResponse(status_code=500, content={
            "import_error": _app_error,
            "steps": _errors,
            "python": sys.version,
            "DATABASE_URL_set": bool(os.getenv("DATABASE_URL")),
        })
