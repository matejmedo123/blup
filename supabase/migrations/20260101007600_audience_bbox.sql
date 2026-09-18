-- ============================================================================
-- Odhad publika sa nesmie zhoršovať s každým novým používateľom
--
-- `ad_audience_estimate()` počítala vzdialenosť pre KAŽDÝ profil v databáze —
-- haversine s piatimi goniometrickými funkciami na riadok. Pri dvoch tisíckach
-- ľudí to nikto nepostrehne. Pri stotisíc je to stotisíc volaní na jedno
-- posunutie posuvníka s okruhom, a obrazovka s reklamou ho posúva často.
--
-- Index `profiles_geo_idx (latitude, longitude)` existuje od prvej migrácie a
-- takýto dotaz ho použiť nevie: podmienka je na výsledku funkcie, nie na
-- stĺpcoch. Preto tu pribúda obdĺžnik okolo miesta konania — ten index použije
-- a odreže drvivú väčšinu riadkov — a presná vzdialenosť sa počíta až pre to,
-- čo v obdĺžniku zostane.
--
-- Obdĺžnik je zámerne ŠIRŠÍ než kruh (rohy), takže sa ním nič nestratí; presná
-- podmienka za ním zostáva nezmenená a výsledok je na riadok rovnaký. Overuje
-- to test 46.
-- ============================================================================
set search_path = public, extensions;

create or replace function public.ad_audience_estimate(
  p_event_id   uuid,
  p_radius_m   integer default 30000,
  p_categories text[] default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  ev        public.events%rowtype;
  radius    integer := greatest(least(coalesce(p_radius_m, 30000), 200000), 1000);
  lat_delta double precision;
  lon_delta double precision;
  people    integer;
  active    integer;
begin
  select * into ev from public.events where id = p_event_id;
  if not found then
    raise exception 'EVENT_NOT_AVAILABLE';
  end if;

  -- Stupeň zemepisnej šírky je všade ~111,32 km. Stupeň dĺžky sa smerom k pólu
  -- skracuje o cos(šírka), preto sa delí ním; `greatest` drží deliteľa nad
  -- nulou, aby obdĺžnik pri póle nebol nekonečný.
  lat_delta := radius / 111320.0;
  lon_delta := radius / greatest(111320.0 * cos(radians(coalesce(ev.latitude, 0))), 1.0);

  select
    count(*),
    count(*) filter (
      where exists (
        select 1 from public.user_stats us
        where us.user_id = p.id
          and us.last_active_on > (current_date - 30)
      )
    )
  into people, active
  from public.profiles p
  where p.id <> ev.creator_id
    and p.latitude is not null
    and p.longitude is not null
    -- Hrubé sito, ktoré vie použiť index.
    and p.latitude between ev.latitude - lat_delta and ev.latitude + lat_delta
    and p.longitude between ev.longitude - lon_delta and ev.longitude + lon_delta
    and not coalesce(p.is_suspended, false)
    -- A až potom presný kruh, na zlomku riadkov.
    and public.blup_distance_m(ev.latitude, ev.longitude, p.latitude, p.longitude) <= radius
    and (
      p_categories is null
      or cardinality(p_categories) = 0
      or exists (
        select 1
        from public.user_interests ui
        join public.interests i on i.id = ui.interest_id
        where ui.user_id = p.id and i.category = any(p_categories)
      )
    );

  return jsonb_build_object(
    'radius_m', radius,
    'people', coalesce(people, 0),
    'active_people', coalesce(active, 0),
    'categories', coalesce(p_categories, '{}')
  );
end;
$$;

grant execute on function public.ad_audience_estimate(uuid, integer, text[]) to authenticated;
