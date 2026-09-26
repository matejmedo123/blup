-- ============================================================================
-- BLUP SWAP — celá cesta, od vypísania po peniaze na účte
-- ============================================================================
-- Ostatné testy sa pýtajú na jednotlivé tvrdenia. Tento prejde celý príbeh
-- dvoch ľudí a jednej vstupenky, lebo chyby v takýchto systémoch nebývajú v
-- krokoch — bývajú medzi nimi.
--
-- Dva scenáre, lebo SWAP má dva druhy vstupeniek a líšia sa práve v tom, čo
-- sa deje po zaplatení:
--
--   A. overená BLUP vstupenka — prevod prebehne sám, peniaze po evente
--   B. vstupenka z inej platformy — predajca doručí, kupujúci potvrdí, a až
--      potom peniaze; bez potvrdenia nedostane nič
--
-- Scenár B je ten dôležitejší. Je to celý obsah sľubu „peniaze držíme, kým
-- nie je vstupenka u teba" — a keby sa dal obísť, bol by to prázdny sľub.
-- ============================================================================
begin;
set search_path = public, extensions;

insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('a5858585-0000-0000-0000-000000000001', 'org58@example.com',   now(), '{"display_name":"Organizátor"}'),
  ('a5858585-0000-0000-0000-000000000002', 'anna58@example.com',  now(), '{"display_name":"Anna"}'),
  ('a5858585-0000-0000-0000-000000000003', 'boris58@example.com', now(), '{"display_name":"Boris"}'),
  ('a5858585-0000-0000-0000-000000000004', 'admin58@example.com', now(), '{"display_name":"Admin"}');

update public.profiles set app_role = 'admin' where id = 'a5858585-0000-0000-0000-000000000004';

insert into public.organizations (id, name, slug, created_by, verification_status)
values ('b5858585-0000-0000-0000-000000000001', 'Aréna s.r.o.', 'arena-58',
        'a5858585-0000-0000-0000-000000000001', 'verified');
insert into public.organization_members (organization_id, user_id, role)
values ('b5858585-0000-0000-0000-000000000001', 'a5858585-0000-0000-0000-000000000001', 'owner')
on conflict do nothing;

-- Event o päť dní. Krátko schválne: v scenári A ho posunieme do minulosti,
-- aby sa dalo overiť, že nárok vzniká až po ňom.
insert into public.events (
  id, creator_id, organization_id, title, category, latitude, longitude,
  start_at, end_at, city, venue_name, is_free, price_cents, currency,
  status, visibility, performers
) values (
  'e5858585-0000-0000-0000-000000000001',
  'a5858585-0000-0000-0000-000000000001', 'b5858585-0000-0000-0000-000000000001',
  'Veľký koncert', 'concert', 48.15, 17.11,
  now() + interval '5 days', now() + interval '5 days 3 hours',
  'Bratislava', 'Aréna', false, 5000, 'EUR', 'published', 'public',
  array['Skupina Test']
);

insert into public.ticket_types (id, event_id, name, price_cents, currency, quantity_total)
values ('f5858585-0000-0000-0000-000000000001', 'e5858585-0000-0000-0000-000000000001',
        'Vstup', 5000, 'EUR', 500);

-- Anna má vstupenku z BLUPu.
insert into public.tickets (id, event_id, ticket_type_id, buyer_id, code, qr_secret, price_cents, currency)
values ('c5858585-0000-0000-0000-000000000001', 'e5858585-0000-0000-0000-000000000001',
        'f5858585-0000-0000-0000-000000000001', 'a5858585-0000-0000-0000-000000000002',
        'BLP-E2E-58A', 'secret-e2e-a', 5000, 'EUR');

-- Predajcovia majú hotový výplatný účet, inak by sa o výplatu nedalo požiadať.
insert into public.seller_accounts (user_id, provider_account_id, payouts_enabled, country)
values
  ('a5858585-0000-0000-0000-000000000002', 'acct_anna_58',  true, 'SK'),
  ('a5858585-0000-0000-0000-000000000003', 'acct_boris_58', true, 'SK');

-- ============================================================================
-- SCENÁR A — overená BLUP vstupenka
-- ============================================================================
do $$
declare
  v_anna   uuid := 'a5858585-0000-0000-0000-000000000002';
  v_boris  uuid := 'a5858585-0000-0000-0000-000000000003';
  v_ticket uuid := 'c5858585-0000-0000-0000-000000000001';
  v_event  uuid := 'e5858585-0000-0000-0000-000000000001';
  v_listing public.resale_listings;
  v_res    public.resale_reservations;
  v_ord    public.resale_orders;
  v_quote  jsonb;
  v_tk     public.tickets;
  v_check  jsonb;
  v_bal    jsonb;
  v_settled integer;
  v_payout public.seller_payouts;
