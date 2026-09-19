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

rollback;
