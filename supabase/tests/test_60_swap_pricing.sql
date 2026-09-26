-- ============================================================================
-- BLUP SWAP — voľná cena a odporúčanie podľa trhu
-- ============================================================================
-- Burza stojí a padá na tom, že cenu určuje predajca. Tento súbor overuje
-- tri tvrdenia, ktoré appka predajcovi dáva:
--
--   „vstupenku predáš za svoju cenu"        strop neplatí, kým ho nezapneme
--   „poradíme ti podľa toho, ako ju predávajú ostatní"
--                                           odporúčanie stojí na trhu, nie
--                                           na pôvodnej faktúre, a vlastnú
--                                           ponuku do trhu nepočíta
--   „cudzie predajné ceny sú tajné"         medián predajov sa ukáže až vtedy,
--                                           keď sa z neho nedá dopočítať, koľko
--                                           dostal konkrétny človek
-- ============================================================================
begin;
set search_path = public, extensions;

insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('a6060606-0000-0000-0000-000000000001', 'org60@example.com',  now(), '{"display_name":"Organizátor"}'),
  ('a6060606-0000-0000-0000-000000000002', 'me60@example.com',   now(), '{"display_name":"Ja"}'),
  ('a6060606-0000-0000-0000-000000000003', 'riv60a@example.com', now(), '{"display_name":"Konkurent A"}'),
  ('a6060606-0000-0000-0000-000000000004', 'riv60b@example.com', now(), '{"display_name":"Konkurent B"}'),
  ('a6060606-0000-0000-0000-000000000005', 'riv60c@example.com', now(), '{"display_name":"Konkurent C"}'),
  ('a6060606-0000-0000-0000-000000000006', 'buy60@example.com',  now(), '{"display_name":"Kupujúci"}');

insert into public.organizations (id, name, slug, created_by, verification_status)
values ('b6060606-0000-0000-0000-000000000001', 'Aréna s.r.o.', 'arena-60',
        'a6060606-0000-0000-0000-000000000001', 'verified');
insert into public.organization_members (organization_id, user_id, role)
values ('b6060606-0000-0000-0000-000000000001', 'a6060606-0000-0000-0000-000000000001', 'owner')
on conflict do nothing;

insert into public.events (
  id, creator_id, organization_id, title, category, latitude, longitude,
  start_at, end_at, is_free, price_cents, currency, status, visibility
) values (
  'e6060606-0000-0000-0000-000000000001',
  'a6060606-0000-0000-0000-000000000001', 'b6060606-0000-0000-0000-000000000001',
  'Vypredaná aréna', 'concert', 48.15, 17.11,
  now() + interval '20 days', now() + interval '20 days 3 hours',
  false, 4000, 'EUR', 'published', 'public'
);

insert into public.ticket_types (id, event_id, name, price_cents, currency, quantity_total)
values ('f6060606-0000-0000-0000-000000000001', 'e6060606-0000-0000-0000-000000000001',
        'State', 4000, 'EUR', 500);

-- Každý predajca má svoju vlastnú vstupenku za 40 €.
insert into public.tickets (id, event_id, ticket_type_id, buyer_id, code, qr_secret, price_cents, currency) values
  ('c6060606-0000-0000-0000-000000000002', 'e6060606-0000-0000-0000-000000000001',
   'f6060606-0000-0000-0000-000000000001', 'a6060606-0000-0000-0000-000000000002',
   'BLP-60-ME', 'secret-60-me', 4000, 'EUR'),
  ('c6060606-0000-0000-0000-000000000003', 'e6060606-0000-0000-0000-000000000001',
   'f6060606-0000-0000-0000-000000000001', 'a6060606-0000-0000-0000-000000000003',
   'BLP-60-A', 'secret-60-a', 4000, 'EUR'),
  ('c6060606-0000-0000-0000-000000000004', 'e6060606-0000-0000-0000-000000000001',
   'f6060606-0000-0000-0000-000000000001', 'a6060606-0000-0000-0000-000000000004',
   'BLP-60-B', 'secret-60-b', 4000, 'EUR'),
  ('c6060606-0000-0000-0000-000000000005', 'e6060606-0000-0000-0000-000000000001',
   'f6060606-0000-0000-0000-000000000001', 'a6060606-0000-0000-0000-000000000005',
   'BLP-60-C', 'secret-60-c', 4000, 'EUR');

