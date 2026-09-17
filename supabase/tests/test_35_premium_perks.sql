-- ============================================================================
-- BLUP test 35 · What Premium gives, and what it must not take
-- ============================================================================
-- Two halves. The perks are real and server-side — a client cannot paint itself
-- pink by writing to its own row. And the free app is untouched: nothing here
-- is a limit invented so that removing it can be sold.
\set ON_ERROR_STOP on

begin;

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'platiaci@blup.test'),
  ('22222222-2222-2222-2222-222222222222', 'neplatiaci@blup.test'),
  ('33333333-3333-3333-3333-333333333333', 'divak@blup.test');

insert into public.premium_subscriptions
  (user_id, platform, product_id, status, original_transaction_id, expires_at, auto_renew)
values
  ('11111111-1111-1111-1111-111111111111', 'stripe', 'premium.monthly', 'active',
   'sub_test_1', now() + interval '30 days', true);

-- --- the colour is behind the subscription, not behind the client -----------
do $$
declare
  row    public.profiles;
  failed boolean := false;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
  row := public.set_premium_look('pink');
  assert row.accent_color = 'pink', format('expected pink, got %s', row.accent_color);
  reset role;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
  begin
    perform public.set_premium_look('pink');
  exception when others then failed := true;
  end;
  reset role;

  assert failed, 'somebody without Premium cannot set the colour';
  assert (select accent_color from public.profiles
          where id = '22222222-2222-2222-2222-222222222222') is null,
    'and their row is untouched';

  raise notice 'PASS the look is behind the subscription, checked on the server';
end $$;

-- --- and a made-up colour is refused ----------------------------------------
do $$
declare failed boolean := false;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
  begin
    perform public.set_premium_look('#000000');
  exception when others then failed := true;
  end;
  reset role;
  assert failed, 'a free colour picker is how you get white text on white';
  raise notice 'PASS the palette is a fixed set, not a colour picker';
end $$;

-- --- a lapsed subscription stops applying, and loses nothing ----------------
do $$
declare look jsonb;
begin
  update public.premium_subscriptions
  set status = 'expired', expires_at = now() - interval '1 day'
  where user_id = '11111111-1111-1111-1111-111111111111';

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
  select public.my_look() into look;
  reset role;

  assert (look ->> 'accent_color') is null, 'a lapsed colour stops being painted';
  assert (look ->> 'saved_accent') = 'pink', 'but it is still there when they come back';

  update public.premium_subscriptions
  set status = 'active', expires_at = now() + interval '30 days'
  where user_id = '11111111-1111-1111-1111-111111111111';

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
  select public.my_look() into look;
  reset role;
  assert (look ->> 'accent_color') = 'pink', 'and comes straight back on';

  raise notice 'PASS lapsing stops the perk without destroying the setting';
end $$;

-- --- double XP, and the cap that is not doubled -----------------------------
do $$
declare
  paid_xp  integer;
  free_xp  integer;
  ev_id    uuid := 'aaaaaaa1-0000-0000-0000-0000000000b1';
begin
  insert into public.events (id, creator_id, title, category, latitude, longitude,
                             start_at, is_free)
  values (ev_id, '33333333-3333-3333-3333-333333333333', 'Test', 'techno',
          48.15, 17.12, now() + interval '5 days', true);

  paid_xp := public.award_xp('11111111-1111-1111-1111-111111111111',
                             'event_saved'::xp_kind, 'event', ev_id);
  free_xp := public.award_xp('22222222-2222-2222-2222-222222222222',
                             'event_saved'::xp_kind, 'event', ev_id);

  assert paid_xp = free_xp * 2,
    format('Premium is double, got %s vs %s', paid_xp, free_xp);
  assert free_xp > 0, 'and the free account still earns';

  -- The award that was written is the doubled one, so the level, the
  -- leaderboard and the badges all read the same number.
  assert (select xp from public.user_stats
          where user_id = '11111111-1111-1111-1111-111111111111') = paid_xp,
    'the doubled amount is what lands in the total';

  raise notice 'PASS Premium earns twice per action (% vs %)', paid_xp, free_xp;
end $$;

-- --- who looked at your profile ---------------------------------------------
do $$
declare
  seen jsonb;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', true);
  perform public.record_profile_view('11111111-1111-1111-1111-111111111111');
  -- Twice in a minute is one interest, not two.
  perform public.record_profile_view('11111111-1111-1111-1111-111111111111');
  reset role;

  assert (select count(*) from public.profile_views
          where profile_id = '11111111-1111-1111-1111-111111111111') = 1,
    'opening a profile twice in an hour is one view';

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
  select public.my_profile_views() into seen;
  reset role;

  assert (seen ->> 'is_premium')::boolean, 'the subscriber sees the list';
  assert (seen ->> 'total')::int = 1, format('one viewer, got %s', seen ->> 'total');
  assert jsonb_array_length(seen -> 'viewers') = 1, 'with a name on it';

  raise notice 'PASS a subscriber sees who looked at them';
end $$;

-- --- and everybody else gets the number, not a blurred fake ------------------
do $$
declare seen jsonb;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
  perform public.record_profile_view('22222222-2222-2222-2222-222222222222');
  reset role;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
  select public.my_profile_views() into seen;
  reset role;

  assert not (seen ->> 'is_premium')::boolean, 'no subscription here';
  assert (seen ->> 'total')::int = 1, 'the count is not the secret';
  assert jsonb_array_length(seen -> 'viewers') = 0, 'the names are';

  raise notice 'PASS without Premium the count is shown and the names are not';
end $$;

-- --- anonymous mode leaves no row at all ------------------------------------
-- Not a row that is filtered out later: a promise kept by filtering is a
-- promise kept only by whoever remembers to filter.
do $$
declare before_n integer; after_n integer;
begin
  update public.profiles set anonymous_mode = true
  where id = '33333333-3333-3333-3333-333333333333';

  select count(*) into before_n from public.profile_views
  where profile_id = '22222222-2222-2222-2222-222222222222';

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', true);
  perform public.record_profile_view('22222222-2222-2222-2222-222222222222');
  reset role;

  select count(*) into after_n from public.profile_views
  where profile_id = '22222222-2222-2222-2222-222222222222';

  assert after_n = before_n, 'anonymous browsing writes nothing';
  raise notice 'PASS anonymous mode leaves no trace to filter';
end $$;

-- --- nobody reads that table directly ---------------------------------------
do $$
declare n integer;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
  select count(*) into n from public.profile_views;
  reset role;
  assert n = 0, 'the rule lives in one function, not in a policy people can read around';
  raise notice 'PASS the views table is not readable from a client';
end $$;

-- --- the badge is public, and does not outlive the subscription -------------
do $$
declare until_ts timestamptz;
begin
  select premium_until into until_ts from public.profiles
  where id = '11111111-1111-1111-1111-111111111111';
  assert until_ts is not null and until_ts > now(), 'a subscriber wears the badge';

  set local role anon;
  assert (select premium_until from public.profiles
          where id = '11111111-1111-1111-1111-111111111111') is not null,
    'and everybody can see it — a badge nobody sees is not a badge';
  reset role;

  update public.premium_subscriptions set status = 'cancelled'
  where user_id = '11111111-1111-1111-1111-111111111111';

  select premium_until into until_ts from public.profiles
  where id = '11111111-1111-1111-1111-111111111111';
  assert until_ts is null, 'and it comes off when the subscription does';

  raise notice 'PASS the badge is public and cannot outlive the subscription';
end $$;

rollback;
