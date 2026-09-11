"""Tests for the FastAPI app's health and readiness endpoints.

These pin down a real defect: the /ready route used to return a
``(payload, 503)`` tuple, which FastAPI serialised as a JSON array while still
setting HTTP 200. A probe that reports healthy unconditionally is worse than
no probe, because it hides a dead database from the orchestrator.
"""

import logging
import os
import pathlib
import subprocess
import sys

from fastapi.testclient import TestClient

BACKEND_DIR = pathlib.Path(__file__).resolve().parents[1]


def test_health_returns_ok_and_request_id():
    import main

    with TestClient(main.app) as client:
        response = client.get("/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "healthy"
    assert body["service"] == "zyvano-api"
    assert "X-Request-ID" in response.headers


def test_health_echoes_supplied_request_id():
    import main

    with TestClient(main.app) as client:
        response = client.get("/health", headers={"X-Request-ID": "trace-abc-123"})
    assert response.headers["X-Request-ID"] == "trace-abc-123"


def test_ready_returns_json_object_not_array():
    """Regression: the tuple return produced a JSON array with status 200."""
    import main

    with TestClient(main.app) as client:
        response = client.get("/ready")
    assert isinstance(response.json(), dict), response.text


def test_ready_reports_healthy_against_migrated_database():
    import main

    with TestClient(main.app) as client:
        response = client.get("/ready")
    assert response.status_code == 200, response.text
    assert response.json()["ready"] is True


def test_importing_main_does_not_emit_startup_log():
    """Importing the module must not construct the application.

    ``main`` used to call ``create_app()`` at module scope, so every import --
    migrations tooling, scripts, and this suite -- logged "FastAPI application
    created successfully". That log is a property of creating the app, not of
    importing the module that defines it, so it is checked in a child process
    where no earlier test has already imported ``main``.
    """
    code = f"import sys; sys.path.insert(0, {str(BACKEND_DIR / 'src')!r}); import main"
    result = subprocess.run(
        [sys.executable, "-c", code],
        cwd=str(BACKEND_DIR),
        env=dict(os.environ),
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    assert "created successfully" not in (result.stdout + result.stderr)


def test_create_app_emits_startup_log(caplog):
    """Creating the application is what produces the startup log."""
    import main

    with caplog.at_level(logging.INFO, logger="main"):
        created = main.create_app()

    assert created is not None
    assert "created successfully" in caplog.text


def test_app_attribute_is_still_available_to_uvicorn():
    """Lazy creation must not break ``uvicorn main:app``."""
    import main

    assert main.get_app() is main.app
    assert not hasattr(main, "does_not_exist")


def test_lifespan_does_not_create_schema():
    """Schema belongs to Alembic; startup must not touch DDL."""
    import main

    source = pathlib.Path(main.__file__).resolve().parent / "main.py"
    code_only = "\n".join(
        line
        for line in source.read_text(encoding="utf-8").splitlines()
        if not line.lstrip().startswith("#")
    )
    assert "create_all" not in code_only
