"""SQLAlchemy database models with SQLAlchemy 2.x patterns."""

import enum
from datetime import datetime
from typing import Any
from uuid import uuid4

from sqlalchemy import (
    JSON,
    UUID,
    Boolean,
    Column,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import relationship

from zyvano.db.session import Base


def _pg_enum(enum_cls) -> Enum:
    """Map a Python enum onto the lowercase values used by migration 001.

    For a ``(str, enum.Enum)`` class SQLAlchemy persists the enum *member name*
    ("USER") by default. Migration 001_initial_schema created every Postgres
    enum with lowercase *values* ('user'), so without ``values_callable`` every
    INSERT fails with::

        psycopg.errors.InvalidTextRepresentation:
        invalid input value for enum userrole: "USER"

    The type NAMES already line up (SQLAlchemy lowercases the class name, so
    ``UserRole`` -> ``userrole``), which is why only the values needed aligning.
    """
    return Enum(enum_cls, values_callable=lambda e: [m.value for m in e])


class UserRole(str, enum.Enum):
    """User account roles."""

    ADMIN = "admin"
    USER = "user"
    VIEWER = "viewer"


class ProjectRole(str, enum.Enum):
    """Project membership roles with permissions."""

    OWNER = "owner"  # Full control
    EDITOR = "editor"  # Can create/edit content
    REVIEWER = "reviewer"  # Can view and comment
    VIEWER = "viewer"  # Read-only


class ProjectType(str, enum.Enum):
    """Project type enumeration."""

    VIDEO = "video"
    IMAGE = "image"
    ANIMATION = "animation"
    AVATAR = "avatar"


class ProjectStatus(str, enum.Enum):
    """Project status enumeration."""

    ACTIVE = "active"
    ARCHIVED = "archived"
    DELETED = "deleted"


class AssetType(str, enum.Enum):
    """Media asset type enumeration."""

    IMAGE = "image"
    VIDEO = "video"
    AUDIO = "audio"
    AVATAR = "avatar"
    DOCUMENT = "document"


class GenerationJobStatus(str, enum.Enum):
    """Generation job status enumeration."""

    PENDING = "pending"
    QUEUED = "queued"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class GenerationJobType(str, enum.Enum):
    """Generation job type enumeration."""

    IMAGE = "image"
    VIDEO = "video"
    AUDIO = "audio"
    AVATAR = "avatar"


class ExportStatus(str, enum.Enum):
    """Export job status enumeration."""

    PENDING = "pending"
    QUEUED = "queued"
    PROCESSING = "processing"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class AuditAction(str, enum.Enum):
    """Audit log action types."""

    CREATE = "create"
    UPDATE = "update"
    DELETE = "delete"
    VIEW = "view"
    SHARE = "share"
    EXPORT = "export"
    DOWNLOAD = "download"
    ERROR = "error"


class User(Base):
    """User model with role-based access control."""

    __tablename__ = "users"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    email = Column(String(255), unique=True, nullable=False, index=True)
    # Annotated `Any` on purpose. This module uses the classic `Column(...)`
    # declarative style, so mypy reads an attribute access as `Column[str]`
    # rather than the `str` the descriptor actually returns at runtime. These
    # four attributes are read or written by the service layer, so annotating
    # them as Any keeps that layer honest without switching the whole model
    # layer to `Mapped[...]`. SQLAlchemy documents `Any` as the supported
    # annotation for the legacy style; leaving them bare would instead make
    # every query expression untyped, which is worse.
    password_hash: Any = Column(String(255), nullable=True)
    name: Any = Column(String(255), nullable=True)
    role = Column(_pg_enum(UserRole), default=UserRole.USER, nullable=False)
    is_active = Column(Boolean, default=True, nullable=False)
    is_verified = Column(Boolean, default=False, nullable=False)
    last_login_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at = Column(DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    projects = relationship(
        "Project",
        back_populates="owner",
        cascade="all, delete-orphan",
        foreign_keys="Project.owner_id",
    )
    project_memberships = relationship(
        "ProjectMember",
        back_populates="user",
        cascade="all, delete-orphan",
        foreign_keys="ProjectMember.user_id",
    )
    media_assets = relationship("MediaAsset", back_populates="owner", cascade="all, delete-orphan")
    generation_jobs = relationship(
        "GenerationJob", back_populates="owner", cascade="all, delete-orphan"
    )
    exports = relationship("Export", back_populates="owner", cascade="all, delete-orphan")
    audit_logs = relationship("AuditLog", back_populates="user", cascade="all, delete-orphan")


class Project(Base):
    """Project model with enhanced metadata."""

    __tablename__ = "projects"
    __table_args__ = (
        Index("ix_projects_owner_id_created_at", "owner_id", "created_at"),
        Index("ix_projects_status", "status"),
        UniqueConstraint("owner_id", "name", name="uq_projects_owner_name"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    owner_id = Column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    name: Any = Column(String(255), nullable=False)
    description: Any = Column(Text, nullable=True)
    type = Column(_pg_enum(ProjectType), default=ProjectType.VIDEO, nullable=False)
    status: Any = Column(_pg_enum(ProjectStatus), default=ProjectStatus.ACTIVE, nullable=False)
    is_public = Column(Boolean, default=False, nullable=False)
    # NB: the ORM attribute cannot be called `metadata` -- SQLAlchemy reserves
    # that name for the declarative MetaData object, and using it made this
    # module unimportable (`InvalidRequestError: Attribute name 'metadata' is
    # reserved`). The DATABASE column keeps the name "metadata" so it still
    # matches migration 001_initial_schema.
    metadata_json = Column("metadata", JSON, nullable=True)  # Custom metadata
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at = Column(DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    owner = relationship("User", back_populates="projects", foreign_keys=[owner_id])
    members = relationship("ProjectMember", back_populates="project", cascade="all, delete-orphan")
    media_assets = relationship(
        "MediaAsset", back_populates="project", cascade="all, delete-orphan"
    )
    generation_jobs = relationship(
        "GenerationJob", back_populates="project", cascade="all, delete-orphan"
    )
    exports = relationship("Export", back_populates="project", cascade="all, delete-orphan")


class ProjectMember(Base):
    """Project membership with role-based access control."""

    __tablename__ = "project_members"
    __table_args__ = (
        Index("ix_project_members_project_user", "project_id", "user_id"),
        Index("ix_project_members_role", "role"),
        UniqueConstraint("project_id", "user_id", name="uq_project_members_project_user"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    project_id = Column(
        UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    role = Column(_pg_enum(ProjectRole), default=ProjectRole.VIEWER, nullable=False)
    invited_by_id = Column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    invite_accepted_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at = Column(DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    project = relationship("Project", back_populates="members")
    user = relationship("User", back_populates="project_memberships", foreign_keys=[user_id])
    invited_by = relationship("User", foreign_keys=[invited_by_id])

    def is_accepted(self) -> bool:
        """Check if invitation has been accepted."""
        return self.invite_accepted_at is not None


class MediaAsset(Base):
    """Media asset model with storage tracking."""

    __tablename__ = "media_assets"
    __table_args__ = (
        Index("ix_media_assets_project_id_type", "project_id", "type"),
        Index("ix_media_assets_storage_key", "storage_key"),
        UniqueConstraint("storage_key", name="uq_media_assets_storage_key"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    project_id = Column(
        UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    owner_id = Column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    type = Column(_pg_enum(AssetType), nullable=False)
    name = Column(String(255), nullable=True)
    mime_type = Column(String(100), nullable=True)
    size = Column(Integer, nullable=True)
    storage_key = Column(String(512), unique=True, nullable=False, index=True)
    # ORM attribute renamed; DB column is still "metadata" (see Project).
    metadata_json = Column("metadata", JSON, nullable=True)
    is_deleted = Column(Boolean, default=False, nullable=False)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at = Column(DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    project = relationship("Project", back_populates="media_assets")
    owner = relationship("User", back_populates="media_assets")


class GenerationJob(Base):
    """Generation job model with retry tracking and idempotency."""

    __tablename__ = "generation_jobs"
    __table_args__ = (
        Index("ix_generation_jobs_project_id_status", "project_id", "status"),
        Index("ix_generation_jobs_owner_id_created_at", "owner_id", "created_at"),
        Index("ix_generation_jobs_idempotency_key", "idempotency_key"),
        Index("ix_generation_jobs_status", "status"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    project_id = Column(
        UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    owner_id = Column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    type = Column(_pg_enum(GenerationJobType), nullable=False)
    status = Column(
        _pg_enum(GenerationJobStatus), default=GenerationJobStatus.PENDING, nullable=False
    )
    payload = Column(JSON, nullable=False)
    result_id = Column(
        UUID(as_uuid=True), ForeignKey("media_assets.id", ondelete="SET NULL"), nullable=True
    )
    error_message = Column(Text, nullable=True)
    retry_count = Column(Integer, default=0, nullable=False)
    max_retries = Column(Integer, default=3, nullable=False)
    idempotency_key = Column(String(255), unique=True, nullable=True, index=True)
    started_at = Column(DateTime, nullable=True)
    completed_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at = Column(DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    project = relationship("Project", back_populates="generation_jobs")
    owner = relationship("User", back_populates="generation_jobs")
    attempts = relationship("GenerationAttempt", back_populates="job", cascade="all, delete-orphan")


class GenerationAttempt(Base):
    """Generation attempt tracking for observability."""

    __tablename__ = "generation_attempts"
    __table_args__ = (
        Index("ix_generation_attempts_job_id", "job_id"),
        Index("ix_generation_attempts_provider_request_id", "provider_request_id"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    job_id = Column(
        UUID(as_uuid=True), ForeignKey("generation_jobs.id", ondelete="CASCADE"), nullable=False
    )
    provider = Column(String(100), nullable=False)
    status = Column(String(50), nullable=False)
    provider_request_id = Column(String(255), nullable=True, index=True)
    error_message = Column(Text, nullable=True)
    attempt_number = Column(Integer, default=1, nullable=False)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at = Column(DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    job = relationship("GenerationJob", back_populates="attempts")


class Export(Base):
    """Export job model with format support."""

    __tablename__ = "exports"
    __table_args__ = (
        Index("ix_exports_project_id_created_at", "project_id", "created_at"),
        Index("ix_exports_status", "status"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    project_id = Column(
        UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    owner_id = Column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    format = Column(String(50), nullable=False)
    status = Column(_pg_enum(ExportStatus), default=ExportStatus.PENDING, nullable=False)
    file_id = Column(
        UUID(as_uuid=True), ForeignKey("media_assets.id", ondelete="SET NULL"), nullable=True
    )
    error_message = Column(Text, nullable=True)
    # ORM attribute renamed; DB column is still "metadata" (see Project).
    metadata_json = Column("metadata", JSON, nullable=True)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at = Column(DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    project = relationship("Project", back_populates="exports")
    owner = relationship("User", back_populates="exports")


class AuditLog(Base):
    """Comprehensive audit logging for compliance."""

    __tablename__ = "audit_logs"
    __table_args__ = (
        Index("ix_audit_logs_user_id_created_at", "user_id", "created_at"),
        Index("ix_audit_logs_resource_type_id", "resource_type", "resource_id"),
        Index("ix_audit_logs_action", "action"),
        Index("ix_audit_logs_created_at", "created_at"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    action = Column(_pg_enum(AuditAction), nullable=False)
    resource_type = Column(String(100), nullable=False)
    resource_id = Column(String(255), nullable=False)
    resource_name = Column(String(255), nullable=True)
    project_id = Column(
        UUID(as_uuid=True), ForeignKey("projects.id", ondelete="SET NULL"), nullable=True
    )
    changes = Column(JSON, nullable=True)  # Before/after values
    ip_address = Column(String(45), nullable=True)  # IPv4 or IPv6
    user_agent = Column(String(255), nullable=True)
    status = Column(String(50), default="success", nullable=False)
    error_message = Column(Text, nullable=True)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)

    # Relationships
    user = relationship("User", back_populates="audit_logs")


class QueueJob(Base):
    """Queue job model for async processing (background tasks)."""

    __tablename__ = "queue_jobs"
    __table_args__ = (
        Index("ix_queue_jobs_status", "status"),
        Index("ix_queue_jobs_type_status", "type", "status"),
        Index("ix_queue_jobs_created_at", "created_at"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    type = Column(String(100), nullable=False)
    status = Column(String(50), nullable=False, default="pending")
    payload = Column(JSON, nullable=False)
    result = Column(JSON, nullable=True)
    error_message = Column(Text, nullable=True)
    retry_count = Column(Integer, default=0, nullable=False)
    max_retries = Column(Integer, default=3, nullable=False)
    scheduled_for = Column(DateTime, nullable=True)
    started_at = Column(DateTime, nullable=True)
    completed_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at = Column(DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)