-- ============================================================================
-- 1. Bez trhu sa poradí podľa nominálnej hodnoty — a nič sa nevymýšľa
-- ============================================================================
do $$
declare
  v_me     uuid := 'a6060606-0000-0000-0000-000000000002';
  v_event  uuid := 'e6060606-0000-0000-0000-000000000001';
  v_ticket uuid := 'c6060606-0000-0000-0000-000000000002';
  v_hint   jsonb;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_me::text, true);

  v_hint := public.resale_price_hint(v_event, v_ticket);

  assert (v_hint->'live'->>'count')::integer = 0,
    'na prázdnom evente sa nemá z čoho počítať trh';
  assert (v_hint->'sold'->>'count')::integer = 0,
    'na prázdnom evente sa nemá z čoho počítať história';
  assert (v_hint->>'face_value_cents')::integer = 4000,
    'nominálnu hodnotu vlastnej vstupenky vieme presne';

  -- Keď trh mlčí, základom je nominálna hodnota. Odporúčanie sa neschováva,
  -- ale ani sa netvári, že vie viac než vie.
  assert (v_hint->'suggest'->>'balanced_cents')::integer = 4000,
    format('vyvážená cena mala byť nominál, je %s', v_hint->'suggest'->>'balanced_cents');
  assert (v_hint->'suggest'->>'fast_cents')::integer = 3600,
    format('rýchla cena mala byť 90 %% nominálu, je %s', v_hint->'suggest'->>'fast_cents');
  assert (v_hint->'suggest'->>'top_cents')::integer = 4600,
    format('maximum malo byť 115 %% nominálu, je %s', v_hint->'suggest'->>'top_cents');

  raise notice 'PASS 1/3 — bez trhu radí nominál';
end $$;

-- ============================================================================
-- 2. S konkurenciou radí trh — a vlastnú ponuku do trhu nepočíta
-- ============================================================================
do $$
declare
  v_me     uuid := 'a6060606-0000-0000-0000-000000000002';
  v_event  uuid := 'e6060606-0000-0000-0000-000000000001';
  v_ticket uuid := 'c6060606-0000-0000-0000-000000000002';
  v_hint   jsonb;
  v_mine   public.resale_listings;
begin
  set local role authenticated;

  -- Traja konkurenti: 30 €, 50 €, 70 €. Všetci drahšie alebo lacnejšie než
  -- nominál — presne preto, že strop už neplatí.
  perform set_config('request.jwt.claim.sub', 'a6060606-0000-0000-0000-000000000003', true);
  perform public.create_resale_listing(v_event, 'blup', 3000, 'c6060606-0000-0000-0000-000000000003');
  perform set_config('request.jwt.claim.sub', 'a6060606-0000-0000-0000-000000000004', true);
  perform public.create_resale_listing(v_event, 'blup', 5000, 'c6060606-0000-0000-0000-000000000004');
  perform set_config('request.jwt.claim.sub', 'a6060606-0000-0000-0000-000000000005', true);
  perform public.create_resale_listing(v_event, 'blup', 7000, 'c6060606-0000-0000-0000-000000000005');

  perform set_config('request.jwt.claim.sub', v_me::text, true);
  v_hint := public.resale_price_hint(v_event, v_ticket);

  assert (v_hint->'live'->>'count')::integer = 3,
    format('čakali sa tri ponuky, je %s', v_hint->'live'->>'count');
  assert (v_hint->'live'->>'min_cents')::integer = 3000, 'najlacnejšia je 30 €';
  assert (v_hint->'live'->>'median_cents')::integer = 5000, 'medián je 50 €';
  assert (v_hint->'live'->>'max_cents')::integer = 7000, 'najdrahšia je 70 €';

  -- Rada: pod najlacnejšiu ponuku ak chceš predať hneď, medián ak chceš
  -- vyvážene, horný kvartil ak chceš vyťažiť maximum.
  assert (v_hint->'suggest'->>'fast_cents')::integer < 3000,
    'rýchla cena musí ísť pod najlacnejšiu konkurenčnú ponuku';
  assert (v_hint->'suggest'->>'balanced_cents')::integer = 5000,
    format('vyvážená cena mala byť medián trhu, je %s', v_hint->'suggest'->>'balanced_cents');
  assert (v_hint->'suggest'->>'top_cents')::integer = 6000,
    format('maximum malo byť horný kvartil, je %s', v_hint->'suggest'->>'top_cents');

  -- A teraz to podstatné: vypíšem sa sám, veľmi draho. Keby sa vlastná ponuka
  -- počítala do trhu, odporúčanie by rástlo samo od seba, kým by neutieklo do
  -- neba — a predajca by si sám sebe radil.
  v_mine := public.create_resale_listing(v_event, 'blup', 50000, v_ticket);
  assert v_mine.price_cents = 50000, 'cenu si určuje predajca, aj keď je nezmyselná';

  v_hint := public.resale_price_hint(v_event, v_ticket);
  assert (v_hint->'live'->>'count')::integer = 3,
    'vlastná ponuka sa nesmie počítať do trhu';
  assert (v_hint->'live'->>'max_cents')::integer = 7000,
    'vlastná ponuka sa nesmie počítať do trhu ani cez maximum';
  assert (v_hint->'suggest'->>'balanced_cents')::integer = 5000,
    'odporúčanie sa nesmie hýbať podľa vlastnej ponuky';

  perform public.cancel_resale_listing(v_mine.id);

  raise notice 'PASS 2/3 — radí trh, nie vlastná ponuka';
