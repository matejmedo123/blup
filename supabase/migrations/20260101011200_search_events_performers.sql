-- ============================================================================
-- Zoznam eventov musí nájsť to isté, čo našiel horný riadok
-- ============================================================================
-- Na obrazovke hľadania vznikol rozpor, ktorý bolo vidieť až na screenshote:
-- hore „Don Toliver · 1 event", dole „Nič také tu nie je. Skús inú náladu."
--
-- Obe tvrdenia boli pravdivé vo svojom svete. `search_all` pozerá do
-- `performers`, takže interpreta našiel. `search_events`, ktorý plní zoznam
-- pod tým, pozerá do názvu, popisu, miesta, mesta a značiek — a meno
-- účinkujúceho v žiadnom z nich byť nemusí. Event sa volá „Derby", nie
-- „Don Toliver".
--
-- Pre človeka to ale nie sú dva svety. Je to jedno pole a jedna odpoveď, a
-- „nič tu nie je" priamo pod nájdeným interpretom vyzerá ako pokazená appka.
--
-- Celá funkcia je tu prepísaná zámerne: je to jeden zdroj pravdy o tom, čo
-- hľadanie eventov znamená, a rozdeliť ju na základ a nadstavbu by znamenalo
-- dve miesta, kde sa dá zabudnúť na jedno z nich.
--
-- POZOR pri ďalšom prepise: táto funkcia neprišla na svet v tejto podobe.
-- Migrácia 005000 do nej doplnila viacero kategórií tým, že v jej uloženej
-- definícii nahradila kus textu. Kto ju prepíše z pôvodnej predlohy, tú
-- zmenu vráti späť — presne to sa pri písaní tohto súboru stalo a odhalil to
-- až test_27.
-- ============================================================================
set search_path = public, extensions;

create or replace function public.search_events(
  p_query      text default null,
  p_lat        double precision default null,
  p_lon        double precision default null,
  p_radius_m   double precision default null,
  p_from       timestamptz default now(),
  p_to         timestamptz default null,
  p_categories text[] default null,
  p_free_only  boolean default false,
  p_max_price_cents integer default null,
  p_sort       text default 'start_at',   -- start_at | distance | popularity
  p_limit      integer default 40,
  p_offset     integer default 0
)
returns setof public.event_feed_item
language sql
stable
security definer
set search_path = public, extensions
as $$
  with me as (select auth.uid() as uid)
  select
    e.id, e.title, e.description, e.cover_image_url, e.category, e.tags,
    e.latitude, e.longitude, e.address, e.venue_name, e.city,
    e.start_at, e.end_at, e.is_free, e.price_cents, e.currency, e.capacity,
    e.attendee_count, e.saved_count, e.like_count, e.comment_count,
    e.status, e.visibility,
    e.creator_id, p.username::text, p.display_name, p.avatar_url,
    e.organization_id, o.name, (o.verification_status = 'verified'),
    case when p_lat is null or p_lon is null then null
         else public.blup_distance_m(p_lat, p_lon, e.latitude, e.longitude) end as distance_m,
    (
      select count(*)::integer from public.event_attendees a
      join public.follows f on f.following_id = a.user_id
      where a.event_id = e.id and a.status in ('going', 'checked_in')
        and f.follower_id = (select uid from me)
    ),
    exists (select 1 from public.saved_events s
            where s.event_id = e.id and s.user_id = (select uid from me)),
    exists (select 1 from public.event_attendees a
            where a.event_id = e.id and a.user_id = (select uid from me)
              and a.status in ('going', 'interested', 'checked_in')),
    null::numeric,
    null::jsonb
  from public.events e
  join public.profiles p on p.id = e.creator_id
  left join public.organizations o on o.id = e.organization_id
  where e.status = 'published'
    and e.visibility in ('public', 'unlisted')
    and coalesce(e.end_at, e.start_at + interval '4 hours') >= coalesce(p_from, now())
    and (p_to is null or e.start_at <= p_to)
    -- `categories`, nie `category`. Event môže mať viac kategórií a
    -- migrácia 005000 to do tejto funkcie doplnila textovou náhradou nad
    -- už existujúcou definíciou. Kto ju potom prepíše zo staršej predlohy —
    -- ako sa práve stalo mne — tú zmenu ticho vráti späť a hľadanie prestane
    -- nachádzať event podľa jeho druhej kategórie. Test to odchytil.
    and (p_categories is null or e.categories && p_categories)
    and (not p_free_only or e.is_free)
    and (p_max_price_cents is null or e.price_cents <= p_max_price_cents)
    and (
      p_query is null or char_length(trim(p_query)) = 0
      or to_tsvector('simple',
           coalesce(e.title, '') || ' ' || coalesce(e.description, '') || ' ' ||
           coalesce(e.venue_name, '') || ' ' || coalesce(e.city, ''))
         @@ plainto_tsquery('simple', p_query)
      or e.title ilike '%' || p_query || '%'
      or p_query = any (e.tags)
      -- Meno účinkujúceho. Bez tohto riadku našiel horný riadok obrazovky
      -- interpreta a zoznam pod ním napísal „nič tu nie je" — dve pravdivé
      -- tvrdenia, ktoré spolu vyzerajú ako pokazená appka.
      --
      -- Cez `blup_norm`, nie `ilike`: inak „dvorak" nenájde „Dvořák", čo je
      -- presne ten preklep, kvôli ktorému `blup_norm` existuje.
      or exists (
        select 1 from unnest(e.performers) as performer
        where public.blup_norm(performer) like '%' || public.blup_norm(p_query) || '%'
      )
    )
    and (
      p_radius_m is null or p_lat is null or p_lon is null
      or public.blup_distance_m(p_lat, p_lon, e.latitude, e.longitude) <= p_radius_m
    )
  order by
    case when p_sort = 'distance' and p_lat is not null
         then public.blup_distance_m(p_lat, p_lon, e.latitude, e.longitude) end asc nulls last,
    case when p_sort = 'popularity'
         then (e.attendee_count + e.saved_count) end desc nulls last,
    case when p_sort not in ('distance', 'popularity') then e.start_at end asc
  limit greatest(1, least(coalesce(p_limit, 40), 100))
  offset greatest(0, coalesce(p_offset, 0));
$$;
