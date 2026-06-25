-- ============================================================
-- 028_compliance.sql
--
-- Compliance additions required by the technical specification:
--
--   1. contacts.opted_out        — WhatsApp opt-out flag; enforced on
--                                  every send attempt (spec: "opt-out
--                                  işlemlerini anlık uygulayabilme").
--
--   2. messages.error_code       — Numeric Meta error code captured from
--   broadcast_recipients.error_code  webhook status events.
--
--   3. accounts.ip_allowlist     — CIDR / plain-IP list for per-account
--                                  IP access restriction ("API ve panel
--                                  erişiminde IP kısıtlaması").
--
--   4. audit_logs                — Immutable append-only table for all
--                                  security-relevant events ("tüm mesaj
--                                  hareketleri için detaylı audit log").
--
-- All changes are idempotent — safe to re-run.
-- ============================================================

-- ============================================================
-- 1. Opt-out flag on contacts
-- ============================================================
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS opted_out BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS opted_out_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_contacts_opted_out
  ON contacts (account_id, opted_out)
  WHERE opted_out = true;

-- ============================================================
-- 2. Error code columns (Meta numeric codes, e.g. 131026, 131031)
-- ============================================================
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS error_code TEXT;

ALTER TABLE broadcast_recipients
  ADD COLUMN IF NOT EXISTS error_code TEXT;

-- ============================================================
-- 3. IP allowlist on accounts
--    Empty array means "allow all" (default open).
--    Non-empty means only listed IPs/CIDRs may access the account.
-- ============================================================
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS ip_allowlist TEXT[] NOT NULL DEFAULT '{}';

-- ============================================================
-- 4. Audit log table
--    Append-only; rows are NEVER updated or deleted.
--    Application layer inserts; no UPDATE/DELETE triggers needed.
-- ============================================================
CREATE TABLE IF NOT EXISTS audit_logs (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    UUID        REFERENCES accounts(id) ON DELETE SET NULL,
  user_id       UUID        REFERENCES users(id)    ON DELETE SET NULL,
  -- Short action key, e.g. "login.success", "member.invite",
  -- "settings.update", "message.send", "broadcast.send",
  -- "contact.opted_out", "ip_allowlist.update"
  action        TEXT        NOT NULL,
  -- Resource being acted on (optional)
  resource_type TEXT,
  resource_id   TEXT,
  -- Arbitrary extra context (phone, template name, old/new values, …)
  metadata      JSONB       NOT NULL DEFAULT '{}',
  ip_address    TEXT,
  user_agent    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_account_created
  ON audit_logs (account_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_user_created
  ON audit_logs (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_action
  ON audit_logs (action, created_at DESC);
