# Zyvano Architecture

## High-Level System Design

Zyvano is architected as a production-scale AI creative platform with clear separation of concerns:

```
User Interfaces (Web, Mobile, Desktop)
            ↓
    API Layer (v1)
            ↓
    Business Logic / Services
            ↓
    Database (PostgreSQL)
    Queue System (INTERFACE ONLY)
    External AI Providers (INTERFACE ONLY)
    Media Storage (INTERFACE ONLY)
```

## Core Principles

### 1. Provider Abstraction

All external AI services are abstracted behind provider interfaces:

```
Zyvano Core
    ↓
Provider Interface (e.g., VideoGenerationProvider)
    ↓
Concrete Adapter (e.g., ReplicateVideoAdapter, OpenAIVideoAdapter)
    ↓
External Service API
```

**Status**: INTERFACE ONLY in Phase 0

### 2. Long-Form Production Pipeline

Movies and episodes are NOT sent as single requests:

```
Production (Movie/Episode)
    ↓
Scenes (typically 5-20 per production)
    ↓
Shots (typically 3-10 per scene)
    ↓
Generation Jobs (one per shot, respecting provider limits)
    ↓
Generated Clips
    ↓
Scene Assembly
    ↓
Timeline Management
    ↓
Audio Integration
    ↓
Final Export
```

**Status**: INTERFACE ONLY in Phase 0

### 3. Queue & Worker Architecture

Async job processing with clear state transitions:

```
Job States: pending → queued → running → completed/failed
```

Worker implementations are idempotent and support bounded retries.

**Status**: INTERFACE ONLY in Phase 0

### 4. Authorization & Ownership

All resources are tied to owners. Destructive operations require authorization verification.

**Status**: IMPLEMENTED (enforced at API and database boundaries)

## Domain Models

### Users & Authentication

```
User
├── id (UUID)
├── email
├── name
├── created_at
└── updated_at

AuthAccount (supports multiple social providers)
├── user_id (FK)
├── provider (google, github, etc.)
├── provider_id
└── metadata

Session
├── user_id (FK)
├── token
├── expires_at
```

**Status**: INTERFACE ONLY (auth contracts defined, providers not yet integrated)

### Projects

```
Project
├── id (UUID)
├── owner_id (FK User)
├── title
├── description
├── status
├── created_at
├── updated_at

ProjectMember (for collaboration)
├── project_id (FK)
├── user_id (FK)
└── role (owner, editor, viewer)
```

**Status**: IMPLEMENTED (schema, contracts defined)

### Media Assets

```
MediaAsset (base type)
├── id (UUID)
├── project_id (FK)
├── owner_id (FK)
├── type (image, video, audio, avatar)
├── storage_location
├── metadata
└── created_at

Image
├── media_asset_id (FK)
├── width
├── height
├── format
└── generated_from

Video
├── media_asset_id (FK)
├── duration
├── resolution
├── fps
└── generated_from

Avatar
├── media_asset_id (FK)
├── avatar_model_id
└── customization_data
```

**Status**: INTERFACE ONLY (schema defined, storage backends not integrated)

### Scripts & Storytelling

```
Script
├── id (UUID)
├── project_id (FK)
├── owner_id (FK)
├── content (original user script)
├── status (approved, draft, in_review)
└── created_at

ScriptVersion
├── script_id (FK)
├── version_number
├── content (modified content)
├── change_type (ai_refinement, user_edit, etc.)
└── created_at

Character
├── id (UUID)
├── project_id (FK)
├── name
├── description
├── appearance
└── arc_summary

World
├── id (UUID)
├── project_id (FK)
├── name
├── description
├── rules
└── visual_style

Location
├── id (UUID)
├── world_id (FK)
├── name
├── description
└── visual_reference
```

**Status**: IMPLEMENTED (schema, contracts defined; AI integration INTERFACE ONLY)

### Movies & Series

```
Movie
├── id (UUID)
├── project_id (FK)
├── title
├── duration (max 5 hours)
├── genre
├── visual_style
├── status
└── created_at

Series
├── id (UUID)
├── project_id (FK)
├── title
├── premise
├── genre
├── visual_style
└── continuity_rules

Season
├── id (UUID)
├── series_id (FK)
├── number
├── title
├── episode_count (10-24)
├── episode_duration (1h or 1h10m)
└── status

Episode
├── id (UUID)
├── season_id (FK)
├── number
├── title
├── script_id (FK)
├── status
└── timeline_data

Scene
├── id (UUID)
├── episode_id (FK) or movie_id (FK)
├── sequence_number
├── description
├── characters (array of char refs)
├── location_id (FK)
└── duration_estimate

Shot
├── id (UUID)
├── scene_id (FK)
├── sequence_number
├── description
├── camera_direction
└── visual_style_override
```

