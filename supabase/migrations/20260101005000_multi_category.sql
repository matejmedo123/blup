-- ============================================================================
-- BLUP · 0050 · An event can be more than one thing
-- ============================================================================
-- A warehouse party with live art is techno and art. A running club that ends
-- in a pub is sport and nightlife. One category forced organizers to pick the
-- half their event was not, and buried the other half for everyone searching by
-- the one they chose.
--
-- `category` stays, and stays authoritative for colour, gradient and the card:
-- every ranking query, index and family mapping is built on it, and an event
-- still has one *primary* thing it is. `categories` is the full list, with the
-- primary one first. A trigger keeps the two from ever disagreeing, in both
-- directions, so older code that only writes `category` keeps working.
-- ============================================================================
set search_path = public, extensions;

alter table public.events
  add column if not exists categories text[] not null default '{}';

alter table public.events
  drop constraint if exists events_categories_len;
alter table public.events
  add constraint events_categories_len
    check (array_length(categories, 1) is null or array_length(categories, 1) between 1 and 3);

-- No duplicates, no blanks — a list with 'techno' twice is a typo, not a choice.
create or replace function public.normalise_event_categories()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
declare
  cleaned text[];
begin
  select coalesce(array_agg(c), '{}')
  into cleaned
  from (
    select distinct btrim(c) as c
    from unnest(coalesce(new.categories, '{}')) as c
    where c is not null and btrim(c) <> ''
  ) as distinct_categories;

  if array_length(cleaned, 1) is null then
    -- Only a primary given: the list is that one entry.
    new.categories := array[new.category];
  else
    -- The primary always leads, whatever order the client sent.
    new.categories := array[new.category]
      || array(select c from unnest(cleaned) as c where c <> new.category);

    if array_length(new.categories, 1) > 3 then
      new.categories := new.categories[1:3];
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists events_normalise_categories on public.events;
create trigger events_normalise_categories
  before insert or update of category, categories on public.events
  for each row execute function public.normalise_event_categories();

-- Backfill: every existing event is a one-category event.
update public.events
set categories = array[category]
where array_length(categories, 1) is null;

-- GIN, because the filters below ask "does this array contain any of these".
create index if not exists events_categories_gin
  on public.events using gin (categories);

-- ---------------------------------------------------------------------------
-- Discovery matches on any of them
-- ---------------------------------------------------------------------------
-- `e.category = any (p_categories)` only ever saw the primary, so an event
-- tagged techno + art was invisible to somebody browsing art. Overlap on the
-- whole list instead; the GIN index above is what makes that cheap.
do $$
declare
  fn  record;
  src text;
begin
  for fn in
    -- Named explicitly rather than by scanning every function in the schema.
    -- The first version searched pg_proc with a LIKE over pg_get_functiondef(),
    -- and Postgres is free to evaluate that before the namespace filter — so it
    -- reached an aggregate, which pg_get_functiondef() refuses outright. A
    -- rewrite that can wander into functions nobody listed has no business
    -- anywhere near the queries that draw the feed.
    select p.oid, p.proname, pg_get_functiondef(p.oid) as def
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.prokind = 'f'
      and p.proname in ('events_nearby', 'search_events', 'recommend_events')
  loop
    if fn.def like '%e.category = any (p_categories)%' then
      src := replace(fn.def,
        'e.category = any (p_categories)',
        'e.categories && p_categories');
      execute src;
      raise notice 'multi-category: %', fn.proname;
    end if;
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- The create RPC passes the list through
-- ---------------------------------------------------------------------------
-- Rewritten by substitution rather than restated in full: the function is a
-- hundred lines of column list and this changes two of them, so a copy here
-- would be a second version to keep in step with the first.
do $$
declare
  def text;
begin
  select pg_get_functiondef(p.oid) into def
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace
    and p.prokind = 'f'
    and p.proname = 'create_event_with_tickets';

  if def is null then
    raise exception 'create_event_with_tickets not found';
  end if;

  def := replace(def,
    'creator_id, organization_id, community_id, title, description, category, tags,',
    'creator_id, organization_id, community_id, title, description, category, categories, tags,');

  def := replace(def,
    E'    p_event ->> \'category\',\n',
    E'    p_event ->> \'category\',\n'
    '    coalesce((select array_agg(value #>> ''{}'') from jsonb_array_elements(p_event -> ''categories'')), ''{}''),\n');

  execute def;
  raise notice 'multi-category: create_event_with_tickets';
end
$$;
