-- ============================================================================
-- BLUP test 37 · What the second ranker fixed
-- ============================================================================
-- One of these is a bug that had been live since multiple categories arrived:
-- an event tagged techno *and* art was invisible to everybody who likes art.
-- The rest are the difference between a list and a recommendation.
\set ON_ERROR_STOP on

begin;

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'divak@blup.test'),
  ('22222222-2222-2222-2222-222222222222', 'organizator@blup.test');

update public.profiles set latitude = 48.1486, longitude = 17.1077
where id = '11111111-1111-1111-1111-111111111111';

-- The catalogue is seeded by migration 0013, where 'art' sits under the
-- 'culture' category. Picking by slug rather than inventing a category is the
-- difference between a user who likes art and a user who likes nothing — and a
-- test that asserts nothing while looking like it asserts something.
insert into public.user_interests (user_id, interest_id)
select '11111111-1111-1111-1111-111111111111', i.id
from public.interests i where i.slug = 'art' limit 1;

do $$
begin
  assert exists (select 1 from public.user_interests
                 where user_id = '11111111-1111-1111-1111-111111111111'),
    'the fixture itself has to work: this person must actually like something';
end $$;

-- --- the bug: a secondary category was invisible ----------------------------
do $$
declare
  hits numeric;
  bd   jsonb;
begin
  insert into public.events (id, creator_id, title, category, categories,
                             latitude, longitude, start_at, end_at, is_free)
  values ('aaaaaaa1-0000-0000-0000-0000000000b1', '22222222-2222-2222-2222-222222222222',
          'Techno s výstavou', 'techno', array['techno', 'art'],
          48.1490, 17.1080, now() + interval '2 days', now() + interval '2 days 5 hours', true);

  select score_breakdown into bd
  from public.recommend_events('11111111-1111-1111-1111-111111111111', 48.1486, 17.1077, 50000, 20)
  where id = 'aaaaaaa1-0000-0000-0000-0000000000b1';

  assert bd is not null, 'the event is in the list at all';
  hits := (bd -> 'facts' ->> 'interest_hits')::numeric;
  assert hits > 0,
    'an event whose SECOND category matches must count as a match — this was the bug';

  raise notice 'PASS every category counts, not only the first';
end $$;

-- --- momentum is a rate, not a total ----------------------------------------
do $$
declare
  old_score numeric;
  new_score numeric;
begin
  -- An old event with a big crowd, and a new one filling fast right now.
  insert into public.events (id, creator_id, title, category, latitude, longitude,
                             start_at, end_at, is_free, attendee_count, capacity, created_at)
  values
    ('aaaaaaa1-0000-0000-0000-0000000000b2', '22222222-2222-2222-2222-222222222222',
     'Stará veľká akcia', 'art', 48.1490, 17.1080,
     now() + interval '9 days', now() + interval '9 days 4 hours', true, 300, 2000,
     now() - interval '120 days'),
    ('aaaaaaa1-0000-0000-0000-0000000000b3', '22222222-2222-2222-2222-222222222222',
     'Práve sa plní', 'art', 48.1490, 17.1080,
     now() + interval '9 days', now() + interval '9 days 4 hours', true, 90, 100,
     now() - interval '30 days');

  -- Twenty people did something about the second one in the last three days.
  insert into public.user_event_signals (user_id, event_id, signal, weight, created_at)
  select '22222222-2222-2222-2222-222222222222', 'aaaaaaa1-0000-0000-0000-0000000000b3',
         'save', 1.0, now() - (i || ' hours')::interval
  from generate_series(1, 20) i;

  select score into old_score from public.recommend_events(
    '11111111-1111-1111-1111-111111111111', 48.1486, 17.1077, 50000, 30)
  where id = 'aaaaaaa1-0000-0000-0000-0000000000b2';

  select score into new_score from public.recommend_events(
    '11111111-1111-1111-1111-111111111111', 48.1486, 17.1077, 50000, 30)
  where id = 'aaaaaaa1-0000-0000-0000-0000000000b3';

  assert new_score > old_score,
    format('the one filling now must beat the one that filled in March (%s vs %s)',
           new_score, old_score);

  raise notice 'PASS trending means a rate, not a total (% > %)', new_score, old_score;
end $$;

