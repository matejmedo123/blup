-- ============================================================================
-- SWAP — z provízie ide podiel organizátorovi
-- ============================================================================
-- Nový model provízie tvrdí tri veci a každá sa dá pokaziť ticho:
--
--   „predajca platí 15 % vždy"        nech je vstupenka naša alebo cudzia
--   „pri našej ide 5 % organizátorovi" a zapíše sa mu do knihy
--   „pri cudzej nedostane nič"         nevydal ju a o predaji nevie
--
-- A štvrtá, najtichšia: podiel sa nesmie pripísať dvakrát, keď cron zbehne
-- dvakrát.
-- ============================================================================
begin;
set search_path = public, extensions;

insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('a6363636-0000-0000-0000-000000000001', 'org63@example.com',  now(), '{"display_name":"Organizátor"}'),
  ('a6363636-0000-0000-0000-000000000002', 'sell63@example.com', now(), '{"display_name":"Predajca"}'),
  ('a6363636-0000-0000-0000-000000000003', 'buy63@example.com',  now(), '{"display_name":"Kupujúci"}');

insert into public.organizations (id, name, slug, created_by, verification_status)
values ('b6363636-0000-0000-0000-000000000001', 'Klub s.r.o.', 'klub-63',
        'a6363636-0000-0000-0000-000000000001', 'verified');
insert into public.organization_members (organization_id, user_id, role)
values ('b6363636-0000-0000-0000-000000000001', 'a6363636-0000-0000-0000-000000000001', 'owner')
on conflict do nothing;

-- Event, ktorý sa už odohral — vyrovnanie sa deje až potom.
insert into public.events (
  id, creator_id, organization_id, title, category, latitude, longitude,
  start_at, end_at, is_free, price_cents, currency, status, visibility
) values (
  'e6363636-0000-0000-0000-000000000001',
  'a6363636-0000-0000-0000-000000000001', 'b6363636-0000-0000-0000-000000000001',
  'Koncert v klube', 'concert', 48.15, 17.11,
  now() + interval '2 days', now() + interval '2 days 3 hours',
  false, 4000, 'EUR', 'published', 'public'
);

insert into public.ticket_types (id, event_id, name, price_cents, currency, quantity_total)
values ('f6363636-0000-0000-0000-000000000001', 'e6363636-0000-0000-0000-000000000001',
        'Státie', 4000, 'EUR', 500);

insert into public.tickets (id, event_id, ticket_type_id, buyer_id, code, qr_secret, price_cents, currency)
values ('c6363636-0000-0000-0000-000000000001', 'e6363636-0000-0000-0000-000000000001',
        'f6363636-0000-0000-0000-000000000001', 'a6363636-0000-0000-0000-000000000002',
        'BLP-63-1', 'secret-63-1', 4000, 'EUR');

