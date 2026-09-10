# Database Schema & Migrations

## Overview

Zyvano uses PostgreSQL as the primary database with SQLAlchemy ORM and Alembic for schema migrations.

**Location**: `database/migrations/versions/`

**Tool Configuration**: `database/alembic.ini`

## Migration Strategy

### Rules

1. **Never modify applied migrations** - Create new migrations for schema changes
2. **All migrations are committed to Git** - History is part of the repository
3. **Migrations must be reversible** - Always include `downgrade()`
4. **One logical change per migration** - Keep migrations focused

### Creating Migrations

```bash
# Generate migration
alembic revision --autogenerate -m "Add users table"

# Apply migrations
alembic upgrade head

# Rollback one migration
alembic downgrade -1
```

## Core Tables

### users

```sql
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) NOT NULL UNIQUE,
    name VARCHAR(255),
    avatar_url TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP
);
```

**Status**: SCHEMA DEFINED

### auth_accounts

Supports multi-provider authentication (Google, GitHub, etc.)

```sql
CREATE TABLE auth_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider VARCHAR(50) NOT NULL,
    provider_id VARCHAR(255) NOT NULL,
    metadata JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(provider, provider_id)
);
```

**Status**: SCHEMA DEFINED | PROVIDER INTEGRATION: INTERFACE ONLY

### sessions

```sql
CREATE TABLE sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token VARCHAR(1024) NOT NULL UNIQUE,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP
);

CREATE INDEX idx_sessions_user_id ON sessions(user_id);
CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);
```

**Status**: SCHEMA DEFINED

### projects

```sql
CREATE TABLE projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    status VARCHAR(50) DEFAULT 'in_progress',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP
);

CREATE INDEX idx_projects_owner_id ON projects(owner_id);
```

**Status**: SCHEMA DEFINED

### project_members

Enables multi-user collaboration on projects.

```sql
CREATE TABLE project_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role VARCHAR(50) NOT NULL DEFAULT 'viewer',
    invited_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    accepted_at TIMESTAMP,
    UNIQUE(project_id, user_id)
);

CREATE INDEX idx_project_members_user_id ON project_members(user_id);
```

**Status**: SCHEMA DEFINED

### scripts

```sql
CREATE TABLE scripts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    status VARCHAR(50) DEFAULT 'draft',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP
);

CREATE INDEX idx_scripts_project_id ON scripts(project_id);
CREATE INDEX idx_scripts_owner_id ON scripts(owner_id);
```

**Status**: SCHEMA DEFINED

### script_versions

All script modifications create a new version. Original user scripts are never overwritten.

```sql
CREATE TABLE script_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    script_id UUID NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
    version_number INTEGER NOT NULL,
    content TEXT NOT NULL,
    change_type VARCHAR(50),
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(script_id, version_number)
);

CREATE INDEX idx_script_versions_script_id ON script_versions(script_id);
```

**Status**: SCHEMA DEFINED

### characters

```sql
CREATE TABLE characters (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    appearance TEXT,
    arc_summary TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP
);

CREATE INDEX idx_characters_project_id ON characters(project_id);
```

**Status**: SCHEMA DEFINED

### worlds

```sql
CREATE TABLE worlds (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    rules TEXT,
    visual_style TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP
);

CREATE INDEX idx_worlds_project_id ON worlds(project_id);
```

**Status**: SCHEMA DEFINED

### locations

```sql
CREATE TABLE locations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    world_id UUID NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    visual_reference TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP
);

CREATE INDEX idx_locations_world_id ON locations(world_id);
```

**Status**: SCHEMA DEFINED

### movies

```sql
CREATE TABLE movies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    script_id UUID REFERENCES scripts(id),
    title VARCHAR(255) NOT NULL,
    duration_seconds INTEGER,
    genre VARCHAR(100),
    visual_style VARCHAR(100),
    tone VARCHAR(100),
    status VARCHAR(50) DEFAULT 'draft',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP
);

CREATE INDEX idx_movies_project_id ON movies(project_id);
CREATE INDEX idx_movies_owner_id ON movies(owner_id);

-- Constraint: duration <= 5 hours (18000 seconds)
ALTER TABLE movies
ADD CONSTRAINT check_movie_duration CHECK (duration_seconds IS NULL OR duration_seconds <= 18000);
```

**Status**: SCHEMA DEFINED

### series

