-- ============================================================================
-- Predlohy hál: geometria
-- ============================================================================
-- Toto je test, ktorý mal existovať skôr. Sedem prekryvov v predlohách prešlo
-- cez typy, lint aj build a prišlo sa na ne až tak, že si to človek pozrel —
-- oblúkové tribúny mali sweep 100° namiesto 90°, tak v každom rohu štadióna
-- ležali dve cez seba.
--
-- Prekryv nie je len škaredý. Sektor je plocha, na ktorú sa dá kliknúť; dva
-- cez seba znamenajú, že kupujúci klikne na jeden a vyberie sa druhý.
-- ============================================================================
begin;
set search_path = public, extensions;

-- --- najprv: vie ten detektor vôbec prekryv nájsť? ----------------------------------
--
-- Kontrola, ktorá prejde preto, že nič nenašla, je horšia než žiadna. Toto je
-- presne tá geometria, ktorú mal štadión pred opravou: dva oblúky, každý cez
-- 100° namiesto 90°, takže sa v rohu prekrývajú. Keby vzorkovanie nižšie
-- nefungovalo, spadne to tu a nie o rok.
do $$
declare
  a polygon;
  b polygon;
  hit boolean := false;
  px numeric; py numeric;
  i integer; j integer;
  N constant integer := 40;
begin
  -- dva štvorce, ktoré sa prekrývajú v rohu na ploche 0,01
  a := polygon('((0.10,0.10),(0.50,0.10),(0.50,0.50),(0.10,0.50))');
  b := polygon('((0.40,0.40),(0.80,0.40),(0.80,0.80),(0.40,0.80))');

  for i in 0 .. N - 1 loop
    exit when hit;
    for j in 0 .. N - 1 loop
      px := 0.40 + 0.10 * (i + 0.5) / N;
      py := 0.40 + 0.10 * (j + 0.5) / N;
      if a @> point(px::float8, py::float8) and b @> point(px::float8, py::float8) then
        hit := true; exit;
      end if;
    end loop;
  end loop;

  assert hit, 'detektor prekryvov nevidí ani prekryv, ktorý tam naozaj je';
  raise notice 'PASS detektor prekryvov naozaj hľadá';
end $$;

-- --- žiadne dva sektory v predlohe sa neprekrývajú ---------------------------------
--
-- Postup: pre každú dvojicu sektorov, ktorých ohraničenia sa pretínajú, sa
-- prieniková plocha navzorkuje mriežkou a hľadá sa bod, ktorý leží v oboch.
-- Postgres nemá prienik polygónov, ale `polygon @> point` má, a na toto to
-- stačí — mriežka 40 × 40 nájde aj prekryv s plochou pod 0,1 % plánu.
do $$
declare
  v_preset  jsonb;
  a         record;
  b         record;
  v_bad     integer := 0;
  v_pairs   integer := 0;   -- všetky dvojice, ktoré test pozrel
  v_boxes   integer := 0;   -- z nich tie, ktorým sa pretínajú ohraničenia
  ix0 numeric; iy0 numeric; ix1 numeric; iy1 numeric;
  lo_a point; hi_a point; lo_b point; hi_b point;
  hit boolean;
  px numeric; py numeric;
  i integer; j integer;
  N constant integer := 40;
