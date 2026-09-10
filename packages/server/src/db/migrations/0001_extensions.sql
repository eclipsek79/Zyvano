-- 0001_extensions.sql
-- Baseline extensions. gen_random_uuid() (pgcrypto, built into PG13+) gives us
-- database-generated UUID primary keys so no application code can produce a
-- weak or colliding identifier.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Case-insensitive text is used for emails to guarantee uniqueness regardless of
-- the casing a user typed at registration.
CREATE EXTENSION IF NOT EXISTS citext;
