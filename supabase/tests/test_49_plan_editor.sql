-- ============================================================================
-- BLUP test 49 · Podklad, otáčanie, kópia, mazanie miest, vlastné názvy
-- ============================================================================
-- Šesť vecí z jedného hlásenia o kreslení plánu. Dve z nich sa dajú pokaziť
-- ticho, a práve tie sa tu overujú najprísnejšie:
--
--   · obrázok, ktorý je len podklad, sa NESMIE dostať ku kupujúcemu — nie
--     „appka ho nezobrazí", ale nesmie odísť zo servera,
--   · a zmazať miesto, na ktoré je predaná vstupenka, sa nesmie dať vôbec.
-- ============================================================================
\set ON_ERROR_STOP on

begin;

set local search_path = public, extensions;

insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('a4949494-0000-0000-0000-000000000001', 'admin49@example.com', now(), '{"display_name":"Admin"}'),
  ('a4949494-0000-0000-0000-000000000002', 'org49@example.com',   now(), '{"display_name":"Organizátor"}'),
  ('a4949494-0000-0000-0000-000000000003', 'buyer49@example.com', now(), '{"display_name":"Kupujúci"}');

update public.profiles set app_role = 'admin' where id = 'a4949494-0000-0000-0000-000000000001';

insert into public.organizations (id, name, slug, created_by, verification_status, payouts_enabled)
values ('d4949494-0000-0000-0000-000000000001', 'Aréna', 'arena-49',
        'a4949494-0000-0000-0000-000000000002', 'verified', true);

insert into public.organization_members (organization_id, user_id, role)
values ('d4949494-0000-0000-0000-000000000001', 'a4949494-0000-0000-0000-000000000002', 'owner')
on conflict do nothing;

insert into public.events (id, creator_id, organization_id, title, category, start_at,
                           latitude, longitude, is_free, price_cents, status)
values ('e4949494-0000-0000-0000-000000000001', 'a4949494-0000-0000-0000-000000000002',
        'd4949494-0000-0000-0000-000000000001', 'Štadión · zápas', 'sport',
        now() + interval '30 days', 48.1486, 17.1077, false, 2000, 'published');

insert into public.ticket_types (id, event_id, name, price_cents, quantity_total)
values
  ('c4949494-0000-0000-0000-000000000001', 'e4949494-0000-0000-0000-000000000001',
   'Tribúna', 2000, 500),
  ('c4949494-0000-0000-0000-000000000002', 'e4949494-0000-0000-0000-000000000001',
   'Tribúna VIP', 5000, 500);

insert into public.venue_maps (id, organization_id, name, image_url, image_width, image_height, created_by)
values ('f4949494-0000-0000-0000-000000000001', 'd4949494-0000-0000-0000-000000000001',
        'Štadión', 'https://example.test/fotka-haly.jpg', 1600, 1200,
        'a4949494-0000-0000-0000-000000000001');

-- Priradiť plán k eventu smie iba admin — stráži to trigger na events, nie
-- obrazovka. Takže aj fixture musí byť admin.
do $$
begin
  perform set_config('request.jwt.claim.sub', 'a4949494-0000-0000-0000-000000000001', true);
  update public.events set venue_map_id = 'f4949494-0000-0000-0000-000000000001'
  where id = 'e4949494-0000-0000-0000-000000000001';
  perform set_config('request.jwt.claim.sub', '', true);
end $$;

insert into public.venue_sections (id, venue_map_id, ticket_type_id, name, colour,
                                   x, y, width, height, kind)
values ('b4949494-0000-0000-0000-000000000001', 'f4949494-0000-0000-0000-000000000001',
        'c4949494-0000-0000-0000-000000000001', 'Tribúna A', '#FF4D8D',
        0.05, 0.05, 0.30, 0.40, 'standard');

-- --- podklad sa ku kupujúcemu nedostane --------------------------------------
do $$
declare
  ev  uuid := 'e4949494-0000-0000-0000-000000000001';
  plan jsonb;
