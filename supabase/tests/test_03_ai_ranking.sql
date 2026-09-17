-- ============================================================================
-- BLUP test 03 · Recommendation ranker and people matching
-- ============================================================================
\set ON_ERROR_STOP on

begin;

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'me@example.com'),
  ('22222222-2222-2222-2222-222222222222', 'creator@example.com'),
  ('55555555-5555-5555-5555-555555555555', 'twin@example.com'),
  ('66666666-6666-6666-6666-666666666666', 'nobody@example.com');

update public.profiles set latitude = 48.1486, longitude = 17.1077, city = 'Bratislava'
where id in ('11111111-1111-1111-1111-111111111111', '55555555-5555-5555-5555-555555555555');

-- I like techno + climbing
insert into public.user_interests (user_id, interest_id)
select '11111111-1111-1111-1111-111111111111', id
from public.interests where slug in ('techno', 'climbing');

-- The "twin" shares both interests; "nobody" shares none.
insert into public.user_interests (user_id, interest_id)
select '55555555-5555-5555-5555-555555555555', id
from public.interests where slug in ('techno', 'climbing');
insert into public.user_interests (user_id, interest_id)
select '66666666-6666-6666-6666-666666666666', id
from public.interests where slug in ('investing');

-- Three candidate events:
--   A: matches my interests, 1 km away, tomorrow          -> should win
--   B: unrelated category, 1 km away, tomorrow
--   C: matches my interests but 200 km away, in 13 days
insert into public.events (id, creator_id, title, category, tags, latitude, longitude, start_at)
values
  ('aaaaaaa1-0000-0000-0000-00000000000a', '22222222-2222-2222-2222-222222222222',
   'Techno night at the docks', 'techno', array['techno','nightlife'],
   48.1576, 17.1077, now() + interval '1 day'),
  ('aaaaaaa1-0000-0000-0000-00000000000b', '22222222-2222-2222-2222-222222222222',
   'Investment breakfast', 'investing', array['investing'],
   48.1576, 17.1077, now() + interval '1 day'),
  ('aaaaaaa1-0000-0000-0000-00000000000c', '22222222-2222-2222-2222-222222222222',
   'Climbing camp far away', 'climbing', array['climbing'],
   49.9500, 17.1077, now() + interval '13 days');

do $$
declare
  r record;
  first_id uuid;
  a_score numeric;
  b_score numeric;
  c_score numeric;
begin
  select id, score into first_id, a_score
  from public.recommend_events('11111111-1111-1111-1111-111111111111', 48.1486, 17.1077, 300000, 10)
  limit 1;

  assert first_id = 'aaaaaaa1-0000-0000-0000-00000000000a',
    format('interest+distance+time match should rank first, got %s', first_id);

  select score into b_score from public.recommend_events(
    '11111111-1111-1111-1111-111111111111', 48.1486, 17.1077, 300000, 10)
  where id = 'aaaaaaa1-0000-0000-0000-00000000000b';

  select score into c_score from public.recommend_events(
    '11111111-1111-1111-1111-111111111111', 48.1486, 17.1077, 300000, 10)
  where id = 'aaaaaaa1-0000-0000-0000-00000000000c';

  assert a_score > b_score, 'interest match must beat an unrelated category';
  assert a_score > c_score, 'a near, soon event must beat a far, distant-in-time one';
  raise notice 'PASS ranking order (% > %, %)', a_score, b_score, c_score;
end $$;

-- --- the breakdown must be explainable (spec §39) ---------------------------
do $$
declare bd jsonb;
begin
  select score_breakdown into bd
  from public.recommend_events('11111111-1111-1111-1111-111111111111', 48.1486, 17.1077, 300000, 10)
  where id = 'aaaaaaa1-0000-0000-0000-00000000000a';

  assert bd -> 'components' ? 'interest_match', 'breakdown must expose interest_match';
  assert bd -> 'components' ? 'distance_score', 'breakdown must expose distance_score';
  assert bd -> 'components' ? 'social_relevance', 'breakdown must expose social_relevance';
  assert bd -> 'components' ? 'past_behaviour', 'breakdown must expose past_behaviour';
  -- `popularity` became `momentum` in the v2 ranker: a total measured age, not
  -- interest — an event that filled in March outranked one selling out this
  -- week, for ever. The component is still exposed, under the name of what it
  -- now measures.
  assert bd -> 'components' ? 'momentum', 'breakdown must expose momentum';
  assert bd -> 'components' ? 'time_relevance', 'breakdown must expose time_relevance';
  assert bd -> 'components' ? 'fit', 'breakdown must expose fit';
  assert bd -> 'components' ? 'freshness', 'breakdown must expose freshness';
  assert bd -> 'components' ? 'fatigue', 'breakdown must expose fatigue';
  assert bd ->> 'engine' = 'sql_ranker_v2', format('engine is %s', bd ->> 'engine');
  assert (bd -> 'components' ->> 'interest_match')::numeric > 0,
    'the matching event must have a non-zero interest score';
  assert (bd -> 'facts' ->> 'distance_m')::numeric between 900 and 1100,
    'the breakdown must carry the real distance';
  raise notice 'PASS explainable score breakdown';
