"""Application configuration with security hardening."""
from typing import List
from pydantic import Field, field_validator
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """Application settings from environment variables.
    
    All sensitive configuration must come from environment.
    No secrets should have default values suitable for production.
    """

    # Database - REQUIRED in production
    DATABASE_URL: str = Field(
        default="",
        description="PostgreSQL connection string (required in production)"
    )

    # Redis - REQUIRED in production
    REDIS_URL: str = Field(
        default="",
        description="Redis connection string (required in production)"
    )

    # JWT - REQUIRED secrets
    JWT_ALGORITHM: str = "HS256"
    JWT_EXPIRATION_HOURS: int = 1
    JWT_REFRESH_EXPIRATION_DAYS: int = 7
    JWT_SECRET_KEY: str = Field(
        default="",
        description="JWT signing secret (required, min 32 chars in production)"
    )

    # Auth - REQUIRED secrets
    AUTH_SECRET: str = Field(
        default="",
        description="Authentication secret (required, min 32 chars in production)"
    )
    AUTH_REDIRECT_URL: str = "http://localhost:3000/auth/callback"

    # Application
    APP_NAME: str = "Zyvano"
    APP_VERSION: str = "0.1.0"
    NODE_ENV: str = Field(default="development", description="Environment: development, staging, production")
    LOG_LEVEL: str = "info"
    DEBUG: bool = False

    # API
    API_V1_PREFIX: str = "/api/v1"

    # CORS - dev defaults
    CORS_ORIGINS: List[str] = Field(
        default=["http://localhost:3000", "http://localhost:8081"],
        description="Allowed CORS origins"
    )

    # Rate limiting
    RATE_LIMIT_ENABLED: bool = True
    RATE_LIMIT_REQUESTS: int = 100
    RATE_LIMIT_WINDOW_SECONDS: int = 60

    # Upload
    MAX_UPLOAD_SIZE_MB: int = 1024

    class Config:
        env_file = ".env.local"
        case_sensitive = True

    @field_validator("DATABASE_URL", mode="after")
    @classmethod
    def validate_database_url(cls, v: str) -> str:
        """Validate DATABASE_URL is configured."""
        if not v:
            raise ValueError(
                "DATABASE_URL must be set via environment variable. "
                "Never commit database credentials."
            )
        if "localhost" not in v and "127.0.0.1" not in v:
            # Production URL - basic validation
            if not v.startswith("postgresql://"):
                raise ValueError("DATABASE_URL must be a valid PostgreSQL connection string")
        return v

    @field_validator("JWT_SECRET_KEY", mode="after")
    @classmethod
    def validate_jwt_secret(cls, v: str) -> str:
        """Validate JWT secret is configured and sufficiently long."""
        if not v:
            raise ValueError(
                "JWT_SECRET_KEY must be set via environment variable. "
                "Never commit JWT secrets."
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
        """Validate NODE_ENV is one of allowed values."""
        if v not in ("development", "staging", "production"):
            raise ValueError("NODE_ENV must be 'development', 'staging', or 'production'")
        return v

    def is_production(self) -> bool:
        """Check if running in production."""
        return self.NODE_ENV == "production"

    def is_development(self) -> bool:
        """Check if running in development."""
        return self.NODE_ENV == "development"


# Create singleton settings instance
# Raises ValueError if required configuration is missing
try:
    settings = Settings()
except ValueError as e:
    import sys
    print(f"Configuration Error: {e}", file=sys.stderr)
    sys.exit(1)