begin
  -- Predvolene je nahratý obrázok PODKLAD.
  assert (select image_is_backdrop from public.venue_maps
          where id = 'f4949494-0000-0000-0000-000000000001'),
    'nahratý obrázok je predvolene len na obkreslenie';

  plan := public.seat_map_for_event(ev);
  assert (plan -> 'map' ->> 'image_url') is null,
    'fotka haly neodchádza zo servera — nie je to tak, že ju appka nezobrazí';
  assert jsonb_array_length(plan -> 'sections') = 1,
    'ale sektory idú ďalej, plán je stále plán';

  -- Keď je to naozaj oficiálny plán sály, dá sa zverejniť.
  update public.venue_maps set image_is_backdrop = false
  where id = 'f4949494-0000-0000-0000-000000000001';

  plan := public.seat_map_for_event(ev);
  assert (plan -> 'map' ->> 'image_url') = 'https://example.test/fotka-haly.jpg',
    'a vtedy sa pošle';

  update public.venue_maps set image_is_backdrop = true
  where id = 'f4949494-0000-0000-0000-000000000001';

  raise notice 'PASS fotka haly je podklad a ku kupujúcemu sa nedostane';
end $$;

-- --- otáčanie -----------------------------------------------------------------
do $$
declare
  admin uuid := 'a4949494-0000-0000-0000-000000000001';
  sec   uuid := 'b4949494-0000-0000-0000-000000000001';
  plan  jsonb;
  failed boolean := false;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', admin::text, true);

  perform public.update_section(sec, p_rotation => 23.5);
  reset role;

  assert (select rotation from public.venue_sections where id = sec) = 23.5,
    'tribúna sa dá nakloniť tak, ako naozaj stojí';

  plan := public.seat_map_for_event('e4949494-0000-0000-0000-000000000001');
  assert (plan -> 'sections' -> 0 ->> 'rotation')::numeric = 23.5,
    'a kupujúci to tak aj uvidí — inak by plán ukazoval inú halu';

  -- Nezmysly databáza neprijme.
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', admin::text, true);
  begin
    perform public.update_section(sec, p_rotation => 900);
  exception when others then failed := true;
  end;
  reset role;
  assert failed, 'deväťsto stupňov nie je otočenie';

  raise notice 'PASS sektor sa dá otočiť a otočenie sa dostane na plán';
end $$;

-- --- vlastné názvy radov a miest ----------------------------------------------
do $$
declare
  admin uuid := 'a4949494-0000-0000-0000-000000000001';
  sec   uuid := 'b4949494-0000-0000-0000-000000000001';
  made  jsonb;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', admin::text, true);

  -- Štadión: rady číslami, miesta od 101, predpona sektora.
  made := public.generate_section_seats(
    sec, 3, 5,
    p_start_row  => 0,
    p_row_style  => 'numbers',
    p_row_prefix => 'S',
    p_seat_start => 101);
  reset role;

  assert (made ->> 'total')::int = 15, 'tri rady po piatich';
  assert exists (select 1 from public.venue_seats
                 where venue_section_id = sec and row_label = 'S1' and seat_number = 101),
    'prvý rad sa volá S1 a prvé miesto má číslo 101';
  assert exists (select 1 from public.venue_seats
                 where venue_section_id = sec and row_label = 'S3' and seat_number = 105),
    'a posledné je S3/105';
  assert not exists (select 1 from public.venue_seats
                     where venue_section_id = sec and row_label = 'A'),
    'žiadne písmená tam, kde sú v hale čísla';

  raise notice 'PASS rady a miesta sa dajú pomenovať tak, ako sú v hale';
end $$;

-- --- premenovanie radu nechá vstupenkám ich miesta ----------------------------
-- Toto je dôvod, prečo je to UPDATE a nie prekreslenie sektora.
do $$
declare
  admin  uuid := 'a4949494-0000-0000-0000-000000000001';
  sec    uuid := 'b4949494-0000-0000-0000-000000000001';
  seat   uuid;
  failed boolean := false;
