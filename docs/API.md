# API Specification

## API Version

All endpoints use versioning: `/api/v1/`

## Base Response Format

All API responses follow a consistent structure:

```json
{
  "success": true,
  "data": {},
  "error": null,
  "request_id": "req_abc123"
}
```

Error responses:

```json
{
  "success": false,
  "data": null,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable error message",
    "details": {}
  },
  "request_id": "req_abc123"
}
```

## Authentication Endpoints

### `POST /api/v1/auth/login`

**Status**: INTERFACE ONLY

Authenticate user and obtain session token.

**Request**:
```json
{
  "provider": "google|github|email",
  "credentials": {}
}
```

**Response**:
```json
{
  "token": "jwt_token",
  "user": { /* User object */ },
  "expires_at": "2024-12-31T00:00:00Z"
}
```

### `POST /api/v1/auth/logout`

**Status**: INTERFACE ONLY

Invalidate current session.

**Response**:
```json
{
  "message": "Logout successful"
}
```

### `POST /api/v1/auth/refresh`

**Status**: INTERFACE ONLY

Refresh authentication token.

**Request**:
```json
{
  "refresh_token": "token"
}
```

**Response**:
```json
{
  "token": "new_jwt_token",
  "expires_at": "2024-12-31T00:00:00Z"
}
```

### `GET /api/v1/auth/providers`

**Status**: INTERFACE ONLY

List available authentication providers.

**Response**:
```json
{
  "providers": [
    {
      "id": "google",
      "name": "Google",
      "icon": "url",
      "enabled": true
    }
  ]
}
```

## User Endpoints

### `GET /api/v1/users/me`

**Status**: INTERFACE ONLY

Get current authenticated user profile.

**Response**:
```json
{
  "id": "user_abc123",
  "email": "user@example.com",
  "name": "John Doe",
  "avatar": "url",
  "created_at": "2024-01-01T00:00:00Z",
  "updated_at": "2024-01-01T00:00:00Z"
}
```

### `PATCH /api/v1/users/me`

**Status**: INTERFACE ONLY

Update user profile.

**Request**:
```json
{
  "name": "New Name",
  "avatar": "image_url"
}
```

**Response**: Updated User object

## Project Endpoints

### `GET /api/v1/projects`

**Status**: INTERFACE ONLY

List user's projects.

**Query Parameters**:
- `limit`: int (default: 20, max: 100)
- `offset`: int (default: 0)
- `status`: string (optional)

**Response**:
```json
{
  "projects": [ /* Project array */ ],
  "total": 42,
  "limit": 20,
  "offset": 0
}
```

### `POST /api/v1/projects`

**Status**: INTERFACE ONLY

Create new project.

**Request**:
```json
{
  "title": "My Movie Project",
  "description": "A sci-fi adventure",
  "type": "movie|series|video"
}
```

**Response**: Created Project object

### `GET /api/v1/projects/:id`

**Status**: INTERFACE ONLY

Get project details.

**Response**:
```json
{
  "id": "proj_abc123",
  "title": "My Movie Project",
  "description": "A sci-fi adventure",
  "owner_id": "user_abc123",
  "status": "in_progress",
  "members": [ /* ProjectMember array */ ],
  "created_at": "2024-01-01T00:00:00Z",
  "updated_at": "2024-01-01T00:00:00Z"
}
```

### `PATCH /api/v1/projects/:id`

**Status**: INTERFACE ONLY

Update project.

**Request**:
```json
{
  "title": "Updated Title",
  "description": "Updated description",
  "status": "completed|archived"
}
```

**Response**: Updated Project object

### `DELETE /api/v1/projects/:id`

**Status**: INTERFACE ONLY

Delete project (requires ownership).

**Response**:
```json
{
  "message": "Project deleted successfully"
}
```

## Script Endpoints

### `POST /api/v1/projects/:projectId/scripts`

**Status**: INTERFACE ONLY

Upload or create a script.

**Request** (multipart/form-data):
```
file: script.txt or script.pdf
title: "Script Title"
```

Or JSON:
```json
{
  "content": "Script content as text",
  "title": "Script Title"
}
```

