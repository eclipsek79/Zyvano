"""Tests for zyvano.db.session -- driver branch and pool selection.

The module picks its engine, session maker and connection pool from
configuration at IMPORT time, and it has two mutually exclusive branches
(sync psycopg3 / async asyncpg). Only one of them can be exercised per process,
so the other is driven through subprocesses with a scrubbed environment. That
is the only way to prove the branch is reachable at all -- a single in-process
test would silently leave half the module unverified.
"""

import os
import pathlib
import subprocess
import sys

BACKEND_DIR = pathlib.Path(__file__).resolve().parents[1]

SYNC_URL = "postgresql+psycopg://zyvano:zyvano@127.0.0.1:5432/zyvano_backend_test"
ASYNC_URL = "postgresql+asyncpg://zyvano:zyvano@127.0.0.1:5432/zyvano_backend_test"

_PROBE = """
import sys
sys.path.insert(0, "src")
from zyvano.db import session as s
print("IS_ASYNC", s.IS_ASYNC)
print("POOL", type(s.engine.pool).__name__ if s.engine is not None else "None")
print("ENGINE", s.engine is not None)
print("SESSIONLOCAL", s.SessionLocal is not None)
print("GETDB", callable(s.get_db))
print("ASYNC_ENGINE", s.async_engine is not None)
print("ASYNC_LOCAL", s.AsyncSessionLocal is not None)
print("GET_ASYNC_DB", callable(s.get_async_db))
"""


def _probe(**overrides):
    """Import zyvano.db.session in a child process with controlled config."""
    env = dict(os.environ)
    env.update(
        DATABASE_URL="postgresql://zyvano:zyvano@127.0.0.1:5432/zyvano",
        REDIS_URL="redis://127.0.0.1:6379/0",
        AUTH_SECRET="t" * 64,
        JWT_SECRET_KEY="t" * 64,
        LOG_LEVEL="warning",
    )
    env.update(overrides)
    result = subprocess.run(
        [sys.executable, "-c", _PROBE],
        cwd=str(BACKEND_DIR),
        env=env,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    out = {}
    for line in result.stdout.strip().splitlines():
        key, _, value = line.partition(" ")
        out[key] = value
    return out


# --------------------------------------------------------------------------- #
# sync branch (the branch this test session runs in)                          #
# --------------------------------------------------------------------------- #


def test_sync_driver_selects_sync_engine():
    probe = _probe(BACKEND_DATABASE_URL=SYNC_URL, NODE_ENV="development")
    assert probe["IS_ASYNC"] == "False"
    assert probe["ENGINE"] == "True"
    assert probe["SESSIONLOCAL"] == "True"
    assert probe["GETDB"] == "True"
    # The async symbols must be explicitly nulled, not left undefined, so
    # callers can branch on them without an AttributeError.
    assert probe["ASYNC_ENGINE"] == "False"
    assert probe["ASYNC_LOCAL"] == "False"
    assert probe["GET_ASYNC_DB"] == "False"


def test_async_driver_selects_async_engine():
    """The asyncpg branch is otherwise completely unexercised."""
    probe = _probe(BACKEND_DATABASE_URL=ASYNC_URL, NODE_ENV="development")
    assert probe["IS_ASYNC"] == "True"
    assert probe["ASYNC_ENGINE"] == "True"
    assert probe["ASYNC_LOCAL"] == "True"
    assert probe["GET_ASYNC_DB"] == "True"
    assert probe["ENGINE"] == "False"
    assert probe["SESSIONLOCAL"] == "False"
    assert probe["GETDB"] == "False"


def test_test_environment_selects_nullpool():
    """NODE_ENV=test must pick NullPool or pooled connections leak between runs.

    This is why config.py accepts "test" as an environment value at all: when it
    rejected the value, this branch was unreachable and every test run silently
    used QueuePool.
    """
    probe = _probe(BACKEND_DATABASE_URL=SYNC_URL, NODE_ENV="test")
    assert probe["POOL"] == "NullPool"


def test_non_test_environment_selects_queuepool():
    probe = _probe(BACKEND_DATABASE_URL=SYNC_URL, NODE_ENV="development")
    assert probe["POOL"] == "QueuePool"


def test_missing_backend_url_refuses_to_start_the_session_module():
    """No silent fallback to the shared platform database."""
    env = dict(os.environ)
    env.update(
        DATABASE_URL="postgresql://zyvano:zyvano@127.0.0.1:5432/zyvano",
        REDIS_URL="redis://127.0.0.1:6379/0",
        AUTH_SECRET="t" * 64,
        JWT_SECRET_KEY="t" * 64,
        NODE_ENV="development",
    )
    env.pop("BACKEND_DATABASE_URL", None)
    # Set to the empty string rather than merely popped: an empty process
    # environment variable still outranks the dotenv file, so this reproduces a
    # genuinely unconfigured backend. Removing the key alone would let the
    # repository .env supply a valid value -- correct layered behaviour, but not
    # the condition under test.
    env["BACKEND_DATABASE_URL"] = ""
    result = subprocess.run(
        [sys.executable, "-c", _PROBE],
        cwd=str(BACKEND_DIR),
        env=env,
        capture_output=True,
        text=True,
    )
    assert result.returncode != 0
    assert "BACKEND_DATABASE_URL" in (result.stdout + result.stderr)


# --------------------------------------------------------------------------- #
# in-process behaviour of the live session objects                            #
# --------------------------------------------------------------------------- #


def test_module_level_objects_exported_for_the_sync_branch():
    from zyvano.db import session

    assert session.IS_ASYNC is False
    assert session.engine is not None
    assert session.SessionLocal is not None
    assert session.async_engine is None


def test_get_db_yields_a_working_session_and_closes_it():
    from sqlalchemy import text

    from zyvano.db.session import get_db

    generator = get_db()
    db = next(generator)
    try:
        assert db.execute(text("SELECT 1")).scalar() == 1
        assert db.is_active is True
    finally:
        generator.close()

    # ``Session.close()`` releases the connection and resets the session rather
    # than making it permanently unusable, so what matters for pool hygiene is
    # that no transaction is left open. get_db's ``finally`` block is what
    # guarantees it. (An earlier version of this assertion expected reuse to
    # raise, which is not what SQLAlchemy does.)
    assert db.in_transaction() is False


def test_get_session_maker_matches_the_selected_branch():
    from zyvano.db import session

    assert session.get_session_maker() is session.SessionLocal


def test_declarative_base_is_shared_by_the_models():
    from zyvano.db.models import Project, User
    from zyvano.db.session import Base

    assert issubclass(User, Base)
    assert issubclass(Project, Base)
