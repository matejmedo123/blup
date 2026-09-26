-- ============================================================================
-- Hľadanie: interpret, mesto, miesto, event — na jednom riadku
-- ============================================================================
-- Doteraz vedela appka hľadať EVENTY podľa názvu. To stačí, kým eventy
-- vytvárajú ľudia a volajú ich po tom, čo sa deje. Prestane to stačiť v
-- momente, keď sa na BLUPe predávajú vstupenky na koncerty: človek nehľadá
-- „Koncert v hale", hľadá „Don Toliver". A hľadá aj „Bratislava", čo nie je
-- názov ničoho — je to mesto.
--
-- Chýbal na to údaj. Event nemal nikde napísané, KTO na ňom vystupuje, takže
-- meno interpreta sa nedalo nájsť inak než náhodou v názve. Pribudlo pole
-- `performers` a s ním jedna funkcia, ktorá vráti všetky štyri druhy výsledkov
-- naraz — interpret, mesto, miesto, event — a appka ich len zoskupí.
--
-- Prečo jedna funkcia a nie štyri dotazy: kým píšeš, pýta sa to pri každom
-- písmene. Štyri dotazy znamenajú štyri kolá na server a štyri príležitosti,
-- aby sa výsledky navzájom predbehli a zoznam poskakoval.
-- ============================================================================
set search_path = public, extensions;

-- Diakritika a preklepy. `unaccent` je ten dôležitejší: bez neho „Dvorak"
-- nenájde „Dvořák" a „Zilina" nenájde „Žilina", čo je na slovenskej appke
-- polovica hľadaní.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'unaccent') then
    create extension if not exists "unaccent" with schema extensions;
  end if;
  if exists (select 1 from pg_available_extensions where name = 'pg_trgm') then
    create extension if not exists "pg_trgm" with schema extensions;
  end if;
end $$;

/**
 * Text pripravený na porovnávanie: bez diakritiky, malými písmenami.
 *
 * `immutable` schválne — inak sa z toho nedá spraviť index a hľadanie by pri
 * každom písmene prešlo celú tabuľku.
 */
create or replace function public.blup_norm(p_text text)
returns text
language sql
immutable
parallel safe
-- `security definer` nie je tu kvôli dátam, ale kvôli SCHÉME. Funkcia je
-- súčasťou indexového výrazu, takže sa vyhodnocuje pri každom zápise do
-- `events` — a to v roli toho, kto zapisuje. Bežný prihlásený človek do
-- schémy `extensions` nevidí, takže bez tohto by mu KAŽDÝ zápis eventu
-- spadol na „permission denied for schema extensions". Funkcia nečíta žiadne
-- tabuľky a vracia len upravený text, ktorý dostala.
security definer
set search_path = public, extensions
as $$
  select lower(
    case when exists (select 1 from pg_extension where extname = 'unaccent')
         then extensions.unaccent(coalesce(p_text, ''))
         else coalesce(p_text, '')
    end
  );
$$;

revoke execute on function public.blup_norm(text) from public;
grant execute on function public.blup_norm(text) to anon, authenticated;

-- --- kto na evente vystupuje -------------------------------------------------
alter table public.events
  add column if not exists performers text[] not null default '{}'::text[];

-- Najviac desať mien a každé rozumne dlhé. Pole bez stropu je miesto, kam sa
-- raz niekto pokúsi nasypať celý zoznam kapiel festivalu aj s popisom.
--
-- Dĺžka sa kontroluje cez `array_to_string`, nie poddotazom: check constraint
-- poddotaz nepustí a pomocná funkcia by musela byť `immutable`, čo by pri
-- zmene jej tela ticho pokazilo už uložené riadky.
alter table public.events drop constraint if exists events_performers_shape;
alter table public.events add constraint events_performers_shape check (
  array_length(performers, 1) is null or (
    array_length(performers, 1) <= 10
    and char_length(array_to_string(performers, '')) <= 800
    -- Prázdne meno v zozname účinkujúcich je prázdny riadok v appke.
    and array_position(performers, '') is null
    and array_position(performers, null) is null
  )
);

