-- 0003_organizations.sql
-- Organizations (workspaces), memberships, and per-organization invitations.

CREATE TABLE organizations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  slug       text NOT NULL,
  owner_id   uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  settings   jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT organizations_slug_unique UNIQUE (slug)
);

CREATE INDEX organizations_owner_idx ON organizations (owner_id);

-- Membership is the anchor of authorization: every protected resource is reached
-- through an organization and the caller's role in it.
CREATE TABLE organization_members (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role            text NOT NULL CHECK (role IN ('owner', 'admin', 'editor', 'member', 'viewer')),
  invited_by      uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organization_members_unique UNIQUE (organization_id, user_id)
);

CREATE INDEX organization_members_user_idx ON organization_members (user_id);
CREATE INDEX organization_members_org_role_idx ON organization_members (organization_id, role);

-- Pending invitations. Acceptance creates the membership row above.
CREATE TABLE organization_invitations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  email           citext NOT NULL,
  role            text NOT NULL CHECK (role IN ('admin', 'editor', 'member', 'viewer')),
  token_hash      text NOT NULL,
  invited_by      uuid REFERENCES users (id) ON DELETE SET NULL,
  expires_at      timestamptz NOT NULL,
  accepted_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organization_invitations_unique UNIQUE (organization_id, email),
  CONSTRAINT organization_invitations_token_unique UNIQUE (token_hash)
);

CREATE INDEX organization_invitations_email_idx ON organization_invitations (email);
