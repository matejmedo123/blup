-- ============================================================================
-- Štadión sa dá použiť a príbeh môže byť video
-- ============================================================================
-- Predloha štadióna má 67 sektorov. Jej použitie trvalo 77 sekúnd, čiže z
-- appky neprešlo vôbec — requestu vyprší čas a človek vidí len to, že sa nič
-- nestalo. Test nemeria rýchlosť (tá je na inom stroji iná), meria to, čo z
-- toho plynie: že sa predloha DOKONČÍ a že vyrobí celý plán, nie kus.
--
-- Druhá polovica je `media_type`: príbeh, ktorý je video, sa musí dať uložiť
-- a prehrávač sa to musí dozvedieť zo servera, nie hádať z prípony.
-- ============================================================================
begin;
set search_path = public, extensions;

insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('a5353535-0000-0000-0000-000000000001', 'org53@example.com', now(), '{"display_name":"Organizátor"}'),
  ('a5353535-0000-0000-0000-000000000002', 'fan53@example.com', now(), '{"display_name":"Fanúšik"}');

update public.profiles set app_role = 'admin' where id = 'a5353535-0000-0000-0000-000000000001';

insert into public.organizations (id, name, slug, created_by, verification_status)
values ('b5353535-0000-0000-0000-000000000001', 'Štadión s.r.o.', 'stadion-53',
        'a5353535-0000-0000-0000-000000000001', 'verified');
-- Zakladateľa pridáva trigger sám; toto je len poistka, keby sa to zmenilo.
insert into public.organization_members (organization_id, user_id, role)
values ('b5353535-0000-0000-0000-000000000001', 'a5353535-0000-0000-0000-000000000001', 'owner')
on conflict do nothing;

-- ============================================================================
-- 1. Predloha štadióna sa dokončí a nakreslí celú halu
-- ============================================================================
do $$
declare
  v_me       uuid := 'a5353535-0000-0000-0000-000000000001';
  v_event    uuid;
  v_map      uuid;
  v_sections integer;
  v_seats    integer;
  v_expected integer;
begin
  insert into public.events (
    creator_id, organization_id, title, category, latitude, longitude,
    start_at, is_free, status, visibility
  ) values (
    v_me, 'b5353535-0000-0000-0000-000000000001', 'Derby', 'football', 48.3, 18.1,
    now() + interval '7 days', true, 'published', 'public'
  ) returning id into v_event;

  -- Koľko sektorov predloha sľubuje.
  select jsonb_array_length(value -> 'sections') into v_expected
  from jsonb_array_elements(public.venue_presets()) value
  where value ->> 'code' = 'stadium';

  assert v_expected >= 60,
    format('predloha štadióna má mať desiatky sektorov, má %s', v_expected);

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_me::text, true);

  v_map := public.apply_venue_preset(v_event, 'stadium');

  reset role;

  assert v_map is not null, 'predloha nevrátila plán';

  select count(*) into v_sections
  from public.venue_sections s where s.venue_map_id = v_map;

  assert v_sections = v_expected,
    format('nakreslilo sa %s zo %s sektorov — predloha sa nedokončila',
           v_sections, v_expected);

  select count(*) into v_seats
  from public.venue_seats vs
  join public.venue_sections s on s.id = vs.venue_section_id
  where s.venue_map_id = v_map;

  -- Tisíce, nie stovky: keby sa generovanie zastavilo v polovici, plán by
  -- vyzeral hotovo a polovica tribún by bola prázdna.
  assert v_seats > 5000,
    format('na štadióne vzniklo len %s miest', v_seats);

  -- A každý sektor, ktorému predloha zadala rady a miesta, ich naozaj má.
  -- Brány a skybox v zozname sú tiež sektory, ale sedenie im predloha nedáva —
  -- sú to vchody a priestor, nie tribúny. Podmienka sa preto pýta predlohy,
  -- nie typu: čo si vypýtalo rady, to má mať miesta.
  assert not exists (
    select 1
    from jsonb_array_elements(
           (select value -> 'sections' from jsonb_array_elements(public.venue_presets()) value
            where value ->> 'code' = 'stadium')
         ) want
    join public.venue_sections s
      on s.venue_map_id = v_map and s.name = want ->> 'name'
    where (want ->> 'rows')::integer > 0
      and (want ->> 'per_row')::integer > 0
      and not exists (select 1 from public.venue_seats vs where vs.venue_section_id = s.id)
  ), 'tribúna, ktorá mala dostať rady a miesta, zostala prázdna';

  raise notice 'PASS predloha štadióna sa dokončí — % sektorov, % miest', v_sections, v_seats;
