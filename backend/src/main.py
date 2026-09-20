"""FastAPI application factory and entry point."""
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from vid.config import settings
from vid.db.session import engine, Base
from vid.middleware.request_id import RequestIDMiddleware
from vid.middleware.error_handler import global_exception_handler
from vid.services.credits.api import router as credits_router

logging.basicConfig(level=getattr(logging, settings.LOG_LEVEL.upper()),
                    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)

@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info(f"Starting Zyvano backend (v{settings.APP_VERSION})")
    try:
        Base.metadata.create_all(bind=engine)
        logger.info("Database tables created/verified")
    except Exception as e:
        logger.error(f"Failed to initialize database: {e}")
        raise
    yield
    logger.info("Shutting down Zyvano backend")

def create_app() -> FastAPI:
    app = FastAPI(title="Zyvano API",
                  description="Cross-platform AI creative-production platform",
                  version=settings.APP_VERSION, lifespan=lifespan)
    app.add_middleware(RequestIDMiddleware)
    app.add_middleware(CORSMiddleware, allow_origins=settings.CORS_ORIGINS,
                       allow_credentials=True,
                       allow_methods=["GET","POST","PUT","DELETE","PATCH","OPTIONS"],
                       allow_headers=["*"], max_age=3600)
    app.add_exception_handler(Exception, global_exception_handler)

    @app.get("/health", tags=["Health"])
    async def health():
        return {"status":"healthy","service":"zyvano-api","version":settings.APP_VERSION}

    @app.get("/ready", tags=["Health"])
    async def ready():
        try:
            with engine.connect() as conn:
                conn.execute("SELECT 1")
            return {"ready":True,"status":"service is ready"}
        except Exception as e:
            logger.error(f"Readiness check failed: {e}")
            return {"ready":False,"error":"database connection failed"}, 503

    app.include_router(credits_router)
    logger.info("FastAPI application created successfully")
    return app

app = create_app()

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=settings.API_PORT,
                reload=settings.NODE_ENV=="development",
                log_level=settings.LOG_LEVEL.lower())
