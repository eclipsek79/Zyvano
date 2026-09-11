"""Tests for zyvano.services.project_service.ProjectService.

The emphasis is on the authorization boundary: every accessor takes an owner
and must never return another user's project.
"""

import uuid

import pytest
from sqlalchemy.exc import IntegrityError

from zyvano.db.models import Project, ProjectStatus, ProjectType
from zyvano.services.project_service import ProjectService
from zyvano.services.user_service import UserService


@pytest.fixture()
def service(db):
    return ProjectService(db)


@pytest.fixture()
def owner(db):
    return UserService(db).create_user("owner@example.com", "Owner", "Correct-Horse-9")


@pytest.fixture()
def stranger(db):
    return UserService(db).create_user("stranger@example.com", "Stranger", "Correct-Horse-9")


# --------------------------------------------------------------------------- #
# create / read                                                               #
# --------------------------------------------------------------------------- #


def test_create_project_defaults(service, owner):
    project = service.create_project(owner, "Launch Film")
    assert isinstance(project.id, uuid.UUID)
    assert project.owner_id == owner.id
    assert project.name == "Launch Film"
    assert project.description is None
    assert project.status == ProjectStatus.ACTIVE
    assert project.is_public is False
    assert project.created_at is not None


def test_create_project_with_description(service, owner):
    project = service.create_project(owner, "Doc", description="A short film")
    assert project.description == "A short film"


def test_project_type_is_stored_as_video_enum(service, owner):
    project = service.create_project(owner, "Typed", type="video")
    assert project.type == ProjectType.VIDEO


def test_duplicate_project_name_per_owner_is_rejected(service, owner, db):
    """uq_projects_owner_name is enforced by the migrated schema."""
    service.create_project(owner, "Same Name")
    with pytest.raises(IntegrityError):
        service.create_project(owner, "Same Name")
    db.rollback()


def test_two_owners_may_reuse_the_same_project_name(service, owner, stranger):
    a = service.create_project(owner, "Shared Title")
    b = service.create_project(stranger, "Shared Title")
    assert a.id != b.id


# --------------------------------------------------------------------------- #
# authorization boundary                                                      #
# --------------------------------------------------------------------------- #


def test_get_project_by_owner(service, owner):
    created = service.create_project(owner, "Mine")
    assert service.get_project(created.id, owner).id == created.id


def test_get_project_by_other_user_returns_none(service, owner, stranger):
    """IDOR guard: knowing the UUID must not grant access."""
    created = service.create_project(owner, "Private")
    assert service.get_project(created.id, stranger) is None


def test_get_project_unknown_id_returns_none(service, owner):
    assert service.get_project(uuid.uuid4(), owner) is None


def test_list_projects_excludes_other_users_projects(service, owner, stranger):
    service.create_project(owner, "Owner Project")
    service.create_project(stranger, "Stranger Project")
    names = [p.name for p in service.list_projects(owner)["projects"]]
    assert names == ["Owner Project"]


def test_update_project_by_other_user_returns_none(service, owner, stranger):
    created = service.create_project(owner, "Original")
    assert service.update_project(created.id, stranger, name="Hijacked") is None
    assert service.get_project(created.id, owner).name == "Original"


def test_delete_project_by_other_user_returns_false(service, owner, stranger):
    created = service.create_project(owner, "Safe")
    assert service.delete_project(created.id, stranger) is False
    assert service.get_project(created.id, owner).status == ProjectStatus.ACTIVE


# --------------------------------------------------------------------------- #
# list / pagination                                                           #
# --------------------------------------------------------------------------- #


def test_list_projects_pagination(service, owner):
    for i in range(3):
        service.create_project(owner, f"Project {i}")
    page = service.list_projects(owner, limit=2, offset=0)
    assert page["total"] == 3
    assert page["limit"] == 2
    assert page["offset"] == 0
    assert len(page["projects"]) == 2

    second = service.list_projects(owner, limit=2, offset=2)
    assert len(second["projects"]) == 1


def test_list_projects_empty_for_new_user(service, stranger):
    page = service.list_projects(stranger)
    assert page["total"] == 0
    assert page["projects"] == []


# --------------------------------------------------------------------------- #
# update / delete                                                             #
# --------------------------------------------------------------------------- #


def test_update_project_fields(service, owner):
    created = service.create_project(owner, "Before", description="old")
    updated = service.update_project(created.id, owner, name="After", description="new")
    assert updated.name == "After"
    assert updated.description == "new"


def test_update_project_partial_leaves_other_field(service, owner):
    created = service.create_project(owner, "Keep Me", description="keep this")
    updated = service.update_project(created.id, owner, name="Renamed")
    assert updated.name == "Renamed"
    assert updated.description == "keep this"


def test_delete_project_is_soft_not_row_removal(service, owner, db):
    created = service.create_project(owner, "Soft Delete")
    assert service.delete_project(created.id, owner) is True

    # Hidden from every service accessor...
    assert service.get_project(created.id, owner) is None
    # ...but the row and its audit trail still exist.
    row = db.query(Project).filter(Project.id == created.id).one()
    assert row.status == ProjectStatus.DELETED


def test_deleted_project_absent_from_list(service, owner):
    keep = service.create_project(owner, "Kept")
    gone = service.create_project(owner, "Gone")
    service.delete_project(gone.id, owner)
    names = [p.name for p in service.list_projects(owner)["projects"]]
    assert names == [keep.name]


def test_delete_project_twice_returns_false_second_time(service, owner):
    created = service.create_project(owner, "Once")
    assert service.delete_project(created.id, owner) is True
    assert service.delete_project(created.id, owner) is False


# --------------------------------------------------------------------------- #
# model / schema coherence                                                    #
# --------------------------------------------------------------------------- #


def test_metadata_attribute_maps_to_metadata_column(service, owner, db):
    """The ORM attribute is `metadata_json` because `metadata` is reserved.

    The underlying column must still be named `metadata` so it keeps matching
    migration 001_initial_schema.
    """
    assert "metadata" in Project.__table__.c
    assert "metadata_json" not in Project.__table__.c

    created = service.create_project(owner, "With Meta")
    created.metadata_json = {"codec": "h264"}
    db.commit()
    db.expire_all()

    reloaded = db.query(Project).filter(Project.id == created.id).one()
    assert reloaded.metadata_json == {"codec": "h264"}
