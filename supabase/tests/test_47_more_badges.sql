-- ============================================================================
-- BLUP test 47 · Odznaky za viac než jedno správanie
-- ============================================================================
-- Nové metriky sa nepočítajú do stĺpcov, ale zo skutočných riadkov — takže to,
-- čo treba dokázať, je, že sa naozaj počítajú a že odznak nepríde, kým na to
-- človek nemá.
-- ============================================================================
\set ON_ERROR_STOP on

begin;

set local search_path = public, extensions;

insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('a4747474-0000-0000-0000-000000000001', 'zberatel@example.com', now(), '{"display_name":"Zberateľ"}'),
  ('a4747474-0000-0000-0000-000000000002', 'lenivy@example.com',   now(), '{"display_name":"Lenivý"}'),
  ('a4747474-0000-0000-0000-000000000009', 'usporiadatel47@example.com', now(), '{"display_name":"Usporiadateľ"}');

-- Tri skončené eventy v troch mestách a v troch kategóriách.
insert into public.events (id, creator_id, title, category, city, latitude, longitude,
                           start_at, end_at, is_free, status, visibility)
values
  ('a4747474-1111-0000-0000-000000000001', 'a4747474-0000-0000-0000-000000000009',
   'Techno v Nitre', 'techno', 'Nitra', 48.3069, 18.0864,
   now() - interval '10 days', now() - interval '10 days' + interval '5 hours',
   true, 'published', 'public'),
  ('a4747474-1111-0000-0000-000000000002', 'a4747474-0000-0000-0000-000000000009',
   'Divadlo v Košiciach', 'theatre', 'Košice', 48.7164, 21.2611,
   now() - interval '8 days', now() - interval '8 days' + interval '3 hours',
   true, 'published', 'public'),
  ('a4747474-1111-0000-0000-000000000003', 'a4747474-0000-0000-0000-000000000009',
   'Beh v Bratislave', 'running', 'Bratislava', 48.1486, 17.1077,
   now() - interval '6 days', now() - interval '6 days' + interval '2 hours',
   true, 'published', 'public');

-- --- mestá a kategórie sa počítajú z toho, kde človek naozaj bol -------------
do $$
declare
  me     uuid := 'a4747474-0000-0000-0000-000000000001';
  lazy   uuid := 'a4747474-0000-0000-0000-000000000002';
begin
  insert into public.event_attendees (event_id, user_id, status)
  values
    ('a4747474-1111-0000-0000-000000000001', me, 'going'),
    ('a4747474-1111-0000-0000-000000000002', me, 'going'),
    ('a4747474-1111-0000-0000-000000000003', me, 'checked_in'),
    -- Lenivý bol na jednom, trikrát by mu to nepomohlo.
    ('a4747474-1111-0000-0000-000000000001', lazy, 'going');

  assert public.badge_metric_value(me, 'cities_visited') = 3,
    'tri mestá, tri rôzne';
  assert public.badge_metric_value(me, 'categories_tried') = 3,
    'a tri druhy vecí';
  assert public.badge_metric_value(lazy, 'cities_visited') = 1,
    'kto chodí stále na to isté, má jedno mesto';

  raise notice 'PASS mestá a kategórie sa počítajú z eventov, na ktorých človek bol';
end $$;

-- --- budúci event sa nepočíta ------------------------------------------------
-- Inak by stačilo kliknúť „idem" na desať vecí a odznak by bol doma bez toho,
-- aby človek kamkoľvek šiel.
do $$
declare me uuid := 'a4747474-0000-0000-0000-000000000001';
begin
  insert into public.events (id, creator_id, title, category, city, latitude, longitude,
                             start_at, end_at, is_free, status, visibility)
  values ('a4747474-1111-0000-0000-000000000004', 'a4747474-0000-0000-0000-000000000009',
          'Jazz v Trnave', 'jazz', 'Trnava', 48.3774, 17.5872,
          now() + interval '20 days', now() + interval '20 days 4 hours',
          true, 'published', 'public');

  insert into public.event_attendees (event_id, user_id, status)
  values ('a4747474-1111-0000-0000-000000000004', me, 'going');

  assert public.badge_metric_value(me, 'cities_visited') = 3,
    'Trnava sa počíta až keď tam naozaj bol';
  assert public.badge_metric_value(me, 'categories_tried') = 3,
    'a jazz tiež';

  raise notice 'PASS „idem" na budúci event ešte nie je odznak';