begin
  select id into seat from public.venue_seats
  where venue_section_id = sec and row_label = 'S2' and seat_number = 103;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', admin::text, true);
  perform public.rename_section_row(sec, 'S2', 'S2A');

  -- Ten istý riadok, iný názov — takže vstupenka, ktorá naň ukazuje, drží.
  assert (select id from public.venue_seats
          where venue_section_id = sec and row_label = 'S2A' and seat_number = 103) = seat,
    'miesto si zachová identitu, takže predaná vstupenka na ňom zostane';

  -- Na existujúci názov sa premenovať nedá; boli by dva rovnaké rady.
  begin
    perform public.rename_section_row(sec, 'S2A', 'S1');
  exception when others then failed := true;
  end;
  reset role;
  assert failed, 'dva rady s rovnakým názvom by boli dve miesta s tým istým menom';

  raise notice 'PASS rad sa dá premenovať bez toho, aby sa stratili miesta';
end $$;

-- --- mazanie miest tam, kde stojí stĺp ----------------------------------------
do $$
declare
  admin   uuid := 'a4949494-0000-0000-0000-000000000001';
  sec     uuid := 'b4949494-0000-0000-0000-000000000001';
  pillar  uuid;
  sold    uuid;
  gone    integer;
  failed  boolean := false;
begin
  select id into pillar from public.venue_seats
  where venue_section_id = sec and row_label = 'S1' and seat_number = 103;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', admin::text, true);
  gone := public.delete_seats(array[pillar]);
  reset role;

  assert gone = 1, 'miesto, kde v skutočnosti stojí stĺp, sa dá zmazať';
  assert not exists (select 1 from public.venue_seats where id = pillar),
    'a je naozaj preč, nie len nepredajné';

  -- A teraz to isté s miestom, ktoré niekto kúpil.
  select id into sold from public.venue_seats
  where venue_section_id = sec and row_label = 'S1' and seat_number = 101;

  insert into public.orders (id, event_id, ticket_type_id, buyer_id, quantity,
                             unit_price_cents, subtotal_cents, total_cents,
                             currency, payment_status)
  values ('a1494949-0000-0000-0000-000000000001', 'e4949494-0000-0000-0000-000000000001',
          'c4949494-0000-0000-0000-000000000001', 'a4949494-0000-0000-0000-000000000003',
          1, 2000, 2000, 2000, 'EUR', 'succeeded');

  insert into public.tickets (order_id, event_id, ticket_type_id, buyer_id,
                              venue_seat_id, code, qr_secret, status)
  values ('a1494949-0000-0000-0000-000000000001', 'e4949494-0000-0000-0000-000000000001',
          'c4949494-0000-0000-0000-000000000001', 'a4949494-0000-0000-0000-000000000003',
          sold, 'BLUP49SEAT', 'secret-49', 'valid');

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', admin::text, true);
  begin
    perform public.delete_seats(array[sold]);
  exception when others then failed := true;
  end;
  reset role;

  assert failed, 'miesto s predanou vstupenkou sa zmazať nedá';
  assert exists (select 1 from public.venue_seats where id = sold),
    'a naozaj tam zostalo — vstupenka bez sedadla je horší problém než zlý plán';

  raise notice 'PASS stĺp sa dá vymazať, predané miesto nie';
end $$;

-- --- kópia sektora -------------------------------------------------------------
do $$
declare
  admin uuid := 'a4949494-0000-0000-0000-000000000001';
  src   uuid := 'b4949494-0000-0000-0000-000000000001';
  copy  public.venue_sections;
  srcw  numeric;
  srcn  integer;
