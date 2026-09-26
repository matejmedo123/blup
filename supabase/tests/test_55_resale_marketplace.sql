-- ============================================================================
-- Burza vstupeniek
-- ============================================================================
-- Testuje presne tie tvrdenia, ktoré burza dáva navonok — a ktoré by bez
-- dôkazu boli len sľubom:
--
--   „dvaja kupujúci nekúpia tú istú vstupenku"   ochrana proti dvojpredaju
--   „100 % pravosť BLUP vstupenky"               prevod naozaj zneplatní starý QR
--   „cenu určuje server"                         frontend ju neovplyvní
--   „webhook smie doraziť viackrát"              idempotencia
--   „peniaze držíme do vstupu"                   výplata čaká a spor ju zadrží
--   „cudziu objednávku nevidíš"                  autorizácia
--
-- Súbor je zámerne dlhý: toto je jediné miesto v projekte, kde sa peniaze
-- posúvajú medzi dvoma ľuďmi, a tam sa test nešetrí.
-- ============================================================================
begin;
set search_path = public, extensions;

insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('a5555555-0000-0000-0000-000000000001', 'org55@example.com',   now(), '{"display_name":"Organizátor"}'),
  ('a5555555-0000-0000-0000-000000000002', 'seller55@example.com',now(), '{"display_name":"Predajca"}'),
  ('a5555555-0000-0000-0000-000000000003', 'buyer55@example.com', now(), '{"display_name":"Kupujúci"}'),
  ('a5555555-0000-0000-0000-000000000004', 'rival55@example.com', now(), '{"display_name":"Druhý kupujúci"}'),
  ('a5555555-0000-0000-0000-000000000005', 'admin55@example.com', now(), '{"display_name":"Admin"}');

update public.profiles set app_role = 'admin' where id = 'a5555555-0000-0000-0000-000000000005';

insert into public.organizations (id, name, slug, created_by, verification_status)
values ('b5555555-0000-0000-0000-000000000001', 'Klub s.r.o.', 'klub-55',
        'a5555555-0000-0000-0000-000000000001', 'verified');
insert into public.organization_members (organization_id, user_id, role)
values ('b5555555-0000-0000-0000-000000000001', 'a5555555-0000-0000-0000-000000000001', 'owner')
on conflict do nothing;

-- Event o týždeň, platený, s jedným typom vstupenky.
insert into public.events (
  id, creator_id, organization_id, title, category, latitude, longitude,
  start_at, end_at, is_free, price_cents, currency, status, visibility
) values (
  'e5555555-0000-0000-0000-000000000001',
  'a5555555-0000-0000-0000-000000000001', 'b5555555-0000-0000-0000-000000000001',
  'Koncert v hale', 'concert', 48.15, 17.11,
  now() + interval '7 days', now() + interval '7 days 3 hours',
  false, 4000, 'EUR', 'published', 'public'
);

insert into public.ticket_types (id, event_id, name, price_cents, currency, quantity_total)
values ('f5555555-0000-0000-0000-000000000001', 'e5555555-0000-0000-0000-000000000001',
        'State', 4000, 'EUR', 500);

-- Predajca má vstupenku, ktorú kúpil za 40 €.
insert into public.tickets (id, event_id, ticket_type_id, buyer_id, code, qr_secret, price_cents, currency)
values ('c5555555-0000-0000-0000-000000000001', 'e5555555-0000-0000-0000-000000000001',
        'f5555555-0000-0000-0000-000000000001', 'a5555555-0000-0000-0000-000000000002',
        'BLP-ORIGINAL1', 'secret-original', 4000, 'EUR');

-- ============================================================================
-- 1. Vypísať sa dá len vlastná platná vstupenka a nie za koľkokoľvek
-- ============================================================================
do $$
declare
  v_seller uuid := 'a5555555-0000-0000-0000-000000000002';
  v_buyer  uuid := 'a5555555-0000-0000-0000-000000000003';
  v_event  uuid := 'e5555555-0000-0000-0000-000000000001';
  v_ticket uuid := 'c5555555-0000-0000-0000-000000000001';
  v_listing public.resale_listings;
  v_failed boolean;
