"""Tests for zyvano.auth.security -- password hashing and JWT handling.

This module is the authentication primitive for the whole backend, and it was
almost entirely uncovered. The behaviours pinned here are the ones whose
failure would be silent: a token that verifies with the wrong key, a token that
outlives its expiry, or a password stored in a form that can be recovered.
"""

from datetime import datetime, timedelta
from uuid import UUID, uuid4

import pytest
from jose import jwt

from zyvano.auth.security import (
    TokenData,
    create_access_token,
    create_refresh_token,
    hash_password,
    verify_password,
    verify_token,
)
from zyvano.config import settings

# --------------------------------------------------------------------------- #
# password hashing                                                            #
# --------------------------------------------------------------------------- #


def test_hash_password_is_bcrypt_and_not_the_plaintext():
    plaintext = "Correct-Horse-9"
    digest = hash_password(plaintext)
    assert digest != plaintext
    assert plaintext not in digest
    assert digest.startswith(("$2a$", "$2b$", "$2y$"))


def test_hash_password_salts_each_call():
    """Two hashes of the same password must differ, or there is no salt."""
    assert hash_password("Same-Password-1") != hash_password("Same-Password-1")


def test_verify_password_round_trip():
    digest = hash_password("Correct-Horse-9")
    assert verify_password("Correct-Horse-9", digest) is True


def test_verify_password_rejects_wrong_password():
    digest = hash_password("Correct-Horse-9")
    assert verify_password("correct-horse-9", digest) is False
    assert verify_password("", digest) is False


def test_verify_password_against_foreign_hash_is_false_not_an_exception():
    """A malformed stored hash must deny access, not crash the login route."""
    assert verify_password("anything", "not-a-bcrypt-hash") is False


# --------------------------------------------------------------------------- #
# token issuance                                                              #
# --------------------------------------------------------------------------- #


def test_access_token_round_trip():
    user_id = uuid4()
    token = create_access_token(user_id)

    data = verify_token(token)
    assert isinstance(data, TokenData)
    assert data.user_id == user_id
    assert isinstance(data.exp, datetime)


def test_refresh_token_round_trip():
    user_id = uuid4()
    assert verify_token(create_refresh_token(user_id)).user_id == user_id


def test_access_and_refresh_tokens_are_distinguishable():
    user_id = uuid4()
    payload = jwt.decode(
        create_access_token(user_id),
        settings.JWT_SECRET_KEY,
        algorithms=[settings.JWT_ALGORITHM],
    )
    assert payload["type"] == "access"

    refresh = jwt.decode(
        create_refresh_token(user_id),
        settings.JWT_SECRET_KEY,
        algorithms=[settings.JWT_ALGORITHM],
    )
    assert refresh["type"] == "refresh"


def test_verify_token_rejects_a_token_signed_with_another_secret():
    """Only JWT_SECRET_KEY may sign an accepted token.

    The signing secret is a value this test does not control, so a fresh random
    one is used rather than a settings attribute: AUTH_SECRET is the TypeScript
    platform's session key and is not guaranteed to differ from JWT_SECRET_KEY,
    which would make the assertion pass or fail for the wrong reason.
    """
    user_id = uuid4()
    forged = jwt.encode(
        {
            "user_id": str(user_id),
            "exp": datetime.utcnow() + timedelta(hours=1),
            "type": "access",
        },
        uuid4().hex + uuid4().hex,
        algorithm=settings.JWT_ALGORITHM,
    )
    assert verify_token(forged) is None


# --------------------------------------------------------------------------- #
# token verification failure modes                                            #
# --------------------------------------------------------------------------- #


def test_verify_token_rejects_wrong_signature():
    forged = jwt.encode(
        {
            "user_id": str(uuid4()),
            "exp": datetime.utcnow() + timedelta(hours=1),
            "type": "access",
        },
        "a-different-secret-entirely",
        algorithm=settings.JWT_ALGORITHM,
    )
    assert verify_token(forged) is None


def test_verify_token_rejects_expired_token():
    expired = jwt.encode(
        {
            "user_id": str(uuid4()),
            "exp": datetime.utcnow() - timedelta(seconds=30),
            "type": "access",
        },
        settings.JWT_SECRET_KEY,
        algorithm=settings.JWT_ALGORITHM,
    )
    assert verify_token(expired) is None


def test_verify_token_rejects_non_uuid_subject():
    """A signed token whose subject is not a UUID must not raise."""
    malformed = jwt.encode(
        {
            "user_id": "not-a-uuid",
            "exp": datetime.utcnow() + timedelta(hours=1),
            "type": "access",
        },
        settings.JWT_SECRET_KEY,
        algorithm=settings.JWT_ALGORITHM,
    )
    assert verify_token(malformed) is None


def test_verify_token_rejects_token_without_subject():
    missing = jwt.encode(
        {"exp": datetime.utcnow() + timedelta(hours=1), "type": "access"},
        settings.JWT_SECRET_KEY,
        algorithm=settings.JWT_ALGORITHM,
    )
    assert verify_token(missing) is None


@pytest.mark.parametrize("token", ["", "not-a-jwt", "a.b.c", "Bearer abc"])
def test_verify_token_rejects_garbage(token):
    assert verify_token(token) is None


def test_token_data_is_frozen_to_validated_types():
    user_id = uuid4()
    data = TokenData(user_id=user_id, exp=datetime.utcnow())
    assert data.user_id == user_id
    assert UUID(str(user_id)) == data.user_id
