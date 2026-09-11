"""FastAPI application factory and entry point."""

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import text

from zyvano.config import settings
from zyvano.db.session import IS_ASYNC, async_engine, engine
from zyvano.middleware.error_handler import global_exception_handler
from zyvano.middleware.request_id import RequestIDMiddleware

# Configure logging
logging.basicConfig(
    level=getattr(logging, settings.LOG_LEVEL.upper()),
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Lifespan context manager for startup and shutdown events."""
    # Startup
    logger.info(f"Starting Zyvano backend (v{settings.APP_VERSION})")
    # Schema management belongs to Alembic, not to application startup.
    # ``Base.metadata.create_all`` used to run here, which made the runtime
    # schema depend on whichever process booted first and let the backend
    # create tables independently of its migrations. Run `alembic upgrade
    # head` (see backend/alembic) before starting the service.

    yield

    # Shutdown
    logger.info("Shutting down Zyvano backend")


def create_app() -> FastAPI:
    """Create and configure FastAPI application.

    Sets up:
    - CORS middleware
    - Request ID middleware for tracing
    - Global exception handlers
    - API routes
    - Health/readiness endpoints
    """
    app = FastAPI(
        title="Zyvano API",
        description="Cross-platform AI creative-production platform",
        version=settings.APP_VERSION,
        lifespan=lifespan,
    )

    # Add middleware (order matters: innermost = last added)
    app.add_middleware(RequestIDMiddleware)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.CORS_ORIGINS,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
        allow_headers=["*"],
        max_age=3600,
    )

    # Add exception handlers
    app.add_exception_handler(Exception, global_exception_handler)

    # Health check endpoints
    @app.get("/health", tags=["Health"])
    async def health():
        """Service health check - no authentication required."""
        return {
            "status": "healthy",
            "service": "zyvano-api",
            "version": settings.APP_VERSION,
        }

    @app.get("/ready", tags=["Health"])
    async def ready():
        """Readiness probe - checks database connectivity.

        Returns 503 when the database is unreachable. Previously this returned
        a ``(dict, 503)`` tuple from the route, which FastAPI serialised as a
        JSON *array* while still sending HTTP 200 -- so the probe reported
        healthy no matter what. The raw "SELECT 1" also had to be wrapped in
        ``text()`` or SQLAlchemy refuses it (ObjectNotExecutableError).
        """
        try:
            if IS_ASYNC:
                async with async_engine.connect() as conn:
                    await conn.execute(text("SELECT 1"))
            else:
                with engine.connect() as conn:
                    conn.execute(text("SELECT 1"))
            return {"ready": True, "status": "service is ready"}
        except Exception as e:
            logger.error(f"Readiness check failed: {e}")
            return JSONResponse(
                status_code=503,
                content={"ready": False, "error": "database connection failed"},
            )

    logger.info("FastAPI application created successfully")
    return app


# The application is created lazily rather than at import time.
#
# ``app = create_app()`` used to run here at module scope, which meant merely
# importing ``main`` -- which migrations tooling, scripts and this test suite
# all do -- constructed a FastAPI application and logged "FastAPI application
# created successfully" as an import side effect.
_app: FastAPI | None = None


def get_app() -> FastAPI:
    """Return the process-wide application, creating it on first use."""
    global _app
    if _app is None:
        _app = create_app()
    return _app


def __getattr__(name: str) -> FastAPI:
    """Resolve ``main.app`` lazily (PEP 562).

    ``uvicorn main:app`` and ``TestClient(main.app)`` both perform the attribute
    lookup *after* importing the module, so the application is still created
    exactly once -- on first access -- and never merely because ``main`` was
    imported.
    """
    if name == "app":
        return get_app()
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=8000,
        reload=settings.NODE_ENV == "development",
        log_level=settings.LOG_LEVEL.lower(),
    )