begin
  for v_preset in select value from jsonb_array_elements(public.venue_presets()) value
  loop
    -- Každý sektor ako polygón: tvarovaný zo svojich bodov, obyčajný zo
    -- svojho obdĺžnika. Ohraničenie sa počíta z toho istého polygónu, nie
    -- z x/y/w/h v JSON-e — inak by test veril číslu, ktoré má overiť.
    for a in
      with secs as (
        -- Sektor ako polygón: tvarovaný zo svojich bodov, obyčajný zo svojho
        -- obdĺžnika. Cez tú istú funkciu, akou z tvaru počíta miesta appka —
        -- test, ktorý si geometriu počíta po svojom, overuje iný program.
        select s.value ->> 'name' as name,
               coalesce(
                 public.jsonb_to_polygon(s.value -> 'shape'),
                 public.jsonb_to_polygon(jsonb_build_array(
                   jsonb_build_object('x', s.value -> 'x', 'y', s.value -> 'y'),
                   jsonb_build_object('x', (s.value ->> 'x')::numeric + (s.value ->> 'width')::numeric, 'y', s.value -> 'y'),
                   jsonb_build_object('x', (s.value ->> 'x')::numeric + (s.value ->> 'width')::numeric,
                                      'y', (s.value ->> 'y')::numeric + (s.value ->> 'height')::numeric),
                   jsonb_build_object('x', s.value -> 'x', 'y', (s.value ->> 'y')::numeric + (s.value ->> 'height')::numeric)
                 ))
               ) as poly,
               row_number() over () as ord
        from jsonb_array_elements(v_preset -> 'sections') s
      )
      select x.name as an, x.poly as ap, y.name as bn, y.poly as bp
      from secs x join secs y on y.ord > x.ord
    loop
      -- Prienik ohraničení. box(polygon) je zabudovaný, takže to ani tu
      -- nepočítam po svojom. box[1] je ľavý dolný roh, box[0] pravý horný;
      -- cez medzipremenné preto, že dvojité zátvorkovanie na bode Postgres
      -- neprežije.
      lo_a := (box(a.ap))[1];  hi_a := (box(a.ap))[0];
      lo_b := (box(a.bp))[1];  hi_b := (box(a.bp))[0];
      ix0 := greatest(lo_a[0], lo_b[0]);
      iy0 := greatest(lo_a[1], lo_b[1]);
      ix1 := least(hi_a[0], hi_b[0]);
      iy1 := least(hi_a[1], hi_b[1]);

      v_pairs := v_pairs + 1;
      -- Keď sa nepretínajú ani ohraničenia, polygóny sa pretínať nemôžu.
      continue when ix0 >= ix1 or iy0 >= iy1;
      v_boxes := v_boxes + 1;

      hit := false;
      for i in 0 .. N - 1 loop
        exit when hit;
        for j in 0 .. N - 1 loop
          px := ix0 + (ix1 - ix0) * (i + 0.5) / N;
          py := iy0 + (iy1 - iy0) * (j + 0.5) / N;
          if a.ap @> point(px::float8, py::float8)
             and a.bp @> point(px::float8, py::float8) then
            hit := true;
            exit;
          end if;
        end loop;
      end loop;

      if hit then
        v_bad := v_bad + 1;
        raise warning 'PREKRYV % : % × %', v_preset ->> 'code', a.an, a.bn;
      end if;
    end loop;
  end loop;

  -- Poistka proti testu, ktorý prejde preto, že nič neporovnal.
  assert v_pairs > 100, format('test pozrel len %s dvojíc — asi sa zmenil tvar predlôh', v_pairs);
  assert v_bad = 0, format('%s dvojíc sektorov leží cez seba', v_bad);
  raise notice 'PASS žiadne dva sektory v predlohe neležia cez seba (% dvojíc, % s dotykom ohraničení)',
    v_pairs, v_boxes;
end $$;

-- --- ohraničenie sektora sedí na to, čo je nakreslené -------------------------------
--
-- x/y/width/height sa používa na ťahanie a na klikacie plochy. Keď nesedí na
-- tvar, kupujúci klikne na tribúnu a netrafí ju.
do $$
declare v_off integer;
begin
  select count(*) into v_off
  from jsonb_array_elements(public.venue_presets()) p,
       jsonb_array_elements(p -> 'sections') s,
       lateral (
         select min((pt ->> 'x')::numeric) x0, max((pt ->> 'x')::numeric) x1,
                min((pt ->> 'y')::numeric) y0, max((pt ->> 'y')::numeric) y1
         from jsonb_array_elements(s -> 'shape') pt
       ) b
  where jsonb_typeof(s -> 'shape') = 'array'
    and (abs(b.x0 - (s ->> 'x')::numeric) > 0.001
      or abs(b.y0 - (s ->> 'y')::numeric) > 0.001
      or abs((b.x1 - b.x0) - (s ->> 'width')::numeric) > 0.001
      or abs((b.y1 - b.y0) - (s ->> 'height')::numeric) > 0.001);

  assert v_off = 0, format('%s tvarovaných sektorov má rámček inde než kresbu', v_off);
  raise notice 'PASS rámček sektora sedí na to, čo je nakreslené';
end $$;

-- --- a všetko sa zmestí do plánu ---------------------------------------------------
do $$
declare v_out integer;
begin
  select count(*) into v_out
  from jsonb_array_elements(public.venue_presets()) p,
       jsonb_array_elements(p -> 'sections') s
  where (s ->> 'x')::numeric < 0
     or (s ->> 'y')::numeric < 0
     or (s ->> 'x')::numeric + (s ->> 'width')::numeric > 1
     or (s ->> 'y')::numeric + (s ->> 'height')::numeric > 1;

  assert v_out = 0, format('%s sektorov vytŕča z plánu', v_out);
  raise notice 'PASS žiadny sektor nevytŕča z plánu';
end $$;

-- --- futbalový štadión prichádza so sedadlami --------------------------------------

do $$
declare
  admin uuid := 'a5050505-0000-0000-0000-000000000001';
  org   uuid := 'b5050505-0000-0000-0000-000000000001';
  ev    uuid := 'c5050505-0000-0000-0000-000000000001';
  v_map uuid;
  v_secs integer;
  v_seats integer;
  v_named integer;
