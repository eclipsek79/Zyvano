"""Application configuration."""
from typing import List
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """Application settings from environment variables."""

    # Database
    DATABASE_URL: str = "postgresql://user:password@localhost:5432/zyvano"
    
    # Redis
    REDIS_URL: str = "redis://localhost:6379"
    
    # JWT
    JWT_ALGORITHM: str = "HS256"
    JWT_EXPIRATION_HOURS: int = 1
    JWT_REFRESH_EXPIRATION_DAYS: int = 7
    JWT_SECRET_KEY: str = "your-secret-key-change-in-production"
    
    # Auth
    AUTH_SECRET: str = "your-auth-secret-change-in-production"
    AUTH_REDIRECT_URL: str = "http://localhost:3000/auth/callback"
    
    # Application
    APP_NAME: str = "Zyvano"
    APP_VERSION: str = "0.1.0"
    NODE_ENV: str = "development"
    LOG_LEVEL: str = "info"
    DEBUG: bool = False
    
    # API
    API_V1_PREFIX: str = "/api/v1"
    
    # CORS
    CORS_ORIGINS: List[str] = ["http://localhost:3000", "http://localhost:8081"]
    
    # Rate limiting
    RATE_LIMIT_ENABLED: bool = True
    RATE_LIMIT_REQUESTS: int = 100
    RATE_LIMIT_WINDOW_SECONDS: int = 60
    
    # Upload
    MAX_UPLOAD_SIZE_MB: int = 1024
    
    class Config:
        env_file = ".env.local"
        case_sensitive = True


settings = Settings()
