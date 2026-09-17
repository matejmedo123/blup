-- ============================================================================
-- BLUP test 36 · The rules that make a boost an ad system
-- ============================================================================
-- The one that matters most is the relevance floor. Everything else here is
-- bookkeeping; that one is the promise that the feed stays worth opening, which
-- is the thing being sold.
\set ON_ERROR_STOP on

begin;

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'divak@blup.test'),
  ('22222222-2222-2222-2222-222222222222', 'organizator@blup.test'),
  ('33333333-3333-3333-3333-333333333333', 'iny@blup.test');

-- Nitra, likes techno.
update public.profiles set latitude = 48.3069, longitude = 18.0864
where id = '11111111-1111-1111-1111-111111111111';

insert into public.interests (slug, name, category, sort_order)
values ('techno', 'Techno', 'techno', 1) on conflict (slug) do nothing;

insert into public.user_interests (user_id, interest_id)
select '11111111-1111-1111-1111-111111111111', i.id
from public.interests i where i.category = 'techno' limit 1;

-- Three events: one that fits, one far away, one of the wrong kind.
insert into public.events (id, creator_id, title, category, latitude, longitude,
                           start_at, end_at, is_free, status, visibility)
values
  ('aaaaaaa1-0000-0000-0000-0000000000b1', '22222222-2222-2222-2222-222222222222',
   'Techno v Nitre', 'techno', 48.3100, 18.0900,
   now() + interval '3 days', now() + interval '3 days 6 hours', true, 'published', 'public'),
  ('aaaaaaa1-0000-0000-0000-0000000000b2', '22222222-2222-2222-2222-222222222222',
   'Techno v Košiciach', 'techno', 48.7164, 21.2611,
   now() + interval '3 days', now() + interval '3 days 6 hours', true, 'published', 'public'),
  ('aaaaaaa1-0000-0000-0000-0000000000b3', '22222222-2222-2222-2222-222222222222',
   'Prednáška o účtovníctve', 'business', 48.3100, 18.0900,
   now() + interval '3 days', now() + interval '3 days 6 hours', true, 'published', 'public');

-- All three boosted, the far one paying the most.
insert into public.event_boosts (id, event_id, package_code, starts_at, ends_at, weight,
                                 amount_cents, payment_status, placements, impression_budget)
values
  ('bbbbbbb1-0000-0000-0000-0000000000c1', 'aaaaaaa1-0000-0000-0000-0000000000b1', 'boost_24',
   now() - interval '1 hour', now() + interval '23 hours', 0.10, 700, 'succeeded',
   array['feed','spotlight'], 2500),
  ('bbbbbbb1-0000-0000-0000-0000000000c2', 'aaaaaaa1-0000-0000-0000-0000000000b2', 'boost_7d',
   now() - interval '1 hour', now() + interval '6 days', 0.22, 3900, 'succeeded',
   array['feed'], 25000),
  ('bbbbbbb1-0000-0000-0000-0000000000c3', 'aaaaaaa1-0000-0000-0000-0000000000b3', 'boost_24',
   now() - interval '1 hour', now() + interval '23 hours', 0.10, 700, 'succeeded',
   array['feed'], 2500);

-- --- money buys position, never relevance -----------------------------------
do $$
declare
  r      record;
  n      integer;
  ids    uuid[];
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);

  select count(*), array_agg(event_id) into n, ids
  from public.sponsored_events('feed', p_limit => 5);

  assert 'aaaaaaa1-0000-0000-0000-0000000000b1' = any(ids),
    'the one that fits is shown';
  assert not ('aaaaaaa1-0000-0000-0000-0000000000b2' = any(ids)),
    'the one 200 km away is not — and it paid the most';

  -- The wrong-category one is local, so it is not excluded outright; it is
  -- simply beaten by the one that also matches.
  select * into r from public.sponsored_events('feed', p_limit => 5) limit 1;
  assert r.event_id = 'aaaaaaa1-0000-0000-0000-0000000000b1',
    format('the best match wins the slot, got %s', r.event_id);

  reset role;
  raise notice 'PASS paying more cannot buy a worse match past a better one';
end $$;

-- --- the same event, at most three times a day ------------------------------
do $$
declare
  shown integer;
  i     integer;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);

  for i in 1..3 loop
    perform public.record_boost_event('bbbbbbb1-0000-0000-0000-0000000000c1', 'feed');
  end loop;

  select count(*) into shown
  from public.sponsored_events('feed', p_limit => 5)
  where event_id = 'aaaaaaa1-0000-0000-0000-0000000000b1';

  assert shown = 0, 'after three views today, that one stops being shown to this person';

  -- And somebody else still sees it: the cap is per person, not per boost.
  reset role;
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', true);
  select count(*) into shown
  from public.sponsored_events('feed', p_limit => 5)
  where event_id = 'aaaaaaa1-0000-0000-0000-0000000000b1';
  assert shown = 1, 'somebody who has not seen it still does';
  reset role;

  raise notice 'PASS the frequency cap is per person';
