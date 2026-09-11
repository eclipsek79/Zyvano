"""Tests for zyvano.api.errors -- the machine-readable error contract.

These classes are entirely uncovered otherwise, yet they define the status codes
and codes every client branches on. A regression here changes the API contract
silently: the body still looks like a valid error, but the code is wrong.
"""

import pytest

from zyvano.api.errors import (
    AppError,
    ConflictError,
    ForbiddenError,
    IdempotencyError,
    InvalidCredentialsError,
    JobError,
    JobNotFoundError,
    NotFoundError,
    RateLimitError,
    UnauthorizedError,
    ValidationError,
)

# (class, expected status, expected code)
CASES = [
    (UnauthorizedError, 401, "UNAUTHORIZED"),
    (ForbiddenError, 403, "FORBIDDEN"),
    (InvalidCredentialsError, 401, "INVALID_CREDENTIALS"),
    (ConflictError, 409, "CONFLICT"),
    (RateLimitError, 429, "RATE_LIMIT_EXCEEDED"),
    (JobError, 400, "JOB_ERROR"),
]


@pytest.mark.parametrize("exc_cls,status,code", CASES)
def test_error_classes_carry_the_documented_status_and_code(exc_cls, status, code):
    err = exc_cls("boom") if exc_cls is not RateLimitError else exc_cls()
    assert isinstance(err, AppError)
    assert err.status_code == status
    assert err.code == code
    assert isinstance(err.message, str) and err.message


def test_app_error_exposes_code_message_status_and_details():
    err = AppError("TEAPOT", "I am a teapot", 418, {"spout": "left"})
    assert (err.code, err.message, err.status_code) == ("TEAPOT", "I am a teapot", 418)
    assert err.details == {"spout": "left"}


def test_app_error_details_defaults_to_empty_dict_not_none():
    """Callers index .details without a None check; a None default would crash
    the error serialiser for every error raised without details."""
    assert AppError("X", "x").details == {}


def test_app_error_status_defaults_to_500():
    assert AppError("X", "x").status_code == 500


def test_app_error_is_a_real_exception_and_carries_its_message():
    with pytest.raises(AppError) as excinfo:
        raise AppError("CODE", "a message")
    assert str(excinfo.value) == "a message"


def test_not_found_message_includes_resource_and_id():
    err = NotFoundError("Project", "abc-123")
    assert err.code == "NOT_FOUND"
    assert err.status_code == 404
    assert "Project not found" in err.message
    assert "abc-123" in err.message


def test_not_found_without_id_omits_the_suffix():
    err = NotFoundError("Project")
    assert err.message == "Project not found"
    assert "ID" not in err.message


def test_job_not_found_message_includes_the_job_id():
    err = JobNotFoundError("job-7")
    assert (err.code, err.status_code) == ("JOB_NOT_FOUND", 404)
    assert "job-7" in err.message


def test_idempotency_error_is_a_conflict_not_a_bad_request():
    err = IdempotencyError()
    assert (err.code, err.status_code) == ("IDEMPOTENCY_CONFLICT", 409)


def test_validation_error_is_400_with_details():
    err = ValidationError("bad input", {"field": "name"})
    assert (err.code, err.status_code) == ("VALIDATION_ERROR", 400)
    assert err.details == {"field": "name"}


def test_every_error_code_is_upper_snake_case():
    """Clients switch on these strings, so casing must stay stable."""
    for _exc_cls, _status, code in CASES:
        assert code == code.upper()
        assert " " not in code
