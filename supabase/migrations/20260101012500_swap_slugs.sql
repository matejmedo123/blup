-- ============================================================================
-- SWAP má čitateľné adresy
-- ============================================================================
-- Doteraz vyzeral odkaz na burzu takto:
--
--   https://blup.sk/swap/863b30b0-f37e-4acc-8e6f-d856a0b1c0b6
--
-- Nedá sa to prečítať, nedá sa to nadiktovať a v správe to vyzerá ako niečo,
-- na čo sa neklikne. BLUP eventy majú `slug` od začiatku, len ho SWAP nikdy
-- nedostal do ruky — karty a hľadanie vracali `event_id`, takže appka nemala
-- z čoho postaviť lepšiu adresu.
--
--   https://blup.sk/swap/hypeland
--
-- Stĺpec `slug` pribúda tam, kde appka berie eventy pre SWAP. Uuid sa
-- NEODSTRAŇUJE ani zo vstupov, ani z výstupov: odkaz, ktorý si niekto pred
-- mesiacom hodil do chatu, musí fungovať aj o rok. Appka si vyberie slug, keď
-- ho event má, a uuid, keď nie (eventy z čias pred slugmi ho nemajú).
-- ============================================================================
set search_path = public, extensions;

-- `create or replace` tu nestačí — pribúda stĺpec do návratového typu.
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
  event_slug     text,
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
    e.id, e.slug, e.title, e.city, e.venue_name, e.start_at, e.cover_image_url,
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
  -- Filter až po zoskupení, aby počty na kartách zostali pravdivé.
  having not p_verified_only
      or count(*) filter (where l.source = 'blup') > 0
  order by e.start_at
  limit greatest(1, least(coalesce(p_limit, 60), 200));
$$;

revoke execute on function public.swap_events(text, boolean, integer) from public;
grant execute on function public.swap_events(text, boolean, integer) to anon, authenticated;