```sql
CREATE TABLE series (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    premise TEXT,
    genre VARCHAR(100),
    visual_style VARCHAR(100),
    continuity_rules TEXT,
    status VARCHAR(50) DEFAULT 'draft',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP
);

CREATE INDEX idx_series_project_id ON series(project_id);
CREATE INDEX idx_series_owner_id ON series(owner_id);
```

**Status**: SCHEMA DEFINED

### seasons

Season-level settings are separate from series-level settings.

```sql
CREATE TABLE seasons (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    series_id UUID NOT NULL REFERENCES series(id) ON DELETE CASCADE,
    season_number INTEGER NOT NULL,
    title VARCHAR(255),
    episode_count INTEGER NOT NULL,
    episode_duration_minutes INTEGER NOT NULL,
    synopsis TEXT,
    story_arc TEXT,
    status VARCHAR(50) DEFAULT 'draft',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(series_id, season_number)
);

CREATE INDEX idx_seasons_series_id ON seasons(series_id);

-- Constraint: episode_count between 10 and 24
ALTER TABLE seasons
ADD CONSTRAINT check_episode_count CHECK (episode_count >= 10 AND episode_count <= 24);

-- Constraint: episode_duration_minutes is 60 or 70
ALTER TABLE seasons
ADD CONSTRAINT check_episode_duration CHECK (episode_duration_minutes IN (60, 70));
```

**Status**: SCHEMA DEFINED

### episodes

```sql
CREATE TABLE episodes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    season_id UUID NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
    episode_number INTEGER NOT NULL,
    title VARCHAR(255),
    script_id UUID REFERENCES scripts(id),
    timeline_data JSONB,
    status VARCHAR(50) DEFAULT 'draft',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(season_id, episode_number)
);

CREATE INDEX idx_episodes_season_id ON episodes(season_id);
CREATE INDEX idx_episodes_script_id ON episodes(script_id);
```

**Status**: SCHEMA DEFINED

### scenes

```sql
CREATE TABLE scenes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    episode_id UUID REFERENCES episodes(id) ON DELETE CASCADE,
    movie_id UUID REFERENCES movies(id) ON DELETE CASCADE,
    sequence_number INTEGER NOT NULL,
    description TEXT,
    location_id UUID REFERENCES locations(id),
    character_ids UUID[] DEFAULT ARRAY[]::UUID[],
    duration_estimate_seconds INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CHECK ((episode_id IS NOT NULL AND movie_id IS NULL) OR (episode_id IS NULL AND movie_id IS NOT NULL))
);

CREATE INDEX idx_scenes_episode_id ON scenes(episode_id);
CREATE INDEX idx_scenes_movie_id ON scenes(movie_id);
```

**Status**: SCHEMA DEFINED

### shots

```sql
CREATE TABLE shots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scene_id UUID NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
    sequence_number INTEGER NOT NULL,
    description TEXT,
    camera_direction VARCHAR(255),
    visual_style_override VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_shots_scene_id ON shots(scene_id);
```

**Status**: SCHEMA DEFINED

### media_assets

Base table for all generated media (images, videos, audio, avatars).

```sql
CREATE TABLE media_assets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type VARCHAR(50) NOT NULL,
    storage_location TEXT,
    metadata JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP
);

CREATE INDEX idx_media_assets_project_id ON media_assets(project_id);
CREATE INDEX idx_media_assets_owner_id ON media_assets(owner_id);
CREATE INDEX idx_media_assets_type ON media_assets(type);
```

**Status**: SCHEMA DEFINED

### images

```sql
CREATE TABLE images (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    media_asset_id UUID NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
    width INTEGER,
    height INTEGER,
    format VARCHAR(50),
    generated_from JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_images_media_asset_id ON images(media_asset_id);
```

**Status**: SCHEMA DEFINED

### videos

```sql
CREATE TABLE videos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    media_asset_id UUID NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
    duration_seconds FLOAT,
    resolution VARCHAR(50),
    fps INTEGER,
    generated_from JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_videos_media_asset_id ON videos(media_asset_id);
```

**Status**: SCHEMA DEFINED

### avatars

```sql
CREATE TABLE avatars (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    media_asset_id UUID NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
    avatar_model_id VARCHAR(255),
    customization_data JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_avatars_media_asset_id ON avatars(media_asset_id);
```

**Status**: SCHEMA DEFINED

