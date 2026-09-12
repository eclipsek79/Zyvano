-- 0009_generation_credit_reservation.sql
--
-- Records the credits reserved at dispatch time so that a failed provider call can
-- return exactly what was withheld. Without this column the ledger could only be
-- guessed at settle time, and a partial refund would be indistinguishable from a
-- mis-billed charge.

ALTER TABLE generations
  ADD COLUMN credits_reserved integer NOT NULL DEFAULT 0
  CHECK (credits_reserved >= 0);

COMMENT ON COLUMN generations.credits_reserved IS
  'Credits withheld from the organization quota when the generation was queued.';

COMMENT ON COLUMN generations.credits_used IS
  'Credits actually billed by the provider, written when the generation settles.';
