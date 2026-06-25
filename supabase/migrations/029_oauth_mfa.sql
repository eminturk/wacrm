-- ============================================================
-- 029_oauth_mfa.sql
--
-- Adds:
--   1. oauth_accounts — links a user to one or more OAuth provider
--      identities (Google, GitHub, etc.). A user may have both a
--      password and one or more OAuth logins.
--   2. mfa_* columns on users — TOTP-based MFA support.
--      mfa_secret     — base32-encoded TOTP secret (encrypted at rest
--                       in the app layer before storing).
--      mfa_enabled    — whether MFA is active for this user.
--      mfa_recovery_codes — JSONB array of hashed single-use codes.
--   3. pending_mfa_sessions — short-lived tokens that mark a session
--      as having passed password auth but not yet TOTP verification.
-- ============================================================

-- ============================================================
-- 1. oauth_accounts
-- ============================================================
CREATE TABLE IF NOT EXISTS oauth_accounts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider        TEXT NOT NULL,          -- 'google', 'github', ...
  provider_user_id TEXT NOT NULL,         -- subject identifier from the provider
  access_token    TEXT,                   -- encrypted; nullable (not always stored)
  refresh_token   TEXT,                   -- encrypted; nullable
  expires_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (provider, provider_user_id)
);

CREATE INDEX IF NOT EXISTS idx_oauth_accounts_user_id ON oauth_accounts(user_id);

-- ============================================================
-- 2. MFA columns on users
-- ============================================================
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS mfa_secret         TEXT,
  ADD COLUMN IF NOT EXISTS mfa_enabled        BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS mfa_recovery_codes JSONB   NOT NULL DEFAULT '[]'::jsonb;

-- ============================================================
-- 3. pending_mfa_sessions — "password OK, TOTP pending" tokens
-- ============================================================
CREATE TABLE IF NOT EXISTS pending_mfa_sessions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash  TEXT NOT NULL UNIQUE,        -- SHA-256 of the plaintext token
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pending_mfa_sessions_user_id
  ON pending_mfa_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_pending_mfa_sessions_expires_at
  ON pending_mfa_sessions(expires_at);
