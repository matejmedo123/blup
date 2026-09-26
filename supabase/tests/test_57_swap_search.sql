-- ============================================================================
-- BLUP SWAP má vlastné hľadanie, nie filter nad hľadaním BLUPu
-- ============================================================================
-- Rozdiel je v otázke, ktorú kladú:
--
--   BLUP  „čo sa deje?"                    — aj event, na ktorý nikto nič nepredáva
--   SWAP  „kde sa dá kúpiť od niekoho?"    — len to, na čo NIEKTO PRÁVE TERAZ niečo ponúka
--
-- Test sa pýta presne na ten rozdiel: ten istý dotaz musí dať v BLUPe viac
-- výsledkov než v SWAPe, a v SWAPe sa nesmie objaviť event bez ponuky.
-- ============================================================================
begin;
set search_path = public, extensions;

insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('a5757575-0000-0000-0000-000000000001', 'org57@example.com',  now(), '{"display_name":"Organizátor"}'),
  ('a5757575-0000-0000-0000-000000000002', 'sell57@example.com', now(), '{"display_name":"Predajca"}');

insert into public.organizations (id, name, slug, created_by, verification_status)
values ('b5757575-0000-0000-0000-000000000001', 'Klub s.r.o.', 'klub-57',
        'a5757575-0000-0000-0000-000000000001', 'verified');
insert into public.organization_members (organization_id, user_id, role)
values ('b5757575-0000-0000-0000-000000000001', 'a5757575-0000-0000-0000-000000000001', 'owner')
on conflict do nothing;

-- Dva eventy toho istého interpreta v tom istom meste. Na jeden bude ponuka,
-- na druhý nie — a práve to ich má v SWAPe rozdeliť.
insert into public.events (
  id, creator_id, organization_id, title, category, latitude, longitude,
  start_at, end_at, city, venue_name, is_free, price_cents, currency,
  status, visibility, performers
) values
  ('e5757575-0000-0000-0000-000000000001',
   'a5757575-0000-0000-0000-000000000001', 'b5757575-0000-0000-0000-000000000001',
   'Prvý večer', 'concert', 48.15, 17.11,
   now() + interval '30 days', now() + interval '30 days 3 hours',
   'Bratislava', 'Veľká sála', false, 4000, 'EUR', 'published', 'public',
   array['Karpatské Chrbáty']),
  ('e5757575-0000-0000-0000-000000000002',
   'a5757575-0000-0000-0000-000000000001', 'b5757575-0000-0000-0000-000000000001',
   'Druhý večer', 'concert', 48.15, 17.11,
   now() + interval '31 days', now() + interval '31 days 3 hours',
   'Bratislava', 'Veľká sála', false, 4000, 'EUR', 'published', 'public',
   array['Karpatské Chrbáty']);

insert into public.ticket_types (id, event_id, name, price_cents, currency, quantity_total)
values ('f5757575-0000-0000-0000-000000000001', 'e5757575-0000-0000-0000-000000000001',
        'Vstup', 4000, 'EUR', 300);

insert into public.tickets (id, event_id, ticket_type_id, buyer_id, code, qr_secret, price_cents, currency)
values ('c5757575-0000-0000-0000-000000000001', 'e5757575-0000-0000-0000-000000000001',
        'f5757575-0000-0000-0000-000000000001', 'a5757575-0000-0000-0000-000000000002',
        'BLP-SWAP57A', 'secret-57a', 4000, 'EUR');

