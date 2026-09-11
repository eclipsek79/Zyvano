"""Tests for zyvano.middleware -- request correlation and error safety.

Both middlewares are uncovered otherwise. The error handler is the one place
where an internal exception could leak a stack trace or a secret to a client, so
its non-disclosure behaviour is asserted directly rather than assumed.
"""

import asyncio
import uuid

from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.requests import Request

from zyvano.middleware.error_handler import global_exception_handler
from zyvano.middleware.request_id import RequestIDMiddleware


def _app() -> FastAPI:
    app = FastAPI()
    app.add_middleware(RequestIDMiddleware)

    @app.get("/ping")
    async def ping():
        return {"ok": True}

    @app.get("/echo-state")
    async def echo_state(request: Request):
        return {"request_id": request.state.request_id}

    return app


def _request(path="/boom", method="GET", request_id="rid-1"):
    scope = {
        "type": "http",
        "method": method,
        "path": path,
        "headers": [],
        "query_string": b"",
        "server": ("testserver", 80),
        "scheme": "http",
        "root_path": "",
    }
    request = Request(scope)
    if request_id is not None:
        request.state.request_id = request_id
    return request


# --------------------------------------------------------------------------- #
# RequestIDMiddleware                                                         #
# --------------------------------------------------------------------------- #


def test_generates_a_request_id_when_none_supplied():
    with TestClient(_app()) as client:
        response = client.get("/ping")
    assert response.status_code == 200
    generated = response.headers["X-Request-ID"]
    assert uuid.UUID(generated)  # must be a real UUID, not a placeholder


def test_echoes_a_supplied_request_id_for_correlation():
    with TestClient(_app()) as client:
        response = client.get("/ping", headers={"X-Request-ID": "trace-abc-123"})
    assert response.headers["X-Request-ID"] == "trace-abc-123"


def test_request_id_is_available_on_request_state():
    """Downstream handlers and the error handler both read request.state."""
    with TestClient(_app()) as client:
        response = client.get("/echo-state", headers={"X-Request-ID": "state-42"})
    assert response.json()["request_id"] == "state-42"


def test_distinct_requests_get_distinct_ids():
    with TestClient(_app()) as client:
        first = client.get("/ping").headers["X-Request-ID"]
        second = client.get("/ping").headers["X-Request-ID"]
    assert first != second


# --------------------------------------------------------------------------- #
# global_exception_handler                                                    #
# --------------------------------------------------------------------------- #


def test_unhandled_exception_returns_500_with_a_safe_envelope():
    response = asyncio.run(global_exception_handler(_request(), RuntimeError("boom")))
    assert response.status_code == 500
    body = response.body.decode()
    assert "INTERNAL_SERVER_ERROR" in body
    assert "rid-1" in body


def test_internal_exception_detail_is_not_leaked_to_the_client():
    """The message must not reach the client -- it may hold credentials,
    connection strings or file paths."""
    secret = "postgresql://user:hunter2@db.internal:5432/prod"
    response = asyncio.run(global_exception_handler(_request(), RuntimeError(secret)))
    body = response.body.decode()
    assert secret not in body
    assert "hunter2" not in body
    assert "RuntimeError" not in body


def test_error_response_is_still_correlated_when_request_id_is_absent():
    response = asyncio.run(global_exception_handler(_request(request_id=None), RuntimeError("x")))
    assert response.status_code == 500
    assert "unknown" in response.body.decode()
