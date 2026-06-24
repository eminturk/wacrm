-- ============================================================
-- 027_postgres_auth.sql
--
-- Migrate the database off Supabase onto standalone PostgreSQL.
--
-- What this does (idempotent — safe to re-run):
--   1. Enables pgcrypto (gen_random_uuid) so we don't need uuid-ossp
--      or the Supabase-provided helpers.
--   2. Creates `users` (replaces auth.users) and `sessions` (custom
--      cookie sessions; token stored hashed).
--   3. Seeds `users` from `auth.users` when that schema still exists
--      (existing Supabase deployments) so FK re-pointing succeeds.
--   4. Re-points every foreign key that referenced auth.users to the
--      new public.users table.
--   5. Drops ALL row-level-security policies and disables RLS — access
--      control now lives in the application layer (scope by account_id).
--   6. Replaces the auth.uid()-based RPCs with versions that take the
--      caller's user id as an explicit parameter (validated in the app
--      layer), and rewires handle_new_user to fire on public.users.
--   7. Replaces the Supabase realtime publication with pg_notify
--      triggers on messages and conversations (consumed by the SSE
--      endpoint at /api/realtime).
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================
-- 1. users + sessions
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sessions (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

-- ============================================================
-- 2. Seed users from auth.users (existing Supabase installs only).
--    password_hash is set to a sentinel that can never match a bcrypt
--    verify — those users must use the password-reset flow to set a
--    local password. Brand-new installs skip this block entirely.
-- ============================================================
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'auth' AND table_name = 'users'
  ) THEN
    INSERT INTO public.users (id, email, password_hash, created_at)
    SELECT au.id,
           au.email,
           '!migrated-from-supabase',
           COALESCE(au.created_at, NOW())
    FROM auth.users au
    WHERE au.email IS NOT NULL
    ON CONFLICT (id) DO NOTHING;
  END IF;
END $$;

-- ============================================================
-- 3. Re-point every FK that referenced auth.users → public.users.
--    Preserves the column and its ON DELETE rule.
-- ============================================================
DO $$
DECLARE
  r RECORD;
  v_delrule TEXT;
BEGIN
  FOR r IN
    SELECT
      con.conname,
      rel.relname        AS table_name,
      att.attname        AS column_name,
      con.confdeltype
    FROM pg_constraint con
    JOIN pg_class rel        ON rel.oid = con.conrelid
    JOIN pg_namespace nsp    ON nsp.oid = rel.relnamespace
    JOIN pg_class frel       ON frel.oid = con.confrelid
    JOIN pg_namespace fnsp   ON fnsp.oid = frel.relnamespace
    JOIN pg_attribute att    ON att.attrelid = con.conrelid
                            AND att.attnum = con.conkey[1]
    WHERE con.contype = 'f'
      AND nsp.nspname = 'public'
      AND fnsp.nspname = 'auth'
      AND frel.relname = 'users'
  LOOP
    v_delrule := CASE r.confdeltype
      WHEN 'c' THEN 'CASCADE'
      WHEN 'n' THEN 'SET NULL'
      WHEN 'r' THEN 'RESTRICT'
      WHEN 'd' THEN 'SET DEFAULT'
      ELSE 'NO ACTION'
    END;

    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I',
                   r.table_name, r.conname);
    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES public.users(id) ON DELETE %s',
      r.table_name, r.conname, r.column_name, v_delrule);
  END LOOP;
END $$;

-- ============================================================
-- 4. Drop ALL RLS policies and disable RLS on public tables.
--    Access control is enforced in the application layer.
-- ============================================================
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT schemaname, tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'public'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I',
                   r.policyname, r.schemaname, r.tablename);
  END LOOP;

  FOR r IN
    SELECT n.nspname AS schemaname, c.relname AS tablename
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND c.relrowsecurity = true
  LOOP
    EXECUTE format('ALTER TABLE %I.%I DISABLE ROW LEVEL SECURITY',
                   r.schemaname, r.tablename);
  END LOOP;
END $$;

-- ============================================================
-- 5. Drop Supabase auth helper dependence.
--    `is_account_member` keyed off auth.uid(); the app no longer
--    relies on it, so drop it (CASCADE clears any leftover policy
--    deps that survived step 4 on a partial run).
-- ============================================================
DROP FUNCTION IF EXISTS public.is_account_member(UUID, account_role_enum) CASCADE;
DROP FUNCTION IF EXISTS public.is_account_member(UUID) CASCADE;

