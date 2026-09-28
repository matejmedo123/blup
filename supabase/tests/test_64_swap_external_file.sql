-- ============================================================================
-- SWAP — vstupenka odinakiaľ ako inzerát so súborom
-- ============================================================================
-- Sľub, ktorý sa tu overuje, znie: „nahráš PDF pri vypisovaní ponuky a
-- kupujúci ho má v sekunde, keď zaplatí — ale peniaze dostaneš až po evente."
--
-- Každá z tých troch vecí sa dá pokaziť ticho, a každá inak:
--
--   1. ponuka bez súboru by prešla a sľub by bol prázdny,
--   2. súbor by sa dal ukázať cudzí alebo ten istý predať dvakrát,
--   3. peniaze by sa uvoľnili pri platbe namiesto po evente.
--
-- A štvrtá vec, ktorá vznikla až s okamžitým doručením: keď kupujúci nikdy
-- neklikne „potvrdzujem", predajcove peniaze nesmú zamrznúť navždy.
-- ============================================================================
begin;
set search_path = public, extensions;

insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('a6464646-0000-0000-0000-000000000001', 'org64@example.com',  now(), '{"display_name":"Organizátor"}'),
  ('a6464646-0000-0000-0000-000000000002', 'sell64@example.com', now(), '{"display_name":"Predajca"}'),
  ('a6464646-0000-0000-0000-000000000003', 'buy64@example.com',  now(), '{"display_name":"Kupujúci"}'),
  ('a6464646-0000-0000-0000-000000000004', 'other64@example.com', now(), '{"display_name":"Cudzí"}');

insert into public.events (
  id, creator_id, title, category, latitude, longitude,
  start_at, end_at, is_free, price_cents, currency, status, visibility
) values (
  'e6464646-0000-0000-0000-000000000001',
  'a6464646-0000-0000-0000-000000000001',
  'Festival mimo BLUPu', 'concert', 48.15, 17.11,
  now() + interval '5 days', now() + interval '5 days 6 hours',
  -- Event na BLUPe je, ale vstupenky sa tu nepredávajú — presne ten prípad,
  -- keď človek drží lístok odinakiaľ a chce ho posunúť ďalej.
  true, 0, 'EUR', 'published', 'public'
);

-- ============================================================================
-- 1. Bez súboru ponuka so spôsobom „súbor" nevznikne
-- ============================================================================
do $$
declare
  v_event  uuid := 'e6464646-0000-0000-0000-000000000001';
  v_seller uuid := 'a6464646-0000-0000-0000-000000000002';
  v_other  uuid := 'a6464646-0000-0000-0000-000000000004';
  v_failed boolean;
  v_l      public.resale_listings;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_seller::text, true);

  v_failed := false;
  begin
    perform public.create_resale_listing(v_event, 'external', 3000, null,
      p_delivery_method => 'file');
  exception when others then
    v_failed := true;
    assert sqlerrm like '%TICKET_FILE_REQUIRED%',
      format('čakalo sa TICKET_FILE_REQUIRED, prišlo: %s', sqlerrm);
  end;
  assert v_failed, 'PRÁZDNY SĽUB: ponuka so „súborom" vznikla bez súboru';

  -- Cudzí priečinok sa prilepiť nedá. Bez tejto kontroly by inzerát ukazoval
  -- na súbor iného človeka.
  v_failed := false;
  begin
    perform public.create_resale_listing(v_event, 'external', 3000, null,
      p_delivery_method => 'file',
      p_ticket_file_path => 'sellers/' || v_other || '/cudzi.pdf');
  exception when others then v_failed := true;
  end;
  assert v_failed, 'ÚNIK: inzerát ukázal na súbor iného predajcu';

  -- Prevod v cudzej appke súbor nemá a mať nemusí.
  v_l := public.create_resale_listing(v_event, 'external', 3000, null,
    p_delivery_method => 'mobile_transfer');
  assert v_l.ticket_file_path is null, 'prevodu v cudzej appke sa priradil súbor';
  perform public.cancel_resale_listing(v_l.id);

  -- Ten istý súbor na dvoch ponukách = jedno PDF predané dvakrát.
  v_l := public.create_resale_listing(v_event, 'external', 3000, null,
    p_delivery_method => 'file',
    p_ticket_file_path => 'sellers/' || v_seller || '/dvojka.pdf');
  v_failed := false;
  begin
    perform public.create_resale_listing(v_event, 'external', 3500, null,
      p_delivery_method => 'file',
      p_ticket_file_path => 'sellers/' || v_seller || '/dvojka.pdf');
  exception when others then
    v_failed := true;
    assert sqlerrm like '%TICKET_FILE_IN_USE%',
      format('čakalo sa TICKET_FILE_IN_USE, prišlo: %s', sqlerrm);
  end;
  assert v_failed, 'ÚNIK: to isté PDF sa dalo ponúknuť dvakrát';
  perform public.cancel_resale_listing(v_l.id);

  reset role;
  raise notice 'PASS 1/4 — bez súboru, s cudzím súborom ani dvakrát to isté PDF to nejde';
