-- ============================================================================
-- BLUP SWAP pre neprihláseného
-- ============================================================================
-- Burza, do ktorej sa nedá pozrieť bez účtu, nemá komu predať. Človek príde z
-- Googlu na vypredaný koncert, musí vidieť, že tam vstupenky sú a za koľko —
-- a až keď jednu chce, má zmysel pýtať si od neho registráciu.
--
-- Čiara medzi „pozerať" a „kúpiť" preto nesmie byť len v appke. Appka vie
-- ukázať čokoľvek; keby bola registrácia len obrazovka pred tlačidlom, dala by
-- sa obísť jedným volaním. Tento test sa pýta databázy, teda tam, kde to
-- rozhoduje:
--
--   pozerať   ponuku, ceny, pravosť, rozpis pokladne     smie ktokoľvek
--   držať     rezerváciu, objednávku, predaj, peniaze    len prihlásený
-- ============================================================================
begin;
set search_path = public, extensions;

insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('a6161616-0000-0000-0000-000000000001', 'org61@example.com',    now(), '{"display_name":"Organizátor"}'),
  ('a6161616-0000-0000-0000-000000000002', 'seller61@example.com', now(), '{"display_name":"Predajca"}');

insert into public.organizations (id, name, slug, created_by, verification_status)
values ('b6161616-0000-0000-0000-000000000001', 'Hala s.r.o.', 'hala-61',
        'a6161616-0000-0000-0000-000000000001', 'verified');
insert into public.organization_members (organization_id, user_id, role)
values ('b6161616-0000-0000-0000-000000000001', 'a6161616-0000-0000-0000-000000000001', 'owner')
on conflict do nothing;

insert into public.events (
  id, creator_id, organization_id, title, category, latitude, longitude,
  city, venue_name, start_at, end_at, is_free, price_cents, currency, status, visibility
) values (
  'e6161616-0000-0000-0000-000000000001',
  'a6161616-0000-0000-0000-000000000001', 'b6161616-0000-0000-0000-000000000001',
  'Vypredaný koncert', 'concert', 48.15, 17.11, 'Bratislava', 'Veľká hala',
  now() + interval '30 days', now() + interval '30 days 3 hours',
  false, 4000, 'EUR', 'published', 'public'
);

insert into public.ticket_types (id, event_id, name, price_cents, currency, quantity_total)
values ('f6161616-0000-0000-0000-000000000001', 'e6161616-0000-0000-0000-000000000001',
        'State', 4000, 'EUR', 500);

insert into public.tickets (id, event_id, ticket_type_id, buyer_id, code, qr_secret, price_cents, currency)
values ('c6161616-0000-0000-0000-000000000001', 'e6161616-0000-0000-0000-000000000001',
        'f6161616-0000-0000-0000-000000000001', 'a6161616-0000-0000-0000-000000000002',
        'BLP-61-A', 'secret-61-a', 4000, 'EUR');

-- Predajca ponuku vypíše. Od tejto chvíle sa už nikde neprihlasujeme.
do $$
declare
  v_seller uuid := 'a6161616-0000-0000-0000-000000000002';
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_seller::text, true);
  perform public.create_resale_listing(
    'e6161616-0000-0000-0000-000000000001'::uuid, 'blup', 7500,
    'c6161616-0000-0000-0000-000000000001'::uuid,
    p_section => 'A', p_row_label => '3', p_seat_label => '9');
  reset role;
end $$;

-- ============================================================================
-- 1. Neprihlásený vidí celú ponuku — vrátane ceny a pravosti
-- ============================================================================
do $$
declare
  v_event uuid := 'e6161616-0000-0000-0000-000000000001';
  v_home  jsonb;
  v_sum   jsonb;
  v_quote jsonb;
  v_n     integer;
  v_listing uuid;
