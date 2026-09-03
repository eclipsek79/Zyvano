"""Authentication and security utilities."""
from datetime import datetime, timedelta
from uuid import UUID
from jose import JWTError, jwt
from passlib.context import CryptContext
from pydantic import BaseModel

from vid.config import settings

# Password hashing
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


class TokenData(BaseModel):
    """Token payload data."""

    user_id: UUID
    exp: datetime


def hash_password(password: str) -> str:
    """Hash password using bcrypt."""
    return pwd_context.hash(password)


def verify_password(plain_password: str, hashed_password: str) -> bool:
    """Verify password against hash."""
    return pwd_context.verify(plain_password, hashed_password)


def create_access_token(user_id: UUID) -> str:
    """Create JWT access token."""
    expires = datetime.utcnow() + timedelta(hours=settings.JWT_EXPIRATION_HOURS)
    payload = {
        "user_id": str(user_id),
        "exp": expires,
        "type": "access",
    }
    return jwt.encode(
        payload, settings.JWT_SECRET_KEY, algorithm=settings.JWT_ALGORITHM
    )


def create_refresh_token(user_id: UUID) -> str:
    """Create JWT refresh token."""
    expires = datetime.utcnow() + timedelta(
        days=settings.JWT_REFRESH_EXPIRATION_DAYS
    )
    payload = {
        "user_id": str(user_id),
        "exp": expires,
        "type": "refresh",
    }
    return jwt.encode(
        payload, settings.JWT_SECRET_KEY, algorithm=settings.JWT_ALGORITHM
    )


def verify_token(token: str) -> TokenData | None:
    """Verify and decode JWT token."""
    try:
        payload = jwt.decode(
            token, settings.JWT_SECRET_KEY, algorithms=[settings.JWT_ALGORITHM]
        )
        user_id = UUID(payload.get("user_id"))
        exp = datetime.fromtimestamp(payload.get("exp"))
        return TokenData(user_id=user_id, exp=exp)
    except (JWTError, ValueError):
        return None
