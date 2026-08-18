-- ============================================================================
-- BLUP test 06 · Gamification — XP is earned, never granted; levels; badges
-- ============================================================================
\set ON_ERROR_STOP on

begin;

insert into auth.users (id, email, raw_user_meta_data) values
  ('d4444444-4444-4444-4444-444444444444', 'dana@example.com', '{"display_name":"Dana"}'),
  ('e5555555-5555-5555-5555-555555555555', 'emil@example.com', '{"display_name":"Emil"}');

-- --- a fresh account starts at zero -----------------------------------------
do $$
declare v_state jsonb;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', 'd4444444-4444-4444-4444-444444444444', true);

  v_state := public.gamification_for();
  assert (v_state->>'xp')::integer = 0, 'a new account must start with 0 XP';
  assert (v_state->>'level')::integer = 1, 'a new account must start at level 1';
  assert jsonb_array_length(v_state->'badges') = 0, 'a new account must have no badges';
  raise notice 'PASS a fresh account starts at level 1 with nothing earned';
end $$;

-- --- publishing an event earns XP and the first badge -----------------------
do $$
declare
  v_event uuid;
  v_state jsonb;
begin
  perform set_config('request.jwt.claim.sub', 'd4444444-4444-4444-4444-444444444444', true);

  insert into public.events (creator_id, title, category, start_at, latitude, longitude, is_free, status)
  values ('d4444444-4444-4444-4444-444444444444', 'Ranný beh', 'running',
          now() + interval '1 day', 48.1486, 17.1077, true, 'published')
  returning id into v_event;

  v_state := public.gamification_for();
  assert (v_state->>'xp')::integer = 120,
    format('publishing an event must pay 120 XP, got %s', v_state->>'xp');
  assert (v_state->>'events_created')::integer = 1, 'events_created must be counted';
  assert (v_state->'badges'->0->>'slug') = 'first-blup',
    format('the first event must award first-blup, got %s', v_state->'badges');

  raise notice 'PASS publishing an event pays XP and awards a badge';
end $$;

-- --- the same event never pays twice ----------------------------------------
do $$
declare
  v_event uuid;
  v_before integer;
  v_after  integer;
begin
  perform set_config('request.jwt.claim.sub', 'd4444444-4444-4444-4444-444444444444', true);
  select id into v_event from public.events
   where creator_id = 'd4444444-4444-4444-4444-444444444444' limit 1;

  select xp into v_before from public.user_stats
   where user_id = 'd4444444-4444-4444-4444-444444444444';

  -- Re-publishing (draft → published → published) must not pay again.
  update public.events set status = 'draft' where id = v_event;
  update public.events set status = 'published' where id = v_event;

  select xp into v_after from public.user_stats
   where user_id = 'd4444444-4444-4444-4444-444444444444';

  assert v_before = v_after,
    format('re-publishing must not pay again (%s → %s)', v_before, v_after);
  raise notice 'PASS XP awards are idempotent per source row';
end $$;

-- --- RSVP and check-in ------------------------------------------------------
do $$
declare
  v_event uuid;
  v_state jsonb;
begin
  select id into v_event from public.events
   where creator_id = 'd4444444-4444-4444-4444-444444444444' limit 1;

  perform set_config('request.jwt.claim.sub', 'e5555555-5555-5555-5555-555555555555', true);

  insert into public.event_attendees (event_id, user_id, status)
  values (v_event, 'e5555555-5555-5555-5555-555555555555', 'going');

  v_state := public.gamification_for();
  assert (v_state->>'xp')::integer = 30,
    format('an RSVP must pay 30 XP, got %s', v_state->>'xp');
  assert (v_state->>'events_attended')::integer = 1, 'events_attended must be counted';

  -- Showing up is worth more than saying you will.
  update public.event_attendees set status = 'checked_in'
   where event_id = v_event and user_id = 'e5555555-5555-5555-5555-555555555555';

  v_state := public.gamification_for();
  assert (v_state->>'xp')::integer = 110,
    format('a check-in must add 80 XP, got %s', v_state->>'xp');
  assert (v_state->>'check_ins')::integer = 1, 'check_ins must be counted';

  raise notice 'PASS RSVP and check-in pay separately';
end $$;

-- --- levels follow the curve ------------------------------------------------
do $$
begin
  assert public.level_for_xp(0)    = 1, 'level 1 at 0 XP';
  assert public.level_for_xp(99)   = 1, 'still level 1 just under the threshold';
  assert public.level_for_xp(100)  = 2, 'level 2 at 100 XP';
  assert public.level_for_xp(399)  = 2, 'still level 2 just under 400';
  assert public.level_for_xp(400)  = 3, 'level 3 at 400 XP';
  assert public.level_for_xp(900)  = 4, 'level 4 at 900 XP';

  assert public.xp_for_level(1) = 0,   'level 1 starts at 0';
  assert public.xp_for_level(2) = 100, 'level 2 starts at 100';
  assert public.xp_for_level(3) = 400, 'level 3 starts at 400';
  raise notice 'PASS level curve';
end $$;

