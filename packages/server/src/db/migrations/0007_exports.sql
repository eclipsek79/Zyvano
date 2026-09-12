-- 0007_exports.sql
-- Export (render) requests and the concrete files they produced.

CREATE TABLE exports (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  project_id      uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  requested_by    uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  status          text NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued', 'processing', 'completed', 'failed', 'cancelled')),
  progress        integer NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  preset          text NOT NULL,
  format          text NOT NULL DEFAULT 'mp4' CHECK (format IN ('mp4', 'webm')),
  resolution      text NOT NULL DEFAULT '1920x1080',
  include_audio   boolean NOT NULL DEFAULT true,
  error_code      text,
  error_message   text,
  -- Flipped to true only after the worker has confirmed the rendered object
  -- exists in storage. The API refuses to report completion before this is set.
  verified        boolean NOT NULL DEFAULT false,
  idempotency_key text,
  expires_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  started_at      timestamptz,
  finished_at     timestamptz,
  cancelled_at    timestamptz
);

CREATE UNIQUE INDEX exports_idempotency_unique
  ON exports (organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX exports_project_idx ON exports (project_id, created_at DESC);
CREATE INDEX exports_org_status_idx ON exports (organization_id, status);
CREATE INDEX exports_expiry_idx ON exports (expires_at) WHERE status = 'completed';

CREATE TABLE export_files (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  export_id        uuid NOT NULL REFERENCES exports (id) ON DELETE CASCADE,
  asset_id         uuid NOT NULL REFERENCES assets (id) ON DELETE CASCADE,
  kind             text NOT NULL CHECK (kind IN ('video', 'thumbnail', 'metadata', 'audio')),
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX export_files_export_idx ON export_files (export_id);

-- The jobs table declares export_id before exports exists, so the foreign key is
-- added now that both tables are present.
ALTER TABLE jobs
  ADD CONSTRAINT jobs_export_fk FOREIGN KEY (export_id) REFERENCES exports (id) ON DELETE CASCADE;

CREATE INDEX jobs_export_idx ON jobs (export_id);

-- The projects/scenes tables reference assets that are created later; wire those
-- foreign keys now (columns were plain uuid to avoid a circular creation order).
ALTER TABLE projects
  ADD CONSTRAINT projects_thumbnail_fk FOREIGN KEY (thumbnail_asset_id) REFERENCES assets (id) ON DELETE SET NULL;

ALTER TABLE scenes
  ADD CONSTRAINT scenes_preview_asset_fk FOREIGN KEY (preview_asset_id) REFERENCES assets (id) ON DELETE SET NULL;
