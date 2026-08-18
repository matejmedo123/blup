-- ============================================================================
-- BLUP test 01 · Zero state, event creation rules, counters, capacity, geo
-- ============================================================================
\set ON_ERROR_STOP on

begin;

-- --- zero state -------------------------------------------------------------
do $$
begin
  assert (select count(*) from public.events) = 0, 'database must start with zero events';
  assert (select count(*) from public.profiles) = 0, 'database must start with zero profiles';
  assert (select count(*) from public.interests) > 30, 'interest catalogue must be seeded by migration';
  raise notice 'PASS zero state';
end $$;

-- --- extension helpers resolve from a bare search_path -----------------------
-- Regression test: Supabase installs pgcrypto into the `extensions` schema, so
-- an unqualified gen_random_bytes() inside a function fails unless that function
-- pins its own search_path. This asserts the helpers work with a minimal path.
do $$
declare
  code text;
  saved text := current_setting('search_path');
begin
  perform set_config('search_path', 'public', true);

  code := public.blup_short_code(10);
  assert code is not null and char_length(code) = 10,
    format('blup_short_code must work from a bare search_path, got %s', code);

  assert public.blup_distance_m(48.0, 17.0, 48.0, 17.0) = 0,
    'blup_distance_m must work from a bare search_path';

  perform set_config('search_path', saved, true);
  raise notice 'PASS extension helpers resolve from a bare search_path';
end $$;

-- --- users ------------------------------------------------------------------
insert into auth.users (id, email, raw_user_meta_data) values
  ('11111111-1111-1111-1111-111111111111', 'alex@example.com', '{"display_name":"Alex"}'),
  ('22222222-2222-2222-2222-222222222222', 'martin@example.com', '{"display_name":"Martin"}'),
  ('33333333-3333-3333-3333-333333333333', 'admin@example.com', '{"display_name":"Admin"}');

do $$
begin
  assert (select count(*) from public.profiles) = 3,
    'handle_new_user trigger must create a profile per auth user';
  assert (select username from public.profiles where id = '11111111-1111-1111-1111-111111111111') = 'alex',
    'username must be derived from the email local part';
  raise notice 'PASS profile auto-provisioning';
end $$;

update public.profiles set app_role = 'admin' where id = '33333333-3333-3333-3333-333333333333';
update public.profiles set latitude = 48.1486, longitude = 17.1077, city = 'Bratislava'
where id in ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222');

-- --- free event can be created by anyone -----------------------------------
insert into public.events (id, creator_id, title, description, category, tags,
                           latitude, longitude, address, start_at, capacity)
values ('aaaaaaa1-0000-0000-0000-000000000001',
        '11111111-1111-1111-1111-111111111111',
        'Sunset run along the Danube', 'Easy 5k, everyone welcome.', 'running',
        array['running','outdoor'], 48.1400, 17.1100, 'Danube riverside',
        now() + interval '2 days', 2);

-- --- paid event WITHOUT an organization must fail ---------------------------
do $$
begin
  begin
    insert into public.events (creator_id, title, category, latitude, longitude, start_at,
                               is_free, price_cents)
    values ('11111111-1111-1111-1111-111111111111', 'Illegal paid party', 'techno',
            48.15, 17.11, now() + interval '3 days', false, 1500);
    raise exception 'TEST FAILED: paid event without organization was accepted';
  exception
    when check_violation or raise_exception then
      raise notice 'PASS paid event requires an organization';
  end;
end $$;

-- --- organization: unverified cannot sell -----------------------------------
insert into public.organizations (id, slug, name, created_by, country)
values ('bbbbbbb1-0000-0000-0000-000000000001', 'nova-collective', 'Nova Collective',
        '22222222-2222-2222-2222-222222222222', 'SK');

do $$
begin
  assert (select role from public.organization_members
          where organization_id = 'bbbbbbb1-0000-0000-0000-000000000001'
            and user_id = '22222222-2222-2222-2222-222222222222') = 'owner',
    'organization creator must become owner';

  begin
    insert into public.events (creator_id, organization_id, title, category, latitude, longitude,
                               start_at, is_free, price_cents)
    values ('22222222-2222-2222-2222-222222222222', 'bbbbbbb1-0000-0000-0000-000000000001',
            'Paid before verification', 'techno', 48.15, 17.11,
            now() + interval '5 days', false, 2000);
    raise exception 'TEST FAILED: unverified organization was allowed to sell tickets';
  exception
    when raise_exception then
      raise notice 'PASS unverified organization cannot create paid events';
  end;
end $$;

