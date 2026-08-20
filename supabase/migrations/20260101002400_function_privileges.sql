-- ============================================================================
-- BLUP · 0024 · Service-role-only functions are actually service-role only
-- ============================================================================
-- A real hole, found while building the cart, and it is worth writing down how
-- it happened because the mistake is easy to repeat.
--
-- Earlier migrations tried to lock the money functions down like this:
--
--     revoke execute on function public.fulfill_order(...) from authenticated, anon;
--
-- That looks right and does nothing. PostgreSQL grants EXECUTE on every new
-- function to the pseudo-role PUBLIC by default, and `authenticated` is a
-- member of PUBLIC. Revoking the *direct* grant leaves the inherited one, so
-- the function stayed callable — `has_function_privilege('authenticated', ...)`
-- returned true the whole time.
--
-- What that meant in practice, for anyone with an account and the anon key
-- that ships in the client bundle:
--
--   fulfill_order()              issue yourself tickets without paying
--   ticket_email_payload()       read anybody's QR secret -> forge entry
--   upsert_premium_subscription() grant yourself Premium
--   refund_order()               refund a stranger's order, wreck the ledger
--   create_order()               place orders in someone else's name
--   activate_boost()             promote your event for free
--   link_stripe_customer()       point your account at another person's cards
--   notify_user()                send a push notification to any user
--
-- The fix is to revoke from PUBLIC — the source of the grant — and then hand
-- EXECUTE back to service_role explicitly, since it loses the inherited right
-- along with everyone else. `create_boost_order` and `request_payout` stay
-- callable by authenticated on purpose: they authorize on auth.uid() and the
-- Edge Functions call them with the caller's own JWT.
--
-- Nothing about these functions changes. Only who may call them.
-- ============================================================================

set search_path = public, extensions;

do $$
declare
  fn text;
  -- Everything here is reachable only from an Edge Function running with the
  -- service role key, which never leaves the server.
  service_only text[] := array[
    'public.create_order(uuid, uuid, integer, text)',
    'public.fulfill_order(uuid, payment_provider, text, integer)',
    'public.fail_order(uuid, text)',
    'public.refund_order(uuid, text)',
    'public.activate_boost(uuid, payment_provider, text, integer)',
    'public.fail_boost(uuid, text)',
    'public.upsert_premium_subscription(uuid, subscription_platform, text, subscription_status, text, text, timestamptz, timestamptz, boolean, text, jsonb)',
    'public.mark_payout_failed(uuid, text)',
    'public.link_stripe_customer(uuid, text)',
    'public.user_for_stripe_customer(text)',
    'public.stripe_customer_for(uuid)',
    'public.ticket_email_payload(uuid)',
    'public.claim_email_deliveries(integer)',
    'public.mark_email_sent(uuid, text, text)',
    'public.mark_email_failed(uuid, text, boolean)',
    'public.queue_ticket_email(uuid)',
    'public.log_recommendation_run(text, jsonb, jsonb)',
    'public.notify_user(uuid, notification_type, text, text, uuid, uuid, jsonb)'
  ];
begin
  foreach fn in array service_only loop
    -- to_regprocedure returns null instead of raising for a signature that does
    -- not exist, so a migration re-run on a partially built database is safe.
    if to_regprocedure(fn) is not null then
      execute format('revoke all on function %s from public', fn);

      if exists (select 1 from pg_roles where rolname = 'anon') then
        execute format('revoke all on function %s from anon', fn);
      end if;
      if exists (select 1 from pg_roles where rolname = 'authenticated') then
        execute format('revoke all on function %s from authenticated', fn);
      end if;
      if exists (select 1 from pg_roles where rolname = 'service_role') then
        execute format('grant execute on function %s to service_role', fn);
      end if;
    end if;
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- Guard rail: fail the migration if any of them is still reachable
-- ---------------------------------------------------------------------------
-- A privilege bug is invisible until someone exploits it, so it is asserted
-- here rather than left to a test suite that may not be run before deploy.
do $$
declare
  fn      text;
  leaked  text[] := '{}';
  checked text[] := array[
    'public.create_order(uuid, uuid, integer, text)',
    'public.fulfill_order(uuid, payment_provider, text, integer)',
    'public.refund_order(uuid, text)',
    'public.ticket_email_payload(uuid)',
    'public.upsert_premium_subscription(uuid, subscription_platform, text, subscription_status, text, text, timestamptz, timestamptz, boolean, text, jsonb)',
    'public.activate_boost(uuid, payment_provider, text, integer)',
    'public.notify_user(uuid, notification_type, text, text, uuid, uuid, jsonb)'
  ];
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    return;
  end if;

  foreach fn in array checked loop
    if to_regprocedure(fn) is not null
       and has_function_privilege('authenticated', to_regprocedure(fn), 'execute')
    then
      leaked := leaked || fn;
    end if;
  end loop;

  if array_length(leaked, 1) > 0 then
    raise exception 'FUNCTION_STILL_EXPOSED: %', array_to_string(leaked, ', ');
  end if;
end
$$;
