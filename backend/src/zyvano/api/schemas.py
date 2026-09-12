"""Pydantic schemas for API request/response validation."""

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, EmailStr, Field, field_validator


# ============= Auth Schemas =============
class UserLogin(BaseModel):
    """User login request."""

    email: EmailStr
    password: str = Field(..., min_length=8, max_length=255)


class TokenResponse(BaseModel):
    """JWT token response."""

    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    expires_in: int


class UserRegister(BaseModel):
    """User registration request."""

    email: EmailStr
    password: str = Field(..., min_length=8, max_length=255)
    name: str | None = Field(None, max_length=255)

    @field_validator("password")
    @classmethod
    def validate_password(cls, v: str) -> str:
        """Ensure password meets minimum requirements."""
        if not any(c.isupper() for c in v):
            raise ValueError("Password must contain at least one uppercase letter")
        if not any(c.isdigit() for c in v):
            raise ValueError("Password must contain at least one digit")
        return v


# ============= User Schemas =============
class UserResponse(BaseModel):
    """User response model."""

    id: UUID
    email: str
    name: str | None
    role: str
    is_active: bool
    is_verified: bool
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class UserUpdate(BaseModel):
    """User update request."""

    name: str | None = Field(None, max_length=255)


# ============= Project Schemas =============
class ProjectCreate(BaseModel):
    """Create project request."""

    name: str = Field(..., min_length=1, max_length=255)
    description: str | None = Field(None, max_length=2000)
    type: str = Field("video", pattern="^(video|image|animation|avatar)$")
    is_public: bool = False


class ProjectUpdate(BaseModel):
    """Update project request."""

    name: str | None = Field(None, min_length=1, max_length=255)
    description: str | None = Field(None, max_length=2000)
    is_public: bool | None = None


class ProjectResponse(BaseModel):
    """Project response model."""

    id: UUID
    owner_id: UUID
    name: str
    description: str | None
    type: str
    status: str
    is_public: bool
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class ProjectListResponse(BaseModel):
    """Project list response with pagination."""

    projects: list[ProjectResponse]
    total: int
    limit: int
    offset: int


# ============= Project Member Schemas =============
class ProjectMemberCreate(BaseModel):
    """Invite user to project."""

    user_id: UUID
    role: str = Field("viewer", pattern="^(owner|editor|reviewer|viewer)$")


class ProjectMemberUpdate(BaseModel):
    """Update project member role."""

    role: str = Field(pattern="^(owner|editor|reviewer|viewer)$")


class ProjectMemberResponse(BaseModel):
    """Project member response."""

    id: UUID
    project_id: UUID
    user_id: UUID
    role: str
    invite_accepted_at: datetime | None
    created_at: datetime

    model_config = {"from_attributes": True}


# ============= Media Asset Schemas =============
class MediaAssetResponse(BaseModel):
    """Media asset response model."""

    id: UUID
    project_id: UUID
    type: str
    name: str | None
    mime_type: str | None
    size: int | None
    storage_key: str
    created_at: datetime

    model_config = {"from_attributes": True}


# ============= Generation Job Schemas =============
class GenerationJobCreate(BaseModel):
    """Create generation job request."""

    type: str = Field(pattern="^(image|video|audio|avatar)$")
    payload: dict = Field(..., description="Job-specific parameters")
    idempotency_key: str | None = Field(None, max_length=255)


class GenerationJobResponse(BaseModel):
    """Generation job response model."""

    id: UUID
    project_id: UUID
    type: str
    status: str
    payload: dict
    result_id: UUID | None
    error_message: str | None
    retry_count: int
    max_retries: int
    started_at: datetime | None
    completed_at: datetime | None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class GenerationJobListResponse(BaseModel):
    """Generation job list response with pagination."""

    jobs: list[GenerationJobResponse]
    total: int
    limit: int
    offset: int


# ============= Export Schemas =============
class ExportCreate(BaseModel):
    """Create export job request."""

    format: str = Field(..., min_length=1, max_length=50)


class ExportResponse(BaseModel):
    """Export response model."""

    id: UUID
    project_id: UUID
    format: str
    status: str
    file_id: UUID | None
    error_message: str | None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


# ============= Error Schemas =============
class ErrorResponse(BaseModel):
    """Standard error response."""

    code: str
    message: str
    request_id: str | None = None
    details: dict | None = None


class ValidationErrorResponse(BaseModel):
    """Validation error response."""

    code: str = "VALIDATION_ERROR"
    message: str = "Request validation failed"
    errors: list[dict]
    request_id: str | None = None
