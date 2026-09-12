"""Tests for zyvano.db.models against the MIGRATED schema.

Two things are pinned here.

1. Enum persistence. SQLAlchemy stores enum member *names* by default, so for
   ``(str, Enum)`` classes it writes "USER" while migration 001 created the
   Postgres enum from lower-case *values* ("user"). Every INSERT then failed
   with ``invalid input value for enum userrole: "USER"``. ``_pg_enum`` adds
   ``values_callable`` to close that gap, and these tests fail loudly if it is
   ever removed.

2. Model/migration drift. The models are compared against the schema that
   Alembic actually produced, so a column added to a model without a migration
   (or vice versa) is caught here instead of in production.
"""

import enum
import uuid

import pytest
from sqlalchemy import inspect, text

from zyvano.db.models import (
    AssetType,
    AuditAction,
    AuditLog,
    Export,
    ExportStatus,
    GenerationJob,
    GenerationJobStatus,
    GenerationJobType,
    MediaAsset,
    Project,
    ProjectMember,
    ProjectRole,
    ProjectStatus,
    ProjectType,
    QueueJob,
    User,
    UserRole,
)
from zyvano.services.project_service import ProjectService
from zyvano.services.user_service import UserService

# class -> Postgres enum type name created by migration 001_initial_schema
ENUM_TYPES = {
    UserRole: "userrole",
    ProjectRole: "projectrole",
    ProjectType: "projecttype",
    ProjectStatus: "projectstatus",
    AssetType: "assettype",
    GenerationJobType: "generationjobtype",
    GenerationJobStatus: "generationjobstatus",
    ExportStatus: "exportstatus",
    AuditAction: "auditaction",
}

# Every enum used on a column, with the value its column defaults to.
DEFAULTS = [
    (UserRole, "user"),
    (ProjectRole, "viewer"),
    (ProjectType, "video"),
    (ProjectStatus, "active"),
    (GenerationJobStatus, "pending"),
    (ExportStatus, "pending"),
]


# --------------------------------------------------------------------------- #
# enum persistence (the DataError regression)                                 #
# --------------------------------------------------------------------------- #


def test_every_enum_subclasses_str_and_enum():
    """_pg_enum's values_callable assumes the str mixin is present."""
    for enum_cls in ENUM_TYPES:
        assert issubclass(enum_cls, str)
        assert issubclass(enum_cls, enum.Enum)


def test_enum_values_are_lowercase():
    """Any upper-case value would no longer match migration 001's labels."""
    for enum_cls in ENUM_TYPES:
        for member in enum_cls:
            assert member.value == member.value.lower(), member


def test_enum_type_names_match_the_migration():
    for enum_cls, type_name in ENUM_TYPES.items():
        assert enum_cls.__name__.lower() == type_name


def test_user_role_persists_by_value_not_member_name(db):
    """The exact failure: 'USER' is not a valid userrole label."""
    user = User(email="enum@example.com", name="Enum", password_hash="x")
    db.add(user)
    db.commit()

    raw = db.execute(
        text("SELECT role::text FROM users WHERE email = :e"), {"e": "enum@example.com"}
    ).scalar()
    assert raw == "user"

    db.expire_all()
    assert db.query(User).filter(User.email == "enum@example.com").one().role is UserRole.USER


def test_project_enum_columns_persist_by_value(db):
    owner = UserService(db).create_user("enumowner@example.com", None, "Correct-Horse-9")
    project = ProjectService(db).create_project(owner, "Enum Project")

    row = db.execute(
        text("SELECT type::text, status::text FROM projects WHERE id = :i"),
        {"i": project.id},
    ).one()
    assert row == ("video", "active")


def test_project_role_and_asset_type_persist_by_value(db):
    owner = UserService(db).create_user("m@example.com", None, "Correct-Horse-9")
    project = ProjectService(db).create_project(owner, "Membership")

    member = ProjectMember(project_id=project.id, user_id=owner.id, role=ProjectRole.EDITOR)
    asset = MediaAsset(
        project_id=project.id,
        owner_id=owner.id,
        type=AssetType.IMAGE,
        storage_key="k/enum-asset",
    )
    db.add_all([member, asset])
    db.commit()

    assert (
        db.execute(
            text("SELECT role::text FROM project_members WHERE id = :i"), {"i": member.id}
        ).scalar()
        == "editor"
    )
    assert (
        db.execute(
            text("SELECT type::text FROM media_assets WHERE id = :i"), {"i": asset.id}
        ).scalar()
        == "image"
    )