### generation_jobs

```sql
CREATE TABLE generation_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type VARCHAR(50) NOT NULL,
    source_data JSONB NOT NULL,
    provider VARCHAR(100),
    status VARCHAR(50) DEFAULT 'pending',
    attempts INTEGER DEFAULT 0,
    max_attempts INTEGER DEFAULT 3,
    result_asset_id UUID REFERENCES media_assets(id),
    error_reason TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_generation_jobs_owner_id ON generation_jobs(owner_id);
CREATE INDEX idx_generation_jobs_status ON generation_jobs(status);
```

**Status**: SCHEMA DEFINED

### generation_attempts

Track individual generation attempts for debugging.

```sql
CREATE TABLE generation_attempts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id UUID NOT NULL REFERENCES generation_jobs(id) ON DELETE CASCADE,
    attempt_number INTEGER NOT NULL,
    status VARCHAR(50) NOT NULL,
    error_reason TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_generation_attempts_job_id ON generation_attempts(job_id);
```

**Status**: SCHEMA DEFINED

### exports

```sql
CREATE TABLE exports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source_asset_id UUID REFERENCES media_assets(id),
    format VARCHAR(50) NOT NULL,
    quality VARCHAR(50),
    status VARCHAR(50) DEFAULT 'pending',
    storage_location TEXT,
    file_size BIGINT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP,
    failure_reason TEXT
);

CREATE INDEX idx_exports_project_id ON exports(project_id);
CREATE INDEX idx_exports_owner_id ON exports(owner_id);
CREATE INDEX idx_exports_status ON exports(status);
```

**Status**: SCHEMA DEFINED

### export_files

```sql
CREATE TABLE export_files (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    export_id UUID NOT NULL REFERENCES exports(id) ON DELETE CASCADE,
    file_path TEXT NOT NULL,
    file_size BIGINT,
    mime_type VARCHAR(100),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_export_files_export_id ON export_files(export_id);
```

**Status**: SCHEMA DEFINED

### deletion_requests

All destructive operations go through a deletion request workflow.

```sql
CREATE TABLE deletion_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    requester_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    resource_type VARCHAR(100) NOT NULL,
    resource_id UUID NOT NULL,
    reason TEXT,
    status VARCHAR(50) DEFAULT 'pending',
    approved_by UUID REFERENCES users(id),
    approved_at TIMESTAMP,
    executed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_deletion_requests_requester_id ON deletion_requests(requester_id);
CREATE INDEX idx_deletion_requests_status ON deletion_requests(status);
```

**Status**: SCHEMA DEFINED

### audit_logs

Track all significant actions for compliance and debugging.

```sql
CREATE TABLE audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id),
    resource_type VARCHAR(100),
    resource_id UUID,
    action VARCHAR(50),
    details JSONB,
    request_id VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_audit_logs_user_id ON audit_logs(user_id);
CREATE INDEX idx_audit_logs_resource_type_id ON audit_logs(resource_type, resource_id);
CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at);
```

**Status**: SCHEMA DEFINED

## Migration Directory Structure

```
database/migrations/
├── env.py
├── script.py.mako
├── alembic.ini
└── versions/
    ├── 001_init_users_auth.py
    ├── 002_init_projects.py
    ├── 003_init_scripts.py
    ├── 004_init_characters_worlds.py
    ├── 005_init_movies.py
    ├── 006_init_series.py
    ├── 007_init_media_assets.py
    ├── 008_init_generation.py
    ├── 009_init_exports.py
    └── 010_init_audit.py
```

## Database Constraints Summary

| Table | Constraint | Rule |
|-------|-----------|------|
| movies | check_movie_duration | duration_seconds ≤ 18000 (5 hours) |
| seasons | check_episode_count | 10 ≤ episode_count ≤ 24 |
| seasons | check_episode_duration | episode_duration_minutes IN (60, 70) |
| scenes | check_source | (episode_id XOR movie_id) |

## Indexes for Performance

All tables include appropriate indexes on:
- Foreign keys (for JOINs)
- Status columns (for filtering)
- User IDs (for authorization checks)
- Created/Updated timestamps (for sorting)

## Future Considerations

- Partitioning by `created_at` for large tables (generation_jobs, audit_logs)
- Read replicas for analytics queries
- Materialized views for reporting
- Full-text search on script content
- Vector columns for embedding storage (AI integration phase)