begin
  select width, (select count(*) from public.venue_seats where venue_section_id = src)
  into srcw, srcn
  from public.venue_sections where id = src;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', admin::text, true);
  copy := public.duplicate_section(src);
  reset role;

  assert copy.width = srcw, 'kópia má tú istú veľkosť — štadión má rovnaké tribúny';
  assert copy.rotation = 23.5, 'aj to isté otočenie';
  assert copy.name <> (select name from public.venue_sections where id = src),
    'ale iný názov, inak sa nedajú rozoznať';
  assert copy.x <> (select x from public.venue_sections where id = src)
      or copy.y <> (select y from public.venue_sections where id = src),
    'a je posunutá, inak leží presne na origináli a nedá sa chytiť';

  assert (select count(*) from public.venue_seats where venue_section_id = copy.id) = srcn,
    'a rovnaké rozloženie miest, vrátane vynechaného stĺpa';

  -- Toto je tá časť, ktorú by bolo ľahké spraviť zle: kópia nepredáva.
  assert copy.ticket_type_id is null,
    'kópia nedostane typ vstupenky — inak dva sektory predávajú ten istý sklad';

  raise notice 'PASS sektor sa skopíruje aj s miestami, ale nepredáva ten istý sklad';
end $$;

-- --- predlohy hál --------------------------------------------------------------
do $$
declare
  admin  uuid := 'a4949494-0000-0000-0000-000000000001';
  ev2    uuid := 'e4949494-0000-0000-0000-000000000002';
  v_map  uuid;
  failed text;
  n      integer;
begin
  assert jsonb_array_length(public.venue_presets()) = 5, 'päť predlôh';

  insert into public.events (id, creator_id, organization_id, title, category, start_at,
                             latitude, longitude, is_free, price_cents, status)
  values (ev2, 'a4949494-0000-0000-0000-000000000002',
          'd4949494-0000-0000-0000-000000000001', 'Divadlo', 'theatre',
          now() + interval '30 days', 48.1486, 17.1077, false, 1500, 'published');

  -- Typ vstupenky, ktorý sa volá presne ako sektor v predlohe.
  insert into public.ticket_types (id, event_id, name, price_cents, quantity_total)
  values ('c4949494-0000-0000-0000-000000000009', ev2, 'Parter', 1500, 200);

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', admin::text, true);
  v_map := public.apply_venue_preset(ev2, 'theatre');
  reset role;

  select count(*) into n from public.venue_sections where venue_map_id = v_map;
  assert n = 5, format('divadlo má päť sektorov, má %s', n);
  assert (select venue_map_id from public.events where id = ev2) = v_map,
    'a plán je na evente';

  assert (select ticket_type_id from public.venue_sections
          where venue_map_id = v_map and name = 'Parter')
         = 'c4949494-0000-0000-0000-000000000009',
    'sektor s rovnakým názvom sa napojí na typ vstupenky';
  assert (select ticket_type_id from public.venue_sections
          where venue_map_id = v_map and name = 'Balkón') is null,
    'ostatné zostanú bez ceny — hádať podľa poradia by predalo lacné za drahé';
  assert (select kind from public.venue_sections
          where venue_map_id = v_map and name = 'Pódium') = 'stage',
    'pódium je pódium, nie sektor na predaj';

  -- Druhýkrát už nie: prepísať existujúci plán by zahodilo sektory, na ktoré
  -- sú predané vstupenky.
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', admin::text, true);
  begin
    perform public.apply_venue_preset(ev2, 'stadium');
  exception when others then failed := sqlerrm;
  end;
  reset role;
  assert failed like '%PLAN_ALREADY_EXISTS%', 'predloha neprepíše hotový plán';

  raise notice 'PASS predloha nakreslí halu a napojí len to, čo sedí podľa názvu';
end $$;

-- --- a predlohu kreslí BLUP, nie organizátor ------------------------------------
do $$
declare failed text;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub',
                     'a4949494-0000-0000-0000-000000000002', true);
  begin
    perform public.apply_venue_preset('e4949494-0000-0000-0000-000000000001', 'club');
  exception when others then failed := sqlerrm;
  end;
  reset role;
  assert failed like '%VENUE_PLAN_IS_ADMIN_ONLY%',
    'predloha je stále plán sály, takže platia tie isté pravidlá';
  raise notice 'PASS predlohu smie použiť len admin';
end $$;

