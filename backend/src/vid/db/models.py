"""SQLAlchemy database models."""
from datetime import datetime
from uuid import uuid4
from sqlalchemy import Column, String, DateTime, UUID, ForeignKey, Integer, Text, JSON, Boolean, Enum, Index, UniqueConstraint
from sqlalchemy.orm import relationship
import enum

from vid.db.session import Base


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


class User(Base):
    """User model."""
    __tablename__ = "users"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    email = Column(String(255), unique=True, nullable=False, index=True)
    password_hash = Column(String(255), nullable=True)
    name = Column(String(255), nullable=True)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at = Column(DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    projects = relationship("Project", back_populates="owner", cascade="all, delete-orphan")
    media_assets = relationship("MediaAsset", back_populates="owner", cascade="all, delete-orphan")
    generation_jobs = relationship("GenerationJob", back_populates="owner", cascade="all, delete-orphan")
    exports = relationship("Export", back_populates="owner", cascade="all, delete-orphan")
    audit_logs = relationship("AuditLog", back_populates="user", cascade="all, delete-orphan")


class Project(Base):
    """Project model."""
    __tablename__ = "projects"
    __table_args__ = (
        Index("ix_projects_owner_id_created_at", "owner_id", "created_at"),
        UniqueConstraint("owner_id", "name", name="uq_projects_owner_name"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    owner_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    name = Column(String(255), nullable=False)
    description = Column(Text, nullable=True)
    type = Column(Enum(ProjectType), default=ProjectType.VIDEO)
    status = Column(Enum(ProjectStatus), default=ProjectStatus.ACTIVE)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at = Column(DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    owner = relationship("User", back_populates="projects")
    media_assets = relationship("MediaAsset", back_populates="project", cascade="all, delete-orphan")
    generation_jobs = relationship("GenerationJob", back_populates="project", cascade="all, delete-orphan")
    exports = relationship("Export", back_populates="project", cascade="all, delete-orphan")


class MediaAsset(Base):
    """Media asset model."""
    __tablename__ = "media_assets"
    __table_args__ = (
        Index("ix_media_assets_project_id_type", "project_id", "type"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    owner_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    type = Column(Enum(AssetType), nullable=False)
    mime_type = Column(String(100), nullable=True)
    size = Column(Integer, nullable=True)
    storage_key = Column(String(255), unique=True, nullable=False, index=True)
    metadata = Column(JSON, nullable=True)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)

    # Relationships
    project = relationship("Project", back_populates="media_assets")
    owner = relationship("User", back_populates="media_assets")


class GenerationJob(Base):
    """Generation job model."""
    __tablename__ = "generation_jobs"
    __table_args__ = (
        Index("ix_generation_jobs_project_id_status", "project_id", "status"),
        Index("ix_generation_jobs_owner_id_created_at", "owner_id", "created_at"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    owner_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    type = Column(Enum(GenerationJobType), nullable=False)
    status = Column(Enum(GenerationJobStatus), default=GenerationJobStatus.PENDING)
    payload = Column(JSON, nullable=False)
    result_id = Column(UUID(as_uuid=True), ForeignKey("media_assets.id", ondelete="SET NULL"), nullable=True)
    error_message = Column(Text, nullable=True)
    retry_count = Column(Integer, default=0)
    idempotency_key = Column(String(255), unique=True, nullable=True, index=True)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at = Column(DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    project = relationship("Project", back_populates="generation_jobs")
    owner = relationship("User", back_populates="generation_jobs")
    attempts = relationship("GenerationAttempt", back_populates="job", cascade="all, delete-orphan")


class GenerationAttempt(Base):
    """Generation attempt model."""
    __tablename__ = "generation_attempts"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    job_id = Column(UUID(as_uuid=True), ForeignKey("generation_jobs.id", ondelete="CASCADE"), nullable=False)
    provider = Column(String(100), nullable=False)
    status = Column(String(50), nullable=False)
    provider_request_id = Column(String(255), nullable=True, index=True)
    error_message = Column(Text, nullable=True)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at = Column(DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    job = relationship("GenerationJob", back_populates="attempts")


class Export(Base):
    """Export job model."""
    __tablename__ = "exports"
    __table_args__ = (
        Index("ix_exports_project_id_created_at", "project_id", "created_at"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    owner_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    format = Column(String(50), nullable=False)
    status = Column(Enum(ExportStatus), default=ExportStatus.PENDING)
    file_id = Column(UUID(as_uuid=True), ForeignKey("media_assets.id", ondelete="SET NULL"), nullable=True)
    error_message = Column(Text, nullable=True)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at = Column(DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    project = relationship("Project", back_populates="exports")
    owner = relationship("User", back_populates="exports")


class AuditLog(Base):
    """Audit log model."""
    __tablename__ = "audit_logs"
    __table_args__ = (
        Index("ix_audit_logs_user_id_created_at", "user_id", "created_at"),
        Index("ix_audit_logs_resource_type_id", "resource_type", "resource_id"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    action = Column(String(100), nullable=False)
    resource_type = Column(String(100), nullable=False)
    resource_id = Column(String(255), nullable=False)
    details = Column(JSON, nullable=True)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)

    # Relationships
    user = relationship("User", back_populates="audit_logs")


class QueueJob(Base):
    """Queue job model for async processing."""
    __tablename__ = "queue_jobs"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    type = Column(String(100), nullable=False)
    status = Column(String(50), nullable=False, default="pending")
    payload = Column(JSON, nullable=False)
    result = Column(JSON, nullable=True)
    error_message = Column(Text, nullable=True)
    retry_count = Column(Integer, default=0)
    max_retries = Column(Integer, default=3)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at = Column(DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)
