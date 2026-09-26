-- ============================================================================
-- BLUP SWAP — domovská stránka a vlastné kategórie
-- ============================================================================
-- SWAP potrebuje iné rozdelenie než BLUP. BLUP triedi podľa nálady — Hudba,
-- Startupy, Outdoor, Umenie, Spiritualita — lebo odpovedá na „čo by som si
-- dnes dal". Na vstupenku sa ale nehľadá podľa nálady. Hľadá sa podľa toho,
-- na ČO sa vôbec vstupenky predávajú: koncert, zápas, divadlo, festival.
--
-- „Spiritualita" nie je kategória, v ktorej niekto hľadá lístok od iného
-- človeka. „Šport" áno.
--
-- Preto vlastné rozdelenie. Neurčuje ho appka: keby si ho kreslil frontend,
-- počty pri kategóriách by sa museli rátať v prehliadači, čo znamená stiahnuť
-- všetky ponuky len na to, aby sa zistilo, koľko ich je.
-- ============================================================================
set search_path = public, extensions;

/**
 * Do ktorej škatuľky SWAPu patrí kategória eventu.
 *
 * Zámerne hrubé delenie — päť škatuliek, nie dvadsať. Kategória, v ktorej je
 * jedna ponuka, nie je kategória, je to položka.
 */
create or replace function public.swap_family(p_category text)
returns text
language sql
immutable
parallel safe
as $$
  select case
    when p_category in ('concert','techno','house','hiphop','rock','jazz','indie',
                        'dance','party','karaoke','nightlife','bars')
      then 'concert'
    when p_category in ('festival') then 'festival'
    when p_category in ('football','hockey','basketball','tennis','sport','running',
                        'cycling','swimming','skiing','climbing','fitness','surfing')
      then 'sport'
    when p_category in ('theatre','standup','comedy','cinema','art','museum',
                        'culture','books','photography','opera')
      then 'stage'
    else 'other'
  end;
$$;

-- ============================================================================
-- Čo je na domovskej stránke
-- ============================================================================
-- Jedna funkcia a nie päť dotazov: obrazovka sa otvára ako prvá vec po vstupe
-- do SWAPu a päť kôl na server by z nej spravilo päť postupne naskakujúcich
-- blokov.
--
-- Vracia to jeden jsonb, lebo sú to rôzne tvary — zoznam kategórií a tri
-- zoznamy eventov sa do jednej tabuľky nedajú vtesnať bez toho, aby polovica
-- stĺpcov bola vždy prázdna.
create or replace function public.swap_home(p_limit integer default 8)
returns jsonb
language sql
stable
security definer
set search_path = public, extensions
as $$
  with live as (
    select
      l.id, l.event_id, l.price_cents, l.currency, l.quantity, l.source,
      e.title, e.city, e.venue_name, e.start_at, e.cover_image_url, e.category,
      public.swap_family(e.category) as family
    from public.swap_live_listings l
    join public.events e on e.id = l.event_id
  ),
  -- Ponuky zhrnuté na event: na domovskej stránke sa klikne na event, nie na
  -- jednotlivú ponuku.
  per_event as (
    select
      event_id,
      max(title) as title, max(city) as city, max(venue_name) as venue_name,
      max(start_at) as start_at, max(cover_image_url) as cover_image_url,
      max(family) as family,
      count(*)::integer as listing_count,
      sum(quantity)::integer as ticket_count,
      min(price_cents)::integer as from_cents,
      min(currency) as currency,
      count(*) filter (where source = 'blup')::integer as verified_count
    from live
    group by event_id
  ),
  cap as (select greatest(1, least(coalesce(p_limit, 8), 30)) as n)
  select jsonb_build_object(
    'total_listings', (select count(*) from live),
    'total_tickets',  (select coalesce(sum(quantity), 0) from live),
    'from_cents',     (select min(price_cents) from live),
    'currency',       (select min(currency) from live),

    -- Kategórie s počtami. Prázdna sa neukáže: škatuľka, po kliknutí na ktorú
    -- je prázdno, je horšia než žiadna škatuľka.
    'families', coalesce((
      select jsonb_agg(f order by f.listing_count desc)
      from (
        select
          family as key,
          count(*)::integer as listing_count,
          sum(quantity)::integer as ticket_count,
          min(price_cents)::integer as from_cents,
          min(currency) as currency
        from live
        group by family
      ) f
    ), '[]'::jsonb),

    -- Čo sa hrá najskôr. Toto je najužitočnejší zoznam na burze: vstupenka na
    -- zajtra je naliehavá pre obe strany.
    'soon', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.start_at)
      from (select * from per_event order by start_at limit (select n from cap)) x
    ), '[]'::jsonb),

    -- Najviac na výber. Kde je desať ponúk, tam sa dá vyberať a zjednávať.
    'most', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.listing_count desc, x.start_at)
      from (select * from per_event
            order by listing_count desc, start_at limit (select n from cap)) x
    ), '[]'::jsonb),

    -- Len overené. Pre toho, kto nechce riskovať nič.
    'verified', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.verified_count desc, x.start_at)
      from (select * from per_event where verified_count > 0
            order by verified_count desc, start_at limit (select n from cap)) x
    ), '[]'::jsonb)
  );
$$;

revoke execute on function public.swap_home(integer) from public;
grant execute on function public.swap_home(integer) to anon, authenticated;

-- ============================================================================
-- Hľadanie vie filtrovať podľa kategórie
-- ============================================================================
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
  where public.swap_family(e.category) = p_family
  group by e.id
  order by e.start_at
  limit greatest(1, least(coalesce(p_limit, 40), 100));
$$;

revoke execute on function public.swap_events_in_family(text, integer) from public;
grant execute on function public.swap_events_in_family(text, integer) to anon, authenticated;
