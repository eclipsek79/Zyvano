"""Tests for zyvano.config's dotenv wiring and its fail-fast behaviour.

The rest of test_config.py drives Settings with explicit kwargs, which bypasses
the dotenv layer entirely. That layer is exactly where the bug was: env_file was
``backend/.env.local``, a path that does not exist, so every documented key in
the repository .env -- BACKEND_DATABASE_URL among them -- was silently ignored.

These tests spawn child processes so a real `.env` can be resolved from a real
working directory, with the process environment scrubbed of the keys under test.
"""

import os
import pathlib
import subprocess
import sys

import pytest

BACKEND_DIR = pathlib.Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_DIR.parent

# Values that must be present for a valid load, supplied by the child process.
BASE_ENV = {
    "DATABASE_URL": "postgresql://zyvano:zyvano@127.0.0.1:5432/zyvano",
    "REDIS_URL": "redis://127.0.0.1:6379/0",
    "AUTH_SECRET": "a" * 64,
    "JWT_SECRET_KEY": "j" * 64,
    "NODE_ENV": "test",
}

_PROBE_TEMPLATE = """
import sys
sys.path.insert(0, {src!r})
from zyvano.config import settings
print("BACKEND_DATABASE_URL", settings.BACKEND_DATABASE_URL)
print("DATABASE_URL", settings.DATABASE_URL)
print("NODE_ENV", settings.NODE_ENV)
print("CORS_ORIGINS", settings.CORS_ORIGINS)
print("SECURE_SSL_REDIRECT", settings.SECURE_SSL_REDIRECT)
"""


def _run_probe(env_overrides=None, drop=(), cwd=BACKEND_DIR):
    env = dict(os.environ)
    for key in list(BASE_ENV) + list(drop):
        env.pop(key, None)
    env.update(BASE_ENV)
    env.update(env_overrides or {})
    # The source directory is injected absolutely: `sys.path.insert(0, "src")`
    # only resolves when the child's cwd is backend/, which would make the
    # cwd-independence test below meaningless.
    probe = _PROBE_TEMPLATE.format(src=str(BACKEND_DIR / "src"))
    return subprocess.run(
        [sys.executable, "-c", probe],
        cwd=str(cwd),
        env=env,
        capture_output=True,
        text=True,
    )


def _parse(result):
    out = {}
    for line in result.stdout.strip().splitlines():
        key, _, value = line.partition(" ")
        out[key] = value
    return out


# --------------------------------------------------------------------------- #
# the documented .env is actually read                                        #
# --------------------------------------------------------------------------- #


def test_env_file_is_resolved_by_absolute_path_not_cwd():
    """Running from anywhere must find the same .env.

    env_file entries are absolute and derived from config.py's own location, so
    the loaded configuration cannot depend on where the process was started.
    """
    from_backend = _run_probe()
    from_root = _run_probe(cwd=REPO_ROOT)
    assert from_backend.returncode == 0, from_backend.stderr
    assert from_root.returncode == 0, from_root.stderr
    assert _parse(from_backend) == _parse(from_root)


def test_backend_database_url_is_read_from_the_repository_env():
    """The field the whole task is about is populated from .env when the process
    environment does not supply it."""
    if not (REPO_ROOT / ".env").exists():
        pytest.skip("repository .env is not present in this checkout")

    result = _run_probe(drop=("BACKEND_DATABASE_URL",))
    assert result.returncode == 0, result.stdout + result.stderr
    value = _parse(result)["BACKEND_DATABASE_URL"]
    assert value.startswith("postgresql+psycopg://")
    assert value == "postgresql+psycopg://zyvano:zyvano@127.0.0.1:5432/zyvano_backend"


def test_process_environment_outranks_the_dotenv_file(monkeypatch):
    """Explicit env vars must win, so containers can override the file."""
    result = _run_probe(
        env_overrides={
            "BACKEND_DATABASE_URL": "postgresql+psycopg://u:p@127.0.0.1:5432/override_db"
        }
    )
    assert _parse(result)["BACKEND_DATABASE_URL"].endswith("/override_db")


def test_unknown_keys_in_the_shared_env_do_not_abort_startup():
    """The root .env configures the TypeScript platform too; keys this backend
    does not declare must be ignored rather than raising."""
    pyproject_keys = _run_probe()
    assert pyproject_keys.returncode == 0, pyproject_keys.stderr


def test_dev_defaults_are_preserved_when_env_says_nothing():
    result = _run_probe()
    parsed = _parse(result)
    assert "localhost:3000" in parsed["CORS_ORIGINS"]
    assert parsed["SECURE_SSL_REDIRECT"] == "False"


# --------------------------------------------------------------------------- #
# fail-fast behaviour                                                         #
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "missing",
    ["BACKEND_DATABASE_URL", "DATABASE_URL", "REDIS_URL", "AUTH_SECRET", "JWT_SECRET_KEY"],
)
def test_missing_required_configuration_exits_non_zero(missing, tmp_path):
    """A required key with no usable value must abort startup, not proceed.

    The key is set to the EMPTY STRING rather than removed. An empty process
    environment variable still outranks the dotenv file, so this simulates a
    genuinely missing value; removing it would let .env supply a valid default,
    which is the documented layered-configuration behaviour and not a failure.
    """
    env = dict(os.environ)
    for key in BASE_ENV:
        env[key] = BASE_ENV[key]
    env[missing] = ""

    result = subprocess.run(
        [
            sys.executable,
            "-c",
            f"import sys; sys.path.insert(0, {str(BACKEND_DIR / 'src')!r}); "
            "import zyvano.config",
        ],
        cwd=str(tmp_path),  # no .env here, so the file cannot fill the gap
        env=env,
        capture_output=True,
        text=True,
    )
    assert result.returncode != 0, f"{missing} absence did not abort startup"
    assert missing in (result.stdout + result.stderr)
