"""
main.py — FastAPI application entry point.

WHY THIS FILE EXISTS:
FastAPI needs one central file that:
1. Creates the app instance
2. Configures CORS (who can call this API)
3. Registers all route files
4. Adds global middleware (logging, error handling)

HOW IT WORKS:
When you run `uvicorn app.main:app`, Python:
1. Imports this file
2. Creates the FastAPI() app object
3. Registers all routes from routes/
4. Starts listening on port 8000

Every request then flows:
  Browser → main.py (CORS check) → route handler → service → Odoo → response
"""

import logging
import time

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded

from app.config import get_settings
from app.db.portal_db import init_db
from app.limiter import limiter
from app.routes import auth, orders, documents, admin, cultfit, portal_auth

# AI Engineer routes require anthropic + chromadb — large packages not included
# in the Vercel deployment. Skipped gracefully if packages are missing.
try:
    from app.routes import ai as _ai_route
    _AI_ENABLED = True
except ImportError:
    _ai_route = None
    _AI_ENABLED = False

# ─── Logger ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
)
logger = logging.getLogger("portal_backend")

# ─── App Instance ─────────────────────────────────────────────────────────────
settings = get_settings()

app = FastAPI(
    title="InBody Customer Portal API",
    description=(
        "Middleware API between the external customer portal (Next.js) "
        "and the Odoo ERP backend. Handles authentication, multi-tenant "
        "isolation, FOFO price masking, and audit logging."
    ),
    version="1.0.0",
    # Swagger/ReDoc disabled in production (DEBUG=false) to avoid exposing API schema.
    docs_url="/docs" if settings.DEBUG else None,
    redoc_url="/redoc" if settings.DEBUG else None,
)

# ─── Rate Limiter ─────────────────────────────────────────────────────────────
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# ─── CORS ─────────────────────────────────────────────────────────────────────
# CORS = Cross-Origin Resource Sharing.
# Without this, the browser blocks the Next.js frontend from calling this API.
# WHY: Browsers enforce same-origin policy — a page on localhost:3000 cannot
#      call an API on localhost:8000 unless the API explicitly allows it.
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)

# ─── Request Timing Middleware ────────────────────────────────────────────────
# Logs how long each request takes. Helps identify slow Odoo queries.
@app.middleware("http")
async def log_requests(request: Request, call_next):
    start = time.perf_counter()
    response = await call_next(request)
    elapsed_ms = round((time.perf_counter() - start) * 1000, 1)
    logger.info(
        "%s %s → %s (%sms)",
        request.method,
        request.url.path,
        response.status_code,
        elapsed_ms,
    )
    response.headers["X-Response-Time"] = f"{elapsed_ms}ms"
    return response

# ─── Global Error Handler ─────────────────────────────────────────────────────
# Catches any unhandled exception and returns a clean JSON error.
# WHY: Without this, Python exceptions appear as ugly 500 HTML pages.
@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    logger.error("Unhandled error on %s: %s", request.url.path, str(exc))
    return JSONResponse(
        status_code=500,
        content={"error": {"code": "INTERNAL_ERROR", "message": "An unexpected error occurred."}},
    )

# ─── Routes ───────────────────────────────────────────────────────────────────
# Each router file handles one group of endpoints.
# prefix="/api/v1" means all routes start with /api/v1/...
app.include_router(portal_auth.router, prefix="/api/v1", tags=["Portal Auth"])
app.include_router(auth.router,        prefix="/api/v1", tags=["Authentication (Odoo)"])
app.include_router(orders.router,      prefix="/api/v1", tags=["Orders"])
app.include_router(documents.router,   prefix="/api/v1", tags=["Documents"])
app.include_router(admin.router,       prefix="/api/v1", tags=["Admin"])
app.include_router(cultfit.router,     prefix="/api/v1", tags=["CultFit"])
if _AI_ENABLED:
    app.include_router(_ai_route.router, prefix="/api/v1", tags=["AI Engineer"])

# ─── Health Check ─────────────────────────────────────────────────────────────
@app.on_event("startup")
async def startup():
    init_db()


@app.get("/ping", tags=["Health"])
async def ping():
    """Quick health check — returns ok if the server is running."""
    return {
        "status": "ok",
        "service": "InBody Portal Backend",
        "version": "1.0.0",
        "odoo_url": settings.ODOO_BASE_URL,
    }
