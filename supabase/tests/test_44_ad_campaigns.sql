-- ============================================================================
-- BLUP test 44 · The buying side of the ad system
-- ============================================================================
-- 0062 built delivery and 0073 built buying, and the thing worth proving is
-- that they are the same system: a campaign bought here is delivered by the
-- same auction, refused by the same relevance floor, and — the new one — is
-- actually stopped by its own pause button.
\set ON_ERROR_STOP on

begin;

insert into auth.users (id, email) values
  ('44444444-4444-4444-4444-444444444441', 'nitran@blup.test'),
  ('44444444-4444-4444-4444-444444444442', 'usporiadatel@blup.test'),
  ('44444444-4444-4444-4444-444444444443', 'bratislavcan@blup.test'),
  ('44444444-4444-4444-4444-444444444444', 'cudzi@blup.test');

-- One person in Nitra who likes techno, one in Bratislava (80 km) who does not.
update public.profiles set latitude = 48.3069, longitude = 18.0864
where id = '44444444-4444-4444-4444-444444444441';

update public.profiles set latitude = 48.1486, longitude = 17.1077
where id = '44444444-4444-4444-4444-444444444443';

-- Activity is the streak tracker: one of them was out two days ago, the other
-- has not opened BLUP in over a year.
insert into public.user_stats (user_id, last_active_on) values
  ('44444444-4444-4444-4444-444444444441', current_date - 2),
  ('44444444-4444-4444-4444-444444444443', current_date - 400)
on conflict (user_id) do update set last_active_on = excluded.last_active_on;

insert into public.user_interests (user_id, interest_id)
select '44444444-4444-4444-4444-444444444441', i.id
from public.interests i where i.slug = 'techno' limit 1;

insert into public.events (id, creator_id, title, category, latitude, longitude,
                           start_at, end_at, is_free, status, visibility)
values
  ('44444444-0000-0000-0000-0000000000e1', '44444444-4444-4444-4444-444444444442',
   'Kampaňové techno', 'techno', 48.3100, 18.0900,
   now() + interval '10 days', now() + interval '10 days 6 hours',
   true, 'published', 'public'),
  -- Far enough out that a sixty-day campaign fits inside it, which is the only
  -- way to see the weight floor rather than the end-of-event clamp.
  ('44444444-0000-0000-0000-0000000000e2', '44444444-4444-4444-4444-444444444442',
   'Festival o tri mesiace', 'techno', 48.3100, 18.0900,
   now() + interval '120 days', now() + interval '122 days',
   true, 'published', 'public');

-- --- the audience is a number, and it is the right number -------------------
do $$
declare
  near jsonb;
  far  jsonb;
  wrong jsonb;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub',
                     '44444444-4444-4444-4444-444444444442', true);

  near := public.ad_audience_estimate('44444444-0000-0000-0000-0000000000e1', 30000, null);
  assert (near ->> 'people')::int >= 1,
    'somebody 3 km away is inside a 30 km radius';
  assert (near ->> 'active_people')::int >= 1,
    'and they opened the app two days ago';
  assert not ((near ->> 'people')::int > 1 and (near ->> 'active_people')::int > 1),
    'the Bratislavčan is 80 km away and has not opened it in a year';

  -- Widen it and the far one appears in `people` but not in `active_people`:
  -- the screen shows both precisely so nobody reads reach as delivery.
  far := public.ad_audience_estimate('44444444-0000-0000-0000-0000000000e1', 200000, null);
  assert (far ->> 'people')::int > (near ->> 'people')::int,
    'a wider radius contains more people';
  assert (far ->> 'active_people')::int = (near ->> 'active_people')::int,
    'but not more ACTIVE people — the Bratislavčan has been gone a year';

  -- Targeting a category nobody near here has stated empties it out.
  wrong := public.ad_audience_estimate('44444444-0000-0000-0000-0000000000e1',
                                       30000, array['business']);
  assert (wrong ->> 'people')::int = 0,
    'nobody in range has stated an interest in that category';

  -- The radius is clamped, not trusted.
  assert (public.ad_audience_estimate('44444444-0000-0000-0000-0000000000e1',
                                      9999999, null) ->> 'radius_m')::int = 200000,
    'the radius is clamped at 200 km';
  assert (public.ad_audience_estimate('44444444-0000-0000-0000-0000000000e1',
                                      1, null) ->> 'radius_m')::int = 1000,
    'and floored at 1 km';

  reset role;
  raise notice 'PASS the audience estimate counts people, and says how many are still here';
end $$;

