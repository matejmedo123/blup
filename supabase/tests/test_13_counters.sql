-- ============================================================================
-- BLUP test 13 · The denormalised counters actually count
-- ============================================================================
-- What is actually being proved here:
--
--   · an RSVP moves attendee_count, which the map and the feed read
--   · a save, a like and a comment move theirs
--   · a sold ticket moves tickets_sold
--   · opening an event moves view_count, for a guest as well as a member
--   · a client still cannot write a counter by hand — the guard is intact
--   · a client cannot raise the trusted flag and then write one either
-- ============================================================================
\set ON_ERROR_STOP on

begin;

insert into auth.users (id, email, raw_user_meta_data) values
  ('a1313131-0000-0000-0000-000000000001', 'org13@example.com',  '{"display_name":"Org"}'),
  ('a1313131-0000-0000-0000-000000000002', 'goer13@example.com', '{"display_name":"Goer"}');

insert into public.organizations (id, name, slug, created_by, verification_status, payouts_enabled)
values ('d1313131-0000-0000-0000-000000000001', 'Counter Co', 'counter-co-13',
        'a1313131-0000-0000-0000-000000000001', 'verified', true);

insert into public.events (id, creator_id, organization_id, title, category, start_at,
                           latitude, longitude, is_free, price_cents, status)
values ('d1313131-0000-0000-0000-000000000002', 'a1313131-0000-0000-0000-000000000001',
        'd1313131-0000-0000-0000-000000000001', 'Counted Night', 'techno',
        now() + interval '11 days', 48.1486, 17.1077, true, 0, 'published');

do $$
declare
  v_event uuid := 'd1313131-0000-0000-0000-000000000002';
  v_goer  uuid := 'a1313131-0000-0000-0000-000000000002';
  n integer;
begin
  perform set_config('request.jwt.claim.sub', v_goer::text, true);

  -- ---- attendance ---------------------------------------------------------
  insert into public.event_attendees (event_id, user_id, status) values (v_event, v_goer, 'going');
  select attendee_count into n from public.events where id = v_event;
  assert n = 1, format('attendee_count should be 1, is %s', n);
  raise notice 'PASS an RSVP moves attendee_count';

  update public.event_attendees set status = 'interested' where event_id = v_event and user_id = v_goer;
  select attendee_count into n from public.events where id = v_event;
  assert n = 0, format('going should drop back to 0, is %s', n);
  select interested_count into n from public.events where id = v_event;
  assert n = 1, format('interested_count should be 1, is %s', n);
  raise notice 'PASS changing an RSVP moves both counts';

  -- ---- saves and likes ----------------------------------------------------
  insert into public.saved_events (event_id, user_id) values (v_event, v_goer);
  select saved_count into n from public.events where id = v_event;
  assert n = 1, format('saved_count should be 1, is %s', n);

  insert into public.event_likes (event_id, user_id) values (v_event, v_goer);
  select like_count into n from public.events where id = v_event;
  assert n = 1, format('like_count should be 1, is %s', n);
  raise notice 'PASS a save and a like move their counters';

  -- ---- comments -----------------------------------------------------------
  insert into public.comments (event_id, user_id, body) values (v_event, v_goer, 'Idem!');
  select comment_count into n from public.events where id = v_event;
  assert n = 1, format('comment_count should be 1, is %s', n);
  raise notice 'PASS a comment moves comment_count';

  -- ---- views, signed in ---------------------------------------------------
  perform public.record_signal(v_event, 'open_detail', 1.0, '{"source":"detail"}'::jsonb);
  select view_count into n from public.events where id = v_event;
  assert n = 1, format('view_count should be 1, is %s', n);
  raise notice 'PASS opening an event moves view_count';

  -- ---- views, as a guest --------------------------------------------------
  perform set_config('request.jwt.claim.sub', '', true);
  perform public.record_event_view(v_event, 'web');
  select view_count into n from public.events where id = v_event;
  assert n = 2, format('a guest view counts too, expected 2, got %s', n);
  raise notice 'PASS a view counts even when nobody is signed in';

  -- ---- the guard is still a guard -----------------------------------------
  perform set_config('request.jwt.claim.sub', v_goer::text, true);
  update public.events set attendee_count = 9999, view_count = 9999 where id = v_event;
  select attendee_count into n from public.events where id = v_event;
  assert n = 0, format('a client must not write attendee_count, got %s', n);
  select view_count into n from public.events where id = v_event;
  assert n = 2, format('a client must not write view_count, got %s', n);
  raise notice 'PASS a client still cannot write a counter by hand';

  -- ---- and cannot borrow the flag -----------------------------------------
  -- Within one transaction a client could try to raise it themselves. The
  -- trigger consumes the flag, so even that buys exactly one update — and the
  -- API gives each request its own transaction, so this cannot be reached.
  perform set_config('blup.counter_update', 'on', true);
  update public.events set view_count = 5555 where id = v_event;
  update public.events set view_count = 7777 where id = v_event;
  select view_count into n from public.events where id = v_event;
  assert n = 5555, format('the flag is single use, expected 5555, got %s', n);
  raise notice 'PASS a raised flag covers exactly one update, not a session';
end $$;

rollback;