end $$;

-- --- one spotlight a day, across every advertiser ---------------------------
do $$
declare n integer;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', true);

  select count(*) into n from public.sponsored_events('spotlight', p_limit => 3);
  assert n >= 1, 'there is a spotlight to show';

  perform public.record_boost_event('bbbbbbb1-0000-0000-0000-0000000000c1', 'spotlight');

  select count(*) into n from public.sponsored_events('spotlight', p_limit => 3);
  assert n = 0, 'and after one, there are no more today — from anybody';

  reset role;
  raise notice 'PASS one spotlight a day, in total';
end $$;

-- --- a spent budget stops delivering ----------------------------------------
do $$
declare n integer;
begin
  update public.event_boosts
  set impressions_served = impression_budget
  where id = 'bbbbbbb1-0000-0000-0000-0000000000c3';

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', true);
  select count(*) into n from public.sponsored_events('feed', p_limit => 5)
  where event_id = 'aaaaaaa1-0000-0000-0000-0000000000b3';
  reset role;

  assert n = 0, 'a spent budget is the end of the boost';
  raise notice 'PASS what is not delivered is not shown';
end $$;

-- --- an organizer cannot spend their own budget by looking at it ------------
do $$
declare before_n integer; after_n integer;
begin
  select impressions_served into before_n from public.event_boosts
  where id = 'bbbbbbb1-0000-0000-0000-0000000000c1';

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
  perform public.record_boost_event('bbbbbbb1-0000-0000-0000-0000000000c1', 'feed');
  reset role;

  select impressions_served into after_n from public.event_boosts
  where id = 'bbbbbbb1-0000-0000-0000-0000000000c1';

  assert after_n = before_n, 'refreshing your own event is not reach';
  raise notice 'PASS the organizer''s own screens do not spend their budget';
end $$;

-- --- the report says what was delivered, narrowly ---------------------------
do $$
declare rep jsonb; row jsonb;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
  select public.boost_report('aaaaaaa1-0000-0000-0000-0000000000b1') into rep;
  reset role;

  assert jsonb_array_length(rep) = 1, 'one boost on this event';
  row := rep -> 0;

  -- Three feed views from one person plus one spotlight from another, and the
  -- organizer's own view, which was refused. The distinction the report has to
  -- get right is the next line: four impressions, two people.
  assert (row ->> 'impressions_served')::int = 4, format('four impressions, got %s',
    row ->> 'impressions_served');
  assert (row ->> 'people_reached')::int = 2,
    format('reach is people, not impressions — got %s', row ->> 'people_reached');
  assert (row ->> 'tickets_attributed')::int = 0, 'nothing was bought';

  raise notice 'PASS reach is people (%), not impressions (%)',
    row ->> 'people_reached', row ->> 'impressions_served';
end $$;

-- --- and a stranger gets no report ------------------------------------------
do $$
declare failed boolean := false;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', true);
  begin
    perform public.boost_report('aaaaaaa1-0000-0000-0000-0000000000b1');
  exception when others then failed := true;
  end;
  reset role;
  assert failed, 'somebody else''s ad spend is not public';
  raise notice 'PASS the report is the organizer''s only';
end $$;

-- --- the free weekly boost --------------------------------------------------
do $$
declare
  b      public.event_boosts;
  failed boolean := false;
  state  jsonb;
begin
  insert into public.premium_subscriptions
    (user_id, platform, product_id, status, original_transaction_id, expires_at, auto_renew)
  values ('22222222-2222-2222-2222-222222222222', 'stripe', 'premium.monthly', 'active',
          'sub_boost_test', now() + interval '30 days', true);

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);

  select public.my_free_boost() into state;
  assert (state ->> 'available')::boolean, 'a subscriber has this week''s boost';

  b := public.claim_free_boost('aaaaaaa1-0000-0000-0000-0000000000b1');
  assert b.amount_cents = 0, 'it costs nothing';
  assert b.payment_status = 'succeeded', 'and it is live immediately';
  assert b.impression_budget > 0, 'with a real budget behind it';

  select public.my_free_boost() into state;
  assert not (state ->> 'available')::boolean, 'and it is gone for this week';

  begin
    perform public.claim_free_boost('aaaaaaa1-0000-0000-0000-0000000000b1');
  exception when others then failed := true;
  end;
  assert failed, 'a second one in the same week is refused by the index, not by a check';

  reset role;
  raise notice 'PASS one free boost a week, enforced by the database';
end $$;

-- --- and not for somebody who does not pay ----------------------------------
do $$
declare failed boolean := false;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', true);
  begin
    perform public.claim_free_boost('aaaaaaa1-0000-0000-0000-0000000000b1');
  exception when others then failed := true;
  end;
  reset role;
  assert failed, 'the free boost is a Premium thing';
  raise notice 'PASS the free boost needs the subscription';
end $$;

rollback;