-- --- the budget arithmetic is the rate, not a guess -------------------------
do $$
declare q jsonb;
begin
  update public.platform_settings set boost_cpm_cents = 250;

  q := public.ad_budget_quote(2500);
  assert (q ->> 'cpm_cents')::int = 250, 'the rate comes from platform_settings';
  assert (q ->> 'impressions')::int = 10000, '25 € at 2,50 € CPM is 10 000 impressions';

  -- Change the rate and every future quote changes with it.
  update public.platform_settings set boost_cpm_cents = 500;
  assert (public.ad_budget_quote(2500) ->> 'impressions')::int = 5000,
    'double the rate, half the impressions';
  update public.platform_settings set boost_cpm_cents = 250;

  raise notice 'PASS budget buys impressions at the platform rate';
end $$;

-- --- buying one -------------------------------------------------------------
do $$
declare
  b public.event_boosts;
  failed boolean;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub',
                     '44444444-4444-4444-4444-444444444442', true);

  b := public.create_ad_campaign(
    '44444444-0000-0000-0000-0000000000e1',
    p_budget_cents => 5000,
    p_days         => 5,
    p_placements   => array['feed'],
    p_radius_m     => 25000,
    p_categories   => array['music']);

  assert b.payment_status = 'requires_payment',
    'nothing is promoted before the money moves';
  assert b.is_campaign, 'and it is marked as a campaign, not a package';
  assert b.impression_budget = 20000, '50 € at 2,50 € CPM';
  assert b.target_radius_m = 25000, 'the audience is stored on the boost';
  assert b.target_categories = array['music'], 'so is the targeting';
  -- 50 € over 5 days is 10 € a day → 1000 cents/day / 1000 = 1.0, capped.
  assert b.weight = 0.40, 'spend per day decides the weight, and it is capped';

  -- Queueing is behind what is PAID FOR, not behind what was merely started —
  -- otherwise anyone could block an event's promo slot by opening a checkout
  -- and walking away. So the first campaign has to be paid before the second
  -- has anything to queue behind.
  reset role;
  update public.event_boosts set payment_status = 'succeeded'
  where event_id = '44444444-0000-0000-0000-0000000000e1';
  set local role authenticated;
  perform set_config('request.jwt.claim.sub',
                     '44444444-4444-4444-4444-444444444442', true);

  -- A second campaign on the same event asks for sixty days. It gets neither
  -- sixty days nor a slot starting now: it queues behind the first and stops
  -- at the event, and BOTH clamps are visible in what it was charged for.
  b := public.create_ad_campaign('44444444-0000-0000-0000-0000000000e1',
                                 1000, 60, array['feed'], 30000, null);
  assert b.target_categories is null, 'no categories means everybody in range';
  assert b.starts_at > now() + interval '4 days',
    'a second campaign waits for the first to finish';
  assert b.ends_at <= (select coalesce(end_at, start_at + interval '4 hours')
                       from public.events
                       where id = '44444444-0000-0000-0000-0000000000e1'),
    'promotion past the end of the event is money for nothing';
  -- 10 € over the ~5 days that are actually left, not over the 60 that were
  -- typed in. The weight follows the schedule it really got.
  assert b.weight between 0.19 and 0.21,
    'the weight is spend over the REAL run, not the requested one';

  -- The floor, on an event with room to run the full sixty days: 10 € spread
  -- that thin is 0.0033 a day, and it is lifted to 0.05 so it still delivers.
  b := public.create_ad_campaign('44444444-0000-0000-0000-0000000000e2',
                                 1000, 60, array['feed'], 30000, null);
  assert b.weight = 0.05, 'and floored, so a trickle still delivers something';

  reset role;
  raise notice 'PASS a campaign is priced, weighted and scheduled by the database';
end $$;

-- --- what it refuses --------------------------------------------------------
do $$
declare
  failed text;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub',
                     '44444444-4444-4444-4444-444444444442', true);

  failed := null;
  begin
    perform public.create_ad_campaign('44444444-0000-0000-0000-0000000000e1', 100, 7);
  exception when others then failed := sqlerrm; end;
  assert failed like '%BUDGET_TOO_SMALL%', 'a euro is not a campaign, got: ' || coalesce(failed, 'nothing');

  failed := null;
  begin
    perform public.create_ad_campaign('44444444-0000-0000-0000-0000000000e1', 900000, 7);
  exception when others then failed := sqlerrm; end;
  assert failed like '%BUDGET_TOO_LARGE%', 'nor is nine thousand euro, unattended';

  failed := null;
  begin
    perform public.create_ad_campaign('44444444-0000-0000-0000-0000000000e1', 5000, 900);
  exception when others then failed := sqlerrm; end;
  assert failed like '%INVALID_SCHEDULE%', 'two and a half years is not a schedule';

  failed := null;
  begin
    perform public.create_ad_campaign('44444444-0000-0000-0000-0000000000e1', 5000, 7,
                                      array['feed', 'takeover']);
  exception when others then failed := sqlerrm; end;
  assert failed like '%INVALID_PLACEMENT%', 'you cannot invent a placement';

  reset role;
  raise notice 'PASS the limits are the database''s, not the form''s';
