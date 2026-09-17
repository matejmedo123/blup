-- ============================================================================
-- BLUP test 32 · The sales screen, and who is allowed to see it
-- ============================================================================
-- Two things to prove. That the numbers are the numbers — a refund is not a
-- sale, a comp is not revenue, a failed payment is not a ticket — and that
-- every one of these functions is scoped to the caller's own events, because
-- between them they expose names, addresses and takings.
\set ON_ERROR_STOP on

begin;

insert into auth.users (id, email) values
  ('22222222-2222-2222-2222-222222222222', 'organizer@blup.test'),
  ('33333333-3333-3333-3333-333333333333', 'stranger@blup.test'),
  ('44444444-4444-4444-4444-444444444444', 'kupujuci@blup.test');

update public.profiles set city = 'Nitra', latitude = 48.3069, longitude = 18.0864
where id = '44444444-4444-4444-4444-444444444444';

insert into public.organizations (id, slug, name, created_by, verification_status)
values ('bbbbbbb1-0000-0000-0000-000000000001', 'nova', 'Nova Collective',
        '22222222-2222-2222-2222-222222222222', 'verified');

insert into public.organization_members (organization_id, user_id, role)
values ('bbbbbbb1-0000-0000-0000-000000000001',
        '22222222-2222-2222-2222-222222222222', 'owner')
on conflict do nothing;

-- Two events, so "across all of them" means something.
insert into public.events (id, creator_id, organization_id, title, category,
                           latitude, longitude, start_at, end_at, is_free, price_cents)
values
  ('aaaaaaa1-0000-0000-0000-0000000000b1', '22222222-2222-2222-2222-222222222222',
   'bbbbbbb1-0000-0000-0000-000000000001', 'Nova Warehouse', 'techno',
   48.1550, 17.1200, now() + interval '10 days', now() + interval '10 days 6 hours', false, 2500),
  ('aaaaaaa1-0000-0000-0000-0000000000b2', '22222222-2222-2222-2222-222222222222',
   'bbbbbbb1-0000-0000-0000-000000000001', 'Nova Open Air', 'techno',
   48.1550, 17.1200, now() + interval '40 days', now() + interval '40 days 8 hours', false, 4000);

insert into public.ticket_types (id, event_id, name, price_cents, currency, quantity_total, max_per_order)
values
  ('ccccccc1-0000-0000-0000-0000000000c1', 'aaaaaaa1-0000-0000-0000-0000000000b1',
   'Standard', 2500, 'EUR', 100, 10),
  ('ccccccc1-0000-0000-0000-0000000000c2', 'aaaaaaa1-0000-0000-0000-0000000000b1',
   'VIP', 6000, 'EUR', 10, 4),
  ('ccccccc1-0000-0000-0000-0000000000c3', 'aaaaaaa1-0000-0000-0000-0000000000b2',
   'Early bird', 4000, 'EUR', 50, 10);

-- Three paid orders, one guest and two accounts, plus one that never got paid.
do $$
declare o public.orders;
begin
  o := public.create_order(
    p_buyer_id => '44444444-4444-4444-4444-444444444444',
    p_ticket_type_id => 'ccccccc1-0000-0000-0000-0000000000c1', p_quantity => 2);
  perform public.fulfill_order(o.id, 'stripe'::payment_provider, 'pi_1', o.total_cents);

  o := public.create_order(
    p_buyer_id => null, p_ticket_type_id => 'ccccccc1-0000-0000-0000-0000000000c2',
    p_quantity => 1, p_guest_email => 'host@example.com', p_guest_name => 'Jana Hosťová',
    p_buyer_city => 'Bratislava', p_buyer_latitude => 48.1486, p_buyer_longitude => 17.1077);
  perform public.fulfill_order(o.id, 'stripe'::payment_provider, 'pi_2', o.total_cents);

  o := public.create_order(
    p_buyer_id => '44444444-4444-4444-4444-444444444444',
    p_ticket_type_id => 'ccccccc1-0000-0000-0000-0000000000c3', p_quantity => 1);
  perform public.fulfill_order(o.id, 'stripe'::payment_provider, 'pi_3', o.total_cents);

  -- Started and walked away. Nothing fulfils it.
  perform public.create_order(
    p_buyer_id => null, p_ticket_type_id => 'ccccccc1-0000-0000-0000-0000000000c1',
    p_quantity => 3, p_guest_email => 'odisiel@example.com', p_buyer_city => 'Košice');
end $$;

-- --- the tiles ---------------------------------------------------------------
do $$
declare t jsonb;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);

  select public.sales_totals() into t;

  assert (t ->> 'events')::int = 2, format('two events, got %s', t ->> 'events');
  assert (t ->> 'orders_paid')::int = 3, format('three paid orders, got %s', t ->> 'orders_paid');
  assert (t ->> 'tickets')::int = 4, format('four tickets sold, got %s', t ->> 'tickets');

  -- 2×2500 + 1×6000 + 1×4000
  assert (t ->> 'gross_cents')::int = 15000, format('gross %s', t ->> 'gross_cents');
  assert (t ->> 'organizer_net_cents')::int > 0
     and (t ->> 'organizer_net_cents')::int < 15000,
    format('the organizer keeps less than the shelf price and more than nothing, got %s',
           t ->> 'organizer_net_cents');
  assert (t ->> 'commission_cents')::int > 0, 'the commission is counted';
  assert (t ->> 'tickets_valid')::int = 4, format('four valid tickets, got %s', t ->> 'tickets_valid');
  assert (t ->> 'checked_in_pct')::numeric = 0, 'nobody has been scanned yet';

  reset role;
  raise notice 'PASS the tiles add up to what was actually sold';
