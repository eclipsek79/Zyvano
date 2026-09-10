"""Database session management with SQLAlchemy 2.x async support."""
from sqlalchemy import create_engine
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from sqlalchemy.orm import declarative_base, sessionmaker
from sqlalchemy.pool import NullPool, QueuePool
import logging

from vid.config import settings

logger = logging.getLogger(__name__)

# Declarative base for models
Base = declarative_base()

# Determine if using async engine
IS_ASYNC = settings.DATABASE_URL.startswith(("postgresql+asyncpg", "mysql+asyncmy"))

if IS_ASYNC:
    # Async engine for async contexts (FastAPI endpoints)
    async_engine = create_async_engine(
        settings.DATABASE_URL,
        poolclass=NullPool if settings.NODE_ENV == "test" else QueuePool,
        pool_size=20,
        max_overflow=40,
        pool_pre_ping=True,
        pool_recycle=3600,
        echo=settings.DEBUG,
    )

    AsyncSessionLocal = async_sessionmaker(
        bind=async_engine,
        class_=AsyncSession,
        expire_on_commit=False,
        autocommit=False,
        autoflush=False,
    )

    async def get_async_db():
        """Dependency for getting async database session."""
        async with AsyncSessionLocal() as session:
            try:
                yield session
            finally:
                await session.close()
else:
    # Sync engine for sync contexts (CLI, migrations, background jobs)
    engine = create_engine(
        settings.DATABASE_URL,
        poolclass=NullPool if settings.NODE_ENV == "test" else QueuePool,
        pool_size=20,
        max_overflow=40,
        pool_pre_ping=True,
        pool_recycle=3600,
        echo=settings.DEBUG,
    )

    SessionLocal = sessionmaker(
        bind=engine,
        autocommit=False,
        autoflush=False,
        expire_on_commit=False,
    )

    def get_db():
        """Dependency for getting database session."""
        db = SessionLocal()
        try:
            yield db
        finally:
            db.close()


# Provide unified interface regardless of sync/async
if IS_ASYNC:
    # Export async versions as primary
    engine = None  # Not used in async context
    SessionLocal = None
    get_db = None
else:
    # Export sync versions
    async_engine = None
    AsyncSessionLocal = None
    get_async_db = None


def get_session_maker():
    """Get the appropriate session maker."""
    if IS_ASYNC:
        return AsyncSessionLocal
    return SessionLocal