end $$;

-- --- and it is not open to strangers ----------------------------------------
do $$
declare failed boolean := false;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub',
                     '44444444-4444-4444-4444-444444444444', true);
  begin
    perform public.create_ad_campaign('44444444-0000-0000-0000-0000000000e1', 5000, 7);
  exception when others then failed := true; end;
  reset role;
  assert failed, 'somebody else''s event is not yours to advertise';
  raise notice 'PASS only the organizer may buy ads for the event';
end $$;

-- --- pause actually stops delivery ------------------------------------------
-- The reason this test exists: a pause button that leaves the campaign running
-- is a fake button, and the whole build forbids those.
do $$
declare
  boost_id uuid;
  shown    integer;
begin
  -- A live, paid campaign, starting now so delivery can be observed.
  insert into public.event_boosts (id, event_id, buyer_id, starts_at, ends_at, weight,
                                   amount_cents, payment_status, placements,
                                   impression_budget, target_radius_m, is_campaign)
  values ('44444444-0000-0000-0000-0000000000f1',
          '44444444-0000-0000-0000-0000000000e1',
          '44444444-4444-4444-4444-444444444442',
          now() - interval '1 hour', now() + interval '3 days', 0.20,
          5000, 'succeeded', array['feed'], 20000, 30000, true);

  set local role authenticated;
  perform set_config('request.jwt.claim.sub',
                     '44444444-4444-4444-4444-444444444441', true);
  select count(*) into shown from public.sponsored_events('feed', p_limit => 5);
  assert shown = 1, 'a paid, live, well-matched campaign is delivered';

  -- Pause it, as the organizer.
  perform set_config('request.jwt.claim.sub',
                     '44444444-4444-4444-4444-444444444442', true);
  perform public.set_ad_paused('44444444-0000-0000-0000-0000000000f1', true);

  perform set_config('request.jwt.claim.sub',
                     '44444444-4444-4444-4444-444444444441', true);
  select count(*) into shown from public.sponsored_events('feed', p_limit => 5);
  assert shown = 0, 'paused means paused — nothing is delivered';

  -- Resume it, and it is back.
  perform set_config('request.jwt.claim.sub',
                     '44444444-4444-4444-4444-444444444442', true);
  perform public.set_ad_paused('44444444-0000-0000-0000-0000000000f1', false);

  perform set_config('request.jwt.claim.sub',
                     '44444444-4444-4444-4444-444444444441', true);
  select count(*) into shown from public.sponsored_events('feed', p_limit => 5);
  assert shown = 1, 'and resuming brings it back, with its budget intact';

  reset role;
  raise notice 'PASS the pause button stops delivery and the resume button restarts it';
end $$;

-- --- one event never fills two sponsored slots ------------------------------
do $$
declare
  n     integer;
  evs   uuid[];
begin
  -- A second paid, live boost on the SAME event, which is reachable in real
  -- life: queueing only looks at boosts that are already paid for, so two
  -- campaigns bought back to back and charged together overlap.
  insert into public.event_boosts (id, event_id, buyer_id, starts_at, ends_at, weight,
                                   amount_cents, payment_status, placements,
                                   impression_budget, target_radius_m, is_campaign)
  values ('44444444-0000-0000-0000-0000000000f2',
          '44444444-0000-0000-0000-0000000000e1',
          '44444444-4444-4444-4444-444444444442',
          now() - interval '1 hour', now() + interval '3 days', 0.35,
          9000, 'succeeded', array['feed'], 36000, 30000, true);

  set local role authenticated;
  perform set_config('request.jwt.claim.sub',
                     '44444444-4444-4444-4444-444444444441', true);

  select count(*), array_agg(event_id) into n, evs
  from public.sponsored_events('feed', p_limit => 5);

  assert n = 1, 'the same event must not take two sponsored slots, got ' || n;
  assert evs[1] = '44444444-0000-0000-0000-0000000000e1', 'and it is that event';

  reset role;
  raise notice 'PASS the same event never appears twice in the sponsored slots';
end $$;

-- --- and a stranger cannot pause somebody else's campaign -------------------
do $$
declare failed boolean := false;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub',
                     '44444444-4444-4444-4444-444444444444', true);
  begin
    perform public.set_ad_paused('44444444-0000-0000-0000-0000000000f1', true);
  exception when others then failed := true; end;
  reset role;
  assert failed, 'pausing is the advertiser''s button, not everybody''s';
  raise notice 'PASS pausing is authorized like everything else';
end $$;

rollback;