create index if not exists events_performers_idx on public.events using gin (performers);

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_trgm') then
    -- Trigramy hľadajú aj v strede slova a znesú preklep. Bez nich vie index
    -- pomôcť len pri hľadaní od začiatku názvu.
    execute 'create index if not exists events_title_trgm_idx
             on public.events using gin (public.blup_norm(title) extensions.gin_trgm_ops)';
    execute 'create index if not exists events_city_trgm_idx
             on public.events using gin (public.blup_norm(city) extensions.gin_trgm_ops)';
    execute 'create index if not exists events_venue_trgm_idx
             on public.events using gin (public.blup_norm(venue_name) extensions.gin_trgm_ops)';
  end if;
end $$;

-- Koľko sa na evente práve ponúka na burze.
--
-- Vo výsledkoch hľadania to nie je ozdoba: keď je koncert vypredaný, jediná
-- cesta dnu vedie cez burzu, a „3 na burze" je presne tá informácia, pre ktorú
-- človek hľadanie otvoril.
create or replace function public.resale_live_count(p_event_id uuid)
returns integer
language sql
stable
security definer
set search_path = public, extensions
as $$
  select count(*)::integer
  from public.resale_listings l
  join public.profiles p on p.id = l.seller_id
  where l.event_id = p_event_id
    and l.status = 'active'
    and (l.expires_at is null or l.expires_at > now())
    and not p.is_suspended;
$$;

revoke execute on function public.resale_live_count(uuid) from public;
grant execute on function public.resale_live_count(uuid) to anon, authenticated;

