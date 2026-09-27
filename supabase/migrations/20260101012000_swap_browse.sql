-- ============================================================================
-- SWAP: jeden zoznam ponuky, filtrovateľný ako domovská stránka BLUPu
-- ============================================================================
-- Domovská SWAPu mala tri kurátorské zoznamy pod sebou (Čoskoro, Najviac,
-- Overené). Vyzerala inak než domovská BLUPu, na ktorú je človek zvyknutý, a
-- ten istý event sa v nej objavil aj trikrát.
--
-- Preto to isté, čo robí BLUP: pás filtrov a pod ním JEDEN zoznam eventov
-- zoradený podľa dátumu. `swap_events` je ten zoznam — s voliteľnou kategóriou
-- a voliteľným „len overené".
--
-- `swap_events_in_family` zostáva, lebo na ňom stojí stránka kategórie
-- (`/swap/family/<kategória>`) a tá má vlastnú adresu, ktorú si ľudia môžu
-- uložiť.
-- ============================================================================
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
    count(*)::integer,
    sum(l.quantity)::integer,
    min(l.price_cents)::integer,
    min(l.currency),
    count(*) filter (where l.source = 'blup')::integer
  from public.swap_live_listings l
  join public.events e on e.id = l.event_id
  -- Prázdny filter aj reťazec 'all' znamenajú to isté: ukáž všetko. Appka
  -- posiela 'all' z URL, kde `null` nemá ako vyzerať.
  where (p_family is null or p_family = 'all'
         or public.swap_family(e.category) = p_family)
  group by e.id
  -- „Len overené" sa musí pýtať AŽ PO zoskupení. Keby sa filtrovalo v `where`,
  -- počty a najnižšia cena by sa rátali len z overených ponúk a event by na
  -- karte tvrdil menej vstupeniek, než na ňom naozaj je.
  having not p_verified_only
      or count(*) filter (where l.source = 'blup') > 0
  order by e.start_at
  limit greatest(1, least(coalesce(p_limit, 60), 200));
$$;

revoke execute on function public.swap_events(text, boolean, integer) from public;
grant execute on function public.swap_events(text, boolean, integer) to anon, authenticated;