end $$;

-- ============================================================================
-- 2. Kupujúci vidí dopredu, že vstupenku dostane hneď
-- ============================================================================
do $$
declare
  v_event  uuid := 'e6464646-0000-0000-0000-000000000001';
  v_seller uuid := 'a6464646-0000-0000-0000-000000000002';
  v_buyer  uuid := 'a6464646-0000-0000-0000-000000000003';
  v_fast   public.resale_listings;
  v_slow   public.resale_listings;
  v_quote  jsonb;
  v_rows   integer;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_seller::text, true);

  v_fast := public.create_resale_listing(v_event, 'external', 4000, null,
    p_delivery_method => 'file', p_ticket_label => 'Hneď',
    p_ticket_file_path => 'sellers/' || v_seller || '/hned.pdf');
  v_slow := public.create_resale_listing(v_event, 'external', 4000, null,
    p_delivery_method => 'mobile_transfer', p_ticket_label => 'Potom');

  perform set_config('request.jwt.claim.sub', v_buyer::text, true);

  select count(*) into v_rows
  from public.event_resale_listings(v_event) r
  where r.id = v_fast.id and r.instant_delivery;
  assert v_rows = 1, 'ponuka so súborom sa vo výpise netvári ako okamžitá';

  select count(*) into v_rows
  from public.event_resale_listings(v_event) r
  where r.id = v_slow.id and not r.instant_delivery;
  assert v_rows = 1, 'PRÁZDNY SĽUB: prevod v cudzej appke sa tvári ako okamžitý';

  -- Výpis nesmie prezradiť CESTU k súboru — ten je cenina a bucket je
  -- súkromný. Vracia sa len „áno/nie".
  v_quote := public.quote_resale(v_fast.id, 1);
  assert (v_quote->>'instant_delivery')::boolean, 'quote nehovorí o okamžitom doručení';
  assert v_quote::text not like '%hned.pdf%', 'ÚNIK: cesta k súboru vyliezla v quote';

  perform set_config('request.jwt.claim.sub', v_seller::text, true);
  perform public.cancel_resale_listing(v_fast.id);
  perform public.cancel_resale_listing(v_slow.id);

  reset role;
  raise notice 'PASS 2/4 — „dostaneš ju hneď" je vidieť pred platbou, cesta k súboru nie';
end $$;

-- ============================================================================
-- 3. Zaplatené → vstupenka je u kupujúceho, peniaze u nikoho
-- ============================================================================
do $$
declare
  v_event  uuid := 'e6464646-0000-0000-0000-000000000001';
  v_seller uuid := 'a6464646-0000-0000-0000-000000000002';
  v_buyer  uuid := 'a6464646-0000-0000-0000-000000000003';
  v_l      public.resale_listings;
  v_res    public.resale_reservations;
  v_ord    public.resale_orders;
  v_file   text;
  v_rows   integer;
  v_failed boolean;
