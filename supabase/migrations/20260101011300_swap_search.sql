-- ============================================================================
-- BLUP SWAP — vlastné hľadanie
-- ============================================================================
-- SWAP je samostatný produkt. Do BLUPu siaha jediným spôsobom — cez vstupenku,
-- ktorú vie previesť — a všetko ostatné si rieši sám. Aj hľadanie.
--
-- Nie je to to isté hľadanie s filtrom. Rozdiel je v otázke, ktorú kladie:
--
--   BLUP        „čo sa deje?" — všetky nadchádzajúce eventy, aj tie, na ktoré
--               sa vstupenky nepredávajú a nikdy nepredávali.
--
--   SWAP        „kde sa dá kúpiť vstupenka od niekoho?" — len to, na čo NIEKTO
--               PRÁVE TERAZ niečo ponúka. Event bez jedinej ponuky tu nemá čo
--               robiť: viedol by na prázdnu obrazovku.
--
-- A iné je aj poradie. BLUP radí podľa času a vzdialenosti — chceš vedieť, čo
-- je dnes večer blízko. SWAP radí podľa toho, čo sa dá kúpiť: najprv to, kde
-- je najviac ponúk a kde sú overené vstupenky, lebo to je to, kvôli čomu sem
-- človek prišiel.
--
-- Preto vlastná funkcia a nie parameter pri `search_all`. Jedna funkcia s
-- prepínačom by musela obe logiky držať v sebe a pri každej zmene jednej by
-- sa dala pokaziť druhá.
-- ============================================================================
set search_path = public, extensions;

-- --- čo sa práve dá kúpiť ----------------------------------------------------
--
-- Jeden pohľad, na ktorom stojí celý SWAP. Ponuka je živá, keď je aktívna,
-- neuplynula a predajca nie je zablokovaný — a to sa nesmie počítať na piatich
-- miestach päťkrát inak.
create or replace view public.swap_live_listings as
select l.*
from public.resale_listings l
join public.profiles p on p.id = l.seller_id
where l.status = 'active'
  and (l.expires_at is null or l.expires_at > now())
  and not p.is_suspended
  and exists (
    select 1 from public.events e
    where e.id = l.event_id
      and e.status = 'published'
      and e.visibility = 'public'
      and coalesce(e.end_at, e.start_at) > now()
  );

-- --- hľadanie ---------------------------------------------------------------
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
      e.title, e.city, e.venue_name, e.start_at, e.cover_image_url, e.performers
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
      'event'::text as kind, h.event_id::text as key, max(h.title) as label,
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

-- --- eventy za jedným výsledkom ---------------------------------------------
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
