-- 0005_assets.sql
-- Media assets. Binary content lives in object storage; this table stores the
-- authoritative metadata plus the storage key. No media bytes are ever stored in
-- the database.

CREATE TABLE assets (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  project_id       uuid REFERENCES projects (id) ON DELETE CASCADE,
  owner_id         uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  kind             text NOT NULL CHECK (kind IN ('image', 'video', 'audio', 'document', 'other')),
  source           text NOT NULL CHECK (source IN ('upload', 'generated', 'system')),
  filename         text NOT NULL,
  mime_type        text NOT NULL,
  size_bytes       bigint NOT NULL CHECK (size_bytes >= 0),
  storage_key      text NOT NULL,
  thumbnail_key    text,
  width            integer,
  height           integer,
  duration_seconds numeric(10, 3),
  checksum         text,
  metadata         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  CONSTRAINT assets_storage_key_unique UNIQUE (storage_key)
);

CREATE INDEX assets_org_idx ON assets (organization_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX assets_project_idx ON assets (project_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX assets_kind_idx ON assets (organization_id, kind) WHERE deleted_at IS NULL;
CREATE INDEX assets_owner_idx ON assets (owner_id);

-- Assets scheduled for storage deletion. Keeping the intent in the database lets
-- the cleanup worker finish the job even if the process dies mid-delete.
CREATE TABLE asset_deletions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id     uuid NOT NULL REFERENCES assets (id) ON DELETE CASCADE,
  storage_keys text[] NOT NULL,
  requested_by uuid REFERENCES users (id) ON DELETE SET NULL,
  attempts     integer NOT NULL DEFAULT 0,
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX asset_deletions_pending_idx ON asset_deletions (created_at) WHERE completed_at IS NULL;
