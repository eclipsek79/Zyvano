-- 0002_identity.sql
-- Users, credentials, sessions and single-use security tokens.

CREATE TABLE users (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email             citext NOT NULL,
  display_name      text NOT NULL,
  avatar_url        text,
  password_hash     text NOT NULL,
  email_verified_at timestamptz,
  last_login_at     timestamptz,
  failed_login_count integer NOT NULL DEFAULT 0,
  locked_until      timestamptz,
  status            text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'suspended', 'deleted')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz,
  CONSTRAINT users_email_unique UNIQUE (email)
);

CREATE INDEX users_status_idx ON users (status) WHERE deleted_at IS NULL;

-- Sessions are stored as a hash of the opaque session token. The raw token only
-- ever exists in the user's cookie, so a database leak cannot be replayed.
CREATE TABLE sessions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash         text NOT NULL,
  csrf_token_hash    text NOT NULL,
  user_agent         text,
  ip_address         inet,
  created_at         timestamptz NOT NULL DEFAULT now(),
  last_used_at       timestamptz NOT NULL DEFAULT now(),
  rotated_at         timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL,
  revoked_at         timestamptz,
  CONSTRAINT sessions_token_hash_unique UNIQUE (token_hash)
);

CREATE INDEX sessions_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

-- Email verification and password reset tokens. Only hashes are stored; tokens
-- are single-use and time-boxed.
CREATE TABLE auth_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('email_verification', 'password_reset')),
  token_hash  text NOT NULL,
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT auth_tokens_token_hash_unique UNIQUE (token_hash)
);

CREATE INDEX auth_tokens_user_kind_idx ON auth_tokens (user_id, kind) WHERE consumed_at IS NULL;
CREATE INDEX auth_tokens_expires_idx ON auth_tokens (expires_at);

-- Throttling ledger for sensitive endpoints (login, password reset). Kept in the
-- database so limits survive process restarts and apply across API replicas.
CREATE TABLE auth_attempts (
  id          bigserial PRIMARY KEY,
  identifier  text NOT NULL,
  action      text NOT NULL,
  succeeded   boolean NOT NULL,
  ip_address  inet,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX auth_attempts_identifier_idx ON auth_attempts (identifier, action, created_at DESC);