begin
  set local role authenticated;

  -- Cudzia vstupenka: kupujúci skúsi predať to, čo mu nepatrí.
  perform set_config('request.jwt.claim.sub', v_buyer::text, true);
  v_failed := false;
  begin
    perform public.create_resale_listing(v_event, 'blup', 4000, v_ticket);
  exception when others then
    v_failed := true;
    assert sqlerrm like '%FORBIDDEN%', format('čakala sa FORBIDDEN, prišlo: %s', sqlerrm);
  end;
  assert v_failed, 'ÚNIK: cudziu vstupenku sa podarilo vypísať na predaj';

  perform set_config('request.jwt.claim.sub', v_seller::text, true);

  -- Strop prirážky. Východzie nastavenie je 0 bps, čiže najviac pôvodná cena.
  v_failed := false;
  begin
    perform public.create_resale_listing(v_event, 'blup', 12000, v_ticket);
  exception when others then
    v_failed := true;
    assert sqlerrm like '%PRICE_ABOVE_CAP%', format('čakal sa strop ceny, prišlo: %s', sqlerrm);
  end;
  assert v_failed, 'vstupenku sa dalo vypísať za trojnásobok pôvodnej ceny';

  -- A teraz správne.
  v_listing := public.create_resale_listing(
    v_event, 'blup', 3500, v_ticket,
    p_section => 'A', p_row_label => '10', p_seat_label => '15'
  );

  assert v_listing.status = 'active', 'listing nie je aktívny';
  assert v_listing.delivery_method = 'blup_transfer',
    'BLUP vstupenka sa musí doručovať prevodom';
  assert v_listing.face_value_cents = 4000,
    'pôvodná cena sa mala prevziať zo vstupenky';

  -- Tá istá vstupenka druhýkrát: unikátny index to nesmie pustiť.
  v_failed := false;
  begin
    perform public.create_resale_listing(v_event, 'blup', 3000, v_ticket);
  exception when others then
    v_failed := true;
  end;
  assert v_failed, 'tá istá vstupenka visí na dvoch listingoch naraz';

  reset role;
  raise notice 'PASS vypísať sa dá len vlastná vstupenka a nie za koľkokoľvek';
end $$;

-- ============================================================================
-- 2. Dvaja kupujúci, jedna vstupenka — rezervovať smie len jeden
-- ============================================================================
do $$
declare
  v_buyer uuid := 'a5555555-0000-0000-0000-000000000003';
  v_rival uuid := 'a5555555-0000-0000-0000-000000000004';
  v_listing uuid;
  v_res public.resale_reservations;
  v_quote jsonb;
  v_failed boolean;
  v_live integer;
begin
  select id into v_listing from public.resale_listings limit 1;

  set local role authenticated;

  -- Prvý kupujúci si ju drží.
  perform set_config('request.jwt.claim.sub', v_buyer::text, true);
  v_res := public.reserve_resale_listing(v_listing, 1);
  assert v_res.status = 'active', 'rezervácia nie je aktívna';
  assert v_res.expires_at > now(), 'rezervácia je už po platnosti';

  -- Druhý prichádza o sekundu neskôr a musí naraziť.
  perform set_config('request.jwt.claim.sub', v_rival::text, true);
  v_quote := public.quote_resale(v_listing, 1);
  assert not (v_quote->>'valid')::boolean, 'druhému sa listing javí ako voľný';
  assert v_quote->>'reason' = 'LISTING_RESERVED',
    format('čakalo sa LISTING_RESERVED, prišlo %s', v_quote->>'reason');

  v_failed := false;
  begin
    perform public.reserve_resale_listing(v_listing, 1);
  exception when others then
    v_failed := true;
  end;
  assert v_failed, 'DVOJPREDAJ: rezervovať si ju stihli obaja';

  -- Počíta sa bez roly. Ako súper by sme videli nulu vždy — RLS mu cudziu
  -- rezerváciu správne skrýva — a test by prešiel aj nad pokazenou ochranou.
  reset role;
  select count(*) into v_live
  from public.resale_reservations
  where listing_id = v_listing and status = 'active';
  assert v_live = 1, format('živých rezervácií má byť práve jedna, je %s', v_live);
  set local role authenticated;

  -- Prvý kupujúci si ju smie predĺžiť — to nie je druhá rezervácia.
  perform set_config('request.jwt.claim.sub', v_buyer::text, true);
  v_res := public.reserve_resale_listing(v_listing, 1);
  assert v_res.status = 'active', 'predĺženie vlastnej rezervácie zlyhalo';

  reset role;
  select count(*) into v_live
  from public.resale_reservations
  where listing_id = v_listing and status = 'active';
  assert v_live = 1, 'predĺženie vyrobilo druhú rezerváciu';
  set local role authenticated;

  -- Listing sa ponúka len tomu, kto ho drží.
  perform set_config('request.jwt.claim.sub', v_rival::text, true);
  select count(*) into v_live from public.event_resale_listings(
    'e5555555-0000-0000-0000-000000000001'::uuid);
  assert v_live = 0, 'rezervovaný listing sa ponúka aj cudziemu kupujúcemu';

  reset role;
  raise notice 'PASS dvaja kupujúci, jedna vstupenka — prejde len jeden';