**Response**:
```json
{
  "id": "script_abc123",
  "project_id": "proj_abc123",
  "title": "Script Title",
  "content": "...",
  "status": "draft",
  "version": 1,
  "created_at": "2024-01-01T00:00:00Z"
}
```

### `GET /api/v1/scripts/:id`

**Status**: INTERFACE ONLY

Get script details.

**Response**:
```json
{
  "id": "script_abc123",
  "project_id": "proj_abc123",
  "content": "...",
  "status": "draft",
  "version_count": 3,
  "created_at": "2024-01-01T00:00:00Z",
  "updated_at": "2024-01-01T00:00:00Z"
}
```

### `POST /api/v1/scripts/:id/refine`

**Status**: INTERFACE ONLY

Refine or rewrite script (creates new version).

**Request**:
```json
{
  "mode": "fine_tune|rewrite|enhance",
  "instructions": "Make it more dramatic"
}
```

**Response**: New ScriptVersion object

### `GET /api/v1/scripts/:id/versions`

**Status**: INTERFACE ONLY

List script versions.

**Response**:
```json
{
  "versions": [
    {
      "version": 1,
      "content": "...",
      "change_type": "user_upload",
      "created_at": "2024-01-01T00:00:00Z"
    }
  ]
}
```

## Character Endpoints

### `POST /api/v1/projects/:projectId/characters`

**Status**: INTERFACE ONLY

Create character.

**Request**:
```json
{
  "name": "Hero",
  "description": "A brave warrior",
  "appearance": "Tall with blue eyes",
  "arc_summary": "Learns humility through adversity"
}
```

**Response**: Created Character object

### `GET /api/v1/characters/:id`

**Status**: INTERFACE ONLY

Get character details.

**Response**: Character object

### `PATCH /api/v1/characters/:id`

**Status**: INTERFACE ONLY

Update character.

**Response**: Updated Character object

## Movie Endpoints

### `POST /api/v1/projects/:projectId/movies`

**Status**: INTERFACE ONLY

Create movie.

**Request**:
```json
{
  "title": "The Adventure",
  "script_id": "script_abc123",
  "duration_hours": 2,
  "genre": "action",
  "visual_style": "cinematic",
  "tone": "dramatic"
}
```

**Validation**:
- `duration_hours` must be ≤ 5
- If `duration_hours` > 5, suggest series conversion

**Response**:
```json
{
  "id": "movie_abc123",
  "project_id": "proj_abc123",
  "title": "The Adventure",
  "duration_seconds": 7200,
  "status": "draft",
  "created_at": "2024-01-01T00:00:00Z"
}
```

### `GET /api/v1/movies/:id`

**Status**: INTERFACE ONLY

Get movie details.

**Response**:
```json
{
  "id": "movie_abc123",
  "title": "The Adventure",
  "duration_seconds": 7200,
  "script_id": "script_abc123",
  "scenes": [ /* Scene array */ ],
  "status": "draft",
  "created_at": "2024-01-01T00:00:00Z"
}
```

### `PATCH /api/v1/movies/:id`

**Status**: INTERFACE ONLY

Update movie.

**Request**:
```json
{
  "title": "New Title",
  "visual_style": "anime"
}
```

**Response**: Updated Movie object

### `DELETE /api/v1/movies/:id`

**Status**: INTERFACE ONLY

Delete movie (requires ownership).

**Response**:
```json
{
  "message": "Movie deleted successfully"
}
```

## Series Endpoints

### `POST /api/v1/projects/:projectId/series`

**Status**: INTERFACE ONLY

Create series.

**Request**:
```json
{
  "title": "The Saga",
  "premise": "An epic journey",
  "genre": "fantasy",
  "visual_style": "cinematic",
  "continuity_rules": "All episodes share the same world"
}
```

**Response**: Created Series object

### `POST /api/v1/series/:id/seasons`

**Status**: INTERFACE ONLY

Add season to series.

**Request**:
```json
{
  "season_number": 1,
  "title": "The Beginning",
  "episode_count": 10,
  "episode_duration_minutes": 60
}
```

**Validation**:
- `episode_count` must be 10–24 (inclusive)
- `episode_duration_minutes` must be 60 or 70

**Response**: Created Season object

### `POST /api/v1/seasons/:id/episodes`

