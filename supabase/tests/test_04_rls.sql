-- ============================================================================
-- BLUP test 04 · Row Level Security
-- ============================================================================
-- Every block switches to the `authenticated` role (RLS applies) and sets the
-- JWT subject, exactly like a real Supabase request.
-- ============================================================================
\set ON_ERROR_STOP on

begin;

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'owner@example.com'),
  ('22222222-2222-2222-2222-222222222222', 'stranger@example.com'),
  ('33333333-3333-3333-3333-333333333333', 'admin@example.com');

update public.profiles set app_role = 'admin' where id = '33333333-3333-3333-3333-333333333333';
update public.profiles set is_private = true where id = '11111111-1111-1111-1111-111111111111';

insert into public.events (id, creator_id, title, category, latitude, longitude, start_at, status)
values
  ('aaaaaaa1-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
   'Public party', 'techno', 48.15, 17.11, now() + interval '2 days', 'published'),
  ('aaaaaaa1-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111',
   'Secret draft', 'techno', 48.15, 17.11, now() + interval '3 days', 'draft');

-- ---------------------------------------------------------------------------
set local role authenticated;

-- --- private profiles are hidden from strangers -----------------------------
do $$
declare n integer;
begin
  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
  select count(*) into n from public.profiles where id = '11111111-1111-1111-1111-111111111111';
  assert n = 0, 'a private profile must not be readable by a stranger';

  perform set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
  select count(*) into n from public.profiles where id = '11111111-1111-1111-1111-111111111111';
  assert n = 1, 'a user must always see their own profile';
  raise notice 'PASS private profile visibility';
end $$;

-- --- you cannot edit someone else's profile ---------------------------------
do $$
declare n integer;
begin
  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
  update public.profiles set bio = 'hacked' where id = '11111111-1111-1111-1111-111111111111';
  get diagnostics n = row_count;
  assert n = 0, 'RLS must block updates to another user''s profile';
  raise notice 'PASS profile update isolation';
end $$;

-- --- you cannot promote yourself to admin -----------------------------------
do $$
declare r app_role;
begin
  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
  update public.profiles set app_role = 'admin' where id = '22222222-2222-2222-2222-222222222222';
  select app_role into r from public.profiles where id = '22222222-2222-2222-2222-222222222222';
  assert r = 'user', format('privilege escalation must be blocked, role is now %s', r);
  raise notice 'PASS no self-promotion to admin';
end $$;

-- --- draft events are invisible to everyone but the creator/admin -----------
do $$
declare n integer;
begin
  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
  select count(*) into n from public.events where id = 'aaaaaaa1-0000-0000-0000-000000000002';
  assert n = 0, 'a draft event must be hidden from other users';

  select count(*) into n from public.events where id = 'aaaaaaa1-0000-0000-0000-000000000001';
  assert n = 1, 'a published public event must be visible';

  perform set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
  select count(*) into n from public.events where id = 'aaaaaaa1-0000-0000-0000-000000000002';
  assert n = 1, 'the creator must see their own draft';

  perform set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', true);
  select count(*) into n from public.events where id = 'aaaaaaa1-0000-0000-0000-000000000002';
  assert n = 1, 'an admin must see drafts for moderation';
  raise notice 'PASS event visibility rules';
end $$;

-- --- you cannot create an event in somebody else's name ---------------------
do $$
begin
  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
  begin
    insert into public.events (creator_id, title, category, latitude, longitude, start_at)
    values ('11111111-1111-1111-1111-111111111111', 'Impersonated event', 'techno',
            48.15, 17.11, now() + interval '1 day');
    raise exception 'TEST FAILED: event impersonation was allowed';
  exception when insufficient_privilege then
    raise notice 'PASS cannot create an event as another user';
  end;
end $$;

-- --- you cannot edit someone else's event -----------------------------------
do $$
declare n integer;
begin
  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
  update public.events set title = 'hijacked' where id = 'aaaaaaa1-0000-0000-0000-000000000001';
  get diagnostics n = row_count;
  assert n = 0, 'RLS must block edits to another user''s event';
  raise notice 'PASS event edit isolation';
end $$;

-- --- counters cannot be forged ----------------------------------------------
do $$
declare c integer;
begin
  perform set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
  update public.events set attendee_count = 9999 where id = 'aaaaaaa1-0000-0000-0000-000000000001';
  select attendee_count into c from public.events where id = 'aaaaaaa1-0000-0000-0000-000000000001';
  assert c = 0, format('counters must be trigger-controlled, got %s', c);
  raise notice 'PASS counters cannot be forged by the client';
end $$;

-- --- money tables are not writable from the client --------------------------
do $$
begin
  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);

  begin
    insert into public.tickets (event_id, buyer_id, code, qr_secret)
    values ('aaaaaaa1-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222',
            'FREE-TICKET', 'x');
    raise exception 'TEST FAILED: a user minted their own ticket';
  exception when insufficient_privilege then
    raise notice 'PASS tickets cannot be minted by the client';
  end;

  begin
    insert into public.orders (event_id, ticket_type_id, buyer_id, quantity, unit_price_cents,
                               subtotal_cents, total_cents, currency, payment_status)
    values ('aaaaaaa1-0000-0000-0000-000000000001', gen_random_uuid(),
            '22222222-2222-2222-2222-222222222222', 1, 0, 0, 0, 'EUR', 'succeeded');
    raise exception 'TEST FAILED: a user created a paid order directly';
  exception when insufficient_privilege then
    raise notice 'PASS orders cannot be written by the client';
  end;

  begin
    insert into public.premium_subscriptions (user_id, platform, product_id, status)
    values ('22222222-2222-2222-2222-222222222222', 'apple', 'com.blup.app.premium.monthly', 'active');
    raise exception 'TEST FAILED: a user granted themselves premium';
  exception when insufficient_privilege then
    raise notice 'PASS premium cannot be self-granted';
  end;

  begin
    insert into public.ledger_entries (organization_id, type, amount_cents, currency)
    values (gen_random_uuid(), 'sale', 100000, 'EUR');
    raise exception 'TEST FAILED: a user wrote to the ledger';
  exception when insufficient_privilege then
    raise notice 'PASS ledger is not client-writable';
  end;
end $$;

-- --- notifications are private ----------------------------------------------
do $$
declare n integer;
begin
  reset role;
  insert into public.notifications (user_id, type, title)
  values ('11111111-1111-1111-1111-111111111111', 'new_follower', 'Someone followed you');
  set local role authenticated;

  -- Filter by the row we just inserted: gamification also writes notifications
  -- (badges, level-ups), so a global count is not a stable assertion.
  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
  select count(*) into n from public.notifications where title = 'Someone followed you';
  assert n = 0, 'notifications must only be readable by their owner';

  perform set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
  select count(*) into n from public.notifications where title = 'Someone followed you';
  assert n = 1, 'the owner must see their notifications';

  select count(*) into n from public.notifications
   where user_id <> '11111111-1111-1111-1111-111111111111';
  assert n = 0, 'no notification belonging to another user may leak';
  raise notice 'PASS notification privacy';
end $$;

-- --- admin-only RPCs reject normal users ------------------------------------
do $$
begin
  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
  begin
    perform public.admin_platform_stats();
    raise exception 'TEST FAILED: a normal user read the admin stats';
  exception when raise_exception then
    raise notice 'PASS admin RPCs require the admin role';
  end;

  perform set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', true);
  perform public.admin_platform_stats();
  raise notice 'PASS admin can read the platform stats';
end $$;

reset role;
rollback;