end $$;

-- ============================================================================
-- 2. Príbeh môže byť video a server povie, čo to je
-- ============================================================================
do $$
declare
  v_me    uuid := 'a5353535-0000-0000-0000-000000000001';
  v_fan   uuid := 'a5353535-0000-0000-0000-000000000002';
  v_story uuid;
  v_kind  text;
  v_failed boolean := false;
begin
  insert into public.follows (follower_id, following_id) values (v_fan, v_me);

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_me::text, true);

  v_story := public.create_story(
    'https://tchvgzbxddqdneylkqvi.supabase.co/storage/v1/object/public/stories/a/klip.mp4',
    'z tribúny', null, null, 'video'
  );

  select media_type into v_kind from public.stories_of(v_me) where id = v_story;
  assert v_kind = 'video', format('príbeh sa uložil ako %s namiesto video', v_kind);

  -- A fotka zostáva fotkou aj bez toho, aby to volajúci povedal.
  perform public.create_story(
    'https://tchvgzbxddqdneylkqvi.supabase.co/storage/v1/object/public/stories/a/foto.jpg',
    null, null, null
  );
  assert exists (select 1 from public.stories_of(v_me) where media_type = 'image'),
    'príbeh bez udaného typu sa neuložil ako fotka';

  -- Sledujúci vidí ten istý typ — prehrávač sa nesmie dozvedieť niečo iné
  -- než autor.
  perform set_config('request.jwt.claim.sub', v_fan::text, true);
  select media_type into v_kind from public.stories_of(v_me) where id = v_story;
  assert v_kind = 'video', 'sledujúcemu sa typ príbehu ukázal inak';

  -- Vymyslený typ sa neuloží.
  perform set_config('request.jwt.claim.sub', v_me::text, true);
  begin
    perform public.create_story(
      'https://tchvgzbxddqdneylkqvi.supabase.co/storage/v1/object/public/stories/a/x.exe',
      null, null, null, 'spustitelny-subor'
    );
  exception when others then
    v_failed := true;
  end;
  assert v_failed, 'príbeh prijal neznámy typ média';

  reset role;
  raise notice 'PASS príbeh môže byť video a typ prichádza zo servera';
end $$;

-- ============================================================================
-- 3. Nové kategórie naozaj existujú
-- ============================================================================
do $$
declare
  v_missing text;
begin
  select string_agg(want, ', ') into v_missing
  from unnest(array['quiz', 'sport', 'hockey', 'tennis', 'fitness', 'concert',
                    'party', 'standup', 'comedy', 'market', 'conference',
                    'workshop', 'esports', 'family', 'charity']) want
  where not exists (select 1 from public.interests i where i.slug = want);

  assert v_missing is null, format('chýbajú kategórie: %s', v_missing);

  -- A každá z nich patrí do niektorej skupiny, ktorú onboarding vie zobraziť.
  assert not exists (
    select 1 from public.interests i
    where i.slug in ('quiz', 'sport', 'concert', 'standup', 'conference')
      and i.category not in ('music', 'sport', 'outdoor', 'culture', 'food',
                             'business', 'nightlife', 'social', 'wellness', 'other')
  ), 'nová kategória spadla do skupiny, ktorú onboarding nepozná';

  raise notice 'PASS kvíz, šport a ďalšie kategórie sú v katalógu';
end $$;

rollback;