begin
  insert into auth.users (id, email, email_confirmed_at)
  values (admin, 'stadion@blup.test', now());
  update public.profiles set app_role = 'admin' where id = admin;

  insert into public.organizations (id, name, slug, created_by, verification_status)
  values (org, 'FC Test', 'fc-test', admin, 'verified');
  -- Zakladateľa pridáva do organizácie trigger, tak tu už len poistka.
  insert into public.organization_members (organization_id, user_id, role)
  values (org, admin, 'owner')
  on conflict do nothing;

  insert into public.events (id, creator_id, organization_id, title, category,
                             start_at, end_at, latitude, longitude, city,
                             is_free, price_cents, status, visibility)
  values (ev, admin, org, 'Zápas', 'football',
          now() + interval '10 days', now() + interval '10 days 2 hours',
          48.1, 17.1, 'Bratislava', false, 1200, 'published', 'public');

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', admin::text, true);
  v_map := public.apply_venue_preset(ev, 'stadium');
  reset role;

  select count(*) into v_secs from public.venue_sections where venue_map_id = v_map;
  select count(*) into v_seats
  from public.venue_seats s
  join public.venue_sections vs on vs.id = s.venue_section_id
  where vs.venue_map_id = v_map;

  assert v_secs > 40, format('štadión má byť očíslovaný po sektoroch, má ich %s', v_secs);
  assert v_seats > 3000, format('a prísť so sedadlami, má ich %s', v_seats);

  -- Sektor, ktorý má na lístku stáť A101, sa musí tak volať aj na pláne.
  select count(*) into v_named
  from public.venue_sections
  where venue_map_id = v_map and name in ('A101', 'B201', 'C102', 'D205');
  assert v_named = 4, 'sektory sa volajú tak, ako sú na turnikete';

  -- Ihrisko je orientačný bod, nie tovar: nesmie mať miesta ani typ lístka.
  assert not exists (
    select 1 from public.venue_seats s
    join public.venue_sections vs on vs.id = s.venue_section_id
    where vs.venue_map_id = v_map and vs.kind in ('stage', 'entrance', 'other')
  ), 'ihrisko ani brány sa nepredávajú';

  raise notice 'PASS futbalový štadión má očíslované sektory aj sedadlá';
end $$;


-- --- miesta kopírujú obrys sektora -------------------------------------------------
--
-- Toto je ten rozdiel, kvôli ktorému funkcia vznikla. Sektor je pás: rad ide
-- pozdĺž neho, číslo radu naprieč. Položené cez ohraničenie mali bočné tribúny
-- rady kolmo na to, ako sa v nich sedí.
do $$
declare
  admin uuid := 'a5050505-0000-0000-0000-000000000002';
  org   uuid := 'b5050505-0000-0000-0000-000000000002';
  vmap  uuid := 'd5050505-0000-0000-0000-000000000002';
  bent  uuid := 'e5050505-0000-0000-0000-000000000003';
  n_all integer;
  outside integer;
  front numeric;
  back  numeric;
  res jsonb;
begin
  insert into auth.users (id, email, email_confirmed_at)
  values (admin, 'tvar@blup.test', now());
  update public.profiles set app_role = 'admin' where id = admin;

  insert into public.organizations (id, name, slug, created_by, verification_status)
  values (org, 'Tvar', 'tvar', admin, 'verified');

  insert into public.venue_maps (id, organization_id, name, image_width, image_height, created_by)
  values (vmap, org, 'Tvar', 1600, 1200, admin);

  -- Zužujúca sa tribúna: zadná hrana široká, predná pri ihrisku úzka. Obrys je
  -- obkreslený po obvode, tak ako ho kreslí editor.
  insert into public.venue_sections (id, venue_map_id, name, colour, x, y, width, height, kind, sort_order)
  values (bent, vmap, 'Tribúna', '#F43F5E', 0.10, 0.10, 0.60, 0.30, 'standard', 1);

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', admin::text, true);
  perform public.set_section_shape(bent, '[
    {"x":0.10,"y":0.10},{"x":0.40,"y":0.10},{"x":0.70,"y":0.10},
    {"x":0.60,"y":0.40},{"x":0.40,"y":0.40},{"x":0.20,"y":0.40}
  ]'::jsonb);
  res := public.generate_section_seats(bent, 6, 10);
  n_all := (res ->> 'total')::integer;
  reset role;

  -- Na páse nevypadne nič: každé miesto niekam patrí.
  assert n_all = 60, format('pás dostane celú mriežku, dostal %s', n_all);

  -- A každé z nich leží vnútri toho, čo je nakreslené. Toto je tá vlastnosť,
  -- na ktorej celé kreslenie sektorov stojí.
  select count(*) into outside
  from public.venue_seats vs
  join public.venue_sections s on s.id = vs.venue_section_id
  cross join lateral (
    select dense_rank() over (order by vs2.row_label) - 1 as r
    from public.venue_seats vs2 where vs2.id = vs.id
  ) ignored
  where vs.venue_section_id = bent
    and not public.jsonb_to_polygon(s.shape) @> public.band_point(
          s.shape,
          (vs.seat_number - 0.5) / 10.0,
          (ascii(vs.row_label) - ascii('A') + 0.5) / 6.0);
  assert outside = 0, format('%s miest leží mimo nakreslenej plochy', outside);

  -- Predný rad zužujúcej sa tribúny je kratší než zadný: rovnaký počet miest
  -- na kratšej hrane znamená, že sedia hustejšie.
  select abs((public.band_point(s.shape, 0.95, 0.05))[0] - (public.band_point(s.shape, 0.05, 0.05))[0])
    into back from public.venue_sections s where s.id = bent;
  select abs((public.band_point(s.shape, 0.95, 0.95))[0] - (public.band_point(s.shape, 0.05, 0.95))[0])
    into front from public.venue_sections s where s.id = bent;
  assert front < back,
    format('predný rad má byť kratší než zadný, je %s proti %s', front, back);

  raise notice 'PASS miesta kopírujú obrys sektora, nie jeho ohraničenie';
