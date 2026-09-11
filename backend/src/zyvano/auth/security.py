"""Authentication and security utilities."""

from datetime import datetime, timedelta
from uuid import UUID

import bcrypt
from jose import JWTError, jwt
from pydantic import BaseModel

from zyvano.config import settings

# Password hashing is done with bcrypt directly.
#
# This previously used passlib's CryptContext. passlib 1.7.4 is incompatible
# with bcrypt >= 4.1: at import it runs a backend-detection probe
# (detect_wrap_bug) that feeds bcrypt an over-72-byte password, which modern
# bcrypt rejects with "ValueError: password cannot be longer than 72 bytes".
# The probe is wrapped in a try/except inside passlib, but the failure
# resurfaced on the first real hash -- so hash_password() raised and every
# registration would have failed at runtime.

# bcrypt silently ignores input past 72 bytes. bcrypt >= 4.1 raises instead,
# so the truncation is explicit here and applied to the ENCODED bytes.
BCRYPT_MAX_BYTES = 72


def _bcrypt_input(password: str) -> bytes:
    """Encode a password to the bytes bcrypt will hash.

    Truncation happens on bytes rather than characters because the 72-byte
    limit is a property of the algorithm's input, not of the string. Doing it
    here keeps hashing and verification symmetric -- both call this same
    function -- so a long password always verifies against its own hash.
    """
    return password.encode("utf-8")[:BCRYPT_MAX_BYTES]


class TokenData(BaseModel):
    """Token payload data."""

    user_id: UUID
    exp: datetime


def hash_password(password: str) -> str:
    """Hash a password with bcrypt, returning its modular-crypt string."""
    return bcrypt.hashpw(_bcrypt_input(password), bcrypt.gensalt()).decode("utf-8")


def verify_password(plain_password: str, hashed_password: str) -> bool:
    """Verify a password against a stored bcrypt hash.

    Returns False rather than raising for a malformed or empty stored hash, so
    a corrupt column cannot turn a failed login into a 500.
    """
    try:
        return bcrypt.checkpw(_bcrypt_input(plain_password), hashed_password.encode("utf-8"))
    except (ValueError, TypeError):
        return False


def create_access_token(user_id: UUID) -> str:
    """Create JWT access token."""
    expires = datetime.utcnow() + timedelta(hours=settings.JWT_EXPIRATION_HOURS)
    payload = {
        "user_id": str(user_id),
        "exp": expires,
        "type": "access",
    }
    encoded: str = jwt.encode(payload, settings.JWT_SECRET_KEY, algorithm=settings.JWT_ALGORITHM)
    return encoded


def create_refresh_token(user_id: UUID) -> str:
    """Create JWT refresh token."""
    expires = datetime.utcnow() + timedelta(days=settings.JWT_REFRESH_EXPIRATION_DAYS)
    payload = {
        "user_id": str(user_id),
        "exp": expires,
        "type": "refresh",
    }
    encoded: str = jwt.encode(payload, settings.JWT_SECRET_KEY, algorithm=settings.JWT_ALGORITHM)
    return encoded


def verify_token(token: str) -> TokenData | None:
    """Verify and decode JWT token."""
    try:
        payload = jwt.decode(token, settings.JWT_SECRET_KEY, algorithms=[settings.JWT_ALGORITHM])
        user_id = UUID(payload["user_id"])
        exp = datetime.fromtimestamp(payload["exp"])
        return TokenData(user_id=user_id, exp=exp)
    except (JWTError, ValueError, KeyError, TypeError):
        # KeyError: the token verifies but carries no `user_id`/`exp` claim.
        # TypeError: those claims are present but not a usable type (e.g. a
        # list), which UUID() and datetime.fromtimestamp() both reject.
        # Both must deny access, not propagate: this runs inside the
        # authentication dependency, where an escaping TypeError would surface
        # as a 500 and fail open into the generic error handler.
        return None
