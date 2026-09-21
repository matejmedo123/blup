-- ============================================================================
-- Širší rad má viac miest, nie tie isté ďalej od seba
-- ============================================================================
-- Mriežka rady × miesta dávala každému radu rovnaký počet miest, takže v
-- sektore, ktorý sa rozširuje, mal zadný rad tie isté miesta len roztiahnuté.
-- Tak sa tribúna nestavia: sedadlo má šírku a susedia stálu vzdialenosť.
--
-- Test meria to, na čo sa človek pozerá: rozostup medzi susedmi. Ten má byť
-- naprieč sektorom rovnaký — nie na desatinu presne, lebo počet miest je celé
-- číslo, ale rozhodne nie o pätinu iný v prvom a poslednom rade.
-- ============================================================================
begin;
set search_path = public, extensions;

do $$
declare
  v_admin uuid := 'a5151515-0000-0000-0000-000000000001';
  v_org   uuid := 'b5151515-0000-0000-0000-000000000001';
  v_map   uuid;
  v_sec   uuid;
  v_first integer;
  v_last  integer;
  v_min   numeric;
  v_max   numeric;
  v_rows  constant integer := 12;
  v_per   constant integer := 10;
  -- Klin: predná hrana 0.30 široká, zadná 0.60. Presne ten tvar, v ktorom
  -- bolo roztiahnutie vidieť.
  v_shape constant jsonb := '[
    {"x":0.35,"y":0.20},{"x":0.50,"y":0.20},{"x":0.65,"y":0.20},
    {"x":0.80,"y":0.60},{"x":0.50,"y":0.60},{"x":0.20,"y":0.60}]'::jsonb;
begin
  insert into auth.users (id, email, email_confirmed_at)
  values (v_admin, 'klin@blup.test', now());
  insert into public.organizations (id, name, slug, created_by, verification_status)
  values (v_org, 'Test geometrie', 'test-geometrie-51', v_admin, 'verified');
  insert into public.organization_members (organization_id, user_id, role)
  values (v_org, v_admin, 'owner') on conflict do nothing;

  insert into public.venue_maps (organization_id, name)
  values (v_org, 'Klin') returning id into v_map;

  insert into public.venue_sections (venue_map_id, name, colour, x, y, width, height, kind, shape)
  values (v_map, 'Klin', '#f59e0b', 0.20, 0.20, 0.60, 0.40, 'standard', v_shape)
  returning id into v_sec;

  -- --- koľko miest má prvý a posledný rad -----------------------------------
  select count(*) into v_first
  from public.section_seat_grid(v_sec, v_rows, v_per) g
  where g.row_label = public.seat_row_name(0, 'letters', null);

  select count(*) into v_last
  from public.section_seat_grid(v_sec, v_rows, v_per) g
  where g.row_label = public.seat_row_name(v_rows - 1, 'letters', null);

  assert v_first = v_per,
    format('rad A má %s miest, vypýtaných bolo %s — rozostup udáva rad A', v_first, v_per);

  assert v_last > v_first,
    format('posledný rad má %s miest a prvý %s, hoci je dvakrát širší — '
           || 'miesta sa roztiahli namiesto toho, aby pribudli', v_last, v_first);

  -- --- a hlavne: rozostup je naprieč sektorom rovnaký ------------------------
  --
  -- Bez tohto by test prešiel aj vtedy, keby do zadného radu pribudlo jedno
  -- jediné miesto. Rozostup je to, čo vidno.
  -- Rozostup je pevný a miesta sadajú na mriežku, ktorú zdieľa celý sektor.
  -- Meria sa medzi prvým a druhým miestom každého radu, na mieste, kam ich
  -- mriežka kladie: od stredu radu (k - (počet+1)/2) rozostupov.
  select min(d), max(d) into v_min, v_max
  from (
    select r,
           public.band_row_length(v_shape, (r + 0.5)::numeric / v_rows) as wide,
           count(*)::numeric as held,
           public.band_row_length(v_shape, 0.5 / v_rows) / v_per as step
    from generate_series(0, v_rows - 1) r
    join public.section_seat_grid(v_sec, v_rows, v_per) g
      on g.row_label = public.seat_row_name(r, 'letters', null)
    group by r
  ) row_of
  cross join lateral (
    select public.band_point(v_shape,
             0.5 + (1 - (row_of.held + 1) / 2) * row_of.step / row_of.wide,
             (row_of.r + 0.5)::numeric / v_rows) as a,
           public.band_point(v_shape,
             0.5 + (2 - (row_of.held + 1) / 2) * row_of.step / row_of.wide,
             (row_of.r + 0.5)::numeric / v_rows) as b
  ) pts
  cross join lateral (
    select sqrt((pts.b[0] - pts.a[0]) ^ 2 + (pts.b[1] - pts.a[1]) ^ 2) as d
  ) gap;

  assert v_max / v_min < 1.02,
    format('rozostup medzi susedmi sa naprieč sektorom líši %sx (%s až %s)',
           round(v_max / v_min, 3), round(v_min, 5), round(v_max, 5));

  -- A stĺpce musia sedieť v jednej línii. Keby sa každý rad centroval sám za
  -- seba, rad so štrnástimi a rad s trinástimi miestami by mali miesta
  -- posunuté o pol rozostupu — to je práve tá medzera, ktorú vidno. Preto
  -- pribúdajú po dvoch a počet zostane rovnakej parity.
  assert not exists (
    select 1
    from (
      select count(*) % 2 as zvysok
      from public.section_seat_grid(v_sec, v_rows, v_per)
      group by row_label
    ) parity
    where parity.zvysok <> v_per % 2
  ), 'rad zmenil paritu počtu miest — stĺpce by sa posunuli o pol rozostupu';

  raise notice 'PASS do širšieho radu pribudnú miesta a rozostup zostane rovnaký';