begin
  set local role authenticated;

  -- 1. Anna nemôže ísť a vypíše vstupenku.
  perform set_config('request.jwt.claim.sub', v_anna::text, true);
  v_listing := public.create_resale_listing(
    v_event, 'blup', 4500, v_ticket,
    p_section => 'A', p_row_label => '5', p_seat_label => '11'
  );
  assert v_listing.status = 'active', 'ponuka nie je v predaji';

  -- 2. Boris ju nájde cez SWAP.
  perform set_config('request.jwt.claim.sub', v_boris::text, true);
  assert exists (
    select 1 from public.swap_search('skupina test', 30) where kind = 'event'
  ), 'ponuka sa v SWAPe nenašla';

  -- 3. Pokladňa: cena zo servera, rozpísaná.
  v_quote := public.quote_resale(v_listing.id, 1);
  assert (v_quote->>'valid')::boolean, format('ponuka neplatí: %s', v_quote->>'reason');
  assert v_quote->>'authenticity' = 'verified', 'BLUP vstupenka nie je označená ako overená';
  assert (v_quote->>'total_cents')::integer = 4500,
    format('kupujúci má zaplatiť presne 4500, má %s', v_quote->>'total_cents');
  -- Desatina ide platforme a strháva sa predajcovi, nie kupujúcemu.
  assert (v_quote->>'seller_fee_cents')::integer = 450,
    format('provízia má byť 450, je %s', v_quote->>'seller_fee_cents');
  assert (v_quote->>'seller_net_cents')::integer = 4050,
    format('Anne má zostať 4050, zostáva %s', v_quote->>'seller_net_cents');

  -- 4. Podrží si ju a založí objednávku.
  v_res := public.reserve_resale_listing(v_listing.id, 1);
  v_ord := public.create_resale_order(v_res.id);
  assert v_ord.order_status = 'payment_pending', 'objednávka nečaká na platbu';

  -- 5. Zaplatí. Toto robí webhook po overení podpisu, nie appka.
  reset role;
  v_ord := public.mark_resale_order_paid(v_ord.id, 'pi_e2e_58a');
  assert v_ord.order_status = 'ticket_delivered',
    'BLUP vstupenka mala byť doručená hneď';

  -- 6. Vstupenka je Borisova a Annin kód je mŕtvy.
  select * into v_tk from public.tickets where id = v_ticket;
  assert v_tk.buyer_id = v_boris, 'vstupenka nezmenila majiteľa';
  v_check := public.check_in_ticket('BLP-E2E-58A', 'secret-e2e-a');
  assert not (v_check->>'ok')::boolean,
    'PRAVOSŤ: Annin pôvodný kód stále prejde pri vstupe';

  -- 7. Pred eventom Anna peniaze nedostane.
  v_settled := public.settle_resale_orders(100);
  assert v_settled = 0, 'nárok vznikol ešte pred eventom';

  v_bal := public.seller_balance(v_anna);
  assert (v_bal->>'available_cents')::integer = 0,
    format('pred eventom má byť k výplate 0, je %s', v_bal->>'available_cents');
  -- Ale vidieť ich musí — inak si myslí, že predaj neprebehol.
  assert (v_bal->>'pending_cents')::integer = v_ord.seller_net_cents,
    'predaná vstupenka sa neukazuje ani ako čakajúca';

  -- 8. Event prebehol. Len tesne: odklad je dva dni, takže event pred troma
  --    dňami by znamenal, že peniaze sú k dispozícii hneď — a krok 9 by
  --    netestoval nič. (Presne na tom tento test prvýkrát spadol.)
  update public.events
  set start_at = now() - interval '4 hours', end_at = now() - interval '1 hour'
  where id = v_event;

  v_settled := public.settle_resale_orders(100);
  assert v_settled = 1, format('po evente mal vzniknúť 1 nárok, vzniklo %s', v_settled);

  -- Druhý beh cronu nesmie vyrobiť nárok druhýkrát.
  assert public.settle_resale_orders(100) = 0, 'druhý beh cronu zdvojil nárok';

  -- 9. Odklad ešte beží, takže vyplatiť sa to nedá.
  v_bal := public.seller_balance(v_anna);
  assert (v_bal->>'available_cents')::integer = 0,
    format('počas odkladu má byť k výplate 0, je %s', v_bal->>'available_cents');
  assert (v_bal->>'pending_cents')::integer > 0,
    'počas odkladu peniaze zmizli aj z čakajúcich';

  -- Po odklade už áno.
  update public.seller_ledger_entries set available_at = now() - interval '1 hour'
  where seller_id = v_anna;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_anna::text, true);
  v_payout := public.request_seller_payout();
  assert v_payout.amount_cents = v_ord.seller_net_cents,
    format('výplata má byť %s, je %s', v_ord.seller_net_cents, v_payout.amount_cents);

  -- 10. A druhýkrát si tie isté peniaze vypýtať nedá.
  declare v_failed boolean := false;
  begin
    begin
      perform public.request_seller_payout();
    exception when others then
      v_failed := true;
    end;
    assert v_failed, 'DVOJITÁ VÝPLATA: tie isté peniaze sa dali vypýtať dvakrát';
  end;

  reset role;
  raise notice 'PASS A: overená vstupenka — prevod, mŕtvy starý kód, peniaze až po evente';
