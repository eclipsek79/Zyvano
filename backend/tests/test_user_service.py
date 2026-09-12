"""Tests for zyvano.services.user_service.UserService."""

import uuid

import pytest

from zyvano.auth.security import verify_password
from zyvano.db.models import User, UserRole
from zyvano.services.user_service import UserService


@pytest.fixture()
def service(db):
    return UserService(db)


# --------------------------------------------------------------------------- #
# create_user                                                                 #
# --------------------------------------------------------------------------- #


def test_create_user_persists_and_returns_model(service, db):
    user = service.create_user("ada@example.com", "Ada Lovelace", "Correct-Horse-9")
    assert isinstance(user.id, uuid.UUID)
    assert user.email == "ada@example.com"
    assert user.name == "Ada Lovelace"
    assert user.role == UserRole.USER
    assert user.is_active is True
    assert user.is_verified is False
    assert user.created_at is not None
    assert user.updated_at is not None

    assert db.query(User).filter(User.email == "ada@example.com").count() == 1


def test_password_is_hashed_with_bcrypt_never_plaintext(service):
    plaintext = "Correct-Horse-9"
    user = service.create_user("grace@example.com", None, plaintext)
    assert user.password_hash != plaintext
    assert plaintext not in user.password_hash
    assert user.password_hash.startswith(("$2b$", "$2a$", "$2y$"))
    assert verify_password(plaintext, user.password_hash)


def test_two_users_with_same_password_get_different_hashes(service):
    """bcrypt salts per hash; identical hashes would imply no salting."""
    a = service.create_user("a@example.com", None, "Same-Password-1")
    b = service.create_user("b@example.com", None, "Same-Password-1")
    assert a.password_hash != b.password_hash


def test_duplicate_email_rejected(service):
    service.create_user("dup@example.com", None, "Correct-Horse-9")
    with pytest.raises(ValueError, match="already exists"):
        service.create_user("dup@example.com", None, "Correct-Horse-9")


def test_duplicate_email_does_not_create_second_row(service, db):
    service.create_user("dup2@example.com", None, "Correct-Horse-9")
    with pytest.raises(ValueError):
        service.create_user("dup2@example.com", None, "Correct-Horse-9")
    assert db.query(User).filter(User.email == "dup2@example.com").count() == 1


def test_name_is_optional(service):
    assert service.create_user("noname@example.com", None, "Correct-Horse-9").name is None


# --------------------------------------------------------------------------- #
# authenticate_user                                                           #
# --------------------------------------------------------------------------- #


def test_authenticate_with_correct_password(service):
    created = service.create_user("ada@example.com", "Ada", "Correct-Horse-9")
    found = service.authenticate_user("ada@example.com", "Correct-Horse-9")
    assert found is not None
    assert found.id == created.id


def test_authenticate_with_wrong_password_returns_none(service):
    service.create_user("ada@example.com", "Ada", "Correct-Horse-9")
    assert service.authenticate_user("ada@example.com", "wrong-password") is None


def test_authenticate_with_unknown_email_returns_none(service):
    assert service.authenticate_user("nobody@example.com", "Correct-Horse-9") is None


def test_authenticate_rejects_user_without_password_hash(service, db):
    """Accounts created without a password must not be loginable."""
    db.add(User(email="nopass@example.com", name="No Pass", password_hash=None))
    db.commit()
    assert service.authenticate_user("nopass@example.com", "anything") is None


# --------------------------------------------------------------------------- #
# lookups                                                                     #
# --------------------------------------------------------------------------- #


def test_get_user_by_id(service):
    created = service.create_user("byid@example.com", None, "Correct-Horse-9")
    assert service.get_user_by_id(created.id).email == "byid@example.com"


def test_get_user_by_id_unknown_returns_none(service):
    assert service.get_user_by_id(uuid.uuid4()) is None


def test_get_user_by_email(service):
    service.create_user("byemail@example.com", None, "Correct-Horse-9")
    assert service.get_user_by_email("byemail@example.com") is not None
    assert service.get_user_by_email("missing@example.com") is None


def test_lookup_scoped_to_exact_email_only(service):
    """A different user's row must never be returned by a lookalike address."""
    service.create_user("real@example.com", None, "Correct-Horse-9")
    assert service.get_user_by_email("real@example.com.evil.test") is None
    assert service.get_user_by_email("real@example.co") is None