end $$;

-- --- swiping left removes an event from recommendations ---------------------
do $$
declare n integer;
begin
  perform set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
  perform public.record_signal('aaaaaaa1-0000-0000-0000-00000000000a', 'swipe_left');

  select count(*) into n
  from public.recommend_events('11111111-1111-1111-1111-111111111111', 48.1486, 17.1077, 300000, 10)
  where id = 'aaaaaaa1-0000-0000-0000-00000000000a';

  assert n = 0, 'a dismissed event must not be recommended again';
  raise notice 'PASS swipe-left suppression';
end $$;

-- --- behavioural signals shift category affinity ----------------------------
do $$
declare before_score numeric; after_score numeric;
begin
  select score into before_score
  from public.recommend_events('11111111-1111-1111-1111-111111111111', 48.1486, 17.1077, 300000, 10)
  where id = 'aaaaaaa1-0000-0000-0000-00000000000b';

  perform set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
  -- pretend the user has been buying tickets for investing events
  insert into public.events (id, creator_id, title, category, latitude, longitude, start_at)
  values ('aaaaaaa1-0000-0000-0000-00000000000d', '22222222-2222-2222-2222-222222222222',
          'Past investing meetup', 'investing', 48.15, 17.10, now() + interval '20 days');
  perform public.record_signal('aaaaaaa1-0000-0000-0000-00000000000d', 'ticket_purchase');
  perform public.record_signal('aaaaaaa1-0000-0000-0000-00000000000d', 'attended');

  select score into after_score
  from public.recommend_events('11111111-1111-1111-1111-111111111111', 48.1486, 17.1077, 300000, 10)
  where id = 'aaaaaaa1-0000-0000-0000-00000000000b';

  assert after_score > before_score,
    format('behaviour must raise the score of that category (%s -> %s)', before_score, after_score);
  raise notice 'PASS behaviour feeds the ranker';
end $$;

-- --- social relevance --------------------------------------------------------
do $$
declare with_friend numeric; without_friend numeric;
begin
  select score into without_friend
  from public.recommend_events('11111111-1111-1111-1111-111111111111', 48.1486, 17.1077, 300000, 10)
  where id = 'aaaaaaa1-0000-0000-0000-00000000000c';

  insert into public.follows (follower_id, following_id)
  values ('11111111-1111-1111-1111-111111111111', '55555555-5555-5555-5555-555555555555');
  insert into public.event_attendees (event_id, user_id, status)
  values ('aaaaaaa1-0000-0000-0000-00000000000c', '55555555-5555-5555-5555-555555555555', 'going');

  select score into with_friend
  from public.recommend_events('11111111-1111-1111-1111-111111111111', 48.1486, 17.1077, 300000, 10)
  where id = 'aaaaaaa1-0000-0000-0000-00000000000c';

  assert with_friend > without_friend,
    'an event a followed user attends must score higher';
  raise notice 'PASS social relevance';
end $$;

-- --- people matching ---------------------------------------------------------
do $$
declare r record;
begin
  select * into r
  from public.recommend_people('66666666-6666-6666-6666-666666666666', null, 10)
  limit 1;
  -- 'nobody' shares nothing with anyone, so there should be no suggestions
  assert r is null, 'people matching must not invent connections';

  -- twin shares 2 interests with me but I already follow them, so exclude twin
  -- and check the reverse direction instead
  select * into r
  from public.recommend_people('55555555-5555-5555-5555-555555555555', null, 10)
  limit 1;

  assert r.user_id = '11111111-1111-1111-1111-111111111111',
    'the user with shared interests must be suggested';
  assert r.shared_interests = 2, format('expected 2 shared interests, got %s', r.shared_interests);
  assert 'Techno' = any (r.shared_interest_names), 'shared interest names must be returned';
  assert r.score > 0, 'people score must be positive';
  raise notice 'PASS people matching (% shared interests)', r.shared_interests;
end $$;

-- --- recommendation runs are logged for the debug screen --------------------
do $$
declare v_run_id uuid; n integer;
begin
  perform set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
  v_run_id := public.log_recommendation_run(
    'for_you',
    jsonb_build_object('radius_m', 50000),
    jsonb_build_array(jsonb_build_object(
      'event_id', 'aaaaaaa1-0000-0000-0000-00000000000b',
      'rank', 1, 'score', 0.77,
      'breakdown', jsonb_build_object('interest_match', 0.5)
    ))
  );
  select count(*) into n from public.ai_recommendation_items where run_id = v_run_id;
  assert n = 1, 'the recommendation run must persist its items';
  raise notice 'PASS recommendation run logging';
end $$;

rollback;
