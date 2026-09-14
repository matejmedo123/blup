-- ============================================================================
-- BLUP test 24 · A finished event stops behaving like an upcoming one
-- ============================================================================
\set ON_ERROR_STOP on

begin;

insert into auth.users (id, email) values
  ('22222222-2222-2222-2222-222222222222', 'organizer@blup.test'),
  ('33333333-3333-3333-3333-333333333333', 'stranger@blup.test');

insert into public.organizations (id, slug, name, created_by, verification_status)
values ('bbbbbbb1-0000-0000-0000-000000000001', 'nova', 'Nova Collective',
        '22222222-2222-2222-2222-222222222222', 'verified');

insert into public.organization_members (organization_id, user_id, role)
values ('bbbbbbb1-0000-0000-0000-000000000001',
        '22222222-2222-2222-2222-222222222222', 'owner')
on conflict do nothing;

insert into public.events (id, creator_id, organization_id, title, category,
                           latitude, longitude, start_at, end_at, status, is_free)
values
  -- Yesterday. Over.
  ('aaaaaaa1-0000-0000-0000-00000000000f', '22222222-2222-2222-2222-222222222222',
   'bbbbbbb1-0000-0000-0000-000000000001', 'Včerajší koncert', 'techno', 48.1, 17.1,
   now() - interval '1 day', now() - interval '1 day' + interval '5 hours', 'published', true),
  -- A three-day festival, currently on day two. Started, but very much not over.
  ('aaaaaaa1-0000-0000-0000-00000000001a', '22222222-2222-2222-2222-222222222222',
   'bbbbbbb1-0000-0000-0000-000000000001', 'Trojdňový festival', 'techno', 48.1, 17.1,
   now() - interval '1 day', now() + interval '2 days', 'published', true),
  -- No end time at all, three hours ago: the four-hour default says still on.
  ('aaaaaaa1-0000-0000-0000-00000000002a', '22222222-2222-2222-2222-222222222222',
   'bbbbbbb1-0000-0000-0000-000000000001', 'Bez konca, pred 3h', 'techno', 48.1, 17.1,
   now() - interval '3 hours', null, 'published', true),
  -- Next week.
  ('aaaaaaa1-0000-0000-0000-00000000003a', '22222222-2222-2222-2222-222222222222',
   'bbbbbbb1-0000-0000-0000-000000000001', 'Budúci týždeň', 'techno', 48.1, 17.1,
   now() + interval '7 days', now() + interval '7 days 6 hours', 'published', true),
  -- A draft in the past, and a cancelled one. Neither is "completed".
  ('aaaaaaa1-0000-0000-0000-00000000004a', '22222222-2222-2222-2222-222222222222',
   'bbbbbbb1-0000-0000-0000-000000000001', 'Starý koncept', 'techno', 48.1, 17.1,
   now() - interval '9 days', now() - interval '9 days' + interval '3 hours', 'draft', true),
  ('aaaaaaa1-0000-0000-0000-00000000005a', '22222222-2222-2222-2222-222222222222',
   'bbbbbbb1-0000-0000-0000-000000000001', 'Zrušený', 'techno', 48.1, 17.1,
   now() - interval '9 days', now() - interval '9 days' + interval '3 hours', 'cancelled', true);

-- --- when an event counts as over --------------------------------------------
do $$
begin
  assert public.event_has_ended(now() - interval '1 day', now() - interval '19 hours'),
    'yesterday is over';
  assert not public.event_has_ended(now() - interval '1 day', now() + interval '2 days'),
    'a festival on day two is not over';
  assert not public.event_has_ended(now() - interval '3 hours', null),
    'without an end time, three hours in is still running';
  assert public.event_has_ended(now() - interval '5 hours', null),
    'without an end time, five hours in is over';
  raise notice 'PASS "over" means ended, not started';
end $$;

-- --- the sweep marks exactly the finished ones -------------------------------
do $$
declare moved integer;
begin
  moved := public.complete_past_events();
  assert moved = 1, format('only yesterday''s concert should move, got %s', moved);

  assert (select status from public.events
          where id = 'aaaaaaa1-0000-0000-0000-00000000000f') = 'completed',
    'the finished concert is completed';
  assert (select status from public.events
          where id = 'aaaaaaa1-0000-0000-0000-00000000001a') = 'published',
    'the running festival stays published';
  assert (select status from public.events
          where id = 'aaaaaaa1-0000-0000-0000-00000000002a') = 'published',
    'an event with no end time is still on three hours in';
  assert (select status from public.events
          where id = 'aaaaaaa1-0000-0000-0000-00000000004a') = 'draft',
    'a past draft is not "completed" — it was never published';
  assert (select status from public.events
          where id = 'aaaaaaa1-0000-0000-0000-00000000005a') = 'cancelled',
    'a cancelled event stays cancelled';

  -- Running it again must be a no-op.
  assert public.complete_past_events() = 0, 'the sweep is idempotent';
  raise notice 'PASS the sweep completes finished events and leaves everything else alone';
