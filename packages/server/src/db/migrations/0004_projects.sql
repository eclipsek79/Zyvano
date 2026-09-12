-- 0004_projects.sql
-- Projects (the central video-creation workspace) and their per-project members,
-- scripts, storyboards and scenes.

CREATE TABLE projects (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id        uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  owner_id               uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  name                   text NOT NULL,
  description            text,
  prompt                 text,
  status                 text NOT NULL DEFAULT 'draft'
                         CHECK (status IN ('draft', 'active', 'rendering', 'completed', 'archived', 'deleted')),
  aspect_ratio           text NOT NULL DEFAULT '16:9',
  target_duration_seconds integer,
  thumbnail_asset_id     uuid,
  settings               jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  deleted_at             timestamptz
);

CREATE INDEX projects_org_idx ON projects (organization_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX projects_owner_idx ON projects (owner_id);
CREATE INDEX projects_status_idx ON projects (status) WHERE deleted_at IS NULL;

-- Optional extra collaborators beyond their organization role.
CREATE TABLE project_members (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('owner', 'admin', 'editor', 'member', 'viewer')),
  added_by   uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_members_unique UNIQUE (project_id, user_id)
);

CREATE INDEX project_members_user_idx ON project_members (user_id);

-- Generated (or hand-written) scripts. Versioned so regeneration never destroys
-- a script the user edited.
CREATE TABLE scripts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id           uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  title                text NOT NULL,
  content              text NOT NULL,
  tone                 text,
  language             text NOT NULL DEFAULT 'en',
  version              integer NOT NULL DEFAULT 1,
  source_generation_id uuid,
  created_by           uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scripts_project_version_unique UNIQUE (project_id, version)
);

CREATE INDEX scripts_project_idx ON scripts (project_id, version DESC);

-- Storyboards hold an ordered shot list as JSONB; the individual scenes table
-- below is the executable representation used by the pipeline.
CREATE TABLE storyboards (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id           uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  title                text NOT NULL,
  shots                jsonb NOT NULL DEFAULT '[]'::jsonb,
  source_generation_id uuid,
  created_by           uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX storyboards_project_idx ON storyboards (project_id, created_at DESC);

CREATE TABLE scenes (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  order_index       integer NOT NULL DEFAULT 0,
  title             text NOT NULL,
  description       text,
  prompt            text,
  duration_seconds  numeric(6, 2) NOT NULL DEFAULT 5,
  status            text NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued', 'processing', 'completed', 'failed', 'cancelled')),
  preview_asset_id  uuid,
  metadata          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX scenes_project_order_idx ON scenes (project_id, order_index);
CREATE INDEX scenes_status_idx ON scenes (status);
