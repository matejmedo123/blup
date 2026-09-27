-- ============================================================================
-- SWAP: karta eventu potrebuje kategóriu, aby mala titulnú fotku ako BLUP
-- ============================================================================
-- Karty na SWAPe kreslili pri chýbajúcej fotke prázdny sivý obdĺžnik. Na
-- domovskej BLUPu je na tom istom mieste `GradientCover`: gradient podľa
-- KATEGÓRIE eventu, šrafovanie a popiska „[ foto z eventu ]" — teda niečo, čo
-- vyzerá zámerne a zároveň priznáva, že fotka chýba.
--
-- Aby to SWAP vedel nakresliť rovnako, musí mu server poslať kategóriu. Inak
-- by si appka musela vypýtať event druhý raz, alebo si gradient vymyslieť z
-- iného údaja — a dva rovnaké eventy by potom mali dve rôzne farby.
--
-- `swap_family` (koncert/festival/šport/…) na to nestačí: to je hrubé delenie
-- pre filtre, zatiaľ čo gradient sa vyberá z pôvodnej kategórie.
-- ============================================================================
-- `create or replace` tu nestačí: pribúda stĺpec do návratového typu a Postgres
-- to odmieta („cannot change return type of existing function"). Funkcia sa
-- preto najprv zahodí. Je to bezpečné — nič sa na ňu neviaže pohľadom ani
-- cudzím kľúčom, volá ju len appka.
drop function if exists public.swap_events(text, boolean, integer);
drop function if exists public.swap_events_in_family(text, integer);
drop function if exists public.swap_events_for(text, text, integer);

create or replace function public.swap_events(
  p_family        text    default null,
  p_verified_only boolean default false,
  p_limit         integer default 60
)
returns table (
  event_id       uuid,
  title          text,
  city           text,
  venue_name     text,
  start_at       timestamptz,
  cover_image_url text,
  category       text,
  listing_count  integer,
  ticket_count   integer,
  from_cents     integer,
  currency       text,
  verified_count integer
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  select
    e.id, e.title, e.city, e.venue_name, e.start_at, e.cover_image_url,
    e.category::text,
    count(*)::integer,
    sum(l.quantity)::integer,
    min(l.price_cents)::integer,
    min(l.currency),
    count(*) filter (where l.source = 'blup')::integer
  from public.swap_live_listings l
  join public.events e on e.id = l.event_id
  where (p_family is null or p_family = 'all'
         or public.swap_family(e.category) = p_family)
  group by e.id
  having not p_verified_only
      or count(*) filter (where l.source = 'blup') > 0
  order by e.start_at
  limit greatest(1, least(coalesce(p_limit, 60), 200));
$$;

revoke execute on function public.swap_events(text, boolean, integer) from public;
grant execute on function public.swap_events(text, boolean, integer) to anon, authenticated;

-- To isté pre stránku kategórie, nech sa karty nelíšia podľa toho, odkiaľ sa
-- na ne človek dostal.
create or replace function public.swap_events_in_family(
  p_family text,
  p_limit  integer default 40
)
returns table (
  event_id       uuid,
  title          text,
  city           text,
  venue_name     text,
  start_at       timestamptz,
  cover_image_url text,
  category       text,
  listing_count  integer,
  ticket_count   integer,
  from_cents     integer,
  currency       text,
  verified_count integer
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  select
    e.id, e.title, e.city, e.venue_name, e.start_at, e.cover_image_url,
    e.category::text,
    count(*)::integer,
    sum(l.quantity)::integer,
    min(l.price_cents)::integer,
    min(l.currency),
    count(*) filter (where l.source = 'blup')::integer
  from public.swap_live_listings l
  join public.events e on e.id = l.event_id
  where public.swap_family(e.category) = p_family
  group by e.id
  order by e.start_at
  limit greatest(1, least(coalesce(p_limit, 40), 100));
$$;

revoke execute on function public.swap_events_in_family(text, integer) from public;
grant execute on function public.swap_events_in_family(text, integer) to anon, authenticated;

-- A pre eventy interpreta/mesta/miesta (`/swap/for/...`).
--
-- Oproti 20260101011300 sa mení JEDINÉ: pribúda stĺpec `category`. Podmienka
-- aj zoradenie (najlacnejšie hore) sú prepísané doslova — pri prepise
-- `search_events` sa už raz stalo, že sa spolu s novým stĺpcom ticho vrátila
-- stará verzia podmienky, a odhalil to až cudzí test.
create or replace function public.swap_events_for(
  p_kind  text,
  p_key   text,
  p_limit integer default 40
)
returns table (
  event_id       uuid,
  title          text,
  city           text,
  venue_name     text,
  start_at       timestamptz,
  cover_image_url text,
  category       text,
  listing_count  integer,
  ticket_count   integer,
  from_cents     integer,
  currency       text,
  verified_count integer
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  select
    e.id, e.title, e.city, e.venue_name, e.start_at, e.cover_image_url,
    e.category::text,
    count(*)::integer,
    sum(l.quantity)::integer,
    min(l.price_cents)::integer,
    min(l.currency),
    count(*) filter (where l.source = 'blup')::integer
  from public.swap_live_listings l
  join public.events e on e.id = l.event_id
  where case p_kind
    when 'artist' then exists (
      select 1 from unnest(e.performers) as name
      where public.blup_norm(name) = public.blup_norm(p_key)
    )
    when 'city'  then public.blup_norm(e.city) = public.blup_norm(p_key)
    when 'venue' then public.blup_norm(e.venue_name) = public.blup_norm(p_key)
    else e.id::text = p_key
  end
  group by e.id
  order by min(l.price_cents)
  limit greatest(1, least(coalesce(p_limit, 40), 100));
$$;

revoke execute on function public.swap_events_for(text, text, integer) from public;
grant execute on function public.swap_events_for(text, text, integer) to anon, authenticated;