**Status**: IMPLEMENTED (schema defined)

### Generation & Export

```
GenerationJob
├── id (UUID)
├── owner_id (FK)
├── type (video, image, avatar)
├── source_data (script, prompt, etc.)
├── status (pending → queued → running → completed/failed)
├── provider (openai, replicate, etc.)
├── created_at
└── updated_at

GenerationAttempt
├── job_id (FK)
├── attempt_number
├── status
├── error_reason
└── timestamp

Export
├── id (UUID)
├── project_id (FK)
├── owner_id (FK)
├── source_asset_id (FK)
├── format
├── status
├── created_at
├── completed_at
└── storage_location

ExportFile
├── export_id (FK)
├── file_path
├── file_size
└── mime_type
```

**Status**: IMPLEMENTED (schema defined; provider integration INTERFACE ONLY)

### Audit & Deletion

```
DeletionRequest
├── id (UUID)
├── requester_id (FK)
├── resource_type (user, project, asset, etc.)
├── resource_id
├── reason
├── status (pending, approved, executed, cancelled)
└── created_at

AuditLog
├── id (UUID)
├── user_id (FK)
├── resource_type
├── resource_id
├── action (create, update, delete, access)
├── details
└── timestamp
```

**Status**: IMPLEMENTED (schema defined)

## API Layer

All APIs follow REST conventions with versioned endpoints: `/api/v1/`

### Authentication Endpoints
- `POST /api/v1/auth/login` - INTERFACE ONLY
- `POST /api/v1/auth/logout` - INTERFACE ONLY
- `POST /api/v1/auth/refresh` - INTERFACE ONLY
- `GET /api/v1/auth/providers` - List available auth providers

### User Endpoints
- `GET /api/v1/users/me` - Get current user
- `PATCH /api/v1/users/me` - Update profile

### Project Endpoints
- `GET /api/v1/projects` - List user projects
- `POST /api/v1/projects` - Create project
- `GET /api/v1/projects/:id` - Get project details
- `PATCH /api/v1/projects/:id` - Update project
- `DELETE /api/v1/projects/:id` - Delete project

### Script Endpoints
- `POST /api/v1/projects/:projectId/scripts` - Create/upload script
- `GET /api/v1/scripts/:id` - Get script
- `POST /api/v1/scripts/:id/refine` - Refine script (creates new version)
- `GET /api/v1/scripts/:id/versions` - List script versions

### Movie Endpoints
- `POST /api/v1/projects/:projectId/movies` - Create movie
- `GET /api/v1/movies/:id` - Get movie details
- `PATCH /api/v1/movies/:id` - Update movie
- `DELETE /api/v1/movies/:id` - Delete movie

### Series Endpoints
- `POST /api/v1/projects/:projectId/series` - Create series
- `GET /api/v1/series/:id` - Get series details
- `POST /api/v1/series/:id/seasons` - Add season
- `POST /api/v1/seasons/:id/episodes` - Add episodes

### Generation Endpoints
- `POST /api/v1/generations` - Start generation job
- `GET /api/v1/generations/:id` - Get job status
- `GET /api/v1/generations` - List user jobs

### Export Endpoints
- `POST /api/v1/exports` - Start export
- `GET /api/v1/exports/:id` - Get export status
- `GET /api/v1/exports` - List user exports

**Status**: INTERFACE ONLY (endpoint contracts defined, implementations pending)

## Provider Architecture

### Video Generation Provider

```typescript
interface VideoGenerationProvider {
  name: string;
  maxDuration: Duration; // e.g., 60 seconds
  supportedFormats: string[];
  supportedResolutions: Resolution[];
  
  generateFromText(prompt: string, options: GenerationOptions): Promise<Video>;
  generateFromScript(script: Script, options: GenerationOptions): Promise<Video[]>;
  // Returns array of clips matching shot-level granularity
}
```

**Status**: INTERFACE ONLY

### Image Generation Provider

```typescript
interface ImageGenerationProvider {
  name: string;
  maxResolution: Resolution;
  
  generateFromText(prompt: string, style?: string): Promise<Image>;
  generateFromImage(source: Image, modifications: string): Promise<Image>;
  generateCharacter(description: Character): Promise<Image>;
  generateEnvironment(description: World): Promise<Image>;
}
```

**Status**: INTERFACE ONLY

### Avatar Provider

```typescript
interface AvatarGenerationProvider {
  name: string;
  
  createFromText(description: string): Promise<Avatar>;
  createFromImage(source: Image): Promise<Avatar>;
  animate(avatar: Avatar, animation: AnimationRequest): Promise<Video>;
  generateSpeech(avatar: Avatar, text: string, voice: string): Promise<Audio>;
}
```

