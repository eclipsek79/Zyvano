-- 0006_generations.sql
-- AI generation requests, their attempts, provider traffic records and jobs.

CREATE TABLE generations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  project_id       uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  scene_id         uuid REFERENCES scenes (id) ON DELETE SET NULL,
  requested_by     uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  kind             text NOT NULL CHECK (kind IN ('script', 'storyboard', 'scene', 'image', 'video', 'voice', 'audio')),
  capability       text NOT NULL CHECK (capability IN ('text', 'image', 'video', 'audio', 'voice')),
  provider         text,
  model            text,
  status           text NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('queued', 'processing', 'completed', 'failed', 'cancelled')),
  progress         integer NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  prompt           text,
  parameters       jsonb NOT NULL DEFAULT '{}'::jsonb,
  result           jsonb,
  output_asset_id  uuid REFERENCES assets (id) ON DELETE SET NULL,
  error_code       text,
  error_message    text,
  credits_used     integer NOT NULL DEFAULT 0,
  idempotency_key  text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  started_at       timestamptz,
  finished_at      timestamptz,
  cancelled_at     timestamptz
);

-- Idempotency: a caller may retry a request with the same key and receive the
-- original generation rather than paying for a duplicate provider call.
CREATE UNIQUE INDEX generations_idempotency_unique
  ON generations (organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX generations_project_idx ON generations (project_id, created_at DESC);
CREATE INDEX generations_org_status_idx ON generations (organization_id, status);
CREATE INDEX generations_status_idx ON generations (status) WHERE status IN ('queued', 'processing');
CREATE INDEX generations_scene_idx ON generations (scene_id);

-- Each attempt is a separate provider invocation, so retries are auditable.
CREATE TABLE generation_attempts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  generation_id       uuid NOT NULL REFERENCES generations (id) ON DELETE CASCADE,
  attempt_number      integer NOT NULL,
  provider            text NOT NULL,
  model               text,
  status              text NOT NULL CHECK (status IN ('queued', 'processing', 'completed', 'failed', 'cancelled')),
  latency_ms          integer,
  external_request_id text,
  error_code          text,
  error_message       text,
  request_payload     jsonb,
  response_summary    jsonb,
  started_at          timestamptz,
  finished_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT generation_attempts_unique UNIQUE (generation_id, attempt_number)
);

CREATE INDEX generation_attempts_generation_idx ON generation_attempts (generation_id, attempt_number);
CREATE INDEX generation_attempts_external_idx ON generation_attempts (external_request_id);

-- Raw provider traffic record, used for cost analysis and incident diagnosis.
CREATE TABLE provider_requests (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  generation_id       uuid REFERENCES generations (id) ON DELETE CASCADE,
  attempt_id          uuid REFERENCES generation_attempts (id) ON DELETE CASCADE,
  organization_id     uuid REFERENCES organizations (id) ON DELETE CASCADE,
  provider            text NOT NULL,
  capability          text NOT NULL,
  model               text,
  external_request_id text,
  status              text NOT NULL,
  http_status         integer,
  latency_ms          integer,
  input_units         integer,
  output_units        integer,
  credits             integer NOT NULL DEFAULT 0,
  error_code          text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX provider_requests_generation_idx ON provider_requests (generation_id);
CREATE INDEX provider_requests_org_idx ON provider_requests (organization_id, created_at DESC);

-- Durable mirror of queued jobs. Redis holds the live queue; this table lets the
-- UI show job state and lets operators replay dead-lettered work.
CREATE TABLE jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  queue           text NOT NULL,
  name            text NOT NULL,
  status          text NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued', 'processing', 'completed', 'failed', 'cancelled')),
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  progress        integer NOT NULL DEFAULT 0,
  attempts_made   integer NOT NULL DEFAULT 0,
  max_attempts    integer NOT NULL DEFAULT 5,
  organization_id uuid REFERENCES organizations (id) ON DELETE CASCADE,
  project_id      uuid REFERENCES projects (id) ON DELETE CASCADE,
  generation_id   uuid REFERENCES generations (id) ON DELETE CASCADE,
  export_id       uuid,
  bull_job_id     text,
  last_error      text,
  dedupe_key      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  started_at      timestamptz,
  finished_at     timestamptz
);

-- Deduplication: only one live job per (name, dedupe_key).
CREATE UNIQUE INDEX jobs_dedupe_unique
  ON jobs (name, dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'processing');

CREATE INDEX jobs_status_idx ON jobs (status, created_at);
CREATE INDEX jobs_generation_idx ON jobs (generation_id);
CREATE INDEX jobs_project_idx ON jobs (project_id, created_at DESC);
