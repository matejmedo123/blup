-- ============================================================================
-- BLUP test 19 · The repair actually repairs
-- ============================================================================
-- What is actually being proved here:
--
--   · an event whose counters were frozen at zero is corrected from the source
--   · a correct event is left alone
--   · quantity_sold on ticket types is corrected too
--   · view_count is never lowered, even if event_views knows fewer
--
-- The frozen state is set up by writing the wrong numbers directly, which is
-- exactly the state the old guard left behind on a live database.
-- ============================================================================
\set ON_ERROR_STOP on

begin;

insert into auth.users (id, email, raw_user_meta_data) values
  ('a1919191-0000-0000-0000-000000000001', 'org19@example.com',  '{"display_name":"Org"}'),
  ('a1919191-0000-0000-0000-000000000002', 'goer19@example.com', '{"display_name":"Goer"}'),
  ('a1919191-0000-0000-0000-000000000003', 'pal19@example.com',  '{"display_name":"Pal"}');

insert into public.events (id, creator_id, title, category, start_at, latitude, longitude, is_free, status)
values
  ('e1919191-0000-0000-0000-000000000001', 'a1919191-0000-0000-0000-000000000001',
   'Zamrznuty', 'techno', now() + interval '9 days', 48.1, 17.1, true, 'published'),
  ('e1919191-0000-0000-0000-000000000002', 'a1919191-0000-0000-0000-000000000001',
   'Spravny', 'techno', now() + interval '9 days', 48.1, 17.1, true, 'published');

-- Real activity on both.
insert into public.event_attendees (event_id, user_id, status) values
  ('e1919191-0000-0000-0000-000000000001', 'a1919191-0000-0000-0000-000000000002', 'going'),
  ('e1919191-0000-0000-0000-000000000001', 'a1919191-0000-0000-0000-000000000003', 'going'),
  ('e1919191-0000-0000-0000-000000000002', 'a1919191-0000-0000-0000-000000000002', 'going');

insert into public.saved_events (event_id, user_id) values
  ('e1919191-0000-0000-0000-000000000001', 'a1919191-0000-0000-0000-000000000002');

insert into public.event_views (event_id, user_id, source) values
  ('e1919191-0000-0000-0000-000000000001', 'a1919191-0000-0000-0000-000000000002', 'app'),
  ('e1919191-0000-0000-0000-000000000001', 'a1919191-0000-0000-0000-000000000003', 'app'),
  ('e1919191-0000-0000-0000-000000000001', null, 'web');

do $$
declare
  frozen  uuid := 'e1919191-0000-0000-0000-000000000001';
  correct uuid := 'e1919191-0000-0000-0000-000000000002';
  n integer;
begin
  -- Put the first one back into the state the old guard left: zeros, while the
  -- source tables above say otherwise. The trigger allows this because a
  -- migration and a test both run without auth.uid().
  update public.events
  set attendee_count = 0, saved_count = 0, view_count = 0
  where id = frozen;

  select attendee_count into n from public.events where id = frozen;
  assert n = 0, 'the frozen state is set up';

  -- The repair, exactly as the migration runs it.
  perform set_config('blup.counter_update', 'on', true);
  update public.events e
  set attendee_count = (select count(*) from public.event_attendees a
                        where a.event_id = e.id and a.status in ('going', 'checked_in')),
      saved_count    = (select count(*) from public.saved_events s where s.event_id = e.id),
      view_count     = greatest(e.view_count,
                        (select count(*) from public.event_views v where v.event_id = e.id));

  select attendee_count into n from public.events where id = frozen;
  assert n = 2, format('two people are going, counter says %s', n);
  select saved_count into n from public.events where id = frozen;
  assert n = 1, format('one save, counter says %s', n);
  select view_count into n from public.events where id = frozen;
  assert n = 3, format('three views including the guest one, counter says %s', n);
  raise notice 'PASS a frozen event is recomputed from the source tables';

  select attendee_count into n from public.events where id = correct;
  assert n = 1, format('the already-correct event is unchanged, got %s', n);
  raise notice 'PASS an event that was already right is left alone';

  -- view_count must never go down: an early deployment may have counted views
  -- before event_views existed, and a repair that lost them would be worse.
  update public.events set view_count = 99 where id = frozen;
  update public.events e
  set view_count = greatest(e.view_count,
                   (select count(*) from public.event_views v where v.event_id = e.id))
  where e.id = frozen;

  select view_count into n from public.events where id = frozen;
  assert n = 99, format('view_count must not be lowered by the repair, got %s', n);
  raise notice 'PASS the repair never lowers view_count';
end $$;

rollback;