end $$;

-- ============================================================================
-- SCENÁR B — vstupenka z inej platformy
-- ============================================================================
-- Tu sa nedá overiť nič, takže všetko drží potvrdenie kupujúceho.
do $$
declare
  v_anna   uuid := 'a5858585-0000-0000-0000-000000000002';
  v_boris  uuid := 'a5858585-0000-0000-0000-000000000003';
  v_event  uuid := 'e5858585-0000-0000-0000-000000000001';
  v_listing public.resale_listings;
  v_res    public.resale_reservations;
  v_ord    public.resale_orders;
  v_quote  jsonb;
  v_settled integer;
  v_failed boolean;
begin
  -- Event znova pred nami, nech sa dá vypísať.
  update public.events
  set start_at = now() + interval '5 days', end_at = now() + interval '5 days 3 hours'
  where id = v_event;

  set local role authenticated;

  -- 1. Boris ponúka vstupenku, o ktorej nevieme nič.
  perform set_config('request.jwt.claim.sub', v_boris::text, true);
  v_listing := public.create_resale_listing(
    v_event, 'external', 6000, null,
    p_delivery_method => 'file',
    p_external_provider => 'Ticketportal',
    p_ticket_label => 'Tribúna'
  );

  -- Strop prirážky sa tu vynútiť nedá — pôvodnú cenu nepoznáme. Je to
  -- vedomý rozdiel a nie diera: 6000 je viac než 5000 a prejde to.
  assert v_listing.price_cents = 6000, 'externú ponuku ovplyvnil strop prirážky';

  perform set_config('request.jwt.claim.sub', v_anna::text, true);
  v_quote := public.quote_resale(v_listing.id, 1);
  assert v_quote->>'authenticity' = 'protected',
    'vstupenka z inej platformy sa tvári ako overená';

  v_res := public.reserve_resale_listing(v_listing.id, 1);
  v_ord := public.create_resale_order(v_res.id);

  reset role;
  v_ord := public.mark_resale_order_paid(v_ord.id, 'pi_e2e_58b');
  assert v_ord.order_status = 'waiting_for_ticket',
    'externá vstupenka sa tvári ako doručená hneď po zaplatení';

  -- 2. Kým ju Boris nedoručí, kupujúca ju potvrdiť nemôže.
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_anna::text, true);
  v_failed := false;
  begin
    perform public.confirm_resale_ticket(v_ord.id);
  exception when others then
    v_failed := true;
    assert sqlerrm like '%TICKET_NOT_AVAILABLE%',
      format('čakalo sa TICKET_NOT_AVAILABLE, prišlo: %s', sqlerrm);
  end;
  assert v_failed, 'potvrdiť sa dala vstupenka, ktorá ešte nedorazila';

  -- 3. Boris doručí.
  perform set_config('request.jwt.claim.sub', v_boris::text, true);
  v_ord := public.deliver_resale_ticket(v_ord.id, v_ord.id::text || '/listok.pdf', null);
  assert v_ord.order_status = 'ticket_delivered', 'doručenie sa nezapísalo';

  -- Cudzí súbor sa "doručiť" nedá.
  v_failed := false;
  begin
    perform public.deliver_resale_ticket(v_ord.id, 'cudzia-objednavka/listok.pdf', null);
  exception when others then
    v_failed := true;
  end;
  assert v_failed, 'ÚNIK: dal sa doručiť súbor z cudzej objednávky';

  -- 4. Event prebehol — ale Anna ešte nepotvrdila, takže Boris nedostane nič.
  --
  -- `reset role` PRED zápisom, nie po ňom: pod rolou `authenticated` ako
  -- niekto, kto event nevlastní, RLS ten update ticho zahodí a test potom
  -- meria niečo úplne iné, než si myslí. Presne na tom tento test spadol a
  -- odhalila to až diagnostika, ktorá vypísala dátum konca eventu.
  reset role;
  update public.events
  set start_at = now() - interval '4 hours', end_at = now() - interval '1 hour'
  where id = v_event;
  v_settled := public.settle_resale_orders(100);
  assert v_settled = 0,
    'PRÁZDNY SĽUB: nárok vznikol aj bez potvrdenia kupujúcej';

  -- 5. Anna potvrdí, že vstupenka fungovala.
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_anna::text, true);
  v_ord := public.confirm_resale_ticket(v_ord.id);
  assert v_ord.order_status = 'completed', 'potvrdenie neuzavrelo objednávku';

  -- Druhé kliknutie nie je chyba.
  perform public.confirm_resale_ticket(v_ord.id);

  reset role;
  v_settled := public.settle_resale_orders(100);
  assert v_settled = 1, 'po potvrdení nárok nevznikol';

  raise notice 'PASS B: externá vstupenka — bez potvrdenia kupujúcej peniaze nikam nejdú';