-- --- sektor, ktorý sa zatáča ----------------------------------------------------
do $$
declare
  admin  uuid := 'a4949494-0000-0000-0000-000000000001';
  sec    uuid := 'b4949494-0000-0000-0000-000000000001';
  out    public.venue_sections;
  plan   jsonb;
  failed text;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', admin::text, true);

  out := public.set_section_shape(sec, '[
    {"x":0.10,"y":0.10},{"x":0.40,"y":0.12},{"x":0.46,"y":0.30},
    {"x":0.30,"y":0.44},{"x":0.08,"y":0.34}
  ]'::jsonb);

  assert out.shape is not null, 'tribúna sa dá nakresliť aj ako päťuholník';
  -- Tvar nesie natočenie sám: body sú tam, kam sa klikalo. Keby k tomu zostalo
  -- ešte `rotation`, obrys by sa otočil druhýkrát a odišiel by od tých bodov.
  assert out.rotation = 0, 'nakreslený tvar vynuluje otočenie';
  -- Ohraničenie sa dorovná samo: mriežka miest a klikanie s ním pracujú, a
  -- keby zostalo po starom, sektor by sa dal chytiť inde, než je nakreslený.
  assert out.x = 0.08, format('ľavý okraj z bodov, je %s', out.x);
  assert out.y = 0.10, 'horný okraj z bodov';
  assert abs(out.width - 0.38) < 0.0001, format('šírka z bodov, je %s', out.width);
  assert abs(out.height - 0.34) < 0.0001, 'výška z bodov';

  reset role;
  plan := public.seat_map_for_event('e4949494-0000-0000-0000-000000000001');
  assert jsonb_array_length(plan -> 'sections' -> 0 -> 'shape') = 5,
    'a tvar sa dostane aj ku kupujúcemu — inak by videl obdĺžnik na inom mieste';

  -- Dva body nie sú tvar.
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', admin::text, true);
  begin
    perform public.set_section_shape(sec, '[{"x":0.1,"y":0.1},{"x":0.2,"y":0.2}]'::jsonb);
  exception when others then failed := sqlerrm;
  end;
  assert failed like '%SHAPE_TOO_SHORT%', 'dva body nie sú plocha';

  -- Späť na obdĺžnik.
  out := public.set_section_shape(sec, null);
  reset role;
  assert out.shape is null, 'tvar sa dá zrušiť';
  assert out.x = 0.08, 'a sektor pritom nikam neskočí';

  raise notice 'PASS sektor sa dá nakresliť aj ako zatáčajúca sa tribúna';
end $$;

-- --- a kópia zatáčajúcej sa tribúny sa zatáča tiež -------------------------------
do $$
declare
  admin uuid := 'a4949494-0000-0000-0000-000000000001';
  sec   uuid := 'b4949494-0000-0000-0000-000000000001';
  copy  public.venue_sections;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', admin::text, true);

  perform public.set_section_shape(sec, '[
    {"x":0.10,"y":0.10},{"x":0.40,"y":0.12},{"x":0.30,"y":0.40}
  ]'::jsonb);
  copy := public.duplicate_section(sec);
  reset role;

  assert jsonb_array_length(copy.shape) = 3, 'kópia má ten istý tvar';
  -- Posunuté body, nie pôvodné: inak by mala tvar na starom mieste a
  -- ohraničenie na novom, a klikalo by sa vedľa.
  assert (copy.shape -> 0 ->> 'x')::numeric <> 0.10,
    'a body sa posunuli spolu s ňou';

  raise notice 'PASS kópia si berie aj tvar, nielen rozmery';
end $$;

-- --- predlohy majú oblúky --------------------------------------------------------
do $$
declare shaped integer;
begin
  select count(*) into shaped
  from jsonb_array_elements(public.venue_presets()) p,
       jsonb_array_elements(p -> 'sections') s
  where jsonb_typeof(s -> 'shape') = 'array';

  assert shaped >= 6,
    format('štadión aj balkón sa zatáčajú, tvarovaných sektorov je %s', shaped);
  raise notice 'PASS predlohy kreslia tribúny tak, ako naozaj stoja';
end $$;

rollback;
