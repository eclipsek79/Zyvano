"""Global error handler middleware."""
import logging
from typing import Any

from fastapi import Request
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException

logger = logging.getLogger(__name__)


async def global_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """Handle uncaught exceptions without leaking sensitive information."""
    request_id = getattr(request.state, "request_id", "unknown")

    # Log the full error internally
    logger.error(
        "Unhandled exception",
        extra={
            "request_id": request_id,
            "path": request.url.path,
            "method": request.method,
            "exception": str(exc),
            "exception_type": type(exc).__name__,
        },
        exc_info=True,
    )

    # Return safe error response without internal details
    return JSONResponse(
        status_code=500,
        content={
            "code": "INTERNAL_SERVER_ERROR",
            "message": "An internal server error occurred",
            "request_id": request_id,
        },
    )
