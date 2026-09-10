-- 0008_templates_usage_audit.sql
-- Templates, usage accounting, quotas, audit trail, notifications, API keys,
-- webhook records and deletion requests.

CREATE TABLE templates (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id          uuid REFERENCES organizations (id) ON DELETE CASCADE,
  name                     text NOT NULL,
  slug                     text NOT NULL,
  description              text,
  category                 text NOT NULL DEFAULT 'general',
  aspect_ratio             text NOT NULL DEFAULT '16:9',
  default_duration_seconds integer NOT NULL DEFAULT 30,
  definition               jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_system                boolean NOT NULL DEFAULT false,
  created_by               uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  deleted_at               timestamptz
);

-- System templates use a NULL organization_id, so uniqueness is enforced per
-- coalesced organization to avoid NULL-comparison surprises.
CREATE UNIQUE INDEX templates_slug_unique
  ON templates (COALESCE(organization_id, '00000000-0000-0000-0000-000000000000'::uuid), slug)
  WHERE deleted_at IS NULL;

CREATE INDEX templates_category_idx ON templates (category) WHERE deleted_at IS NULL;
CREATE INDEX templates_org_idx ON templates (organization_id) WHERE deleted_at IS NULL;

-- Immutable usage ledger. One row per metered provider call.
CREATE TABLE usage_records (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  user_id         uuid REFERENCES users (id) ON DELETE SET NULL,
  project_id      uuid REFERENCES projects (id) ON DELETE SET NULL,
  generation_id   uuid REFERENCES generations (id) ON DELETE SET NULL,
  capability      text NOT NULL CHECK (capability IN ('text', 'image', 'video', 'audio', 'voice')),
  provider        text NOT NULL,
  model           text,
  units           integer NOT NULL DEFAULT 0,
  credits         integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX usage_records_org_created_idx ON usage_records (organization_id, created_at DESC);
CREATE INDEX usage_records_project_idx ON usage_records (project_id, created_at DESC);
CREATE INDEX usage_records_generation_idx ON usage_records (generation_id);

-- Per-organization quota/billing window. Credits are decremented on metering.
CREATE TABLE usage_quotas (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  period_start    timestamptz NOT NULL,
  period_end      timestamptz NOT NULL,
  credits_granted integer NOT NULL DEFAULT 0,
  credits_used    integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT usage_quotas_period_unique UNIQUE (organization_id, period_start)
);

CREATE INDEX usage_quotas_org_idx ON usage_quotas (organization_id, period_end DESC);

-- Append-only audit trail. Metadata is JSONB and must never contain secrets —
-- callers pass values through the logger's redaction helper when in doubt.
CREATE TABLE audit_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations (id) ON DELETE SET NULL,
  actor_user_id   uuid REFERENCES users (id) ON DELETE SET NULL,
  actor_email     text,
  category        text NOT NULL CHECK (category IN
                    ('auth', 'authorization', 'project', 'generation', 'export', 'asset',
                     'destructive', 'admin', 'system')),
  action          text NOT NULL,
  resource_type   text,
  resource_id     uuid,
  ip_address      inet,
  user_agent      text,
  request_id      text,
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_events_org_created_idx ON audit_events (organization_id, created_at DESC);
CREATE INDEX audit_events_category_idx ON audit_events (category, created_at DESC);
CREATE INDEX audit_events_actor_idx ON audit_events (actor_user_id, created_at DESC);
CREATE INDEX audit_events_resource_idx ON audit_events (resource_type, resource_id);

CREATE TABLE notifications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  organization_id uuid REFERENCES organizations (id) ON DELETE CASCADE,
  type            text NOT NULL,
  title           text NOT NULL,
  body            text,
  resource_type   text,
  resource_id     uuid,
  read_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);
CREATE INDEX notifications_unread_idx ON notifications (user_id) WHERE read_at IS NULL;

-- Programmatic API keys. Only the hash is persisted; the plaintext key is shown
-- to its owner exactly once at creation time.
CREATE TABLE api_keys (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  created_by      uuid REFERENCES users (id) ON DELETE SET NULL,
  name            text NOT NULL,
  prefix          text NOT NULL,
  key_hash        text NOT NULL,
  scopes          text[] NOT NULL DEFAULT '{}',
  last_used_at    timestamptz,
  expires_at      timestamptz,
  revoked_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT api_keys_hash_unique UNIQUE (key_hash),
  CONSTRAINT api_keys_prefix_unique UNIQUE (prefix)
);

CREATE INDEX api_keys_org_idx ON api_keys (organization_id) WHERE revoked_at IS NULL;

-- Inbound webhook deliveries from providers (e.g. async render callbacks) are
-- recorded so duplicate/forged callbacks can be detected.
CREATE TABLE webhook_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider      text NOT NULL,
  external_id   text NOT NULL,
  signature     text,
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  processed_at  timestamptz,
  error_message text,
  received_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT webhook_events_unique UNIQUE (provider, external_id)
);

CREATE INDEX webhook_events_pending_idx ON webhook_events (received_at) WHERE processed_at IS NULL;

-- Explicit, auditable record of data-deletion work. The DeleteUserData job
-- consumes this table so deletion completes even across restarts.
CREATE TABLE deletion_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations (id) ON DELETE SET NULL,
  user_id         uuid REFERENCES users (id) ON DELETE SET NULL,
  project_id      uuid REFERENCES projects (id) ON DELETE SET NULL,
  scope           text NOT NULL CHECK (scope IN ('account', 'project', 'asset', 'export', 'organization')),
  reason          text,
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  node_count      integer NOT NULL DEFAULT 0,
  bytes_reclaimed bigint NOT NULL DEFAULT 0,
  attempts        integer NOT NULL DEFAULT 0,
  last_error      text,
  requested_by    uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  started_at      timestamptz,
  completed_at    timestamptz
);

CREATE INDEX deletion_requests_pending_idx ON deletion_requests (status, created_at);

-- Retention metadata: which objects are due for expiry and why.
CREATE TABLE retention_records (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_type text NOT NULL,
  resource_id   uuid NOT NULL,
  storage_keys  text[] NOT NULL DEFAULT '{}',
  expires_at    timestamptz NOT NULL,
  policy        text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  processed_at  timestamptz
);

CREATE INDEX retention_records_due_idx ON retention_records (expires_at) WHERE processed_at IS NULL;
CREATE INDEX retention_records_resource_idx ON retention_records (resource_type, resource_id);