-- ============================================================
-- 6a. handle_new_user — bootstrap an account + owner profile when a
--     new row lands in public.users. The app's signup route inserts
--     the user, then patches full_name/account name afterward.
-- ============================================================
DROP TRIGGER IF EXISTS on_auth_user_created ON public.users;
DROP TRIGGER IF EXISTS on_user_created ON public.users;
DROP FUNCTION IF EXISTS public.handle_new_user() CASCADE;

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_account_id UUID;
BEGIN
  -- Skip if a profile already exists (defensive against manual inserts
  -- or a re-run); the app's signup path relies on this trigger to
  -- create the account + owner profile.
  IF EXISTS (SELECT 1 FROM public.profiles WHERE user_id = NEW.id) THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.accounts (name, owner_user_id)
  VALUES (COALESCE(NEW.email, 'My account'), NEW.id)
  RETURNING id INTO v_account_id;

  INSERT INTO public.profiles (user_id, full_name, email, account_id, account_role)
  VALUES (NEW.id, COALESCE(NEW.email, ''), NEW.email, v_account_id, 'owner');

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to bootstrap account/profile for user %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_user_created
  AFTER INSERT ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ============================================================
-- 6b. touch_presence(p_caller_id, p_status) — heartbeat. The caller's
--     id is supplied by the app layer (no auth.uid()).
-- ============================================================
DROP FUNCTION IF EXISTS public.touch_presence(TEXT);
DROP FUNCTION IF EXISTS public.touch_presence(UUID, TEXT);

CREATE OR REPLACE FUNCTION public.touch_presence(
  p_caller_id UUID,
  p_status TEXT DEFAULT 'online'
) RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  v_account_id UUID;
BEGIN
  IF p_caller_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  IF p_status NOT IN ('online', 'away') THEN
    RAISE EXCEPTION 'Invalid presence status: %', p_status USING ERRCODE = '22023';
  END IF;

  SELECT account_id INTO v_account_id FROM profiles WHERE user_id = p_caller_id;

  IF v_account_id IS NULL THEN
    RAISE EXCEPTION 'No account for caller' USING ERRCODE = '22023';
  END IF;

  INSERT INTO member_presence (user_id, account_id, status, last_seen_at)
  VALUES (p_caller_id, v_account_id, p_status, now())
  ON CONFLICT (user_id) DO UPDATE
    SET status       = excluded.status,
        last_seen_at = now(),
        account_id   = excluded.account_id;
END;
$$;

-- ============================================================
-- 6c. set_member_role(p_caller_id, p_user_id, p_new_role)
-- ============================================================
DROP FUNCTION IF EXISTS public.set_member_role(UUID, account_role_enum);
DROP FUNCTION IF EXISTS public.set_member_role(UUID, UUID, account_role_enum);

CREATE OR REPLACE FUNCTION public.set_member_role(
  p_caller_id UUID,
  p_user_id UUID,
  p_new_role account_role_enum
) RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  v_caller_account_id UUID;
  v_caller_role account_role_enum;
  v_target_account_id UUID;
  v_target_role account_role_enum;
BEGIN
  IF p_caller_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT account_id, account_role INTO v_caller_account_id, v_caller_role
  FROM profiles WHERE user_id = p_caller_id;

  IF v_caller_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;

  IF v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'This action requires the admin role or higher' USING ERRCODE = '42501';
  END IF;

  IF p_user_id = p_caller_id THEN
    RAISE EXCEPTION 'Cannot change your own role' USING ERRCODE = '22023';
  END IF;

  SELECT account_id, account_role INTO v_target_account_id, v_target_role
  FROM profiles WHERE user_id = p_user_id;

  IF v_target_account_id IS NULL THEN
    RAISE EXCEPTION 'Target user not found' USING ERRCODE = '22023';
  END IF;

  IF v_target_account_id <> v_caller_account_id THEN
    RAISE EXCEPTION 'Target user is not a member of your account' USING ERRCODE = '42501';
  END IF;

  IF v_target_role = 'owner' THEN
    RAISE EXCEPTION 'Use transfer_account_ownership to demote an owner' USING ERRCODE = '22023';
  END IF;
  IF p_new_role = 'owner' THEN
    RAISE EXCEPTION 'Use transfer_account_ownership to promote to owner' USING ERRCODE = '22023';
  END IF;

  UPDATE profiles SET account_role = p_new_role WHERE user_id = p_user_id;
END;
$$;

-- ============================================================
-- 6d. remove_account_member(p_caller_id, p_user_id)
-- ============================================================
DROP FUNCTION IF EXISTS public.remove_account_member(UUID);
DROP FUNCTION IF EXISTS public.remove_account_member(UUID, UUID);

CREATE OR REPLACE FUNCTION public.remove_account_member(
  p_caller_id UUID,
  p_user_id UUID
) RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
  v_caller_account_id UUID;
  v_caller_role account_role_enum;
  v_target_account_id UUID;
  v_target_role account_role_enum;
  v_target_name TEXT;
  v_target_email TEXT;
  v_new_account_id UUID;
