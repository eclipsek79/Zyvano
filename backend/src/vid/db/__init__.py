"""Database module."""
from vid.db.session import Base, get_db, get_async_db, SessionLocal, AsyncSessionLocal
from vid.db.models import (
    User, Project, ProjectMember, MediaAsset, GenerationJob, GenerationAttempt,
    Export, AuditLog, QueueJob,
    UserRole, ProjectRole, ProjectType, ProjectStatus, AssetType,
    GenerationJobStatus, GenerationJobType, ExportStatus, AuditAction
)

__all__ = [
    # Session management
    "Base",
    "get_db",
    "get_async_db",
    "SessionLocal",
    "AsyncSessionLocal",
    # Models
    "User",
    "Project",
    "ProjectMember",
    "MediaAsset",
    "GenerationJob",
    "GenerationAttempt",
    "Export",
    "AuditLog",
    "QueueJob",
    # Enums
    "UserRole",
    "ProjectRole",
    "ProjectType",
    "ProjectStatus",
    "AssetType",
    "GenerationJobStatus",
    "GenerationJobType",
    "ExportStatus",
    "AuditAction",
]
