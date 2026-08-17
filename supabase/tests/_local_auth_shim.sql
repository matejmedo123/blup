-- ============================================================================
-- LOCAL VERIFICATION SHIM — never applied to Supabase
-- ============================================================================
-- Supabase provides the `auth` schema, `auth.uid()` and the anon/authenticated
-- roles. This file recreates just enough of them so the real migrations can be
-- executed and tested against a plain PostgreSQL instance in CI / locally.
-- Run scripts/verify-db.sh to use it.
-- ============================================================================

create schema if not exists auth;

create table if not exists auth.users (
  id                 uuid primary key default gen_random_uuid(),
  email              text unique,
  encrypted_password text,
  email_confirmed_at timestamptz,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now()
);

-- auth.uid() reads the request JWT claims in Supabase. Locally we emulate it
-- with a session GUC so tests can "log in" as any user:
--     select set_config('request.jwt.claim.sub', '<uuid>', true);
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

create or replace function auth.role()
returns text
language sql
stable
as $$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'anon');
$$;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end
$$;

grant usage on schema public to anon, authenticated, service_role;
grant usage on schema auth to anon, authenticated, service_role;