-- --- shown and ignored goes down --------------------------------------------
do $$
declare
  before_score numeric;
  after_score  numeric;
  bd           jsonb;
  i            integer;
begin
  select score into before_score from public.recommend_events(
    '11111111-1111-1111-1111-111111111111', 48.1486, 17.1077, 50000, 30)
  where id = 'aaaaaaa1-0000-0000-0000-0000000000b2';

  -- Put it in front of them eight times. They never open it.
  for i in 1..8 loop
    insert into public.event_views (event_id, user_id, source, created_at)
    values ('aaaaaaa1-0000-0000-0000-0000000000b2',
            '11111111-1111-1111-1111-111111111111', 'feed', now() - (i || ' hours')::interval);
  end loop;

  select score, score_breakdown into after_score, bd from public.recommend_events(
    '11111111-1111-1111-1111-111111111111', 48.1486, 17.1077, 50000, 30)
  where id = 'aaaaaaa1-0000-0000-0000-0000000000b2';

  assert after_score < before_score,
    format('eight views and no interest must cost it something (%s -> %s)',
           before_score, after_score);
  assert (bd -> 'components' ->> 'fatigue')::numeric > 0, 'and the breakdown says why';
  assert after_score > 0, 'but it is pushed down, not buried';

  raise notice 'PASS scrolling past something repeatedly moves it down (% -> %)',
    before_score, after_score;
end $$;

-- --- opening it once cancels the fatigue ------------------------------------
do $$
declare bd jsonb;
begin
  perform set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
  insert into public.user_event_signals (user_id, event_id, signal, weight)
  values ('11111111-1111-1111-1111-111111111111', 'aaaaaaa1-0000-0000-0000-0000000000b2',
          'open_detail', 1.0);

  select score_breakdown into bd from public.recommend_events(
    '11111111-1111-1111-1111-111111111111', 48.1486, 17.1077, 50000, 30)
  where id = 'aaaaaaa1-0000-0000-0000-0000000000b2';

  assert (bd -> 'components' ->> 'fatigue')::numeric = 0,
    'interest cancels it — this only ever punishes the genuinely scrolled-past';

  raise notice 'PASS opening something once clears its fatigue';
end $$;

-- --- a brand-new event gets a chance to be seen -----------------------------
do $$
declare bd jsonb;
begin
  insert into public.events (id, creator_id, title, category, latitude, longitude,
                             start_at, end_at, is_free, attendee_count, created_at)
  values ('aaaaaaa1-0000-0000-0000-0000000000b4', '22222222-2222-2222-2222-222222222222',
          'Úplne nový', 'art', 48.1490, 17.1080,
          now() + interval '9 days', now() + interval '9 days 4 hours', true, 0, now());

  select score_breakdown into bd from public.recommend_events(
    '11111111-1111-1111-1111-111111111111', 48.1486, 17.1077, 50000, 30)
  where id = 'aaaaaaa1-0000-0000-0000-0000000000b4';

  assert bd is not null, 'an event with nobody going is still shown to somebody';
  assert (bd -> 'components' ->> 'freshness')::numeric > 0.9,
    'and its freshness is what got it there';

  raise notice 'PASS a new event has a way into the feed at all';
end $$;

-- --- the reason names what actually carried the score -----------------------
do $$
declare r record;
begin
  for r in
    select id, score_breakdown as bd from public.recommend_events(
      '11111111-1111-1111-1111-111111111111', 48.1486, 17.1077, 50000, 30)
  loop
    -- Whatever it says, it has to be true.
    if r.bd ->> 'reason' = 'friends' then
      assert (r.bd -> 'facts' ->> 'friends_going')::int > 0
          or (r.bd -> 'facts' ->> 'mutuals_going')::int > 0,
        'nothing may claim friends without one';
    end if;
    if r.bd ->> 'reason' = 'promoted' then
      assert (r.bd -> 'facts' ->> 'is_boosted')::boolean, 'nor promotion without a boost';
    end if;
    if r.bd ->> 'reason' = 'new' then
      assert (r.bd -> 'components' ->> 'freshness')::numeric > 0,
        'nor newness without freshness';
    end if;
  end loop;

  raise notice 'PASS every stated reason is one the ranking actually used';
end $$;

rollback;