end $$;

-- ============================================================================
-- SCENÁR C — spor zadrží peniaze a admin rozhodne
-- ============================================================================
do $$
declare
  v_anna  uuid := 'a5858585-0000-0000-0000-000000000002';
  v_boris uuid := 'a5858585-0000-0000-0000-000000000003';
  v_admin uuid := 'a5858585-0000-0000-0000-000000000004';
  v_event uuid := 'e5858585-0000-0000-0000-000000000001';
  v_listing public.resale_listings;
  v_res   public.resale_reservations;
  v_ord   public.resale_orders;
  v_d     public.resale_disputes;
  v_out   jsonb;
  v_settled integer;
  v_seen  integer;
begin
  update public.events
  set start_at = now() + interval '5 days', end_at = now() + interval '5 days 3 hours'
  where id = v_event;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_boris::text, true);
  v_listing := public.create_resale_listing(
    v_event, 'external', 5500, null,
    p_delivery_method => 'file', p_external_provider => 'Predpredaj.sk'
  );

  perform set_config('request.jwt.claim.sub', v_anna::text, true);
  v_res := public.reserve_resale_listing(v_listing.id, 1);
  v_ord := public.create_resale_order(v_res.id);

  reset role;
  v_ord := public.mark_resale_order_paid(v_ord.id, 'pi_e2e_58c');

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_boris::text, true);
  perform public.deliver_resale_ticket(v_ord.id, v_ord.id::text || '/falos.pdf', null);

  -- Anna zistí, že vstupenka neprešla pri vstupe.
  perform set_config('request.jwt.claim.sub', v_anna::text, true);
  v_d := public.open_resale_dispute(v_ord.id, 'invalid', 'Pri vstupe ma nepustili.');
  assert v_d.status = 'open', 'spor sa neotvoril';

  select order_status into v_ord.order_status from public.resale_orders where id = v_ord.id;
  assert v_ord.order_status = 'disputed', 'objednávka nie je v spore';

  -- Otvorený spor zadrží peniaze aj po evente.
  reset role;
  update public.events
  set start_at = now() - interval '4 hours', end_at = now() - interval '1 hour'
  where id = v_event;
  v_settled := public.settle_resale_orders(100);
  assert v_settled = 0, 'otvorený spor peniaze nezadržal';

  -- Admin má podklady.
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  select count(*) into v_seen from public.swap_admin_disputes('open', 50);
  assert v_seen = 1, format('admin má vidieť 1 spor, vidí %s', v_seen);

  -- A rozhodne v prospech kupujúcej.
  v_out := public.resolve_resale_dispute(v_d.id, 'refunded', null, 'Vstupenka neprešla.');
  assert (v_out->>'refund_cents')::integer = v_ord.total_cents,
    format('vrátiť sa má %s, vracia sa %s', v_ord.total_cents, v_out->>'refund_cents');

  -- Druhé rozhodnutie nesmie vrátiť peniaze druhýkrát.
  v_out := public.resolve_resale_dispute(v_d.id, 'refunded', null, null);
  assert (v_out->>'already_resolved')::boolean,
    'DVOJITÁ REFUNDÁCIA: spor sa dal rozhodnúť dvakrát';

  -- Boris má v knihe mínus a nedostane za to nič.
  reset role;
  select count(*) into v_seen from public.seller_ledger_entries
  where seller_id = v_boris and type = 'refund';
  assert v_seen = 1, 'vrátená suma sa predajcovi nestrhla';

  raise notice 'PASS C: spor zadrží peniaze, admin rozhodne a dvakrát to nejde';