end $$;

-- --- a refund is not a sale --------------------------------------------------
do $$
declare
  before_gross int;
  after_gross  int;
  o            public.orders;
  t            jsonb;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
  select (public.sales_totals() ->> 'gross_cents')::int into before_gross;
  reset role;

  select * into o from public.orders where provider_reference = 'pi_1';
  perform public.refund_order(o.id, 'test');

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
  select public.sales_totals() into t;
  after_gross := (t ->> 'gross_cents')::int;

  assert after_gross = before_gross - 5000,
    format('a refunded order leaves the takings: %s -> %s', before_gross, after_gross);
  assert (t ->> 'refunded_orders')::int = 1, 'and is counted as a refund';
  assert (t ->> 'refunded_cents')::int > 0, 'with its amount';

  reset role;
  raise notice 'PASS a refund comes out of the takings and shows as a refund';
end $$;

-- --- per event, per ticket type ----------------------------------------------
do $$
declare
  r     record;
  seen  int := 0;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);

  for r in select * from public.sales_by_event() loop
    seen := seen + 1;
    if r.title = 'Nova Open Air' then
      assert r.tickets = 1, format('open air sold one, got %s', r.tickets);
      assert r.gross_cents = 4000, format('open air took 4000, got %s', r.gross_cents);
    end if;
  end loop;
  assert seen = 2, format('both events listed, got %s', seen);

  select * into r from public.sales_by_ticket_type() where name = 'VIP';
  assert r.sold = 1, format('one VIP sold, got %s', r.sold);
  assert r.remaining = 9, format('nine VIP left, got %s', r.remaining);

  reset role;
  raise notice 'PASS the per-event and per-type rows match the orders';
end $$;

-- --- how they paid, and where they are from ----------------------------------
do $$
declare
  guest_row   record;
  city_row    record;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);

  select * into guest_row from public.sales_by_method() where method = 'Karta (bez účtu)';
  assert guest_row.orders = 1, format('one purchase without an account, got %s', guest_row.orders);

  select * into city_row from public.sales_by_city() where city = 'Bratislava';
  assert city_row.tickets = 1, format('one ticket to Bratislava, got %s', city_row.tickets);
  assert city_row.latitude is not null, 'and a point for the map';

  -- The refunded order's town is gone from the map with it.
  assert not exists (select 1 from public.sales_by_city() where city = 'Nitra' and tickets > 1),
    'a refunded order does not keep its dot';

  reset role;
  raise notice 'PASS the method and the town come from the orders themselves';
end $$;

-- --- the funnel --------------------------------------------------------------
do $$
declare f jsonb;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);

  select public.checkout_funnel() into f;

  assert (f ->> 'started')::int = 4, format('four orders were started, got %s', f ->> 'started');
  assert (f ->> 'paid')::int = 3, format('three were paid, got %s', f ->> 'paid');
  assert (f ->> 'abandoned')::int = 1, format('one was abandoned, got %s', f ->> 'abandoned');
  assert (f ->> 'success_pct')::numeric = 75.0, format('75 %%, got %s', f ->> 'success_pct');
  assert (f ->> 'abandoned_cents')::int > 0, 'and it was worth something';

  reset role;
  raise notice 'PASS the funnel counts who started and who finished';
end $$;

-- --- and none of it belongs to anybody else ----------------------------------
do $$
declare n int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', true);

  assert (public.sales_totals() ->> 'events')::int = 0, 'a stranger owns no events here';
  assert (public.sales_totals() ->> 'gross_cents')::int = 0, 'and sees no takings';
  assert (public.checkout_funnel() ->> 'started')::int = 0, 'nor anybody else''s funnel';

  select count(*) into n from public.sales_by_event();
  assert n = 0, format('and no rows, got %s', n);
  select count(*) into n from public.sales_by_ticket_type();
  assert n = 0, 'nor ticket types';
  select count(*) into n from public.sales_rows();
  assert n = 0, 'nor the buyers'' names and addresses';

  -- Asking for a specific event id must not widen anything either.
  select count(*) into n from public.sales_by_event(array['aaaaaaa1-0000-0000-0000-0000000000b1']::uuid[]);
  assert n = 0, 'naming the event does not grant access to it';

  reset role;
  raise notice 'PASS naming somebody else''s event id grants nothing';
end $$;

-- --- the export is the same numbers ------------------------------------------
do $$
declare
  rows_n int;
  sum_gross bigint;
  tiles_gross bigint;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);

  select count(*), coalesce(sum(gross_cents), 0) into rows_n, sum_gross from public.sales_rows();
  select (public.sales_totals() ->> 'gross_cents')::bigint into tiles_gross;

  assert rows_n = 2, format('two paid orders left after the refund, got %s', rows_n);
  assert sum_gross = tiles_gross,
    format('the export must equal the tiles: %s vs %s', sum_gross, tiles_gross);

  reset role;
  raise notice 'PASS the export and the tiles cannot disagree';
end $$;

rollback;