end $$;

-- --- a obdĺžnikový sektor zostáva obdĺžnikový --------------------------------
--
-- Sektor bez obrysu nemá pás, na ktorom by sa dalo čokoľvek merať, a jeho rady
-- sú z princípu rovnako dlhé. Musí mu vyjsť presne to, čo si organizátor
-- vypýtal — inak by táto zmena ticho prepísala každý plán, ktorý nikto
-- nekreslil.
do $$
declare
  v_admin uuid := 'a5151515-0000-0000-0000-000000000002';
  v_org uuid := 'b5151515-0000-0000-0000-000000000002';
  v_map uuid; v_sec uuid; v_total integer; v_rows integer;
begin
  insert into auth.users (id, email, email_confirmed_at)
  values (v_admin, 'blok@blup.test', now());
  insert into public.organizations (id, name, slug, created_by, verification_status)
  values (v_org, 'Test geometrie B', 'test-geometrie-51b', v_admin, 'verified');
  insert into public.organization_members (organization_id, user_id, role)
  values (v_org, v_admin, 'owner') on conflict do nothing;
  insert into public.venue_maps (organization_id, name)
  values (v_org, 'Obdĺžnik') returning id into v_map;
  insert into public.venue_sections (venue_map_id, name, colour, x, y, width, height, kind)
  values (v_map, 'Blok', '#38bdf8', 0.1, 0.1, 0.5, 0.4, 'standard')
  returning id into v_sec;

  select count(*), count(distinct row_label) into v_total, v_rows
  from public.section_seat_grid(v_sec, 8, 12);

  assert v_rows = 8 and v_total = 96,
    format('obdĺžnik dal %s miest v %s radoch, má dať 96 v 8', v_total, v_rows);

  raise notice 'PASS obdĺžnikový sektor má stále rovnaké rady';
end $$;

rollback;

-- --- ručne pridané miesto --------------------------------------------------
--
-- Tribúny nie sú pravidelné a mriežka to nemá ako vedieť. Organizátor musí
-- vedieť do radu miesto pridať — a hlavne tým nesmie pohnúť tými, ktoré tam
-- už sú. Preto si miesto pamätá bod mriežky, na ktorom stojí, a nedopočítava
-- sa z toho, koľké je.
begin;
set search_path = public, extensions;

do $$
declare
  v_admin uuid := 'a5151515-0000-0000-0000-000000000003';
  v_org   uuid := 'b5151515-0000-0000-0000-000000000003';
  v_map   uuid;
  v_sec   uuid;
  v_before integer[];
  v_after  integer[];
  v_added  jsonb;
begin
  insert into auth.users (id, email, email_confirmed_at)
  values (v_admin, 'ruka@blup.test', now());
  -- Plán sály kreslí BLUP, tak to musí byť admin.
  update public.profiles set app_role = 'admin' where id = v_admin;
  insert into public.organizations (id, name, slug, created_by, verification_status)
  values (v_org, 'Test ruky', 'test-ruky-51', v_admin, 'verified');
  insert into public.organization_members (organization_id, user_id, role)
  values (v_org, v_admin, 'owner') on conflict do nothing;
  insert into public.venue_maps (organization_id, name) values (v_org, 'Ruka')
  returning id into v_map;
  insert into public.venue_sections (venue_map_id, name, colour, x, y, width, height, kind, shape)
  values (v_map, 'Blok', '#38bdf8', 0.2, 0.2, 0.6, 0.4, 'standard',
          '[{"x":0.2,"y":0.2},{"x":0.5,"y":0.2},{"x":0.8,"y":0.2},
            {"x":0.8,"y":0.6},{"x":0.5,"y":0.6},{"x":0.2,"y":0.6}]'::jsonb)
  returning id into v_sec;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  perform public.generate_section_seats(v_sec, 6, 10);

  select array_agg(slot order by seat_number) into v_before
  from public.venue_seats where venue_section_id = v_sec and row_label = 'C';

  assert v_before is not null and array_length(v_before, 1) = 10,
    'rad C má mať desať miest, kým sa doň nesiahne';

  v_added := public.add_section_seat(v_sec, 'C', 'right');

  select array_agg(slot order by seat_number) into v_after
  from public.venue_seats where venue_section_id = v_sec and row_label = 'C';

  assert array_length(v_after, 1) = 11,
    format('po pridaní má mať rad C jedenásť miest, má %s', array_length(v_after, 1));

  -- Toto je celá pointa: pôvodné miesta zostali na svojich bodoch.
  assert v_after[1:10] = v_before,
    format('pridaním sa pohli pôvodné miesta: %s → %s', v_before, v_after);

  assert (v_added ->> 'slot')::integer = v_before[10] + 2,
    'nové miesto sadlo na ďalší bod mriežky za posledným';

  -- Vľavo sa čísla posunú, lebo v rade sa sedí po poradí.
  perform public.add_section_seat(v_sec, 'C', 'left');
  assert (select min(slot) from public.venue_seats
          where venue_section_id = v_sec and row_label = 'C' and seat_number = 1)
       = v_before[1] - 2,
    'miesto pridané vľavo je prvé v rade';

  reset role;
  raise notice 'PASS ručne pridané miesto nepohne tými, ktoré v rade už sú';
end $$;

rollback;