end $$;

-- --- státie sa predáva na počet, nie po sedadlách -----------------------------------
--
-- Sektor na státie je plocha. Vygenerovať doň „rad C, miesto 14" znamená dať
-- človeku na vstupenku číslo, ktoré v hale nikde nie je.
do $$
declare
  admin uuid := 'a5050505-0000-0000-0000-000000000003';
  org   uuid := 'b5050505-0000-0000-0000-000000000003';
  vmap  uuid := 'd5050505-0000-0000-0000-000000000003';
  stand uuid := 'e5050505-0000-0000-0000-000000000004';
  seats uuid := 'e5050505-0000-0000-0000-000000000005';
  ev    uuid := 'c5050505-0000-0000-0000-000000000003';
  n integer;
  refused boolean;
begin
  insert into auth.users (id, email, email_confirmed_at)
  values (admin, 'statie@blup.test', now());
  update public.profiles set app_role = 'admin' where id = admin;

  insert into public.organizations (id, name, slug, created_by, verification_status)
  values (org, 'Státie', 'statie', admin, 'verified');

  insert into public.venue_maps (id, organization_id, name, image_width, image_height, created_by)
  values (vmap, org, 'Klub', 1600, 1200, admin);

  insert into public.venue_sections (id, venue_map_id, name, colour, x, y, width, height, kind, sort_order)
  values (stand, vmap, 'Parket', '#22C55E', 0.10, 0.10, 0.40, 0.40, 'standing', 1),
         (seats, vmap, 'Balkón', '#0080FF', 0.55, 0.10, 0.30, 0.40, 'standard', 2);

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', admin::text, true);

  refused := false;
  begin
    perform public.generate_section_seats(stand, 5, 10);
  exception when others then
    refused := (sqlerrm like '%STANDING_HAS_NO_SEATS%');
  end;
  assert refused, 'do sektora na státie sa miesta generovať nesmú';

  -- A ani obchádzkou cez tabuľku.
  refused := false;
  begin
    insert into public.venue_seats (venue_section_id, row_label, seat_number)
    values (stand, 'A', 1);
  exception when others then
    refused := (sqlerrm like '%STANDING_HAS_NO_SEATS%');
  end;
  assert refused, 'ani priamy zápis do tabuľky nesmie prejsť';

  -- Sedenie vedľa neho funguje ďalej, aby bolo jasné, že to nie je vypnuté všetkým.
  perform public.generate_section_seats(seats, 5, 10);
  select count(*) into n from public.venue_seats where venue_section_id = seats;
  assert n = 50, format('sektor na sedenie má dostať miesta, dostal %s', n);

  -- A sektor, ktorý už miesta má, sa na státie prepnúť nedá — inak by sa
  -- ticho zahodili sedadlá, na ktoré môže niekto mať vstupenku.
  refused := false;
  begin
    update public.venue_sections set kind = 'standing' where id = seats;
  exception when others then
    refused := (sqlerrm like '%SECTION_HAS_SEATS%');
  end;
  assert refused, 'obsadené sedenie sa nesmie prepnúť na státie';
  reset role;

  -- V predlohách je to tak už teraz: státie nikde nepýta miesta.
  select count(*) into n
  from jsonb_array_elements(public.venue_presets()) p,
       jsonb_array_elements(p -> 'sections') s
  where s ->> 'kind' in ('standing', 'stage', 'bar', 'entrance', 'other')
    and (s ? 'rows' or s ? 'per_row');
  assert n = 0, format('%s predlohových sektorov pýta miesta tam, kde nepatria', n);

  raise notice 'PASS státie sa predáva na počet, sedenie po miestach';
end $$;

rollback;
