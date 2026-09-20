-- Zyvano credits/entitlements foundation.
-- Canonical schema snapshot of Supabase migration
-- 20260920155506_create_credits_entitlements_foundation.
-- This file is intentionally kept byte-for-byte equivalent in schema intent
-- to the database that was already applied to the Zyvano Supabase project.

CREATE TYPE public.plan_code AS ENUM (
  'free',
  'premium'
);

CREATE TYPE public.ledger_entry_type AS ENUM (
  'free_plan_grant',
  'promotional_grant',
  'purchase',
  'reserve',
  'release',
  'refund',
  'admin_adjustment',
  'expiration'
);

CREATE TYPE public.reservation_status AS ENUM (
  'pending',
  'finalized',
  'released',
  'partially_refunded'
);

CREATE TABLE public.plans (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  code public.plan_code NOT NULL UNIQUE,
  name text NOT NULL,
  max_resolution text NOT NULL DEFAULT '1080p',
  allows_desktop_only_resolutions boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT plans_name_check CHECK (char_length(name) >= 1 AND char_length(name) <= 100),
  CONSTRAINT plans_max_resolution_check CHECK (
    max_resolution = ANY (
      ARRAY['480p','720p','1080p','2k','4k','8k','12k','16k','24k']::text[]
    )
  )
);

CREATE TABLE public.user_plans (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE,
  plan_id uuid NOT NULL,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_plans_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE,
  CONSTRAINT user_plans_plan_id_fkey
    FOREIGN KEY (plan_id) REFERENCES public.plans(id) ON DELETE RESTRICT
);

CREATE INDEX user_plans_plan_id_idx ON public.user_plans(plan_id);

CREATE TABLE public.user_credit_balances (
  user_id uuid PRIMARY KEY,
  balance integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_credit_balances_balance_check CHECK (balance >= 0),
  CONSTRAINT user_credit_balances_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
);

CREATE TABLE public.credit_ledger_entries (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  user_id uuid NOT NULL,
  entry_type public.ledger_entry_type NOT NULL,
  amount integer NOT NULL,
  reason text NOT NULL,
  status public.reservation_status NULL,
  job_id uuid NULL,
  related_entry_id uuid NULL,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_ledger_user_idempotency UNIQUE (user_id, idempotency_key),
  CONSTRAINT credit_ledger_entries_amount_check CHECK (amount <> 0),
  CONSTRAINT credit_ledger_entries_reason_check CHECK (
    char_length(reason) >= 1 AND char_length(reason) <= 255
  ),
  CONSTRAINT credit_ledger_entries_idempotency_key_check CHECK (
    char_length(idempotency_key) >= 1 AND char_length(idempotency_key) <= 255
  ),
  CONSTRAINT credit_ledger_reserve_amount_check CHECK (
    entry_type <> 'reserve' OR amount < 0
  ),
  CONSTRAINT credit_ledger_release_refund_amount_check CHECK (
    entry_type NOT IN ('release','refund') OR amount > 0
  ),
  CONSTRAINT credit_ledger_reservation_status_check CHECK (
    status IS NULL OR entry_type = 'reserve'
  ),
  CONSTRAINT credit_ledger_entries_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE,
  CONSTRAINT credit_ledger_entries_related_entry_id_fkey
    FOREIGN KEY (related_entry_id)
    REFERENCES public.credit_ledger_entries(id) ON DELETE RESTRICT
);

CREATE INDEX credit_ledger_entries_user_id_idx
  ON public.credit_ledger_entries(user_id);

CREATE INDEX credit_ledger_entries_created_at_idx
  ON public.credit_ledger_entries(created_at);

CREATE INDEX credit_ledger_entries_job_id_idx
  ON public.credit_ledger_entries(job_id)
  WHERE job_id IS NOT NULL;

CREATE INDEX credit_ledger_entries_related_entry_id_idx
  ON public.credit_ledger_entries(related_entry_id)
  WHERE related_entry_id IS NOT NULL;

ALTER TABLE public.plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_credit_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credit_ledger_entries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "authenticated users can view plans"
  ON public.plans
  FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "users can view their own plan"
  ON public.user_plans
  FOR SELECT
  TO authenticated
  USING ((SELECT auth.uid()) = user_id);

CREATE POLICY "users can view their own credit balance"
  ON public.user_credit_balances
  FOR SELECT
  TO authenticated
  USING ((SELECT auth.uid()) = user_id);

CREATE POLICY "users can view their own credit ledger"
  ON public.credit_ledger_entries
  FOR SELECT
  TO authenticated
  USING ((SELECT auth.uid()) = user_id);

INSERT INTO public.plans (
  code, name, max_resolution, allows_desktop_only_resolutions
)
VALUES
  ('free', 'Free', '1080p', false),
  ('premium', 'Premium', '24k', true)
ON CONFLICT (code) DO UPDATE
SET
  name = EXCLUDED.name,
  max_resolution = EXCLUDED.max_resolution,
  allows_desktop_only_resolutions = EXCLUDED.allows_desktop_only_resolutions;
