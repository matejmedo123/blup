-- ============================================================================
-- BLUP test 27 · An event can be more than one thing
-- ============================================================================
\set ON_ERROR_STOP on

begin;

insert into auth.users (id, email) values
  ('22222222-2222-2222-2222-222222222222', 'organizer@blup.test');

insert into public.events (id, creator_id, title, category, categories,
                           latitude, longitude, start_at, is_free)
values ('aaaaaaa1-0000-0000-0000-0000000000c1', '22222222-2222-2222-2222-222222222222',
        'Warehouse + výstava', 'techno', array['art', 'techno', 'nightlife'],
        48.15, 17.12, now() + interval '5 days', true);

-- --- the primary leads, whatever order it arrived in -------------------------
do $$
declare e public.events;
begin
  select * into e from public.events where id = 'aaaaaaa1-0000-0000-0000-0000000000c1';
  assert e.categories[1] = 'techno',
    format('the primary category must lead, got %s', e.categories[1]);
  assert array_length(e.categories, 1) = 3, format('three categories, got %s', array_length(e.categories, 1));
  assert e.category = 'techno', 'and `category` still says which one is primary';
  raise notice 'PASS the primary category leads the list';
end $$;

-- --- one category is still one category ---------------------------------------
do $$
declare e public.events;
begin
  insert into public.events (id, creator_id, title, category,
                             latitude, longitude, start_at, is_free)
  values ('aaaaaaa1-0000-0000-0000-0000000000c2', '22222222-2222-2222-2222-222222222222',
          'Len beh', 'running', 48.15, 17.12, now() + interval '5 days', true);

  select * into e from public.events where id = 'aaaaaaa1-0000-0000-0000-0000000000c2';
  assert e.categories = array['running'],
    format('a single-category event lists exactly that one, got %s', e.categories);
  raise notice 'PASS writing only `category` still fills the list';
end $$;

-- --- duplicates and blanks are typos, not choices ------------------------------
do $$
declare e public.events;
begin
  update public.events
  set categories = array['techno', 'techno', '  ', 'art']
  where id = 'aaaaaaa1-0000-0000-0000-0000000000c1';

  select * into e from public.events where id = 'aaaaaaa1-0000-0000-0000-0000000000c1';
  assert array_length(e.categories, 1) = 2,
    format('techno twice plus a blank is two categories, got %s', e.categories);
  assert e.categories[1] = 'techno', 'the primary still leads';
  raise notice 'PASS duplicates and blanks are dropped';
end $$;

-- --- more than three is refused -----------------------------------------------
do $$
begin
  begin
    insert into public.events (creator_id, title, category, categories,
                               latitude, longitude, start_at, is_free)
    values ('22222222-2222-2222-2222-222222222222', 'Priveľa', 'techno',
            array['techno', 'art', 'food', 'yoga'],
            48.15, 17.12, now() + interval '5 days', true);
    -- The trigger trims to three before the constraint sees it, so this is
    -- allowed — what must never happen is a row ending up with four.
  exception when others then
    assert sqlerrm like '%events_categories_len%', format('unexpected: %s', sqlerrm);
  end;

  assert not exists (
    select 1 from public.events where array_length(categories, 1) > 3
  ), 'no event may end up with more than three categories';
  raise notice 'PASS three is the ceiling, however many arrive';
end $$;

-- --- changing the primary re-seats the list -----------------------------------
do $$
declare e public.events;
begin
  update public.events set category = 'art'
  where id = 'aaaaaaa1-0000-0000-0000-0000000000c1';

  select * into e from public.events where id = 'aaaaaaa1-0000-0000-0000-0000000000c1';
  assert e.categories[1] = 'art',
    format('the new primary leads, got %s', e.categories[1]);
  assert 'techno' = any (e.categories), 'and the old one is still in the list';
  raise notice 'PASS changing the primary reorders rather than loses';
end $$;

-- --- discovery finds an event by its secondary category ------------------------
-- The whole point: an event tagged techno + art used to be invisible to anyone
-- browsing art, because the filter only ever saw the primary.
do $$
declare hits integer;
begin
  update public.events
  set category = 'techno', categories = array['techno', 'art']
  where id = 'aaaaaaa1-0000-0000-0000-0000000000c1';

  select count(*) into hits
  from public.search_events(p_query => null, p_categories => array['art'])
  where id = 'aaaaaaa1-0000-0000-0000-0000000000c1';
  assert hits = 1, 'searching art finds an event whose primary is techno';

  select count(*) into hits
  from public.search_events(p_query => null, p_categories => array['techno'])
  where id = 'aaaaaaa1-0000-0000-0000-0000000000c1';
  assert hits = 1, 'and searching techno still finds it';

  select count(*) into hits
  from public.search_events(p_query => null, p_categories => array['yoga'])
  where id = 'aaaaaaa1-0000-0000-0000-0000000000c1';
  assert hits = 0, 'a category it does not have does not match';

  raise notice 'PASS discovery matches any of an event''s categories';
end $$;

-- --- and the create RPC carries the list through -----------------------------
do $$
declare
  e public.events;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);

  e := public.create_event_with_tickets(jsonb_build_object(
    'title', 'Cez RPC',
    'category', 'techno',
    'categories', jsonb_build_array('art', 'techno'),
    'latitude', 48.15,
    'longitude', 17.12,
    'start_at', (now() + interval '9 days')::text,
    'is_free', true
  ));
  reset role;

  assert e.categories[1] = 'techno', format('primary leads, got %s', e.categories);
  assert 'art' = any (e.categories), 'the second one arrived too';
  raise notice 'PASS create_event_with_tickets carries every category';
end $$;

rollback;