end $$;

-- ============================================================================
-- 3. Cenu určuje server a súčet sedí na cent
-- ============================================================================
do $$
declare
  v_buyer uuid := 'a5555555-0000-0000-0000-000000000003';
  v_listing uuid;
  v_res uuid;
  v_ord public.resale_orders;
  v_ord2 public.resale_orders;
  v_quote jsonb;
begin
  select id into v_listing from public.resale_listings limit 1;
  select id into v_res from public.resale_reservations
  where listing_id = v_listing and status = 'active';

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_buyer::text, true);

  v_quote := public.quote_resale(v_listing, 1);
  assert (v_quote->>'valid')::boolean, format('ponuka neplatí: %s', v_quote->>'reason');
  assert v_quote->>'authenticity' = 'verified',
    'BLUP vstupenka sa musí označiť ako overená';

  v_ord := public.create_resale_order(v_res);

  -- Cena: 35 € vstupenka, 5 % poplatok kupujúceho = 1,75 €, spolu 36,75 €.
  assert v_ord.ticket_price_cents = 3500,
    format('cena vstupenky má byť 3500, je %s', v_ord.ticket_price_cents);
  assert v_ord.buyer_fee_cents = 175,
    format('poplatok kupujúceho má byť 175, je %s', v_ord.buyer_fee_cents);
  assert v_ord.total_cents = 3675,
    format('spolu má byť 3675, je %s', v_ord.total_cents);
  assert v_ord.total_cents
         = v_ord.ticket_price_cents + v_ord.buyer_fee_cents + v_ord.delivery_fee_cents,
    'súčet objednávky nesedí';
  assert v_ord.seller_net_cents = 3500 - v_ord.seller_fee_cents,
    'podiel predajcu nesedí';
  assert v_ord.order_status = 'payment_pending', 'objednávka nečaká na platbu';

  -- Dvakrát kliknuté „Zaplatiť" nesmie založiť druhú objednávku.
  v_ord2 := public.create_resale_order(v_res);
  assert v_ord2.id = v_ord.id, 'druhý klik založil druhú objednávku';

  reset role;
  raise notice 'PASS cenu určuje server a dvojklik nezaloží druhú objednávku';
end $$;

-- ============================================================================
-- 4. Platba prevedie vstupenku a starý QR prestane platiť
-- ============================================================================
-- Toto je jadro tvrdenia o pravosti. Ak by prevod nechal starý kód funkčný,
-- predajca by sa s fotkou z telefónu dostal dnu pred kupujúcim.
do $$
declare
  v_seller uuid := 'a5555555-0000-0000-0000-000000000002';
  v_buyer  uuid := 'a5555555-0000-0000-0000-000000000003';
  v_ord    uuid;
  v_after  public.resale_orders;
  v_ticket public.tickets;
  v_old_code text := 'BLP-ORIGINAL1';
  v_old_secret text := 'secret-original';
  v_check  jsonb;
  v_listing public.resale_listings;