end $$;

-- ============================================================================
-- SCENÁR D — desatina patrí platforme a predajcovi sedí zvyšok
-- ============================================================================
-- Provízia sa rátala v dvoch krokoch a na dvoch miestach: v objednávke pri
-- predaji a v knihe pri zaúčtovaní. Práve medzi nimi sa raz stratila (strhla
-- sa dvakrát) a nikto by si toho nevšimol, kým by sa niekto nesťažoval.
--
-- Tento blok preto neporovnáva kód s kódom, ale súčet knihy s tým, čo má
-- podľa sadzby vyjsť — na cent, pre niekoľko cien vrátane tých, kde delenie
-- nevychádza presne.
do $$
declare
  v_anna  uuid := 'a5858585-0000-0000-0000-000000000002';
  v_boris uuid := 'a5858585-0000-0000-0000-000000000003';
  v_event uuid := 'e5858585-0000-0000-0000-000000000001';
  v_bps   integer;
  v_price integer;
  v_listing public.resale_listings;
  v_res   public.resale_reservations;
  v_ord   public.resale_orders;
  v_fee   integer;
  v_book  integer;
begin
  select resale_seller_fee_bps into v_bps from public.platform_settings where id;
  assert v_bps = 1000, format('provízia má byť 10 %%, je %s bps', v_bps);

  -- Ceny zámerne aj také, kde desatina nevyjde na celý cent.
  foreach v_price in array array[1000, 3333, 4999, 12345]
  loop
    reset role;
    update public.events
    set start_at = now() + interval '5 days', end_at = now() + interval '5 days 3 hours'
    where id = v_event;

    set local role authenticated;
    perform set_config('request.jwt.claim.sub', v_boris::text, true);
    v_listing := public.create_resale_listing(
      v_event, 'external', v_price, null,
      p_delivery_method => 'file', p_external_provider => 'Test'
    );

    perform set_config('request.jwt.claim.sub', v_anna::text, true);
    v_res := public.reserve_resale_listing(v_listing.id, 1);
    v_ord := public.create_resale_order(v_res.id);

    v_fee := (v_price * v_bps) / 10000;

    -- Kupujúci platí presne cenu z ponuky.
    assert v_ord.total_cents = v_price,
      format('pri %s má kupujúci platiť %s, platí %s', v_price, v_price, v_ord.total_cents);
    assert v_ord.buyer_fee_cents = 0, 'kupujúcemu sa niečo pripočítalo';

    -- A platforme patrí presne desatina.
    assert v_ord.seller_fee_cents = v_fee,
      format('pri %s má provízia byť %s, je %s', v_price, v_fee, v_ord.seller_fee_cents);
    assert v_ord.seller_net_cents = v_price - v_fee,
      format('pri %s má predajcovi zostať %s, zostáva %s',
             v_price, v_price - v_fee, v_ord.seller_net_cents);

    -- Zaplatí (toto robí webhook), doručí, potvrdí, event prebehne.
    reset role;
    v_ord := public.mark_resale_order_paid(v_ord.id, 'pi_fee_' || v_price::text);

    set local role authenticated;
    perform set_config('request.jwt.claim.sub', v_boris::text, true);
    perform public.deliver_resale_ticket(v_ord.id, null, 'poslané');
    perform set_config('request.jwt.claim.sub', v_anna::text, true);
    perform public.confirm_resale_ticket(v_ord.id);

    reset role;
    update public.events
    set start_at = now() - interval '4 hours', end_at = now() - interval '1 hour'
    where id = v_event;
    perform public.settle_resale_orders(100);

    -- A TOTO je ten test: súčet knihy pre túto objednávku sa musí rovnať
    -- tomu, čo je v objednávke. Keď sa provízia strhne dvakrát, nesedí to.
    select coalesce(sum(amount_cents), 0) into v_book
    from public.seller_ledger_entries
    where resale_order_id = v_ord.id;

    assert v_book = v_ord.seller_net_cents,
      format('pri %s hovorí objednávka %s, ale kniha %s',
             v_price, v_ord.seller_net_cents, v_book);
  end loop;

  raise notice 'PASS D: platforme patrí desatina a kniha sedí s objednávkou na cent';
end $$;

rollback;