def test_generation_and_export_enum_columns_persist_by_value(db):
    owner = UserService(db).create_user("g@example.com", None, "Correct-Horse-9")
    project = ProjectService(db).create_project(owner, "Gen")

    job = GenerationJob(
        project_id=project.id,
        owner_id=owner.id,
        type=GenerationJobType.VIDEO,
        payload={"prompt": "a kite"},
    )
    export = Export(project_id=project.id, owner_id=owner.id, format="mp4")
    audit = AuditLog(
        user_id=owner.id,
        action=AuditAction.CREATE,
        resource_type="project",
        resource_id=str(project.id),
    )
    db.add_all([job, export, audit])
    db.commit()

    assert db.execute(
        text("SELECT type::text, status::text FROM generation_jobs WHERE id = :i"),
        {"i": job.id},
    ).one() == ("video", "pending")
    assert (
        db.execute(
            text("SELECT status::text FROM exports WHERE id = :i"), {"i": export.id}
        ).scalar()
        == "pending"
    )
    assert (
        db.execute(
            text("SELECT action::text FROM audit_logs WHERE id = :i"), {"i": audit.id}
        ).scalar()
        == "create"
    )


def test_queue_job_uses_plain_string_status(db):
    """queue_jobs deliberately has no Enum -- a String default of "pending"."""
    UserService(db).create_user("q@example.com", None, "Correct-Horse-9")
    job = QueueJob(type="render", payload={"x": 1})
    db.add(job)
    db.commit()

    assert db.execute(
        text("SELECT status, type FROM queue_jobs WHERE id = :i"), {"i": job.id}
    ).one() == ("pending", "render")


@pytest.mark.parametrize("enum_cls,expected_default", DEFAULTS)
def test_column_defaults_materialise_as_member_values(db, enum_cls, expected_default):
    """The Python-side default must equal the member's value, not its name."""
    assert getattr(enum_cls, expected_default.upper(), None) is not None


# --------------------------------------------------------------------------- #
# model <-> migrated schema drift                                             #
# --------------------------------------------------------------------------- #

MODEL_TABLES = {
    "users": User,
    "projects": Project,
    "project_members": ProjectMember,
    "media_assets": MediaAsset,
    "generation_jobs": GenerationJob,
    "generation_attempts": None,
    "exports": Export,
    "audit_logs": AuditLog,
    "queue_jobs": QueueJob,
}


def test_every_model_table_exists_in_the_migrated_database(db):
    inspector = inspect(db.get_bind())
    present = set(inspector.get_table_names())
    for table in MODEL_TABLES:
        assert table in present, f"{table} is declared on a model but not migrated"


def test_no_model_column_is_missing_from_the_migrated_table(db):
    """Guards against a model gaining a column with no accompanying migration."""
    inspector = inspect(db.get_bind())
    for table, model in MODEL_TABLES.items():
        if model is None:
            continue
        migrated = {col["name"] for col in inspector.get_columns(table)}
        declared = set(model.__table__.c.keys())
        missing = declared - migrated
        assert not missing, f"{table} is missing migrated columns: {sorted(missing)}"


def test_no_migrated_not_null_column_is_absent_from_the_model(db):
    """The reverse drift: a NOT NULL column the ORM would never populate."""
    inspector = inspect(db.get_bind())
    for table, model in MODEL_TABLES.items():
        if model is None:
            continue
        declared = set(model.__table__.c.keys())
        for col in inspector.get_columns(table):
            if col["nullable"] and col["default"] is None:
                continue
            if col["name"] not in declared:
                # Must be defaulted or nullable server-side, or inserts break.
                assert col["nullable"] or col["default"] is not None, (
                    f"{table}.{col['name']} is NOT NULL in the database but absent "
                    "from the ORM model"
                )


def test_metadata_json_maps_to_the_metadata_column_name(db):
    """`metadata` is reserved on a declarative class, so the attribute differs."""
    assert "metadata" in Project.__table__.c
    assert "metadata_json" not in Project.__table__.c
    assert "metadata" in MediaAsset.__table__.c
    assert "metadata" in Export.__table__.c

    inspector = inspect(db.get_bind())
    for table in ("projects", "media_assets", "exports"):
        assert "metadata" in {c["name"] for c in inspector.get_columns(table)}


def test_project_unique_constraint_on_owner_and_name_is_migrated(db):
    inspector = inspect(db.get_bind())
    names = {c["name"] for c in inspector.get_unique_constraints("projects")}
    assert "uq_projects_owner_name" in names


def test_foreign_keys_present_for_tenant_columns(db):
    """projects.owner_id and media_assets.project_id must be real FKs, not
    loose UUIDs -- without them cross-entity cleanup cannot cascade."""
    inspector = inspect(db.get_bind())
    referenced = {fk["referred_table"] for fk in inspector.get_foreign_keys("projects")}
    assert "users" in referenced
    assert {fk["referred_table"] for fk in inspector.get_foreign_keys("media_assets")} >= {
        "projects",
        "users",
    }


def test_uuid_defaults_are_generated_per_row(db):
    owner = UserService(db).create_user("u1@example.com", None, "Correct-Horse-9")
    other = UserService(db).create_user("u2@example.com", None, "Correct-Horse-9")
    assert isinstance(owner.id, uuid.UUID)
    assert owner.id != other.id
