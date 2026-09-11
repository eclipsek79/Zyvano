"""Tests for zyvano.api.schemas -- request validation.

These schemas are the only place some rules are enforced (password strength,
project name bounds, the project/asset type allowlists). If a constraint here
is loosened by accident, invalid input reaches the services unchallenged, so
each one is asserted against both accepted and rejected input.
"""

import pytest
from pydantic import ValidationError as PydanticValidationError

from zyvano.api.schemas import (
    ErrorResponse,
    ExportCreate,
    GenerationJobCreate,
    ProjectCreate,
    ProjectMemberCreate,
    ProjectMemberUpdate,
    ProjectUpdate,
    UserLogin,
    UserRegister,
    UserUpdate,
)

GOOD_PASSWORD = "Correct-Horse-9"


# --------------------------------------------------------------------------- #
# registration                                                                #
# --------------------------------------------------------------------------- #


def test_register_accepts_a_valid_payload():
    user = UserRegister(email="ada@example.com", password=GOOD_PASSWORD, name="Ada")
    assert user.email == "ada@example.com"
    assert user.name == "Ada"


def test_register_name_is_optional():
    assert UserRegister(email="a@example.com", password=GOOD_PASSWORD).name is None


@pytest.mark.parametrize("password", ["weak", "alllowercase1", "NoDigitsHere", "sh0rt"])
def test_register_rejects_passwords_failing_the_strength_rules(password):
    with pytest.raises(PydanticValidationError):
        UserRegister(email="a@example.com", password=password)


def test_register_password_needs_an_uppercase_letter_and_a_digit():
    with pytest.raises(PydanticValidationError) as excinfo:
        UserRegister(email="a@example.com", password="lowercaseonly1")
    assert "uppercase" in str(excinfo.value)

    with pytest.raises(PydanticValidationError) as excinfo:
        UserRegister(email="a@example.com", password="NoDigitsHereAtAll")
    assert "digit" in str(excinfo.value)


def test_register_password_max_length_enforced():
    with pytest.raises(PydanticValidationError):
        UserRegister(email="a@example.com", password="A1" + "x" * 255)


@pytest.mark.parametrize("email", ["not-an-email", "@example.com", "a@", "a b@example.com", ""])
def test_register_rejects_malformed_email(email):
    """EmailStr is why email-validator is a hard dependency."""
    with pytest.raises(PydanticValidationError):
        UserRegister(email=email, password=GOOD_PASSWORD)


def test_register_rejects_overlong_name():
    with pytest.raises(PydanticValidationError):
        UserRegister(email="a@example.com", password=GOOD_PASSWORD, name="n" * 256)


def test_login_accepts_valid_payload_and_enforces_min_length():
    assert UserLogin(email="a@example.com", password=GOOD_PASSWORD).password == GOOD_PASSWORD
    with pytest.raises(PydanticValidationError):
        UserLogin(email="a@example.com", password="short")


def test_user_update_allows_clearing_the_name_but_bounds_it():
    assert UserUpdate().name is None
    with pytest.raises(PydanticValidationError):
        UserUpdate(name="n" * 256)


# --------------------------------------------------------------------------- #
# projects                                                                    #
# --------------------------------------------------------------------------- #


def test_project_create_defaults():
    project = ProjectCreate(name="Launch Film")
    assert project.description is None
    assert project.type == "video"
    assert project.is_public is False


@pytest.mark.parametrize("project_type", ["video", "image", "animation", "avatar"])
def test_project_create_accepts_each_documented_type(project_type):
    assert ProjectCreate(name="P", type=project_type).type == project_type


@pytest.mark.parametrize("project_type", ["audio", "3d", "", "VIDEO"])
def test_project_create_rejects_unknown_types(project_type):
    with pytest.raises(PydanticValidationError):
        ProjectCreate(name="P", type=project_type)


@pytest.mark.parametrize("name", ["", "n" * 256])
def test_project_create_name_bounds(name):
    with pytest.raises(PydanticValidationError):
        ProjectCreate(name=name)


def test_project_create_bounds_description():
    assert ProjectCreate(name="P", description="d" * 2000).description
    with pytest.raises(PydanticValidationError):
        ProjectCreate(name="P", description="d" * 2001)


def test_project_update_fields_are_all_optional():
    update = ProjectUpdate()
    assert (update.name, update.description, update.is_public) == (None, None, None)


def test_project_update_still_bounds_name_when_supplied():
    with pytest.raises(PydanticValidationError):
        ProjectUpdate(name="")


# --------------------------------------------------------------------------- #
# members                                                                     #
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("role", ["owner", "editor", "reviewer", "viewer"])
def test_member_roles_accept_the_documented_set(role):
    assert ProjectMemberUpdate(role=role).role == role


@pytest.mark.parametrize("role", ["admin", "member", "OWNER", ""])
def test_member_roles_reject_anything_else(role):
    with pytest.raises(PydanticValidationError):
        ProjectMemberUpdate(role=role)


def test_member_create_requires_a_uuid_and_defaults_to_viewer():
    member = ProjectMemberCreate(user_id="6f1e1f6c-1f4e-4a2a-9b3f-3a4d5c6b7a80")
    assert member.role == "viewer"
    with pytest.raises(PydanticValidationError):
        ProjectMemberCreate(user_id="not-a-uuid")


# --------------------------------------------------------------------------- #
# generation / export                                                         #
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("job_type", ["image", "video", "audio", "avatar"])
def test_generation_job_accepts_documented_types(job_type):
    job = GenerationJobCreate(type=job_type, payload={"prompt": "x"})
    assert job.type == job_type


def test_generation_job_rejects_unknown_type_and_requires_payload():
    with pytest.raises(PydanticValidationError):
        GenerationJobCreate(type="hologram", payload={})
    with pytest.raises(PydanticValidationError):
        GenerationJobCreate(type="video")


def test_generation_job_optional_idempotency_key_is_bounded():
    assert GenerationJobCreate(type="video", payload={}).idempotency_key is None
    with pytest.raises(PydanticValidationError):
        GenerationJobCreate(type="video", payload={}, idempotency_key="k" * 256)


def test_export_create_requires_a_bounded_format():
    assert ExportCreate(format="mp4").format == "mp4"
    for bad in ["", "f" * 51]:
        with pytest.raises(PydanticValidationError):
            ExportCreate(format=bad)


# --------------------------------------------------------------------------- #
# error envelope                                                              #
# --------------------------------------------------------------------------- #


def test_error_response_defaults_are_optional():
    err = ErrorResponse(code="NOT_FOUND", message="gone")
    assert err.request_id is None
    assert err.details is None