begin
  set local role anon;
  perform set_config('request.jwt.claim.sub', '', true);

  -- Domovská stránka SWAPu.
  v_home := public.swap_home(12);
  assert (v_home->>'total_listings')::integer >= 1,
    'neprihlásenému sa domovská stránka SWAPu javí prázdna';
  assert jsonb_array_length(v_home->'families') >= 1,
    'neprihlásený nevidí ani jednu kategóriu';

  -- Vyhľadávanie SWAPu — aj prázdny dotaz, teda „ukáž, čo máš".
  select count(*) into v_n from public.swap_search('', 20);
  assert v_n >= 1, 'neprihlásenému vyhľadávanie SWAPu nevráti nič';
  select count(*) into v_n from public.swap_search('koncert', 20);
  assert v_n >= 1, 'neprihlásený nenájde event podľa názvu';
  select count(*) into v_n from public.swap_events_in_family('concert', 20);
  assert v_n >= 1, 'neprihlásený sa nedostane do kategórie';

  -- Ponuka na evente aj so súhrnom pre štítok „na burze od …".
  select count(*) into v_n from public.event_resale_listings(v_event);
  assert v_n = 1, format('neprihlásený mal vidieť jednu ponuku, vidí %s', v_n);

  v_sum := public.event_resale_summary(v_event);
  assert (v_sum->>'listings')::integer = 1, 'súhrn na evente sa neprihlásenému nezobrazí';
  assert (v_sum->>'from_cents')::integer = 7500,
    format('neprihlásený má vidieť cenu, vidí %s', v_sum->>'from_cents');
  assert (v_sum->>'verified_count')::integer = 1,
    'neprihlásený nevidí, že je vstupenka overená — pritom je to hlavný dôvod kúpy';

  -- A rozpis pokladne. Kto nevie, čo zaplatí, nemá sa prečo registrovať.
  select id into v_listing from public.resale_listings where event_id = v_event limit 1;
  v_quote := public.quote_resale(v_listing, 1);
  assert (v_quote->>'valid')::boolean, 'neprihlásenému sa ponuka javí ako neplatná';
  assert (v_quote->>'total_cents')::integer = 7500,
    format('rozpis pre neprihláseného nesedí: %s', v_quote->>'total_cents');

  -- Sadzby, aby sa dalo napísať „bez poplatku navyše".
  assert (public.resale_fees()->>'enabled')::boolean,
    'neprihlásený sa nedozvie ani to, že burza beží';

  reset role;
  raise notice 'PASS 1/2 — neprihlásený vidí ponuku, cenu aj pravosť';
end $$;

-- ============================================================================
-- 2. Kúpiť, predať ani vidieť cudzie peniaze bez účtu nejde
-- ============================================================================
-- Každý z týchto krokov musí zlyhať. Nezáleží na tom, či ho zastaví grant
-- alebo samotná funkcia — záleží na tom, že neprejde ani jeden.
do $$
declare
  v_event   uuid := 'e6161616-0000-0000-0000-000000000001';
  v_listing uuid;
  v_n       integer;
  v_failed  boolean;
begin
  select id into v_listing from public.resale_listings where event_id = v_event limit 1;

  set local role anon;
  perform set_config('request.jwt.claim.sub', '', true);

  -- Držať vstupenku.
  v_failed := false;
  begin
    perform public.reserve_resale_listing(v_listing, 1);
  exception when others then v_failed := true;
  end;
  assert v_failed, 'ÚNIK: neprihlásený si rezervoval vstupenku';

  -- Vypísať na predaj.
  v_failed := false;
  begin
    perform public.create_resale_listing(v_event, 'external', 5000, null,
      p_delivery_method => 'file');
  exception when others then v_failed := true;
  end;
  assert v_failed, 'ÚNIK: neprihlásený vypísal ponuku';

  -- Pozrieť si cudzie peniaze.
  v_failed := false;
  begin
    perform public.seller_balance();
  exception when others then v_failed := true;
  end;
  assert v_failed, 'ÚNIK: neprihlásený sa dostal k zostatku predajcu';

  -- A cudzie objednávky. Tu by tichá nula bola rovnako zlá ako chyba, preto
  -- sa pýta na počet: nesmie prejsť ani jeden riadok.
  select count(*) into v_n from public.resale_orders;
  assert v_n = 0, format('ÚNIK: neprihlásený vidí %s objednávok', v_n);

  select count(*) into v_n from public.resale_reservations;
  assert v_n = 0, format('ÚNIK: neprihlásený vidí %s rezervácií', v_n);

  select count(*) into v_n from public.seller_payouts;
  assert v_n = 0, format('ÚNIK: neprihlásený vidí %s výplat', v_n);

  reset role;
  raise notice 'PASS 2/2 — kúpiť, predať ani vidieť peniaze bez účtu nejde';
end $$;

rollback;