create or replace function public.swap_events_in_family(
  p_family text,
  p_limit  integer default 40
)
returns table (
  event_id       uuid,
  event_slug     text,
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
    e.id, e.slug, e.title, e.city, e.venue_name, e.start_at, e.cover_image_url,
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

-- Eventy za jedným výsledkom hľadania (`/swap/for/artist/…`).
--
-- Vetva `else` prijíma aj slug, nielen uuid. Odkedy sa v adresách používa
-- slug, môže sa sem dostať oboje a odmietnuť jedno z nich by znamenalo
-- prázdnu stránku bez vysvetlenia.
create or replace function public.swap_events_for(
  p_kind  text,
  p_key   text,
  p_limit integer default 40
)
returns table (
  event_id       uuid,
  event_slug     text,
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
    e.id, e.slug, e.title, e.city, e.venue_name, e.start_at, e.cover_image_url,
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
    else e.id::text = p_key or e.slug = p_key
  end
  group by e.id
  order by min(l.price_cents)
  limit greatest(1, least(coalesce(p_limit, 40), 100));
$$;

revoke execute on function public.swap_events_for(text, text, integer) from public;
grant execute on function public.swap_events_for(text, text, integer) to anon, authenticated;

-- ============================================================================
-- Domovská stránka SWAPu
-- ============================================================================
-- Vracia jsonb, takže tu nič netreba zahadzovať — pribudne kľúč `event_slug`
-- do každého eventu v zoznamoch „Čoskoro", „Najviac na výber" a „Len overené".
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
      e.slug,
      public.swap_family(e.category) as family
    from public.swap_live_listings l
    join public.events e on e.id = l.event_id
  ),
  -- Ponuky zhrnuté na event: na domovskej stránke sa klikne na event, nie na
  -- jednotlivú ponuku.
  per_event as (
    select
      event_id,
      max(slug) as event_slug,
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
-- Hľadanie vracia pri evente slug, nie uuid
-- ============================================================================
-- `key` je to, z čoho appka skladá adresu. Návratový typ sa nemení, mení sa
-- jeho obsah — a preto sa tu funkcia nezahadzuje.
--
-- Zvyšok je prepísaný doslova z 20260101011300. Pri predošlých prepisoch sa už
-- stalo, že sa spolu s novým stĺpcom ticho vrátila stará podmienka, a odhalil
-- to až cudzí test.
create or replace function public.swap_search(
  p_query text default null,
  p_limit integer default 30
)
returns table (
  kind            text,      -- 'artist' | 'city' | 'venue' | 'event'
  key             text,
  label           text,
  sublabel        text,
  image_url       text,
  event_id        uuid,
  start_at        timestamptz,
  listing_count   integer,
  ticket_count    integer,
  from_cents      integer,
  currency        text,
  verified_count  integer
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  with q as (
    select public.blup_norm(coalesce(btrim(p_query), '')) as needle,
           greatest(1, least(coalesce(p_limit, 30), 100))  as cap
  ),
  -- Základ: živé ponuky aj s eventom, ku ktorému patria.
  base as (
    select
      l.id, l.event_id, l.price_cents, l.currency, l.quantity, l.source,
      e.title, e.city, e.venue_name, e.start_at, e.cover_image_url, e.performers,
      e.slug
    from public.swap_live_listings l
    join public.events e on e.id = l.event_id
  ),
  -- Prázdny dotaz nie je chyba: je to prvé otvorenie SWAPu, keď človek ešte
  -- nič nenapísal. Vtedy sa ukáže všetko, čo je v ponuke.
  hit as (
    select b.* from base b, q
    where q.needle = ''
       or public.blup_norm(b.title) like '%' || q.needle || '%'
       or public.blup_norm(coalesce(b.city, '')) like '%' || q.needle || '%'
       or public.blup_norm(coalesce(b.venue_name, '')) like '%' || q.needle || '%'
       or exists (
            select 1 from unnest(b.performers) as name
            where public.blup_norm(name) like '%' || q.needle || '%'
          )
  ),

  -- Interpreti. Len tí, na ktorých niekto naozaj niečo ponúka.
  artists as (
    select
      'artist'::text as kind, name as key, name as label,
      null::text as sublabel,
      (array_agg(h.cover_image_url order by h.start_at)
        filter (where h.cover_image_url is not null))[1] as image_url,
      null::uuid as event_id,
      min(h.start_at) as start_at,
      count(*)::integer as listing_count,
      sum(h.quantity)::integer as ticket_count,
      min(h.price_cents)::integer as from_cents,
      min(h.currency) as currency,
      count(*) filter (where h.source = 'blup')::integer as verified_count
    from hit h
    cross join lateral unnest(h.performers) as name
    cross join q
    where q.needle <> '' and public.blup_norm(name) like '%' || q.needle || '%'
    group by name
  ),

  cities as (
    select
      'city'::text as kind, h.city as key, h.city as label,
      null::text as sublabel,
      (array_agg(h.cover_image_url order by h.start_at)
        filter (where h.cover_image_url is not null))[1] as image_url,
      null::uuid as event_id,
      min(h.start_at) as start_at,
      count(*)::integer as listing_count,
      sum(h.quantity)::integer as ticket_count,
      min(h.price_cents)::integer as from_cents,
      min(h.currency) as currency,
      count(*) filter (where h.source = 'blup')::integer as verified_count
    from hit h, q
    where h.city is not null and q.needle <> ''
      and public.blup_norm(h.city) like '%' || q.needle || '%'
    group by h.city
  ),

  venues as (
    select
      'venue'::text as kind, h.venue_name as key, h.venue_name as label,
      max(h.city) as sublabel,
      (array_agg(h.cover_image_url order by h.start_at)
        filter (where h.cover_image_url is not null))[1] as image_url,
      null::uuid as event_id,
      min(h.start_at) as start_at,
      count(*)::integer as listing_count,
      sum(h.quantity)::integer as ticket_count,
      min(h.price_cents)::integer as from_cents,
      min(h.currency) as currency,
      count(*) filter (where h.source = 'blup')::integer as verified_count
    from hit h, q
    where h.venue_name is not null and q.needle <> ''
      and public.blup_norm(h.venue_name) like '%' || q.needle || '%'
    group by h.venue_name
  ),

  -- Eventy. Toto je to, na čo sa naozaj klikne, takže je ich tu viac než
  -- ostatných druhov a sú posledné.
  events_hit as (
    select
      -- `key` je to, čo sa dostane do adresy. Pri evente teda slug, keď ho má,
      -- a uuid, keď nie — `max()` preto, že sme v `group by h.event_id` a
      -- slug je v rámci jedného eventu vždy ten istý.
      'event'::text as kind,
      coalesce(max(h.slug), h.event_id::text) as key,
      max(h.title) as label,
      concat_ws(' · ', max(h.venue_name), max(h.city)) as sublabel,
      max(h.cover_image_url) as image_url,
      h.event_id,
      max(h.start_at) as start_at,
      count(*)::integer as listing_count,
      sum(h.quantity)::integer as ticket_count,
      min(h.price_cents)::integer as from_cents,
      min(h.currency) as currency,
      count(*) filter (where h.source = 'blup')::integer as verified_count
    from hit h
    group by h.event_id
  )

  -- Poradie: najprv to, kde sa dá najviac vybrať a kde sú overené vstupenky.
  -- BLUP radí podľa času a vzdialenosti, lebo odpovedá na „čo je dnes večer".
  -- SWAP odpovedá na „kde niečo zoženiem", a tam je ponuka dôležitejšia než
  -- to, či je to o hodinu alebo o mesiac.
  select kind, key, label, sublabel, image_url, event_id, start_at,
         listing_count, ticket_count, from_cents, currency, verified_count
  from (select * from artists order by listing_count desc, label limit (select cap from q)) a
  union all
  select kind, key, label, sublabel, image_url, event_id, start_at,
         listing_count, ticket_count, from_cents, currency, verified_count
  from (select * from cities order by listing_count desc, label limit (select cap from q)) c
  union all
  select kind, key, label, sublabel, image_url, event_id, start_at,
         listing_count, ticket_count, from_cents, currency, verified_count
  from (select * from venues order by listing_count desc, label limit (select cap from q)) v
  union all
  select kind, key, label, sublabel, image_url, event_id, start_at,
         listing_count, ticket_count, from_cents, currency, verified_count
  from (select * from events_hit
        order by verified_count desc, listing_count desc, start_at
        limit (select cap from q)) e;
$$;

revoke execute on function public.swap_search(text, integer) from public;
grant execute on function public.swap_search(text, integer) to anon, authenticated;