end $$;

-- ============================================================================
-- 3. Cudzie predajné ceny sú tajné, kým sa z nich nestane štatistika
-- ============================================================================
-- `resale_orders` vidí len kupujúci a predajca. Funkcia je `security definer`,
-- takže do nich vidí — a preto musí sama strážiť, aby z nej nevypadla suma
-- jedného človeka. Celý platobný tok je overený v teste 58; tu ide o to, kedy
-- sa agregát smie ukázať, takže objednávky sa vkladajú priamo.
do $$
declare
  v_me    uuid := 'a6060606-0000-0000-0000-000000000002';
  v_event uuid := 'e6060606-0000-0000-0000-000000000001';
  v_ticket uuid := 'c6060606-0000-0000-0000-000000000002';
  v_listing uuid;
  v_hint  jsonb;
begin
  reset role;

  select id into v_listing from public.resale_listings
   where event_id = v_event and price_cents = 5000 limit 1;

  -- Dva predaje. To je málo — z mediánu dvoch čísel a jedného verejne známeho
  -- by sa dalo dopočítať to druhé.
  insert into public.resale_orders (
    listing_id, event_id, buyer_id, seller_id, source, quantity,
    ticket_price_cents, total_cents, seller_fee_cents, seller_net_cents,
    currency, payment_status, order_status, paid_at
  ) values
    (v_listing, v_event, 'a6060606-0000-0000-0000-000000000006',
     'a6060606-0000-0000-0000-000000000004', 'blup', 1,
     6000, 6000, 600, 5400, 'EUR', 'succeeded', 'completed', now() - interval '2 days'),
    (v_listing, v_event, 'a6060606-0000-0000-0000-000000000006',
     'a6060606-0000-0000-0000-000000000004', 'blup', 1,
     8000, 8000, 800, 7200, 'EUR', 'succeeded', 'completed', now() - interval '1 day');

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_me::text, true);
  v_hint := public.resale_price_hint(v_event, v_ticket);

  assert (v_hint->'sold'->>'count')::integer = 0,
    'ÚNIK: pri dvoch predajoch sa nesmie ukázať štatistika predajných cien';
  assert v_hint->'sold'->>'median_cents' is null,
    'ÚNIK: medián dvoch predajov prezrádza konkrétnu sumu';
  assert (v_hint->'suggest'->>'balanced_cents')::integer = 5000,
    'kým sú predaje skryté, radí sa podľa ponúk';

  -- Tretí predaj. Odteraz je to už štatistika a smie sa ukázať.
  reset role;
  insert into public.resale_orders (
    listing_id, event_id, buyer_id, seller_id, source, quantity,
    ticket_price_cents, total_cents, seller_fee_cents, seller_net_cents,
    currency, payment_status, order_status, paid_at
  ) values
    (v_listing, v_event, 'a6060606-0000-0000-0000-000000000006',
     'a6060606-0000-0000-0000-000000000004', 'blup', 1,
     10000, 10000, 1000, 9000, 'EUR', 'succeeded', 'completed', now() - interval '3 hours');

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_me::text, true);
  v_hint := public.resale_price_hint(v_event, v_ticket);

  assert (v_hint->'sold'->>'count')::integer = 3,
    format('čakali sa tri predaje, je %s', v_hint->'sold'->>'count');
  assert (v_hint->'sold'->>'median_cents')::integer = 8000,
    format('medián troch predajov je 80 €, je %s', v_hint->'sold'->>'median_cents');

  -- A čo ľudia naozaj zaplatili, má väčšiu váhu než to, čo pýtajú.
  assert (v_hint->'suggest'->>'balanced_cents')::integer = 8000,
    format('základom má byť medián predajov, je %s', v_hint->'suggest'->>'balanced_cents');

  -- Tu sa predávalo drahšie, než sa teraz ponúka, takže horný kvartil ponúk
  -- (60 €) je pod mediánom predajov (80 €). „Maximum" sa nesmie zliať s
  -- „Vyváženou" — dva rovnaké návrhy vedľa seba nie sú rada.
  assert (v_hint->'suggest'->>'top_cents')::integer > 8000,
    format('maximum sa zlialo s vyváženou cenou (%s)', v_hint->'suggest'->>'top_cents');
  assert (v_hint->'suggest'->>'fast_cents')::integer
       < (v_hint->'suggest'->>'balanced_cents')::integer,
    'rýchla cena musí byť nižšia než vyvážená';

  raise notice 'PASS 3/3 — predajné ceny až ako štatistika';
end $$;

rollback;