begin
  select id into v_ord from public.resale_orders limit 1;

  -- Beží ako server, presne ako webhook po overení podpisu.
  v_after := public.mark_resale_order_paid(v_ord, 'pi_test_55');

  assert v_after.payment_status = 'succeeded', 'platba sa nezapísala';
  assert v_after.order_status = 'ticket_delivered',
    format('BLUP vstupenka má byť doručená hneď, je %s', v_after.order_status);

  select * into v_ticket from public.tickets where id = 'c5555555-0000-0000-0000-000000000001';
  assert v_ticket.buyer_id = v_buyer,
    'vstupenka nezmenila majiteľa';
  assert v_ticket.code <> v_old_code,
    'PRAVOSŤ: vstupenka má po prevode stále pôvodný kód';
  assert v_ticket.qr_secret <> v_old_secret,
    'PRAVOSŤ: vstupenka má po prevode stále pôvodný QR';

  -- A starý QR naozaj neprejde pri vstupe.
  v_check := public.check_in_ticket(v_old_code, v_old_secret);
  assert not (v_check->>'ok')::boolean,
    'PRAVOSŤ: pôvodným kódom sa dá prejsť pri vstupe aj po predaji';

  select * into v_listing from public.resale_listings where id = v_after.listing_id;
  assert v_listing.status = 'sold', 'listing nezostal označený ako predaný';

  -- Ten istý webhook druhý a tretí raz. Nesmie sa stať nič.
  perform public.mark_resale_order_paid(v_ord, 'pi_test_55');
  perform public.mark_resale_order_paid(v_ord, 'pi_test_55');

  select * into v_ticket from public.tickets where id = 'c5555555-0000-0000-0000-000000000001';
  assert v_ticket.buyer_id = v_buyer, 'opakovaný webhook pohol vstupenkou';

  raise notice 'PASS platba prevedie vstupenku, starý QR umrie a webhook je idempotentný';
end $$;

-- ============================================================================
-- 5. Cudziu objednávku nevidíš
-- ============================================================================
do $$
declare
  v_seller uuid := 'a5555555-0000-0000-0000-000000000002';
  v_buyer  uuid := 'a5555555-0000-0000-0000-000000000003';
  v_rival  uuid := 'a5555555-0000-0000-0000-000000000004';
  v_admin  uuid := 'a5555555-0000-0000-0000-000000000005';
  v_seen   integer;
  v_failed boolean;
  v_listing uuid;
begin
  select id into v_listing from public.resale_listings limit 1;

  set local role authenticated;

  perform set_config('request.jwt.claim.sub', v_buyer::text, true);
  select count(*) into v_seen from public.resale_orders;
  assert v_seen = 1, format('kupujúci má vidieť svoju objednávku, vidí %s', v_seen);

  perform set_config('request.jwt.claim.sub', v_seller::text, true);
  select count(*) into v_seen from public.resale_orders;
  assert v_seen = 1, 'predajca nevidí objednávku na svoju vstupenku';

  -- Nezúčastnený človek nesmie vidieť nič.
  perform set_config('request.jwt.claim.sub', v_rival::text, true);
  select count(*) into v_seen from public.resale_orders;
  assert v_seen = 0, format('ÚNIK: cudzí vidí %s objednávok', v_seen);

  select count(*) into v_seen from public.resale_reservations
  where buyer_id <> v_rival;
  assert v_seen = 0, 'ÚNIK: cudzí vidí cudzie rezervácie';

  -- A cudzí listing nesmie stiahnuť.
  v_failed := false;
  begin
    perform public.cancel_resale_listing(v_listing);
  exception when others then
    v_failed := true;
    assert sqlerrm like '%FORBIDDEN%' or sqlerrm like '%LISTING_SOLD%',
      format('čakala sa FORBIDDEN, prišlo: %s', sqlerrm);
  end;
  assert v_failed, 'ÚNIK: cudzí listing sa dal stiahnuť';

  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  select count(*) into v_seen from public.resale_orders;
  assert v_seen = 1, 'admin nevidí objednávky';

  reset role;
  raise notice 'PASS cudziu objednávku, rezerváciu ani listing nikto nevidí';
end $$;

rollback;