-- --- verify the organization, then the paid event is allowed ---------------
update public.organizations set verification_status = 'verified', payouts_enabled = true
where id = 'bbbbbbb1-0000-0000-0000-000000000001';

insert into public.events (id, creator_id, organization_id, title, category,
                           latitude, longitude, address, start_at, is_free, price_cents, currency)
values ('aaaaaaa1-0000-0000-0000-000000000002',
        '22222222-2222-2222-2222-222222222222', 'bbbbbbb1-0000-0000-0000-000000000001',
        'Nova Warehouse Night', 'techno', 48.1550, 17.1200, 'Old Warehouse',
        now() + interval '6 days', false, 2500, 'EUR');

do $$
begin
  assert (select count(*) from public.events where not is_free) = 1,
    'verified organization must be able to create a paid event';
  raise notice 'PASS verified organization can create paid events';
end $$;

-- --- RSVP counters + capacity ----------------------------------------------
insert into public.event_attendees (event_id, user_id, status)
values ('aaaaaaa1-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222', 'going');

do $$
begin
  assert (select attendee_count from public.events where id = 'aaaaaaa1-0000-0000-0000-000000000001') = 1,
    'attendee_count trigger must maintain the counter';
  raise notice 'PASS attendee counter';
end $$;

insert into public.event_attendees (event_id, user_id, status)
values ('aaaaaaa1-0000-0000-0000-000000000001', '33333333-3333-3333-3333-333333333333', 'going');

do $$
begin
  -- capacity is 2 and both seats are taken; a third RSVP must fail
  insert into auth.users (id, email) values ('44444444-4444-4444-4444-444444444444', 'zoe@example.com');
  begin
    insert into public.event_attendees (event_id, user_id, status)
    values ('aaaaaaa1-0000-0000-0000-000000000001', '44444444-4444-4444-4444-444444444444', 'going');
    raise exception 'TEST FAILED: capacity limit was not enforced';
  exception
    when raise_exception then
      raise notice 'PASS capacity enforcement';
  end;
end $$;

-- --- saves / likes / comments counters -------------------------------------
insert into public.saved_events (user_id, event_id)
values ('22222222-2222-2222-2222-222222222222', 'aaaaaaa1-0000-0000-0000-000000000002');
insert into public.event_likes (user_id, event_id)
values ('22222222-2222-2222-2222-222222222222', 'aaaaaaa1-0000-0000-0000-000000000002');
insert into public.comments (user_id, event_id, body)
values ('11111111-1111-1111-1111-111111111111', 'aaaaaaa1-0000-0000-0000-000000000002', 'Taking my crew!');

do $$
declare e record;
begin
  select saved_count, like_count, comment_count into e
  from public.events where id = 'aaaaaaa1-0000-0000-0000-000000000002';
  assert e.saved_count = 1, 'saved_count must be 1';
  assert e.like_count = 1, 'like_count must be 1';
  assert e.comment_count = 1, 'comment_count must be 1';
  raise notice 'PASS save/like/comment counters';
end $$;

-- --- geo: distance + nearby query ------------------------------------------
do $$
declare d double precision;
begin
  -- Bratislava main square -> Vienna is roughly 55 km
  d := public.blup_distance_m(48.1486, 17.1077, 48.2082, 16.3738);
  assert d between 50000 and 60000, format('unexpected distance: %s', d);

  -- ~1.0 km north
  d := public.blup_distance_m(48.1486, 17.1077, 48.1576, 17.1077);
  assert d between 950 and 1050, format('unexpected short distance: %s', d);
  raise notice 'PASS haversine distance';
end $$;

do $$
declare n integer;
begin
  select count(*) into n from public.events_nearby(48.1486, 17.1077, 25000);
  assert n = 2, format('events_nearby should find both events, found %s', n);

  select count(*) into n from public.events_nearby(48.1486, 17.1077, 500);
  assert n = 0, format('events_nearby with a 500m radius should find none, found %s', n);

  select count(*) into n from public.events_nearby(48.1486, 17.1077, 25000, now(), null, null, true);
  assert n = 1, format('free-only filter should find 1 event, found %s', n);
  raise notice 'PASS events_nearby';
end $$;

-- --- search -----------------------------------------------------------------
do $$
declare n integer;
begin
  select count(*) into n from public.search_events('warehouse');
  assert n = 1, format('full-text search should find the warehouse event, found %s', n);

  select count(*) into n from public.search_events('nonexistentquery');
  assert n = 0, 'search must return nothing for an unmatched query';
  raise notice 'PASS search_events';
end $$;

rollback;
