"""Custom application errors for standardized error handling."""
from typing import Optional, Dict, Any


class AppError(Exception):
    """Base application error."""
    
    def __init__(
        self,
        code: str,
        message: str,
        status_code: int = 500,
        details: Optional[Dict[str, Any]] = None,
    ):
        self.code = code
        self.message = message
        self.status_code = status_code
        self.details = details or {}
        super().__init__(message)


# Authentication errors
class UnauthorizedError(AppError):
    """User is not authenticated."""
    def __init__(self, message: str = "Unauthorized", details: Optional[Dict] = None):
        super().__init__("UNAUTHORIZED", message, 401, details)


class ForbiddenError(AppError):
    """User lacks permission to access resource."""
    def __init__(self, message: str = "Forbidden", details: Optional[Dict] = None):
        super().__init__("FORBIDDEN", message, 403, details)


class InvalidCredentialsError(AppError):
    """Invalid login credentials."""
    def __init__(self, message: str = "Invalid credentials"):
        super().__init__("INVALID_CREDENTIALS", message, 401)


# Resource errors
class NotFoundError(AppError):
    """Resource not found."""
    def __init__(self, resource: str, resource_id: str = ""):
        message = f"{resource} not found"
        if resource_id:
            message += f" (ID: {resource_id})"
        super().__init__("NOT_FOUND", message, 404)


class ConflictError(AppError):
    """Resource already exists or conflict."""
    def __init__(self, message: str, details: Optional[Dict] = None):
        super().__init__("CONFLICT", message, 409, details)


# Validation errors
class ValidationError(AppError):
    """Request validation failed."""
    def __init__(self, message: str, details: Optional[Dict] = None):
        super().__init__("VALIDATION_ERROR", message, 400, details)


class RateLimitError(AppError):
    """Rate limit exceeded."""
    def __init__(self, message: str = "Rate limit exceeded"):
        super().__init__("RATE_LIMIT_EXCEEDED", message, 429)


# Job errors
class JobError(AppError):
    """Job processing error."""
    def __init__(self, message: str, details: Optional[Dict] = None):
        super().__init__("JOB_ERROR", message, 400, details)


class JobNotFoundError(AppError):
    """Job not found."""
    def __init__(self, job_id: str):
        super().__init__("JOB_NOT_FOUND", f"Job not found (ID: {job_id})", 404)


class IdempotencyError(AppError):
    """Idempotent request conflict."""
    def __init__(self, message: str = "Duplicate request"):
        super().__init__("IDEMPOTENCY_CONFLICT", message, 409)
