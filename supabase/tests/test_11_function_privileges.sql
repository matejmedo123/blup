-- ============================================================================
-- BLUP test 11 · The money functions are not reachable from a browser
-- ============================================================================
-- This is the regression test for a real hole. `revoke ... from authenticated`
-- looks like it locks a function down and does not: PostgreSQL grants EXECUTE
-- to PUBLIC by default, and `authenticated` inherits it. Every one of these was
-- callable with the anon key that ships in the client bundle.
--
-- The test asserts the privilege itself rather than trying to call each
-- function, because a call can fail for the wrong reason — a missing row, a bad
-- argument — and still leave the door open.
-- ============================================================================
\set ON_ERROR_STOP on

begin;

do $$
declare
  fn      text;
  leaked  text[] := '{}';
  guarded text[] := array[
    'public.create_order(uuid, uuid, integer, text, integer, uuid, uuid)',
    'public.create_checkout(uuid, text)',
    'public.fulfill_order(uuid, payment_provider, text, integer)',
    'public.fulfill_checkout(uuid, payment_provider, text, integer)',
    'public.fail_order(uuid, text)',
    'public.fail_checkout(uuid, text)',
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
    'public.notify_user(uuid, notification_type, text, text, uuid, uuid, jsonb)',
    'public.release_expired_holds()'
  ];
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    raise notice 'SKIP no authenticated role in this cluster';
    return;
  end if;

  foreach fn in array guarded loop
    if to_regprocedure(fn) is null then
      raise exception 'TEST FAILED: % does not exist — the guard list is stale', fn;
    end if;

    if has_function_privilege('authenticated', to_regprocedure(fn), 'execute')
       or has_function_privilege('anon', to_regprocedure(fn), 'execute')
    then
      leaked := leaked || fn;
    end if;
  end loop;

  if array_length(leaked, 1) > 0 then
    raise exception 'TEST FAILED: reachable from a browser: %', array_to_string(leaked, ', ');
  end if;

  raise notice 'PASS % service-role-only functions are unreachable from anon/authenticated',
    array_length(guarded, 1);
end $$;

-- --- and the things a signed-in person *must* still be able to call ----------
do $$
declare
  fn      text;
  missing text[] := '{}';
  allowed text[] := array[
    'public.cart_add(uuid, integer)',
    'public.cart_set_quantity(uuid, integer)',
    'public.cart_remove(uuid)',
    'public.cart_clear()',
    'public.cart_view(text)',
    'public.ticket_type_availability(uuid)',
    'public.create_boost_order(uuid, text)',
    'public.request_payout(uuid, integer)',
    'public.quote_order(uuid, integer, text)',
    'public.check_in_ticket(text, text, uuid)'
  ];
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    return;
  end if;

  foreach fn in array allowed loop
    if to_regprocedure(fn) is null then
      raise exception 'TEST FAILED: % does not exist — the allow list is stale', fn;
    end if;
    if not has_function_privilege('authenticated', to_regprocedure(fn), 'execute') then
      missing := missing || fn;
    end if;
  end loop;

  if array_length(missing, 1) > 0 then
    raise exception 'TEST FAILED: locked out of its own app: %', array_to_string(missing, ', ');
  end if;

  raise notice 'PASS the app can still call what it needs';
end $$;

-- --- browsing needs no account at all ----------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then return; end if;

  assert has_function_privilege('anon', 'public.events_nearby(double precision, double precision, double precision, timestamptz, timestamptz, text[], boolean, integer, integer)', 'execute'),
    'a visitor must be able to see what is on';
  assert has_function_privilege('anon', 'public.search_events(text, double precision, double precision, double precision, timestamptz, timestamptz, text[], boolean, integer, text, integer, integer)', 'execute'),
    'a visitor must be able to search';
  assert has_function_privilege('anon', 'public.marketing_tags()', 'execute'),
    'the page needs to know which tags to load before anyone signs in';

  raise notice 'PASS a guest can browse, search and load the page';
end $$;

rollback;