**Status**: INTERFACE ONLY

Add episodes to season.

**Request**:
```json
{
  "episodes": [
    {
      "number": 1,
      "title": "Pilot",
      "script_id": "script_abc123"
    }
  ]
}
```

**Response**: Array of created Episode objects

## Generation Endpoints

### `POST /api/v1/generations`

**Status**: INTERFACE ONLY

Start a generation job.

**Request**:
```json
{
  "type": "video|image|avatar|audio",
  "source": {
    "script_id": "script_abc123" or "prompt": "A brave hero...",
    "style": "cinematic"
  },
  "provider_preference": "openai|replicate|anthropic" (optional)
}
```

**Response**:
```json
{
  "job_id": "gen_abc123",
  "status": "pending",
  "created_at": "2024-01-01T00:00:00Z",
  "estimated_duration": 300
}
```

### `GET /api/v1/generations/:id`

**Status**: INTERFACE ONLY

Get generation job status.

**Response**:
```json
{
  "job_id": "gen_abc123",
  "status": "running",
  "progress": 45,
  "created_at": "2024-01-01T00:00:00Z",
  "updated_at": "2024-01-01T00:00:00Z",
  "result": null or { /* Generated asset */ }
}
```

### `GET /api/v1/generations`

**Status**: INTERFACE ONLY

List user's generation jobs.

**Query Parameters**:
- `limit`: int
- `offset`: int
- `status`: pending|queued|running|completed|failed

**Response**:
```json
{
  "jobs": [ /* Generation job array */ ],
  "total": 42
}
```

## Export Endpoints

### `POST /api/v1/exports`

**Status**: INTERFACE ONLY

Start an export job.

**Request**:
```json
{
  "source_id": "movie_abc123|episode_abc123",
  "format": "mp4|mov|gif|png|webm",
  "quality": "high|medium|low"
}
```

**Response**:
```json
{
  "export_id": "export_abc123",
  "status": "pending",
  "format": "mp4",
  "created_at": "2024-01-01T00:00:00Z"
}
```

### `GET /api/v1/exports/:id`

**Status**: INTERFACE ONLY

Get export job status.

**Response**:
```json
{
  "export_id": "export_abc123",
  "status": "completed",
  "download_url": "https://...",
  "file_size": 1024000,
  "created_at": "2024-01-01T00:00:00Z",
  "completed_at": "2024-01-01T01:30:00Z"
}
```

## Error Codes

All errors include a standardized `code` field:

- `INVALID_INPUT` - Input validation failed
- `UNAUTHORIZED` - User not authenticated
- `FORBIDDEN` - User lacks required permissions
- `NOT_FOUND` - Resource not found
- `CONFLICT` - Resource conflict
- `RATE_LIMITED` - Rate limit exceeded
- `GENERATION_FAILED` - AI generation failed
- `EXPORT_FAILED` - Export failed
- `DELETE_FORBIDDEN` - Cannot delete resource
- `INVALID_MOVIE_DURATION` - Movie duration exceeds 5 hours
- `INVALID_SEASON_EPISODE_COUNT` - Season episode count invalid (not 10–24)
- `INVALID_EPISODE_DURATION` - Episode duration invalid (not 60 or 70 minutes)
- `UNAUTHORIZED_PROJECT_ACCESS` - User not authorized for project
- `RESOURCE_LOCKED` - Resource is locked for editing
- `QUOTA_EXCEEDED` - User quota exceeded

## Rate Limiting

**Status**: INTERFACE ONLY

Expected rate limits (to be finalized):

- Authentication endpoints: 10 req/minute
- API endpoints: 100 req/minute per user
- Generation endpoints: Custom limits per provider

All rate-limited responses include headers:
```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 95
X-RateLimit-Reset: 1234567890
```

## Pagination

List endpoints support:
- `limit`: Items per page (default 20, max 100)
- `offset`: Starting position (default 0)

Response:
```json
{
  "items": [],
  "total": 1000,
  "limit": 20,
  "offset": 0
}
```

## Request IDs

Every request receives a unique `request_id` for tracking:

```
X-Request-ID: req_abc123xyz
```

Used for:
- Error tracking
- Audit logging
- Debugging