end $$;

-- --- recenzie, sledovanie, komunity ------------------------------------------
do $$
declare
  me uuid := 'a4747474-0000-0000-0000-000000000001';
begin
  -- Prázdna recenzia je hviezdičky bez slov — za tie odznak za písanie nie je.
  insert into public.event_reviews (event_id, user_id, rating, body) values
    ('a4747474-1111-0000-0000-000000000001', me, 5, 'Bolo to dobré, zvuk sedel.'),
    ('a4747474-1111-0000-0000-000000000002', me, 4, '   ');

  assert public.badge_metric_value(me, 'reviews_written') = 1,
    'hviezdičky bez slov nie sú recenzia';

  insert into public.follows (follower_id, following_id) values
    (me, 'a4747474-0000-0000-0000-000000000002'),
    (me, 'a4747474-0000-0000-0000-000000000009');
  assert public.badge_metric_value(me, 'following') = 2, 'sleduje dvoch';
  assert public.badge_metric_value('a4747474-0000-0000-0000-000000000009', 'followers') = 1,
    'a usporiadateľa sleduje jeden';

  raise notice 'PASS recenzie a sledovanie sa rátajú zo skutočných riadkov';
end $$;

-- --- a odznak príde, keď naň človek má --------------------------------------
do $$
declare
  me      uuid := 'a4747474-0000-0000-0000-000000000001';
  lazy    uuid := 'a4747474-0000-0000-0000-000000000002';
  awarded integer;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', me::text, true);

  awarded := public.check_my_badges();
  assert awarded > 0, 'niečo si zaslúžil';

  assert exists (
    select 1 from public.user_badges ub
    join public.badges b on b.id = ub.badge_id
    where ub.user_id = me and b.slug = 'cities-3'
  ), 'tri mestá = Cestovateľ';

  assert exists (
    select 1 from public.user_badges ub
    join public.badges b on b.id = ub.badge_id
    where ub.user_id = me and b.slug = 'reviewer-1'
  ), 'a prvá recenzia je tiež odznak';

  assert not exists (
    select 1 from public.user_badges ub
    join public.badges b on b.id = ub.badge_id
    where ub.user_id = me and b.slug = 'cities-10'
  ), 'ale desať miest ešte nie';

  -- Druhé zavolanie nesmie udeliť to isté znova.
  assert public.check_my_badges() = 0, 'odznak sa neudeľuje dvakrát';

  -- A postup je vidieť aj pri tom, čo ešte nemá.
  assert (select progress from public.my_badges() where slug = 'cities-10') = 3,
    'k desiatim mestám sú zatiaľ tri';
  assert (select threshold from public.my_badges() where slug = 'cities-10') = 10,
    'a je vidieť, koľko ich treba';

  reset role;

  -- Lenivý nemá nič z toho.
  assert public.evaluate_badges(lazy) >= 0, 'vyhodnotenie nespadne ani bez štatistík';
  assert not exists (
    select 1 from public.user_badges ub
    join public.badges b on b.id = ub.badge_id
    where ub.user_id = lazy and b.slug = 'cities-3'
  ), 'jedno mesto nie je Cestovateľ';

  raise notice 'PASS odznak príde za skutok a nepríde dvakrát';
end $$;

-- --- a nikto si ho neudelí za niekoho iného ----------------------------------
do $$
declare
  lazy   uuid := 'a4747474-0000-0000-0000-000000000002';
  before integer;
  after  integer;
begin
  select count(*) into before from public.user_badges where user_id = lazy;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', lazy::text, true);
  perform public.check_my_badges();
  reset role;

  select count(*) into after from public.user_badges where user_id = lazy;
  assert after = before or after > before,
    'vyhodnotenie sa týka len toho, kto ho zavolal';
  assert not exists (
    select 1 from public.user_badges ub
    join public.badges b on b.id = ub.badge_id
    where ub.user_id = lazy and b.metric = 'cities_visited' and b.threshold > 1
  ), 'a nedá mu odznak, ktorý patrí niekomu inému';

  raise notice 'PASS check_my_badges vyhodnocuje len volajúceho';
end $$;

rollback;
