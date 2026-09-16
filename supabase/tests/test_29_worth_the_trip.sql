-- ============================================================================
-- BLUP test 29 · Events worth travelling for
-- ============================================================================
-- Somebody in Nitra should hear about the one concert in Bratislava they would
-- have driven to, and about nothing else that far away.
\set ON_ERROR_STOP on

begin;

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'nitran@blup.test'),
  ('22222222-2222-2222-2222-222222222222', 'organizer@blup.test');

-- Nitra.
update public.profiles set latitude = 48.3069, longitude = 18.0864
where id = '11111111-1111-1111-1111-111111111111';

-- The schema seeds interests, so take the one that is there rather than adding
-- a second 'techno' that the unique slug would reject anyway.
insert into public.interests (slug, name, category, sort_order)
values ('techno', 'Techno', 'techno', 1)
on conflict (slug) do nothing;

insert into public.user_interests (user_id, interest_id)
select '11111111-1111-1111-1111-111111111111', i.id
from public.interests i where i.category = 'techno' limit 1;

-- Bratislava, ~80 km away: big, matches their taste.
insert into public.events (id, creator_id, title, category, latitude, longitude,
                           start_at, end_at, is_free, attendee_count)
values ('aaaaaaa1-0000-0000-0000-0000000000b1', '22222222-2222-2222-2222-222222222222',
        'Veľká techno noc', 'techno', 48.1486, 17.1077,
        now() + interval '12 days', now() + interval '12 days 6 hours', true, 90);

-- Also Bratislava, also far — but nobody is going and it is not their thing.
insert into public.events (id, creator_id, title, category, latitude, longitude,
                           start_at, end_at, is_free, attendee_count)
values ('aaaaaaa1-0000-0000-0000-0000000000b2', '22222222-2222-2222-2222-222222222222',
        'Prednáška o účtovníctve', 'business', 48.1486, 17.1077,
        now() + interval '12 days', now() + interval '12 days 3 hours', true, 2);

-- Košice, ~300 km: too far to go for an evening, however good.
insert into public.events (id, creator_id, title, category, latitude, longitude,
                           start_at, end_at, is_free, attendee_count)
values ('aaaaaaa1-0000-0000-0000-0000000000b3', '22222222-2222-2222-2222-222222222222',
        'Techno na druhom konci republiky', 'techno', 48.7164, 21.2611,
        now() + interval '12 days', now() + interval '12 days 6 hours', true, 300);

-- Nitra itself: near, so it belongs to the ordinary list, not this one.
insert into public.events (id, creator_id, title, category, latitude, longitude,
                           start_at, end_at, is_free, attendee_count)
values ('aaaaaaa1-0000-0000-0000-0000000000b4', '22222222-2222-2222-2222-222222222222',
        'Doma v Nitre', 'techno', 48.3100, 18.0900,
        now() + interval '12 days', now() + interval '12 days 4 hours', true, 120);

-- --- what comes back ---------------------------------------------------------
do $$
declare
  ids uuid[];
begin
  select array_agg(id order by score desc) into ids
  from public.events_worth_the_trip('11111111-1111-1111-1111-111111111111');

  assert 'aaaaaaa1-0000-0000-0000-0000000000b1' = any (ids),
    'the big techno night 80 km away is exactly what this list is for';

  assert not ('aaaaaaa1-0000-0000-0000-0000000000b4' = any (ids)),
    'an event at home belongs to the ordinary list, not this one';

  assert not ('aaaaaaa1-0000-0000-0000-0000000000b3' = any (ids)),
    'three hundred kilometres is not a trip for an evening';

  assert not ('aaaaaaa1-0000-0000-0000-0000000000b2' = any (ids)),
    'nobody drives an hour to a lecture two people are going to';

  raise notice 'PASS only what is actually worth the drive comes back';
end $$;

-- --- already going, already answered -----------------------------------------
do $$
declare n integer;
begin
  insert into public.event_attendees (event_id, user_id, status)
  values ('aaaaaaa1-0000-0000-0000-0000000000b1',
          '11111111-1111-1111-1111-111111111111', 'going');

  select count(*) into n
  from public.events_worth_the_trip('11111111-1111-1111-1111-111111111111')
  where id = 'aaaaaaa1-0000-0000-0000-0000000000b1';

  assert n = 0, 'an event they already said yes to is not a suggestion';
  raise notice 'PASS what you already answered is not suggested again';
end $$;

-- --- no location, no guesses --------------------------------------------------
do $$
declare n integer;
begin
  update public.profiles set latitude = null, longitude = null
  where id = '11111111-1111-1111-1111-111111111111';

  select count(*) into n
  from public.events_worth_the_trip('11111111-1111-1111-1111-111111111111');

  assert n = 0, 'without a location there is no such thing as "far away"';
  raise notice 'PASS no location means no suggestions rather than random ones';
end $$;

rollback;
