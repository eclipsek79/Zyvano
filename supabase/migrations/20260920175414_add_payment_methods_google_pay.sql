-- Zyvano payment-method foundation: provider-agnostic payment records with Google Pay support.
-- Google Pay is represented as a payment method; no payment is marked successful
-- until a trusted provider webhook/verification path confirms it.

CREATE TYPE public.payment_method AS ENUM (
  'mpesa', 'card', 'google_pay', 'apple_pay', 'paypal', 'bank_transfer'
);

CREATE TYPE public.payment_status AS ENUM (
  'pending', 'requires_action', 'succeeded', 'failed', 'cancelled',
  'refunded', 'partially_refunded'
);

CREATE TABLE public.payments (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  user_id uuid NOT NULL,
  provider text NOT NULL,
  payment_method public.payment_method NOT NULL,
  status public.payment_status NOT NULL DEFAULT 'pending',
  currency text NOT NULL,
  amount_minor bigint NOT NULL,
  credits integer NULL,
  provider_payment_id text NULL,
  idempotency_key text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz NULL,
  CONSTRAINT payments_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE,
  CONSTRAINT payments_amount_minor_check CHECK (amount_minor > 0),
  CONSTRAINT payments_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT payments_credits_check CHECK (credits IS NULL OR credits > 0),
  CONSTRAINT payments_provider_check CHECK (char_length(provider) >= 1 AND char_length(provider) <= 50),
  CONSTRAINT payments_provider_payment_id_check CHECK (provider_payment_id IS NULL OR char_length(provider_payment_id) >= 1),
  CONSTRAINT payments_idempotency_key_check CHECK (char_length(idempotency_key) >= 1 AND char_length(idempotency_key) <= 255),
  CONSTRAINT uq_payments_user_idempotency UNIQUE (user_id, idempotency_key),
  CONSTRAINT uq_payments_provider_payment_id UNIQUE (provider, provider_payment_id)
);

CREATE INDEX payments_user_id_idx ON public.payments(user_id);
CREATE INDEX payments_status_idx ON public.payments(status);
CREATE INDEX payments_created_at_idx ON public.payments(created_at);

ALTER TABLE public.credit_ledger_entries
  ADD COLUMN payment_id uuid NULL,
  ADD CONSTRAINT credit_ledger_entries_payment_id_fkey
    FOREIGN KEY (payment_id) REFERENCES public.payments(id) ON DELETE RESTRICT;

CREATE INDEX credit_ledger_entries_payment_id_idx
  ON public.credit_ledger_entries(payment_id)
  WHERE payment_id IS NOT NULL;

ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users can view their own payments"
  ON public.payments FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = user_id);

COMMENT ON TYPE public.payment_method IS
  'Supported Zyvano checkout methods. google_pay is the Google Pay wallet option.';

COMMENT ON TABLE public.payments IS
  'Authoritative payment records. Credits must only be granted after trusted provider verification/webhook processing.';
