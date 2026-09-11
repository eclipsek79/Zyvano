"""Shared pytest fixtures for the Zyvano Python backend.

Environment variables are set at IMPORT time, before ``zyvano.config`` is
imported. ``Settings()`` is instantiated as a module-level singleton in
``zyvano/config.py``, so anything imported earlier would freeze the wrong
configuration for the whole session.

Each session gets a freshly created PostgreSQL database with the real Alembic
migrations applied -- not ``Base.metadata.create_all``, which is what the app
used to do at startup. Testing against migrated DDL is the only way to catch
drift between the models and migration 001_initial_schema.
"""

import os
import pathlib
import subprocess
import sys

import pytest

BACKEND_DIR = pathlib.Path(__file__).resolve().parents[1]
SRC_DIR = BACKEND_DIR / "src"

PG_HOST = "127.0.0.1"
PG_PORT = 5432
PG_USER = "zyvano"
PG_PASS = "zyvano"
TEST_DB_NAME = "zyvano_backend_test"

TEST_DATABASE_URL = f"postgresql+psycopg://{PG_USER}:{PG_PASS}@{PG_HOST}:{PG_PORT}/{TEST_DB_NAME}"
SHARED_DATABASE_URL = f"postgresql://{PG_USER}:{PG_PASS}@{PG_HOST}:{PG_PORT}/zyvano"

# --- configuration must be in place BEFORE zyvano is imported ---------------
os.environ["NODE_ENV"] = "test"
os.environ["DATABASE_URL"] = SHARED_DATABASE_URL
os.environ["BACKEND_DATABASE_URL"] = TEST_DATABASE_URL
os.environ["REDIS_URL"] = f"redis://{PG_HOST}:6379/0"
os.environ["AUTH_SECRET"] = "t" * 64
os.environ["JWT_SECRET_KEY"] = "t" * 64
os.environ["LOG_LEVEL"] = "warning"

# These are set as real process environment variables rather than relying on
# the dotenv file, because process environment is the documented
# highest-priority configuration source. The repository-root .env is loaded as
# a second source and configures BOTH stacks, so its NODE_ENV=development and
# its TypeScript-platform DATABASE_URL would otherwise win over the values above
# and silently move the suite onto the wrong database and the wrong pool.

if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))


def _admin_connection():
    """Connect to the maintenance DB so we can create/drop the test DB."""
    import psycopg

    return psycopg.connect(
        f"postgresql://{PG_USER}:{PG_PASS}@{PG_HOST}:{PG_PORT}/postgres",
        autocommit=True,
    )


@pytest.fixture(scope="session", autouse=True)
def _database():
    """Recreate the backend test database, then apply Alembic migrations."""
    with _admin_connection() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
            "WHERE datname = %s AND pid <> pg_backend_pid()",
            (TEST_DB_NAME,),
        )
        cur.execute(f'DROP DATABASE IF EXISTS "{TEST_DB_NAME}"')
        cur.execute(f'CREATE DATABASE "{TEST_DB_NAME}" OWNER {PG_USER}')

    result = subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", "head"],
        cwd=str(BACKEND_DIR),
        capture_output=True,
        text=True,
        env=dict(os.environ),
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"alembic upgrade head failed (rc={result.returncode})\n"
            f"--- stdout ---\n{result.stdout}\n"
            f"--- stderr ---\n{result.stderr}"
        )
    yield


@pytest.fixture(scope="session")
def engine(_database):
    """Session-scoped engine bound to the migrated test database."""
    from sqlalchemy import create_engine
    from sqlalchemy.pool import NullPool

    eng = create_engine(TEST_DATABASE_URL, poolclass=NullPool)
    yield eng
    eng.dispose()


@pytest.fixture()
def db(engine):
    """Function-scoped session wrapped in a transaction that never commits.

    ``join_transaction_mode="create_savepoint"`` lets the services call
    ``commit()`` as they normally do while the outer transaction is still
    rolled back afterwards, so no test can leak rows into another.
    """
    from sqlalchemy.orm import Session

    connection = engine.connect()
    transaction = connection.begin()
    session = Session(bind=connection, join_transaction_mode="create_savepoint")
    try:
        yield session
    finally:
        session.close()
        transaction.rollback()
        connection.close()