-- ============================================================================
-- 1. Naša vstupenka: 15 % z ceny, z toho 5 % organizátorovi
-- ============================================================================
do $$
declare
  v_event  uuid := 'e6363636-0000-0000-0000-000000000001';
  v_seller uuid := 'a6363636-0000-0000-0000-000000000002';
  v_buyer  uuid := 'a6363636-0000-0000-0000-000000000003';
  v_org    uuid := 'b6363636-0000-0000-0000-000000000001';
  v_l      public.resale_listings;
  v_res    public.resale_reservations;
  v_ord    public.resale_orders;
  v_share  integer;
  v_rows   integer;
  v_seller_sum integer;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_seller::text, true);
  -- 60 € za vstupenku, ktorá stála 40 € — cenu si určuje predajca.
  v_l := public.create_resale_listing(
    v_event, 'blup', 6000, 'c6363636-0000-0000-0000-000000000001'::uuid);

  perform set_config('request.jwt.claim.sub', v_buyer::text, true);
  v_res := public.reserve_resale_listing(v_l.id, 1);
  v_ord := public.create_resale_order(v_res.id);

  -- Predajca platí 15 %, nech je vstupenka čiakoľvek.
  assert v_ord.seller_fee_cents = 900,
    format('provízia z 60 € má byť 9 €, je %s', v_ord.seller_fee_cents);
  assert v_ord.seller_net_cents = 5100,
    format('predajcovi má zostať 51 €, zostáva %s', v_ord.seller_net_cents);
  assert v_ord.total_cents = 6000, 'kupujúci platí presne cenu z ponuky';

  reset role;
  -- Pri našej vstupenke prevod robí samotné zaplatenie; objednávka je potom
  -- rovno `ticket_delivered`.
  perform public.mark_resale_order_paid(v_ord.id, 'pi_63_a');

  -- Event prebehne a spustí sa vyrovnanie.
  update public.events
  set start_at = now() - interval '2 days', end_at = now() - interval '2 days' + interval '3 hours'
  where id = v_event;

  perform public.settle_resale_orders(100);

  -- Predajcovi sedí hrubá suma mínus provízia.
  select coalesce(sum(amount_cents), 0) into v_seller_sum
  from public.seller_ledger_entries where resale_order_id = v_ord.id;
  assert v_seller_sum = 5100,
    format('predajcovi má v knihe sedieť 51 €, sedí %s', v_seller_sum);

  -- A organizátorovi pribudlo 5 % z ceny.
  select coalesce(sum(amount_cents), 0) into v_share
  from public.ledger_entries
  where resale_order_id = v_ord.id and organization_id = v_org;
  assert v_share = 300,
    format('organizátorovi má pribudnúť 3 €, pribudlo %s', v_share);

  -- Zapísané ako úprava, nie ako predaj — vstupenku predal niekto iný a keby
  -- to bol `sale`, rozišli by sa mu tržby s počtom predaných vstupeniek.
  select count(*) into v_rows from public.ledger_entries
  where resale_order_id = v_ord.id and type = 'adjustment';
  assert v_rows = 1, format('čakal sa jeden záznam typu adjustment, je %s', v_rows);

  -- Druhý beh cronu nesmie pripísať nič navyše.
  perform public.settle_resale_orders(100);
  select coalesce(sum(amount_cents), 0) into v_share
  from public.ledger_entries where resale_order_id = v_ord.id;
  assert v_share = 300,
    format('druhý beh pripísal organizátorovi navyše: %s', v_share);
  select coalesce(sum(amount_cents), 0) into v_seller_sum
  from public.seller_ledger_entries where resale_order_id = v_ord.id;
  assert v_seller_sum = 5100,
    format('druhý beh pripísal predajcovi navyše: %s', v_seller_sum);

  raise notice 'PASS 1/2 — naša vstupenka: 15 %%, z toho 5 %% organizátorovi';
end $$;

-- ============================================================================
-- 2. Vstupenka odinakiaľ: 15 % celé BLUPu, organizátor nedostane nič
-- ============================================================================
do $$
declare
  v_event  uuid := 'e6363636-0000-0000-0000-000000000001';
  v_seller uuid := 'a6363636-0000-0000-0000-000000000002';
  v_buyer  uuid := 'a6363636-0000-0000-0000-000000000003';
  v_l      public.resale_listings;
  v_res    public.resale_reservations;
  v_ord    public.resale_orders;
  v_share  integer;
begin
  reset role;
  update public.events
  set start_at = now() + interval '2 days', end_at = now() + interval '2 days 3 hours'
  where id = v_event;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_seller::text, true);
  v_l := public.create_resale_listing(v_event, 'external', 6000, null,
    p_delivery_method => 'file', p_external_provider => 'Ticketportal');

  perform set_config('request.jwt.claim.sub', v_buyer::text, true);
  v_res := public.reserve_resale_listing(v_l.id, 1);
  v_ord := public.create_resale_order(v_res.id);

  assert v_ord.seller_fee_cents = 900,
    format('aj pri cudzej vstupenke je provízia 15 %%, je %s', v_ord.seller_fee_cents);

  reset role;
  perform public.mark_resale_order_paid(v_ord.id, 'pi_63_b');
  -- Externá sa doručí a kupujúci potvrdí — inak sa nevyrovnáva vôbec.
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_seller::text, true);
  perform public.deliver_resale_ticket(v_ord.id, null, 'PDF poslané');
  perform set_config('request.jwt.claim.sub', v_buyer::text, true);
  perform public.confirm_resale_ticket(v_ord.id);

  reset role;
  update public.events
  set start_at = now() - interval '2 days', end_at = now() - interval '2 days' + interval '3 hours'
  where id = v_event;
  perform public.settle_resale_orders(100);

  select coalesce(sum(amount_cents), 0) into v_share
  from public.ledger_entries where resale_order_id = v_ord.id;
  assert v_share = 0,
    format('pri vstupenke odinakiaľ nemá organizátor dostať nič, dostal %s', v_share);

  raise notice 'PASS 2/2 — cudzia vstupenka: 15 %% celé BLUPu';
end $$;

rollback;