**Status**: INTERFACE ONLY

### Other Providers

- **ImageEditingProvider** - INTERFACE ONLY
- **VideoEditingProvider** - INTERFACE ONLY
- **AudioGenerationProvider** - INTERFACE ONLY
- **MusicGenerationProvider** - INTERFACE ONLY
- **ModerationProvider** - INTERFACE ONLY

All provider implementations will be added in Phase 1+.

## Queue & Worker System

### Job States

```
PENDING → QUEUED → RUNNING → COMPLETED
              ↓                    ↓
           FAILED ←→ RETRYING → COMPLETED
              ↓
           CANCELLED
```

### Worker Contract

```typescript
interface Worker {
  processJob(job: QueueJob): Promise<JobResult>;
  // Must be idempotent
  // Retries are bounded (e.g., max 3 attempts)
}
```

**Status**: INTERFACE ONLY (local implementations for testing, distributed queues deferred)

## Validation

### Business Rule Validation

- **Movie Duration**: ≤ 5 hours
- **Series Episode Count**: 10-24 per season
- **Episode Duration**: 1h or 1h10m
- **Ownership**: All resource access requires ownership verification
- **Project Membership**: Editing requires project membership

### Input Validation

- JSON Schema validation at API boundaries
- Type checking via TypeScript
- Database constraint validation

**Status**: PARTIALLY IMPLEMENTED (schemas defined, some validation logic implemented)

## Error Handling

All API errors follow structured format:

```json
{
  "code": "INVALID_MOVIE_DURATION",
  "message": "Movie duration exceeds 5 hours",
  "request_id": "req_abc123",
  "details": {
    "provided": "6h",
    "maximum": "5h"
  }
}
```

Standard error codes:
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
- `INVALID_SEASON_EPISODE_COUNT` - Season episode count invalid
- `INVALID_EPISODE_DURATION` - Episode duration invalid

**Status**: IMPLEMENTED (contract defined, propagation in progress)

## Security Baseline

- Environment variable configuration (no hardcoded secrets)
- Request ID tracking for audit trails
- Ownership verification on all mutations
- Input validation at API boundaries
- SQL parameterization (SQLAlchemy ORM)
- CORS configuration (to be finalized)
- Rate limiting (contract defined, implementation deferred)

**Status**: PARTIALLY IMPLEMENTED

## Database

### Technology
- **PostgreSQL** (primary database)
- **SQLAlchemy** (ORM)
- **Alembic** (migrations)

### Migrations Location
`database/migrations/versions/`

### Strategy
- Migrations are committed to Git
- Never modify an already-applied migration
- Create new migrations for schema changes
- All migrations are reversible

**Status**: IMPLEMENTED (framework in place, schemas to be migrated)

## Deployment Architecture

### Phase 0
- Local development environment
- Docker Compose for local PostgreSQL + Redis (INTERFACE ONLY)
- No production deployment

### Future Phases
- Kubernetes orchestration
- Cloud storage integration (S3, GCS)
- CDN integration
- GPU rendering infrastructure

**Status**: INTERFACE ONLY

## Monorepo Structure

```
Zyvano/
├── apps/
│   ├── web/                    # Next.js web app
│   ├── mobile/                 # React Native/Expo
│   └── desktop/                # Tauri desktop
├── backend/                    # Python FastAPI
├── packages/                   # Shared libraries
│   ├── types/                  # TypeScript definitions
│   ├── validation/             # Validation schemas
│   ├── config/                 # Configuration
│   ├── shared/                 # Utilities
│   ├── ui/                     # React components
│   ├── api-client/             # API client
│   └── media-contracts/        # Provider interfaces
├── database/                   # Migrations
├── infrastructure/             # Docker, deployment
├── scripts/                    # Validation tooling
└── docs/                       # Documentation
```

### Dependency Ownership
- Root: Only monorepo tooling
- Apps: Own their dependencies
- Packages: Own their dependencies
- Backend: Manages Python deps via `pyproject.toml`
- Desktop: Manages Rust deps via `Cargo.toml`

## Implementation Roadmap

### Phase 0 (Current)
✅ Repository foundation
✅ API contracts
✅ Database schemas
✅ Provider interfaces
✅ Validation infrastructure

### Phase 1
- External AI provider integrations
- Authentication provider implementation
- Queue system (Redis/Bull or similar)
- Media storage backends
- Job processing workers

### Phase 2
- Advanced features (branching, collaboration)
- Performance optimization
- Distributed rendering

### Phase 3+
- Mobile app finalization
- Desktop app finalization
- Production deployment infrastructure