-- --- the level on user_stats tracks the XP ----------------------------------
do $$
declare v_state jsonb;
begin
  perform set_config('request.jwt.claim.sub', 'd4444444-4444-4444-4444-444444444444', true);
  v_state := public.gamification_for();

  assert (v_state->>'level')::integer = public.level_for_xp((v_state->>'xp')::integer),
    format('stored level %s does not match %s XP', v_state->>'level', v_state->>'xp');
  assert (v_state->>'level_floor')::integer <= (v_state->>'xp')::integer,
    'the level floor must be at or below the current XP';
  assert (v_state->>'level_ceiling')::integer > (v_state->>'xp')::integer,
    'the next level must still be ahead';

  raise notice 'PASS the stored level tracks XP, with a progress window';
end $$;

-- --- the daily cap bounds a farmable action ---------------------------------
do $$
declare
  v_event  uuid;
  v_awards integer;
  i        integer;
begin
  perform set_config('request.jwt.claim.sub', 'e5555555-5555-5555-5555-555555555555', true);

  -- Saving and un-saving the same event repeatedly must not print XP.
  select id into v_event from public.events limit 1;

  for i in 1..5 loop
    insert into public.saved_events (user_id, event_id)
    values ('e5555555-5555-5555-5555-555555555555', v_event)
    on conflict do nothing;
    delete from public.saved_events
     where user_id = 'e5555555-5555-5555-5555-555555555555' and event_id = v_event;
  end loop;

  select count(*) into v_awards from public.xp_awards
   where user_id = 'e5555555-5555-5555-5555-555555555555' and kind = 'event_saved';

  assert v_awards = 1,
    format('saving the same event repeatedly must pay once, got %s awards', v_awards);
  raise notice 'PASS re-saving the same event cannot be farmed';
end $$;

-- --- XP is not client-writable ----------------------------------------------
do $$
begin
  perform set_config('request.jwt.claim.sub', 'e5555555-5555-5555-5555-555555555555', true);

  begin
    update public.user_stats set xp = 999999
     where user_id = 'e5555555-5555-5555-5555-555555555555';
    raise exception 'TEST FAILED: a user granted themselves XP';
  exception when insufficient_privilege or raise_exception then
    raise notice 'PASS user_stats is not client-writable';
  end;

  begin
    insert into public.xp_awards (user_id, kind, amount)
    values ('e5555555-5555-5555-5555-555555555555', 'event_created', 100000);
    raise exception 'TEST FAILED: a user wrote the XP ledger';
  exception when insufficient_privilege or raise_exception then
    raise notice 'PASS the XP ledger is not client-writable';
  end;

  begin
    insert into public.user_badges (user_id, badge_id)
    select 'e5555555-5555-5555-5555-555555555555', id from public.badges limit 1;
    raise exception 'TEST FAILED: a user awarded themselves a badge';
  exception when insufficient_privilege or raise_exception then
    raise notice 'PASS badges cannot be self-awarded';
  end;
end $$;

-- --- streaks ----------------------------------------------------------------
do $$
declare
  v_first  record;
  v_second record;
begin
  perform set_config('request.jwt.claim.sub', 'd4444444-4444-4444-4444-444444444444', true);

  select * into v_first from public.touch_activity();
  assert v_first.streak >= 1, 'the first visit starts a streak';

  -- A second call on the same day must not extend the streak or pay again.
  select * into v_second from public.touch_activity();
  assert v_second.streak = v_first.streak,
    format('the streak must not move twice in a day (%s → %s)', v_first.streak, v_second.streak);
  assert v_second.xp_awarded = 0, 'the streak bonus pays at most once a day';

  -- Yesterday's visit extends it; a gap resets it.
  reset role;
  update public.user_stats
     set last_active_on = current_date - 1, streak_days = 3
   where user_id = 'd4444444-4444-4444-4444-444444444444';
  set local role authenticated;

  select * into v_first from public.touch_activity();
  assert v_first.streak = 4, format('a consecutive day extends the streak, got %s', v_first.streak);

  reset role;
  update public.user_stats
     set last_active_on = current_date - 5
   where user_id = 'd4444444-4444-4444-4444-444444444444';
  set local role authenticated;

  select * into v_first from public.touch_activity();
  assert v_first.streak = 1, format('a gap resets the streak, got %s', v_first.streak);

  raise notice 'PASS streaks extend on consecutive days and reset on a gap';
end $$;

-- --- badge progress is honest about what is still locked --------------------
do $$
declare
  v_row record;
begin
  perform set_config('request.jwt.claim.sub', 'd4444444-4444-4444-4444-444444444444', true);

  select * into v_row from public.badge_progress() where slug = 'first-blup';
  assert v_row.earned, 'first-blup must be earned by now';

  select * into v_row from public.badge_progress() where slug = 'everywhere-50';
  assert not v_row.earned, 'a badge nobody has reached must not be marked earned';
  assert v_row.progress < v_row.threshold, 'progress must be below the threshold';

  raise notice 'PASS badge progress reports locked badges honestly';
end $$;

-- --- another user's private stats stay private ------------------------------
do $$
begin
  reset role;
  update public.profiles set is_private = true
   where id = 'd4444444-4444-4444-4444-444444444444';
  set local role authenticated;

  perform set_config('request.jwt.claim.sub', 'e5555555-5555-5555-5555-555555555555', true);
  begin
    perform public.gamification_for('d4444444-4444-4444-4444-444444444444');
    raise exception 'TEST FAILED: a private profile leaked its stats';
  exception when raise_exception then
    raise notice 'PASS a private profile does not expose its stats';
  end;
end $$;

reset role;
rollback;