begin
  reset role;
  update public.events
  set start_at = now() + interval '5 days', end_at = now() + interval '5 days 6 hours'
  where id = v_event;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_seller::text, true);
  v_l := public.create_resale_listing(v_event, 'external', 6000, null,
    p_delivery_method => 'file', p_external_provider => 'Ticketportal',
    p_ticket_file_path => 'sellers/' || v_seller || '/vstupenka.pdf');

  perform set_config('request.jwt.claim.sub', v_buyer::text, true);
  v_res := public.reserve_resale_listing(v_l.id, 1);
  v_ord := public.create_resale_order(v_res.id);

  reset role;
  v_ord := public.mark_resale_order_paid(v_ord.id, 'pi_64_a');

  assert v_ord.order_status = 'ticket_delivered',
    format('po zaplatení má byť doručené, je %s', v_ord.order_status);
  assert v_ord.delivered_at is not null, 'čas doručenia sa nezapísal';

  select file_path into v_file
  from public.resale_deliveries where resale_order_id = v_ord.id;
  assert v_file = 'sellers/' || v_seller || '/vstupenka.pdf',
    format('kupujúcemu sa priradil iný súbor: %s', v_file);

  -- Druhý webhook nesmie doručiť druhýkrát.
  perform public.mark_resale_order_paid(v_ord.id, 'pi_64_a');
  select count(*) into v_rows
  from public.resale_deliveries where resale_order_id = v_ord.id;
  assert v_rows = 1, format('opakovaný webhook zapísal %s doručení', v_rows);

  -- A predajca už kupujúcemu nepodstrčí iný súbor.
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_seller::text, true);
  v_failed := false;
  begin
    perform public.deliver_resale_ticket(v_ord.id, v_ord.id::text || '/iny.pdf', null);
  exception when others then
    v_failed := true;
    assert sqlerrm like '%ALREADY_DELIVERED%',
      format('čakalo sa ALREADY_DELIVERED, prišlo: %s', sqlerrm);
  end;
  assert v_failed, 'ÚNIK: predajca vymenil vstupenku po predaji';

  -- Doručené neznamená zaplatené predajcovi. Event ešte len bude.
  reset role;
  assert public.settle_resale_orders(100) = 0,
    'PRÁZDNY SĽUB: peniaze sa uvoľnili pred eventom';
  select count(*) into v_rows
  from public.seller_ledger_entries where resale_order_id = v_ord.id;
  assert v_rows = 0, 'predajcovi vznikol nárok pred eventom';

  raise notice 'PASS 3/4 — vstupenka odchádza pri platbe, peniaze až po evente';
end $$;

-- ============================================================================
-- 4. Kupujúci nikdy neklikne — a predajcove peniaze aj tak nezamrznú
-- ============================================================================
do $$
declare
  v_event  uuid := 'e6464646-0000-0000-0000-000000000001';
  v_ord    public.resale_orders;
  v_sum    integer;
begin
  reset role;

  select * into v_ord from public.resale_orders
  where event_id = v_event and payment_status = 'succeeded'
  order by paid_at desc limit 1;

  -- Deň po evente je ešte v lehote (`resale_settlement_days` = 2).
  update public.events
  set start_at = now() - interval '1 day' - interval '6 hours',
      end_at   = now() - interval '1 day'
  where id = v_event;
  assert public.auto_complete_resale_orders(100) = 0,
    'objednávka sa uzavrela pred uplynutím lehoty';
  assert public.settle_resale_orders(100) = 0, 'nárok vznikol pred uplynutím lehoty';

  -- Tri dni po evente už lehota ubehla.
  update public.events
  set start_at = now() - interval '3 days' - interval '6 hours',
      end_at   = now() - interval '3 days'
  where id = v_event;

  assert public.settle_resale_orders(100) = 1,
    'PENIAZE ZAMRZLI: bez kliknutia kupujúceho sa nárok nikdy nezapísal';

  select order_status into v_ord.order_status
  from public.resale_orders where id = v_ord.id;
  assert v_ord.order_status = 'completed',
    format('objednávka sa mala uzavrieť sama, je %s', v_ord.order_status);

  select coalesce(sum(amount_cents), 0) into v_sum
  from public.seller_ledger_entries where resale_order_id = v_ord.id;
  assert v_sum = v_ord.seller_net_cents,
    format('predajcovi malo pribudnúť %s, pribudlo %s', v_ord.seller_net_cents, v_sum);

  -- Druhý beh cronu nesmie pripísať nič navyše.
  perform public.settle_resale_orders(100);
  select coalesce(sum(amount_cents), 0) into v_sum
  from public.seller_ledger_entries where resale_order_id = v_ord.id;
  assert v_sum = v_ord.seller_net_cents,
    format('druhý beh pripísal navyše: %s', v_sum);

  -- A pri cudzej vstupenke nedostane organizátor nič ani teraz.
  select coalesce(sum(amount_cents), 0) into v_sum
  from public.ledger_entries where resale_order_id = v_ord.id;
  assert v_sum = 0, format('organizátor dostal %s z cudzej vstupenky', v_sum);

  raise notice 'PASS 4/4 — po evente a lehote sa objednávka uzavrie sama, raz';
end $$;

rollback;
