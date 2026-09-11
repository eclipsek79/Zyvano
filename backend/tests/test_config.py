"""Validation tests for zyvano.config.Settings.

Focused on the failure modes that are silent and destructive in production:
falling back to the shared TypeScript database, and a connection URL that
selects a driver this project does not install.
"""

import pytest
from pydantic import ValidationError

from zyvano.config import Settings

REDIS = "redis://127.0.0.1:6379/0"
BACKEND_URL = "postgresql+psycopg://zyvano:zyvano@127.0.0.1:5432/zyvano_backend"
SHARED_URL = "postgresql://zyvano:zyvano@127.0.0.1:5432/zyvano"


VALID = {
    "BACKEND_DATABASE_URL": BACKEND_URL,
    "DATABASE_URL": SHARED_URL,
    "REDIS_URL": REDIS,
    "AUTH_SECRET": "a" * 64,
    "JWT_SECRET_KEY": "j" * 64,
}


def make(**overrides) -> Settings:
    """Build Settings from explicit kwargs (init args beat env vars)."""
    return Settings(**{**VALID, **overrides})


def errors_for(**overrides) -> str:
    with pytest.raises(ValidationError) as excinfo:
        make(**overrides)
    return str(excinfo.value)


# --------------------------------------------------------------------------- #
# BACKEND_DATABASE_URL                                                        #
# --------------------------------------------------------------------------- #


def test_valid_configuration_loads():
    settings = make()
    assert settings.BACKEND_DATABASE_URL == BACKEND_URL
    assert settings.DATABASE_URL == SHARED_URL
    assert settings.is_test() is True


def test_backend_url_absent_is_rejected_not_silently_fallen_back():
    """The whole point of the field: no fallback to the shared platform DB."""
    message = errors_for(BACKEND_DATABASE_URL="")
    assert "BACKEND_DATABASE_URL must be set" in message


def test_backend_url_equal_to_shared_url_is_rejected():
    """Sharing the platform DB collides on projects/users/exports."""
    message = errors_for(BACKEND_DATABASE_URL=SHARED_URL)
    assert "must not be identical to DATABASE_URL" in message


def test_asyncpg_scheme_accepted():
    settings = make(
        BACKEND_DATABASE_URL="postgresql+asyncpg://zyvano:zyvano@127.0.0.1:5432/zyvano_backend"
    )
    assert "+asyncpg" in settings.BACKEND_DATABASE_URL


def test_bare_postgresql_scheme_rejected():
    """Bare postgresql:// selects the psycopg2 path, which is not installed.

    db/session.py treats only postgresql+asyncpg/asyncmy as async, so a bare
    URL picks the sync branch and hands psycopg2's dialect to create_engine --
    which then raises NotImplementedError when QueuePool is set up.
    """
    message = errors_for(BACKEND_DATABASE_URL="postgresql://u:p@localhost:5432/other_db")
    assert "driver" in message


def test_mysql_scheme_rejected():
    message = errors_for(BACKEND_DATABASE_URL="mysql://u:p@localhost/db")
    assert "driver" in message


# --------------------------------------------------------------------------- #
# NODE_ENV                                                                    #
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("value", ["development", "staging", "production", "test"])
def test_node_env_allowed_values(value):
    overrides = {"NODE_ENV": value}
    if value == "production":
        overrides.update(
            CORS_ORIGINS=["https://app.zyvano.example"],
            SECURE_SSL_REDIRECT=True,
        )
    assert value == make(**overrides).NODE_ENV


def test_node_env_rejects_unknown_value():
    message = errors_for(NODE_ENV="banana")
    assert "NODE_ENV must be" in message


def test_test_env_selects_nullpool_branch():
    """db/session.py branches on NODE_ENV == "test"; it must be reachable."""
    settings = make(NODE_ENV="test")
    assert settings.is_test() is True
    assert settings.is_production() is False


# --------------------------------------------------------------------------- #
# secrets / redis                                                             #
# --------------------------------------------------------------------------- #


def test_short_auth_secret_rejected():
    assert "AUTH_SECRET must be at least 32" in errors_for(AUTH_SECRET="short")


def test_empty_auth_secret_rejected():
    assert "AUTH_SECRET must be set" in errors_for(AUTH_SECRET="")


def test_short_jwt_secret_rejected():
    assert "JWT_SECRET_KEY must be at least 32" in errors_for(JWT_SECRET_KEY="short")


def test_empty_redis_url_rejected():
    assert "REDIS_URL must be set" in errors_for(REDIS_URL="")


def test_empty_shared_database_url_rejected():
    assert "DATABASE_URL must be set" in errors_for(DATABASE_URL="")


# --------------------------------------------------------------------------- #
# production hardening                                                        #
# --------------------------------------------------------------------------- #


def test_production_rejects_localhost_cors_origin():
    message = errors_for(
        NODE_ENV="production",
        CORS_ORIGINS=["http://localhost:3000"],
        SECURE_SSL_REDIRECT=True,
    )
    assert "must not include localhost" in message


def test_production_requires_ssl_redirect():
    message = errors_for(
        NODE_ENV="production",
        CORS_ORIGINS=["https://app.zyvano.example"],
        SECURE_SSL_REDIRECT=False,
    )
    assert "SECURE_SSL_REDIRECT must be True" in message


def test_empty_cors_origins_rejected():
    assert "CORS_ORIGINS must not be empty" in errors_for(CORS_ORIGINS=[])
