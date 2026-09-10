"""FastAPI application factory and entry point."""
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.exceptions import RequestValidationError
from starlette.exceptions import HTTPException

from vid.config import settings
from vid.db.session import engine, Base
from vid.middleware.request_id import RequestIDMiddleware
from vid.middleware.error_handler import global_exception_handler

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
    try:
        Base.metadata.create_all(bind=engine)
        logger.info("Database tables created/verified")
    except Exception as e:
        logger.error(f"Failed to initialize database: {e}")
        raise

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
        """Readiness probe - checks database connectivity."""
        try:
            with engine.connect() as conn:
                conn.execute("SELECT 1")
            return {"ready": True, "status": "service is ready"}
        except Exception as e:
            logger.error(f"Readiness check failed: {e}")
            return {
                "ready": False,
                "error": "database connection failed",
            }, 503

    logger.info("FastAPI application created successfully")
    return app


# Create application instance for uvicorn
app = create_app()

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=8000,
        reload=settings.NODE_ENV == "development",
        log_level=settings.LOG_LEVEL.lower(),
    )