BEGIN
  IF p_caller_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT account_id, account_role INTO v_caller_account_id, v_caller_role
  FROM profiles WHERE user_id = p_caller_id;

  IF v_caller_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;

  IF v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'This action requires the admin role or higher' USING ERRCODE = '42501';
  END IF;

  IF p_user_id = p_caller_id THEN
    RAISE EXCEPTION 'Cannot remove yourself; transfer ownership or leave the account instead' USING ERRCODE = '22023';
  END IF;

  SELECT account_id, account_role, full_name, email
  INTO v_target_account_id, v_target_role, v_target_name, v_target_email
  FROM profiles WHERE user_id = p_user_id;

  IF v_target_account_id IS NULL THEN
    RAISE EXCEPTION 'Target user not found' USING ERRCODE = '22023';
  END IF;

  IF v_target_account_id <> v_caller_account_id THEN
    RAISE EXCEPTION 'Target user is not a member of your account' USING ERRCODE = '42501';
  END IF;

  IF v_target_role = 'owner' THEN
    RAISE EXCEPTION 'Cannot remove the account owner; transfer ownership first' USING ERRCODE = '22023';
  END IF;

  INSERT INTO accounts (name, owner_user_id)
  VALUES (COALESCE(NULLIF(v_target_name, ''), v_target_email, 'My account'), p_user_id)
  RETURNING id INTO v_new_account_id;

  UPDATE profiles
  SET account_id = v_new_account_id, account_role = 'owner'
  WHERE user_id = p_user_id;

  RETURN v_new_account_id;
END;
$$;

-- ============================================================
-- 6e. transfer_account_ownership(p_caller_id, p_new_owner_user_id)
-- ============================================================
DROP FUNCTION IF EXISTS public.transfer_account_ownership(UUID);
DROP FUNCTION IF EXISTS public.transfer_account_ownership(UUID, UUID);

CREATE OR REPLACE FUNCTION public.transfer_account_ownership(
  p_caller_id UUID,
  p_new_owner_user_id UUID
) RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  v_caller_account_id UUID;
  v_caller_role account_role_enum;
  v_target_account_id UUID;
BEGIN
  IF p_caller_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT account_id, account_role INTO v_caller_account_id, v_caller_role
  FROM profiles WHERE user_id = p_caller_id;

  IF v_caller_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;

  IF v_caller_role <> 'owner' THEN
    RAISE EXCEPTION 'Only the account owner can transfer ownership' USING ERRCODE = '42501';
  END IF;

  IF p_new_owner_user_id = p_caller_id THEN
    RAISE EXCEPTION 'You are already the owner' USING ERRCODE = '22023';
  END IF;

  SELECT account_id INTO v_target_account_id
  FROM profiles WHERE user_id = p_new_owner_user_id;

  IF v_target_account_id IS NULL THEN
    RAISE EXCEPTION 'Target user not found' USING ERRCODE = '22023';
  END IF;

  IF v_target_account_id <> v_caller_account_id THEN
    RAISE EXCEPTION 'Target user is not a member of your account' USING ERRCODE = '42501';
  END IF;

  UPDATE profiles SET account_role = 'admin' WHERE user_id = p_caller_id;
  UPDATE profiles SET account_role = 'owner' WHERE user_id = p_new_owner_user_id;
  UPDATE accounts SET owner_user_id = p_new_owner_user_id WHERE id = v_caller_account_id;
END;
$$;

-- ============================================================
-- 7. pg_notify triggers — replace the supabase_realtime publication.
--    The SSE endpoint (/api/realtime) LISTENs on these channels and
--    forwards events to subscribed browsers. Payload is intentionally
--    small (id + account_id + op) — the client refetches details.
-- ============================================================
CREATE OR REPLACE FUNCTION public.notify_realtime()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_row JSONB;
  v_account_id UUID;
  v_payload JSONB;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_row := to_jsonb(OLD);
  ELSE
    v_row := to_jsonb(NEW);
  END IF;

  v_account_id := NULLIF(v_row->>'account_id', '')::UUID;

  v_payload := jsonb_build_object(
    'table', TG_TABLE_NAME,
    'op', TG_OP,
    'id', v_row->>'id',
    'account_id', v_account_id,
    'conversation_id', v_row->>'conversation_id'
  );

  PERFORM pg_notify('wacrm_realtime', v_payload::text);

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS notify_messages ON public.messages;
CREATE TRIGGER notify_messages
  AFTER INSERT OR UPDATE OR DELETE ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.notify_realtime();

DROP TRIGGER IF EXISTS notify_conversations ON public.conversations;
CREATE TRIGGER notify_conversations
  AFTER INSERT OR UPDATE OR DELETE ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.notify_realtime();

DROP TRIGGER IF EXISTS notify_member_presence ON public.member_presence;
CREATE TRIGGER notify_member_presence
  AFTER INSERT OR UPDATE OR DELETE ON public.member_presence
  FOR EACH ROW EXECUTE FUNCTION public.notify_realtime();
