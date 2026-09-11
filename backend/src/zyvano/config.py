"""Application configuration with security hardening."""

from pathlib import Path

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """Application settings from environment variables.

    All sensitive configuration must come from environment.
    No secrets should have default values suitable for production.

    Security principles:
    - All secrets required (no defaults)
    - HTTPS enforced in production
    - CORS strictly configured
    - SQL injection prevention via ORM/parameterization
    - CSRF protection via secure tokens
    - Rate limiting enabled
    """

    # Database - REQUIRED in production
    #
    # DATABASE_URL is the shared TypeScript/Node platform connection string.
    # It is still read for parity with the rest of the repo, but it is NOT the
    # database this backend uses -- see BACKEND_DATABASE_URL below.
    DATABASE_URL: str = Field(
        default="",
        description="Shared TypeScript/Node platform connection string (required in production)",
    )

    # This backend's OWN database. Required, and deliberately separate from the
    # TypeScript platform's DATABASE_URL: the two tracks both create `projects`,
    # `users`, `exports`, `generation_attempts` and `project_members` with
    # different schemas, so sharing one database means whichever migration runs
    # second fails on DuplicateTable -- or worse, silently writes into the other
    # platform's tables.
    BACKEND_DATABASE_URL: str = Field(
        default="",
        description=(
            "This Python backend's own PostgreSQL connection string (required). "
            "Must point at a database separate from the TypeScript platform's."
        ),
    )

    # Redis - REQUIRED in production
    REDIS_URL: str = Field(
        default="", description="Redis connection string (required in production)"
    )

    # JWT - REQUIRED secrets
    JWT_ALGORITHM: str = "HS256"
    JWT_EXPIRATION_HOURS: int = 1
    JWT_REFRESH_EXPIRATION_DAYS: int = 7
    JWT_SECRET_KEY: str = Field(
        default="", description="JWT signing secret (required, min 32 chars in production)"
    )

    # Auth - REQUIRED secrets
    AUTH_SECRET: str = Field(
        default="", description="Authentication secret (required, min 32 chars in production)"
    )
    AUTH_REDIRECT_URL: str = "http://localhost:3000/auth/callback"

    # Application
    APP_NAME: str = "Zyvano"
    APP_VERSION: str = "0.1.0"
    NODE_ENV: str = Field(
        default="development", description="Environment: development, staging, production"
    )
    LOG_LEVEL: str = "info"
    DEBUG: bool = False

    # API
    API_V1_PREFIX: str = "/api/v1"

    # CORS - dev defaults, must be overridden in production
    CORS_ORIGINS: list[str] = Field(
        default=["http://localhost:3000", "http://localhost:8081"],
        description="Allowed CORS origins",
    )

    # Rate limiting
    RATE_LIMIT_ENABLED: bool = True
    RATE_LIMIT_REQUESTS: int = 100
    RATE_LIMIT_WINDOW_SECONDS: int = 60

    # Upload
    MAX_UPLOAD_SIZE_MB: int = 1024

    # Security headers
    SECURE_HSTS_SECONDS: int = 31536000  # 1 year
    SECURE_HSTS_PRELOAD: bool = True
    SECURE_HSTS_INCLUDE_SUBDOMAINS: bool = True
    SECURE_SSL_REDIRECT: bool = False  # Set to True in production

    class Config:
        # A single gitignored repository-root .env configures both stacks.
        # This previously read only ``backend/.env.local``, which does not
        # exist -- so every documented key in .env (BACKEND_DATABASE_URL among
        # them) was silently ignored and only real process environment
        # variables took effect. Paths are absolute and derived from this
        # file, so the result does not depend on the process CWD.
        #
        # Order matters: later files win, so the root .env supplies defaults
        # and a local ``backend/.env.local`` can override them.
        env_file = (
            str(Path(__file__).resolve().parents[3] / ".env"),
            str(Path(__file__).resolve().parents[2] / ".env.local"),
        )
        case_sensitive = True
        # The shared root .env holds configuration for the TypeScript platform
        # as well, so keys this backend does not know about must not abort
        # startup. Real process environment variables still outrank dotenv.
        extra = "ignore"

    @field_validator("DATABASE_URL", mode="after")
    @classmethod
    def validate_database_url(cls, v: str) -> str:
        """Validate DATABASE_URL is configured."""
        if not v:
            raise ValueError(
                "DATABASE_URL must be set via environment variable. "
                "Never commit database credentials."
            )
        # A non-local host is treated as production and must be an explicit
        # PostgreSQL URL; localhost is exempt so the documented local default
        # does not have to repeat the scheme.
        if "localhost" not in v and "127.0.0.1" not in v and not v.startswith("postgresql://"):
            raise ValueError("DATABASE_URL must be a valid PostgreSQL connection string")
        return v

    @field_validator("BACKEND_DATABASE_URL", mode="after")
    @classmethod
    def validate_backend_database_url(cls, v: str, info) -> str:
        """Validate the backend's own database URL and keep it isolated.

        Two failure modes are rejected here because both are silent and
        destructive rather than loud:

        1. Falling back to the shared DATABASE_URL, which would point Alembic
           at the TypeScript platform's schema where `projects`/`users`/
           `exports` already exist with different shapes.
        2. A bare ``postgresql://`` URL. ``IS_ASYNC`` in db/session.py only
           treats ``postgresql+asyncpg``/``postgresql+asyncmy`` as async, so a
           bare URL selects the sync branch and instantiates ``QueuePool``,
           which raises NotImplementedError when ``create_engine`` builds it
           for a psycopg3 driver.
        """
        if not v:
            raise ValueError(
                "BACKEND_DATABASE_URL must be set via environment variable. "
                "This backend must not fall back to the TypeScript platform's "
                "DATABASE_URL; both define projects/users/exports with "
                "different schemas."
            )

        shared = info.data.get("DATABASE_URL")
        if shared and v == shared:
            raise ValueError(
                "BACKEND_DATABASE_URL must not be identical to DATABASE_URL. "
                "The Python backend requires its own database; sharing the "
                "platform database collides on projects, users, exports, "
                "generation_attempts and project_members."
            )

        scheme = v.split("://", 1)[0] if "://" in v else ""
        if "+psycopg" not in scheme and "+asyncpg" not in scheme:
            raise ValueError(
                "BACKEND_DATABASE_URL must name an explicit psycopg3 or asyncpg "
                f"driver (got scheme '{scheme}'). Use "
                "postgresql+psycopg://... -- a bare 'postgresql://' URL selects "
                "the psycopg2 path, which this project does not install."
            )
        return v

    @field_validator("REDIS_URL", mode="after")
    @classmethod
    def validate_redis_url(cls, v: str) -> str:
        """Validate REDIS_URL is configured."""
        if not v:
            raise ValueError(
                "REDIS_URL must be set via environment variable. "
                "Required for job queue and caching."
            )
        return v

    @field_validator("JWT_SECRET_KEY", mode="after")
    @classmethod
    def validate_jwt_secret(cls, v: str) -> str:
        """Validate JWT secret is configured and sufficiently long."""
        if not v:
            raise ValueError(
                "JWT_SECRET_KEY must be set via environment variable. " "Never commit JWT secrets."
            )
        if len(v) < 32:
            raise ValueError("JWT_SECRET_KEY must be at least 32 characters")
        return v

    @field_validator("AUTH_SECRET", mode="after")
    @classmethod
    def validate_auth_secret(cls, v: str) -> str:
        """Validate AUTH_SECRET is configured and sufficiently long."""
        if not v:
            raise ValueError(
                "AUTH_SECRET must be set via environment variable. "
                "Never commit authentication secrets."
            )
        if len(v) < 32:
            raise ValueError("AUTH_SECRET must be at least 32 characters")
        return v

    @field_validator("NODE_ENV", mode="after")
    @classmethod
    def validate_environment(cls, v: str) -> str:
        """Validate NODE_ENV is one of allowed values.

        "test" is included because db/session.py branches on
        ``settings.NODE_ENV == "test"`` to select NullPool. When "test" was
        rejected here, that branch was unreachable and every test run silently
        used QueuePool -- so a connection pool was opened against the test
        database and never deterministically released.
        """
        if v not in ("development", "staging", "production", "test"):
            raise ValueError("NODE_ENV must be 'development', 'staging', 'production', or 'test'")
        return v

    @field_validator("CORS_ORIGINS", mode="after")
    @classmethod
    def validate_cors_origins(cls, v: list[str], info) -> list[str]:
        """Validate CORS origins are properly configured."""
        if not v:
            raise ValueError("CORS_ORIGINS must not be empty")

        # In production, ensure no localhost
        if info.data.get("NODE_ENV") == "production":
            for origin in v:
                if "localhost" in origin or "127.0.0.1" in origin:
                    raise ValueError(
                        "Production CORS_ORIGINS must not include localhost. "
                        "Configure proper domain origins."
                    )
        return v

    @field_validator("SECURE_SSL_REDIRECT", mode="after")
    @classmethod
    def validate_ssl_redirect(cls, v: bool, info) -> bool:
        """Ensure SSL redirect is enabled in production."""
        if info.data.get("NODE_ENV") == "production" and not v:
            raise ValueError("SECURE_SSL_REDIRECT must be True in production")
        return v

    def is_production(self) -> bool:
        """Check if running in production."""
        return self.NODE_ENV == "production"

    def is_development(self) -> bool:
        """Check if running in development."""
        return self.NODE_ENV == "development"

    def is_staging(self) -> bool:
        """Check if running in staging."""
        return self.NODE_ENV == "staging"

    def is_test(self) -> bool:
        """Check if running under tests (selects NullPool in db/session.py)."""
        return self.NODE_ENV == "test"


# Create singleton settings instance
# Raises ValueError if required configuration is missing
try:
    settings = Settings()
except ValueError as e:
    import sys

    print(f"Configuration Error: {e}", file=sys.stderr)
    sys.exit(1)
