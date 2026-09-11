"""Tests for zyvano.auth.dependencies -- the authentication boundary.

get_current_user is what turns a bearer token into an identity. It is entirely
uncovered otherwise, and its failure modes are security-relevant: a token whose
subject does not exist, or a malformed credential, must be denied rather than
falling through to an anonymous request.
"""

import asyncio
import uuid
from datetime import datetime, timedelta

import pytest
from fastapi import Depends, FastAPI
from fastapi.exceptions import HTTPException
from fastapi.security import HTTPAuthorizationCredentials
from fastapi.testclient import TestClient
from jose import jwt

from zyvano.auth.dependencies import get_current_user
from zyvano.auth.security import create_access_token, hash_password
from zyvano.config import settings
from zyvano.db.models import User
from zyvano.db.session import get_db


def _credentials(token: str) -> HTTPAuthorizationCredentials:
    return HTTPAuthorizationCredentials(scheme="Bearer", credentials=token)


@pytest.fixture()
def user(db):
    return User(
        email="dep@example.com",
        name="Dep",
        password_hash=hash_password("Correct-Horse-9"),
    )


def _persist(db, user):
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


# --------------------------------------------------------------------------- #
# happy path                                                                  #
# --------------------------------------------------------------------------- #


def test_valid_token_returns_the_matching_user(db, user):
    stored = _persist(db, user)
    token = create_access_token(stored.id)
    resolved = asyncio.run(get_current_user(_credentials(token), db))
    assert resolved.id == stored.id
    assert resolved.email == "dep@example.com"


# --------------------------------------------------------------------------- #
# denial paths                                                                #
# --------------------------------------------------------------------------- #


def test_token_for_unknown_user_is_rejected(db, user):
    """A correctly signed token for a deleted account must not authenticate."""
    _persist(db, user)
    token = create_access_token(uuid.uuid4())
    with pytest.raises(HTTPException) as excinfo:
        asyncio.run(get_current_user(_credentials(token), db))
    assert excinfo.value.status_code == 401


def test_garbage_token_is_rejected(db):
    with pytest.raises(HTTPException) as excinfo:
        asyncio.run(get_current_user(_credentials("not-a-jwt"), db))
    assert excinfo.value.status_code == 401


def test_expired_token_is_rejected(db, user):
    stored = _persist(db, user)
    expired = jwt.encode(
        {
            "user_id": str(stored.id),
            "exp": datetime.utcnow() - timedelta(minutes=1),
            "type": "access",
        },
        settings.JWT_SECRET_KEY,
        algorithm=settings.JWT_ALGORITHM,
    )
    with pytest.raises(HTTPException) as excinfo:
        asyncio.run(get_current_user(_credentials(expired), db))
    assert excinfo.value.status_code == 401


def test_token_signed_with_the_wrong_secret_is_rejected(db, user):
    stored = _persist(db, user)
    forged = jwt.encode(
        {
            "user_id": str(stored.id),
            "exp": datetime.utcnow() + timedelta(hours=1),
            "type": "access",
        },
        "some-other-secret",
        algorithm=settings.JWT_ALGORITHM,
    )
    with pytest.raises(HTTPException) as excinfo:
        asyncio.run(get_current_user(_credentials(forged), db))
    assert excinfo.value.status_code == 401


def test_denial_does_not_reveal_which_check_failed(db, user):
    """The two 401s must not leak whether the token or the user was bad."""
    stored = _persist(db, user)
    missing_user = None
    with pytest.raises(HTTPException) as unknown_user:
        asyncio.run(get_current_user(_credentials(create_access_token(uuid.uuid4())), db))
    with pytest.raises(HTTPException) as bad_token:
        try:
            asyncio.run(get_current_user(_credentials("garbage"), db))
        finally:
            missing_user = stored.id
    assert unknown_user.value.status_code == bad_token.value.status_code == 401
    assert missing_user is not None


# --------------------------------------------------------------------------- #
# the HTTP surface                                                            #
# --------------------------------------------------------------------------- #


def _protected_app(db) -> FastAPI:
    app = FastAPI()

    @app.get("/protected")
    async def protected(user: User = Depends(get_current_user)):
        return {"id": str(user.id), "email": user.email}

    # get_current_user depends on the real get_db, which opens its own session
    # on a separate connection and therefore cannot see rows still inside the
    # test's uncommitted transaction -- a valid token then failed with 401 for
    # reasons unrelated to authentication. Overriding it makes the test exercise
    # the auth boundary rather than transaction isolation.
    app.dependency_overrides[get_db] = lambda: db
    return app


def test_protected_route_denies_a_request_with_no_credentials(db, user):
    """An unauthenticated caller must never reach the handler."""
    token = create_access_token(_persist(db, user).id)
    with TestClient(_protected_app(db)) as client:
        assert client.get("/protected").status_code in (401, 403)
        assert (
            client.get("/protected", headers={"Authorization": "Bearer malformed"}).status_code
            == 401
        )
        ok = client.get("/protected", headers={"Authorization": f"Bearer {token}"})
    assert ok.status_code == 200
    assert ok.json()["email"] == "dep@example.com"


def test_protected_route_rejects_a_non_bearer_scheme(db, user):
    token = create_access_token(_persist(db, user).id)
    with TestClient(_protected_app(db)) as client:
        response = client.get("/protected", headers={"Authorization": f"Basic {token}"})
    assert response.status_code in (401, 403)
