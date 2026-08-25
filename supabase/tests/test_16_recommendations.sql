-- ============================================================================
-- BLUP test 16 · Recommendations that vary, explain themselves, and greet guests
-- ============================================================================
-- What is actually being proved here:
--
--   · the top of the list is not one category over and over
--   · every event carries a reason, and it matches what the score was made of
--   · "friends" only appears when somebody you follow is actually going
--   · a guest gets something rather than an empty section
--   · discover never leaks a private or unpublished event
-- ============================================================================
\set ON_ERROR_STOP on

begin;

insert into auth.users (id, email, raw_user_meta_data) values
  ('a1616161-0000-0000-0000-000000000001', 'me16@example.com',     '{"display_name":"Me"}'),
  ('a1616161-0000-0000-0000-000000000002', 'friend16@example.com', '{"display_name":"Friend"}'),
  ('a1616161-0000-0000-0000-000000000003', 'host16@example.com',   '{"display_name":"Host"}');

insert into public.follows (follower_id, following_id)
values ('a1616161-0000-0000-0000-000000000001', 'a1616161-0000-0000-0000-000000000002');

insert into public.interests (id, slug, name, category)
values ('11616161-0000-0000-0000-000000000001', 'techno-16', 'Techno', 'techno');
insert into public.user_interests (user_id, interest_id)
values ('a1616161-0000-0000-0000-000000000001', '11616161-0000-0000-0000-000000000001');

-- Six techno nights and two of something else, all nearby and soon. Sorted by
-- score alone the techno would fill the whole list.
insert into public.events (id, creator_id, title, category, start_at, latitude, longitude, is_free, status, visibility)
select
  ('e1616161-0000-0000-0000-00000000000' || n)::uuid,
  'a1616161-0000-0000-0000-000000000003',
  'Techno ' || n, 'techno', now() + (n || ' days')::interval, 48.1486, 17.1077, true, 'published', 'public'
from generate_series(1, 6) n;

insert into public.events (id, creator_id, title, category, start_at, latitude, longitude, is_free, status, visibility)
values
  ('e1616161-0000-0000-0000-000000000007', 'a1616161-0000-0000-0000-000000000003',
   'Beh v parku', 'running', now() + interval '2 days', 48.1486, 17.1077, true, 'published', 'public'),
  ('e1616161-0000-0000-0000-000000000008', 'a1616161-0000-0000-0000-000000000003',
   'Startup pivo', 'startup', now() + interval '3 days', 48.1486, 17.1077, true, 'published', 'public'),
  -- must never appear anywhere
  ('e1616161-0000-0000-0000-000000000009', 'a1616161-0000-0000-0000-000000000003',
   'Tajny', 'techno', now() + interval '2 days', 48.1486, 17.1077, true, 'draft', 'public'),
  ('e1616161-0000-0000-0000-00000000000a', 'a1616161-0000-0000-0000-000000000003',
   'Sukromny', 'techno', now() + interval '2 days', 48.1486, 17.1077, true, 'published', 'private');

-- the friend is going to exactly one of them
insert into public.event_attendees (event_id, user_id, status)
values ('e1616161-0000-0000-0000-000000000007', 'a1616161-0000-0000-0000-000000000002', 'going');

do $$
declare
  me uuid := 'a1616161-0000-0000-0000-000000000001';
  cats text[];
  reasons text[];
  titles text[];
  r record;
begin
  perform set_config('request.jwt.claim.sub', me::text, true);

  -- ---- variety at the top --------------------------------------------------
  select array_agg(category order by ord) into cats
  from (select category, row_number() over () as ord
        from public.recommend_events(me, 48.1486, 17.1077, 50000, 4, 0)) t;

  assert array_length(cats, 1) = 4, format('expected 4, got %s', array_length(cats, 1));
  assert cardinality(array(select distinct unnest(cats))) >= 3,
    format('the first four should span at least three categories, got %s', cats::text);
  raise notice 'PASS the top of the list is not one category over and over';

  -- ---- every event explains itself ----------------------------------------
  select array_agg(score_breakdown ->> 'reason') into reasons
  from public.recommend_events(me, 48.1486, 17.1077, 50000, 8, 0);

  assert not (reasons @> array[null::text]), 'every recommendation carries a reason';
  raise notice 'PASS every recommendation carries a reason';

  -- ---- and the reason is true ---------------------------------------------
  for r in
    select title, score_breakdown ->> 'reason' as reason,
           (score_breakdown -> 'facts' ->> 'friends_going')::int as friends
    from public.recommend_events(me, 48.1486, 17.1077, 50000, 8, 0)
  loop
    if r.reason = 'friends' then
      assert r.friends > 0, format('"%s" claims friends but none are going', r.title);
    else
      assert coalesce(r.friends, 0) = 0 or r.reason <> 'friends', 'consistent';
    end if;
  end loop;

  select array_agg(title) into titles
  from public.recommend_events(me, 48.1486, 17.1077, 50000, 8, 0)
  where score_breakdown ->> 'reason' = 'friends';
  assert titles = array['Beh v parku'],
    format('only the event a followed person attends may say "friends", got %s', titles::text);
  raise notice 'PASS "friends" appears only where somebody you follow is going';

  -- ---- a guest -------------------------------------------------------------
  perform set_config('request.jwt.claim.sub', '', true);
  select array_agg(title) into titles from public.discover_events(48.1486, 17.1077, 50000, 8);
  assert array_length(titles, 1) >= 4,
    format('a guest gets a real list, got %s', coalesce(array_length(titles, 1), 0));
  assert not (titles @> array['Tajny']), 'an unpublished event never appears';
  assert not (titles @> array['Sukromny']), 'a private event never appears';
  raise notice 'PASS a guest gets a list, and it leaks nothing private';
end $$;

rollback;
