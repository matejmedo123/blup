-- ============================================================================
-- BLUP · 0014 · Role grants
-- ============================================================================
-- Supabase grants table privileges to anon/authenticated by default; we make it
-- explicit so the schema is reproducible on any PostgreSQL. Access is still
-- governed entirely by the RLS policies in 0011 — a grant without a matching
-- policy grants nothing.
-- ============================================================================

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'grant usage on schema public to anon';
    execute 'grant select on all tables in schema public to anon';
    execute 'alter default privileges in schema public grant select on tables to anon';
  end if;

  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant usage on schema public to authenticated';
    execute 'grant select, insert, update, delete on all tables in schema public to authenticated';
    execute 'grant usage, select on all sequences in schema public to authenticated';
    execute 'alter default privileges in schema public grant select, insert, update, delete on tables to authenticated';
    execute 'alter default privileges in schema public grant usage, select on sequences to authenticated';
  end if;

  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant usage on schema public to service_role';
    execute 'grant all on all tables in schema public to service_role';
    execute 'grant all on all sequences in schema public to service_role';
    execute 'grant all on all functions in schema public to service_role';
  end if;
end
$$;

-- Tables that must never be readable by end users, whatever the blanket grant
-- above says (RLS also denies, this is defence in depth).
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on public.webhook_events, public.admin_audit_log, public.payments,
             public.ledger_entries, public.payouts, public.premium_subscriptions,
             public.subscription_events, public.ai_requests from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke insert, update, delete on
               public.webhook_events, public.admin_audit_log, public.payments,
               public.ledger_entries, public.payouts, public.premium_subscriptions,
               public.subscription_events, public.orders, public.tickets
             from authenticated';
  end if;
end
$$;