-- ============================================================================
-- 1. SWAP ukáže len to, na čo niekto ponúka
-- ============================================================================
do $$
declare
  v_seller uuid := 'a5757575-0000-0000-0000-000000000002';
  v_blup   integer;
  v_swap   integer;
  v_hit    record;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_seller::text, true);

  -- Zatiaľ nikto nič neponúka: SWAP musí byť prázdny, aj keď eventy existujú.
  select count(*) into v_swap from public.swap_search('chrbaty', 30);
  assert v_swap = 0,
    format('SWAP ukazuje %s výsledkov, hoci nikto nič neponúka', v_swap);

  -- BLUP ich medzitým nájde oba — to je správne, odpovedá na inú otázku.
  select count(*) into v_blup from public.search_events(p_query => 'chrbaty');
  assert v_blup = 2, format('BLUP mal nájsť 2 eventy, našiel %s', v_blup);

  -- Teraz ponuka na PRVÝ event.
  perform public.create_resale_listing(
    'e5757575-0000-0000-0000-000000000001'::uuid, 'blup', 3500,
    'c5757575-0000-0000-0000-000000000001'::uuid,
    p_section => 'A', p_row_label => '3'
  );

  select count(*) into v_swap from public.swap_search('chrbaty', 30) where kind = 'event';
  assert v_swap = 1,
    format('SWAP má ukázať jeden event s ponukou, ukazuje %s', v_swap);

  -- A ten druhý, bez ponuky, sa v ňom objaviť nesmie.
  select count(*) into v_swap from public.swap_search('chrbaty', 30)
  where kind = 'event' and key = 'e5757575-0000-0000-0000-000000000002';
  assert v_swap = 0, 'SWAP ukazuje event, na ktorý nikto nič neponúka';

  -- Interpret má v SWAPe počet PONÚK, nie počet eventov. To je ten istý
  -- rozdiel ešte raz: SWAP počíta, čo sa dá kúpiť.
  select * into v_hit from public.swap_search('chrbaty', 30) where kind = 'artist';
  assert found, 'interpret sa v SWAPe nenašiel';
  assert v_hit.listing_count = 1,
    format('interpret má mať 1 ponuku, má %s', v_hit.listing_count);
  assert v_hit.from_cents = 3500,
    format('najnižšia cena má byť 3500, je %s', v_hit.from_cents);
  assert v_hit.verified_count = 1,
    'BLUP vstupenka sa má rátať medzi overené';

  reset role;
  raise notice 'PASS SWAP ukazuje len to, na čo niekto naozaj ponúka';
end $$;

-- ============================================================================
-- 2. Prázdny dotaz je ponuka, nie prázdno
-- ============================================================================
-- Prvé otvorenie SWAPu, keď človek ešte nič nenapísal. Výzva „napíš niečo"
-- nad plnou burzou je premárnená obrazovka.
do $$
declare
  v_seen integer;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', 'a5757575-0000-0000-0000-000000000002', true);

  select count(*) into v_seen from public.swap_search('', 30) where kind = 'event';
  assert v_seen >= 1, 'prázdny dotaz nič neukázal, hoci ponuka existuje';

  -- Ale interpreti a mestá sa pri prázdnom dotaze neponúkajú: bolo by to
  -- zoskupenie toho istého zoznamu trikrát pod sebou.
  select count(*) into v_seen from public.swap_search('', 30) where kind <> 'event';
  assert v_seen = 0,
    format('prázdny dotaz vrátil %s zoskupení navyše', v_seen);

  reset role;
  raise notice 'PASS prázdny dotaz ukáže ponuku, nie výzvu';
end $$;

-- ============================================================================
-- 3. Predaná a stiahnutá ponuka zo SWAPu zmizne
-- ============================================================================
do $$
declare
  v_listing uuid;
  v_seen    integer;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', 'a5757575-0000-0000-0000-000000000002', true);

  select id into v_listing from public.resale_listings
  where event_id = 'e5757575-0000-0000-0000-000000000001';

  perform public.cancel_resale_listing(v_listing);

  select count(*) into v_seen from public.swap_search('chrbaty', 30);
  assert v_seen = 0,
    format('stiahnutá ponuka je stále v SWAPe (%s výsledkov)', v_seen);

  -- BLUP o tom nemá vedieť vôbec: event sa nezmenil.
  reset role;
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', 'a5757575-0000-0000-0000-000000000002', true);
  select count(*) into v_seen from public.search_events(p_query => 'chrbaty');
  assert v_seen = 2,
    'stiahnutie ponuky na SWAPe ovplyvnilo hľadanie v BLUPe';

  reset role;
  raise notice 'PASS stiahnutá ponuka zmizne zo SWAPu a BLUPu sa to netýka';
end $$;

rollback;
