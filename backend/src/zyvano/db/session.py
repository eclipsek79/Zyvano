"""Database session management with SQLAlchemy 2.x support.

The connection URL always comes from ``BACKEND_DATABASE_URL`` -- never the
shared ``DATABASE_URL``, which belongs to the TypeScript platform and defines
projects/users/exports with different schemas. See ``zyvano/config.py``.
"""

import logging

from sqlalchemy import create_engine
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import declarative_base, sessionmaker
from sqlalchemy.pool import NullPool, QueuePool

from zyvano.config import settings

logger = logging.getLogger(__name__)

# Declarative base for models
Base = declarative_base()

# Only postgresql+asyncpg / mysql+asyncmy select the async engine. A bare
# "postgresql://" URL implies the sync psycopg2 driver, which this project does
# not install; config validation rejects that scheme up front.
IS_ASYNC = settings.BACKEND_DATABASE_URL.startswith(("postgresql+asyncpg", "mysql+asyncmy"))

_POOL_KWARGS: dict = {}
if IS_ASYNC:
    # An asyncio engine cannot use QueuePool -- ``create_async_engine`` raises
    # ``ArgumentError: Pool class QueuePool cannot be used with asyncio engine``,
    # and the sync NullPool variant is rejected for the same reason.
    # Passing no poolclass at all lets SQLAlchemy select its own
    # AsyncAdaptedQueuePool, which is the supported configuration. Previously
    # this branch inherited QueuePool from the non-test path, so the entire
    # asyncpg configuration was unusable.
    pass
elif settings.NODE_ENV == "test":
    # NullPool opens a connection per checkout and closes it on return, so a
    # test run cannot leak pooled connections into the next one. Critically, it
    # accepts NO pool_size/max_overflow arguments -- passing them raises
    # ``TypeError: Invalid argument(s) 'pool_size','max_overflow'``. That is a
    # second, independent reason the test configuration never worked: the branch
    # was unreachable because config rejected NODE_ENV="test", and it was broken
    # even when reached. Hence the explicit split below.
    _POOL_KWARGS["poolclass"] = NullPool
else:
    _POOL_KWARGS.update(
        poolclass=QueuePool,
        pool_size=20,
        max_overflow=40,
        pool_pre_ping=True,
        pool_recycle=3600,
    )

if IS_ASYNC:
    # Async engine for async contexts (FastAPI endpoints)
    async_engine = create_async_engine(
        settings.BACKEND_DATABASE_URL,
        echo=settings.DEBUG,
        **_POOL_KWARGS,
    )

    AsyncSessionLocal = async_sessionmaker(
        bind=async_engine,
        class_=AsyncSession,
        expire_on_commit=False,
        autocommit=False,
        autoflush=False,
    )

    async def get_async_db():
        """Dependency for getting an async database session."""
        async with AsyncSessionLocal() as session:
            try:
                yield session
            finally:
                await session.close()

    # Sync names are not available in this configuration. They are explicitly
    # typed as None so the placeholder value is not mistaken for a usable engine
    # while still failing loudly on first use rather than at import.
    engine = None  # type: ignore[assignment]
    SessionLocal = None
    get_db = None
else:
    # Sync engine for sync contexts (CLI, migrations, background jobs)
    engine = create_engine(
        settings.BACKEND_DATABASE_URL,
        echo=settings.DEBUG,
        **_POOL_KWARGS,
    )

    SessionLocal = sessionmaker(
        bind=engine,
        autocommit=False,
        autoflush=False,
        expire_on_commit=False,
    )

    def get_db():
        """Dependency for getting a database session."""
        db = SessionLocal()
        try:
            yield db
        finally:
            db.close()

    async_engine = None  # type: ignore[assignment]
    AsyncSessionLocal = None  # type: ignore[assignment]
    get_async_db = None  # type: ignore[assignment]


def get_session_maker():
    """Get the session maker appropriate to the configured driver."""
    return AsyncSessionLocal if IS_ASYNC else SessionLocal