-- ============================================================================
-- Jedno hľadanie, štyri druhy výsledkov
-- ============================================================================
create or replace function public.search_all(
  p_query text,
  p_limit integer default 8
)
returns table (
  kind          text,      -- 'artist' | 'city' | 'venue' | 'event'
  key           text,      -- čím sa na to dá odkázať (meno, mesto, id eventu)
  label         text,
  sublabel      text,
  image_url     text,
  event_count   integer,
  next_at       timestamptz,
  latitude      double precision,
  longitude     double precision,
  resale_count  integer
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  with q as (
    select public.blup_norm(btrim(p_query)) as needle,
           greatest(1, least(coalesce(p_limit, 8), 20)) as cap
  ),
  -- Len to, čo sa naozaj dá kúpiť: zverejnené, verejné a ešte pred koncom.
  live as (
    select e.*
    from public.events e, q
    where e.status = 'published'
      and e.visibility = 'public'
      and coalesce(e.end_at, e.start_at) > now()
      and q.needle <> ''
  ),

  -- 1. Interpreti. Meno sa berie z `performers`, nie z názvu eventu: „Koncert
  --    v hale" nepovie nikomu nič, ale medzi účinkujúcimi je Don Toliver.
  artists as (
    select
      'artist'::text as kind,
      name           as key,
      name           as label,
      count(*)::integer                       as event_count,
      min(l.start_at)                         as next_at,
      (array_agg(l.cover_image_url order by l.start_at)
        filter (where l.cover_image_url is not null))[1] as image_url,
      sum(public.resale_live_count(l.id))::integer as resale_count
    from live l
    cross join lateral unnest(l.performers) as name
    cross join q
    where public.blup_norm(name) like '%' || q.needle || '%'
    group by name
  ),

  -- 2. Mestá. Nie je to názov ničoho, je to miesto — a je to druhý
  --    najčastejší spôsob, akým človek hľadá, čo sa deje.
  cities as (
    select
      'city'::text   as kind,
      l.city         as key,
      l.city         as label,
      count(*)::integer as event_count,
      min(l.start_at)   as next_at,
      (array_agg(l.cover_image_url order by l.start_at)
        filter (where l.cover_image_url is not null))[1] as image_url,
      sum(public.resale_live_count(l.id))::integer as resale_count,
      avg(l.latitude)::double precision  as latitude,
      avg(l.longitude)::double precision as longitude
    from live l, q
    where l.city is not null
      and public.blup_norm(l.city) like '%' || q.needle || '%'
    group by l.city
  ),

  -- 3. Miesta. „O2 Arena" je to, čo si človek pamätá, keď si nepamätá dátum.
  venues as (
    select
      'venue'::text    as kind,
      l.venue_name     as key,
      l.venue_name     as label,
      max(l.city)      as sublabel,
      count(*)::integer as event_count,
      min(l.start_at)   as next_at,
      (array_agg(l.cover_image_url order by l.start_at)
        filter (where l.cover_image_url is not null))[1] as image_url,
      sum(public.resale_live_count(l.id))::integer as resale_count,
      avg(l.latitude)::double precision  as latitude,
      avg(l.longitude)::double precision as longitude
    from live l, q
    where l.venue_name is not null
      and public.blup_norm(l.venue_name) like '%' || q.needle || '%'
    group by l.venue_name
  ),

  -- 4. Konkrétne eventy.
  events_hit as (
    select
      'event'::text as kind,
      l.id::text    as key,
      l.title       as label,
      concat_ws(' · ', l.venue_name, l.city) as sublabel,
      l.cover_image_url as image_url,
      1             as event_count,
      l.start_at    as next_at,
      l.latitude, l.longitude,
      public.resale_live_count(l.id) as resale_count,
      l.attendee_count
    from live l, q
    where public.blup_norm(l.title) like '%' || q.needle || '%'
       or public.blup_norm(coalesce(l.description, '')) like '%' || q.needle || '%'
  )

  -- Poradie druhov je zámerné: kto hľadá meno, chce najprv interpreta a až
  -- potom jeho jednotlivé termíny. Vnútri druhu rozhoduje, čoho je viac.
  select kind, key, label, null::text, image_url, event_count, next_at,
         null::double precision, null::double precision, resale_count
  from (select * from artists order by event_count desc, label limit (select cap from q)) a
  union all
  select kind, key, label, null::text, image_url, event_count, next_at,
         latitude, longitude, resale_count
  from (select * from cities order by event_count desc, label limit (select cap from q)) c
  union all
  select kind, key, label, sublabel, image_url, event_count, next_at,
         latitude, longitude, resale_count
  from (select * from venues order by event_count desc, label limit (select cap from q)) v
  union all
  select kind, key, label, sublabel, image_url, event_count, next_at,
         latitude, longitude, resale_count
  from (select * from events_hit
        order by resale_count desc, attendee_count desc, next_at
        limit (select cap from q) * 2) e;
$$;

revoke execute on function public.search_all(text, integer) from public;
grant execute on function public.search_all(text, integer) to anon, authenticated;

-- ============================================================================
-- Z výsledku na zoznam eventov
-- ============================================================================
-- Kliknutie na interpreta, mesto alebo miesto musí niekam viesť. Vracia to
-- `event_feed_item`, teda presne to, čo už appka vie zobraziť — žiadna nová
-- karta a žiadny nový tvar dát.
create or replace function public.events_matching(
  p_kind  text,
  p_key   text,
  p_limit integer default 40
)
returns setof public.event_feed_item
language sql
stable
security definer
set search_path = public, extensions
as $$
  select *
  from public.search_events(
    -- Interpret sa nehľadá textom: `search_events` pozerá do názvu a popisu,
    -- kde meno byť nemusí. Preto sa filtruje nižšie cez `performers`.
    p_query => case when p_kind = 'event' then null else null end,
    p_limit => greatest(1, least(coalesce(p_limit, 40), 100))
  ) f
  where case p_kind
    when 'artist' then exists (
      select 1 from public.events e
      where e.id = f.id
        and exists (
          select 1 from unnest(e.performers) as name
          where public.blup_norm(name) = public.blup_norm(p_key)
        )
    )
    when 'city' then exists (
      select 1 from public.events e
      where e.id = f.id and public.blup_norm(e.city) = public.blup_norm(p_key)
    )
    when 'venue' then exists (
      select 1 from public.events e
      where e.id = f.id and public.blup_norm(e.venue_name) = public.blup_norm(p_key)
    )
    else f.id::text = p_key
  end;
$$;

revoke execute on function public.events_matching(text, text, integer) from public;
grant execute on function public.events_matching(text, text, integer) to anon, authenticated;