end $$;

-- --- a completed event is still readable by the public -----------------------
-- Marking it completed must not turn last month's event into a 404 for the
-- person holding a ticket to it.
do $$
declare visible integer;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', true);

  select count(*) into visible from public.events
  where id = 'aaaaaaa1-0000-0000-0000-00000000000f';
  assert visible = 1, 'a stranger can still open a finished event';

  select count(*) into visible from public.events
  where id = 'aaaaaaa1-0000-0000-0000-00000000004a';
  assert visible = 0, 'a draft is still nobody else''s business';

  reset role;
  raise notice 'PASS a finished event is still a page, a draft still is not';
end $$;

-- --- boosting ----------------------------------------------------------------
do $$
declare q jsonb;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);

  -- Yesterday's concert: refused, and told why.
  begin
    perform public.create_boost_order('aaaaaaa1-0000-0000-0000-00000000000f', 'boost_24');
    raise exception 'boosting a finished event should have been refused';
  exception when others then
    assert sqlerrm like '%EVENT_ALREADY_ENDED%',
      format('expected EVENT_ALREADY_ENDED, got %s', sqlerrm);
  end;

  -- And the quote says so before any payment sheet opens.
  q := public.boost_quote('aaaaaaa1-0000-0000-0000-00000000000f', 'boost_24');
  assert not (q->>'available')::boolean, 'the quote refuses a finished event';
  assert q->>'reason' = 'EVENT_ALREADY_ENDED',
    format('expected EVENT_ALREADY_ENDED, got %s', q->>'reason');

  reset role;
  raise notice 'PASS a finished event cannot be boosted, and the quote says so first';
end $$;

-- --- a festival on day two CAN be boosted ------------------------------------
-- The old check was `start_at < now()`, which refused this. It is the most
-- obvious moment to promote a festival.
do $$
declare b public.event_boosts; q jsonb;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);

  q := public.boost_quote('aaaaaaa1-0000-0000-0000-00000000001a', 'boost_24');
  assert (q->>'available')::boolean, format('a running festival is boostable, got %s', q->>'reason');

  b := public.create_boost_order('aaaaaaa1-0000-0000-0000-00000000001a', 'boost_24');
  assert b.id is not null, 'the boost exists';
  reset role;
  raise notice 'PASS a multi-day event can be promoted while it is running';
end $$;

-- --- a boost is never sold past the end of the event -------------------------
do $$
declare
  q       jsonb;
  b       public.event_boosts;
  ev_end  timestamptz;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);

  -- Three hours in, no end time: the event is treated as ending an hour from
  -- now, so a 24-hour package can only deliver about one hour.
  q := public.boost_quote('aaaaaaa1-0000-0000-0000-00000000002a', 'boost_24');

  assert (q->>'available')::boolean, 'still boostable';
  assert (q->>'truncated')::boolean, 'the quote must admit it is being cut short';
  assert (q->>'effective_hours')::numeric < (q->>'package_hours')::numeric,
    format('effective %s should be under package %s',
           q->>'effective_hours', q->>'package_hours');
  assert (q->>'effective_hours')::numeric <= 1.1,
    format('about an hour is left, quote said %s', q->>'effective_hours');

  b := public.create_boost_order('aaaaaaa1-0000-0000-0000-00000000002a', 'boost_24');
  select public.event_ends_at(start_at, end_at) into ev_end
  from public.events where id = 'aaaaaaa1-0000-0000-0000-00000000002a';

  assert b.ends_at <= ev_end,
    format('the boost must not outlive the event: %s vs %s', b.ends_at, ev_end);

  reset role;
  raise notice 'PASS a boost is cut at the end of the event, and the quote says so up front';
end $$;

-- --- somebody else's event ---------------------------------------------------
do $$
declare q jsonb;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', true);

  q := public.boost_quote('aaaaaaa1-0000-0000-0000-00000000003a', 'boost_24');
  assert not (q->>'available')::boolean, 'a stranger gets no quote';
  assert q->>'reason' = 'NOT_AUTHORIZED', format('expected NOT_AUTHORIZED, got %s', q->>'reason');

  begin
    perform public.create_boost_order('aaaaaaa1-0000-0000-0000-00000000003a', 'boost_24');
    raise exception 'a stranger boosting someone else''s event should have been refused';
  exception when others then
    assert sqlerrm like '%NOT_AUTHORIZED%', format('expected NOT_AUTHORIZED, got %s', sqlerrm);
  end;

  reset role;
  raise notice 'PASS only the host can promote their own event';
end $$;

rollback;
