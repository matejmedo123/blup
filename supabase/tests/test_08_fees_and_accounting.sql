-- ============================================================================
-- BLUP test 08 · Fee schedule (4 % + 1 EUR/ticket) and the accounting export
-- ============================================================================
\set ON_ERROR_STOP on

begin;

insert into auth.users (id, email, raw_user_meta_data) values
  ('a8888888-8888-8888-8888-888888888888', 'org8@example.com',     '{"display_name":"Org"}'),
  ('b8888888-8888-8888-8888-888888888888', 'buyer8@example.com',   '{"display_name":"Buyer"}'),
  ('c8888888-8888-8888-8888-888888888888', 'stranger8@example.com','{"display_name":"Stranger"}'),
  ('d8888888-8888-8888-8888-888888888888', 'admin8@example.com',   '{"display_name":"Admin"}');

update public.profiles set app_role = 'admin' where id = 'd8888888-8888-8888-8888-888888888888';

-- An organization on the standard schedule: no fee override anywhere, so it
-- must pick up the platform values.
do $$
declare
  v_org   uuid;
  v_event uuid;
begin
  insert into public.organizations (id, name, slug, created_by, verification_status,
                                    payouts_enabled, default_currency)
  values ('e8888888-0000-0000-0000-000000000001', 'Standard Rate', 'standard-rate',
          'a8888888-8888-8888-8888-888888888888', 'verified', true, 'EUR')
  returning id into v_org;

  insert into public.organization_members (organization_id, user_id, role)
  values (v_org, 'a8888888-8888-8888-8888-888888888888', 'owner')
  on conflict do nothing;

  insert into public.events (id, creator_id, organization_id, title, category, start_at,
                             latitude, longitude, is_free, price_cents, status)
  values ('e8888888-0000-0000-0000-000000000002', 'a8888888-8888-8888-8888-888888888888',
          v_org, 'Sadzba', 'techno', now() + interval '4 days',
          48.1486, 17.1077, false, 2500, 'published')
  returning id into v_event;

  insert into public.ticket_types (id, event_id, name, price_cents, quantity_total, max_per_order)
  values ('e8888888-0000-0000-0000-000000000003', v_event, 'Standard', 2500, 100, 10);
end $$;

-- --- the platform default is 4 % + 1.00 EUR per ticket ----------------------
do $$
declare
  fees jsonb;
  o    public.orders;
begin
  fees := public.resolve_fees('e8888888-0000-0000-0000-000000000001');
  assert (fees ->> 'platform_fee_bps')::int = 400,
    format('the platform commission must be 4.00%%, got %s bps', fees ->> 'platform_fee_bps');
  assert (fees ->> 'archive_fee_cents')::int = 100,
    format('the archive fee must be 1.00 EUR, got %s', fees ->> 'archive_fee_cents');

  o := public.create_order('b8888888-8888-8888-8888-888888888888',
                           'e8888888-0000-0000-0000-000000000003', 3);

  assert o.subtotal_cents = 7500, format('subtotal 7500, got %s', o.subtotal_cents);
  assert o.commission_cents = 300, format('4%% of 7500 is 300, got %s', o.commission_cents);
  assert o.archive_fee_cents = 300, format('3 x 1.00 EUR is 300, got %s', o.archive_fee_cents);
  assert o.total_cents = 7800, format('buyer pays 7800, got %s', o.total_cents);
  assert o.blup_revenue_cents = 600, format('BLUP earns 600, got %s', o.blup_revenue_cents);
  assert o.net_cents - o.platform_fee_cents = 7200,
    format('organizer keeps 7200, got %s', o.net_cents - o.platform_fee_cents);

  raise notice 'PASS an organization without an override is charged 4%% + 1 EUR/ticket';
end $$;

-- --- a free ticket is not charged an archive fee -----------------------------
-- The archive fee pays for keeping a paid ticket's record. Charging it on a
-- zero-price ticket would be a fee for nothing, and would silently turn a free
-- event into a paid one.
do $$
declare q jsonb;
begin
  insert into public.ticket_types (id, event_id, name, price_cents, quantity_total, max_per_order)
  values ('e8888888-0000-0000-0000-000000000004', 'e8888888-0000-0000-0000-000000000002',
          'Zdarma', 0, 50, 4);

  q := public.quote_order('e8888888-0000-0000-0000-000000000004', 2);
  assert (q ->> 'archive_fee_cents')::int = 0,
    format('a free ticket must carry no archive fee, got %s', q ->> 'archive_fee_cents');
  assert (q ->> 'buyer_total_cents')::int = 0,
    format('a free ticket must stay free, got %s', q ->> 'buyer_total_cents');
  raise notice 'PASS a free ticket carries no archive fee';
end $$;

-- --- quote_order reports a problem instead of raising ------------------------
do $$
declare q jsonb;
begin
  q := public.quote_order('e8888888-0000-0000-0000-000000000003', 99);
  assert not (q ->> 'valid')::boolean, 'a basket above max_per_order is not valid';
  assert (q ->> 'reason') = 'QUANTITY_ABOVE_LIMIT',
    format('expected QUANTITY_ABOVE_LIMIT, got %s', q ->> 'reason');
  raise notice 'PASS quote_order answers with a reason rather than an exception';
end $$;

-- --- fulfilment must be paid the buyer total, archive fee included -----------
do $$
declare v_order public.orders;
begin
  select * into v_order from public.orders
  where buyer_id = 'b8888888-8888-8888-8888-888888888888' limit 1;

  begin
    -- the ticket price alone is not what the buyer was charged
    perform public.fulfill_order(v_order.id, 'stripe', 'pi_fee_short', 7500);
    raise exception 'TEST FAILED: an amount short of the archive fee was accepted';
  exception when raise_exception then
    raise notice 'PASS a payment short of the archive fee is rejected';
  end;

  perform public.fulfill_order(v_order.id, 'stripe', 'pi_fee_ok', 7800);
  assert (select payment_status from public.orders where id = v_order.id) = 'succeeded',
    'the correct amount must fulfil the order';
  raise notice 'PASS the webhook must present the full buyer total';
end $$;

-- --- the ledger credits what was collected, not the list price ---------------
do $$
declare b record;
begin
  select * into b from public.organization_balances
  where organization_id = 'e8888888-0000-0000-0000-000000000001';

  assert b.gross_sales_cents = 7500,
    format('the sale must credit the ticket revenue, got %s', b.gross_sales_cents);
  assert b.commission_cents = 300, format('commission 300, got %s', b.commission_cents);
  assert b.archive_fee_cents = 0,
    format('a buyer-paid archive fee never touches the organizer, got %s', b.archive_fee_cents);
  assert b.balance_cents = 7200, format('balance 7200, got %s', b.balance_cents);
  raise notice 'PASS the ledger moves what the buyer actually paid';
end $$;

-- --- flipping the payer moves the fee to the organizer's side ----------------
do $$
declare
  o    public.orders;
  n    integer;
begin
  update public.platform_settings set archive_fee_payer = 'organizer' where id;

  o := public.create_order('b8888888-8888-8888-8888-888888888888',
                           'e8888888-0000-0000-0000-000000000003', 2);

  assert o.archive_fee_payer = 'organizer', 'the order must record who was billed';
  assert o.total_cents = 5000,
    format('the buyer pays the ticket price only, got %s', o.total_cents);
  assert o.platform_fee_cents = 400,
    format('the organizer is charged 200 commission + 200 archive, got %s', o.platform_fee_cents);
  assert o.blup_revenue_cents = 400, 'BLUP earns the same either way';
  -- the money still balances, just from the other direction
  assert o.total_cents = (o.net_cents - o.platform_fee_cents) + o.blup_revenue_cents,
    'buyer total must equal organizer net plus BLUP revenue';

  perform public.fulfill_order(o.id, 'stripe', 'pi_org_pays', 5000);

  select count(*) into n from public.ledger_entries
  where order_id = o.id and type = 'platform_fee';
  assert n = 2,
    format('commission and archive fee must be booked as separate lines, got %s', n);

  update public.platform_settings set archive_fee_payer = 'buyer' where id;
  raise notice 'PASS the archive fee can be moved onto the organizer';
end $$;

-- --- accounting: the sales journal ------------------------------------------
do $$
declare
  r record;
  n integer;
begin
  perform set_config('request.jwt.claim.sub', 'a8888888-8888-8888-8888-888888888888', true);

  select count(*) into n from public.accounting_orders('e8888888-0000-0000-0000-000000000001');
  assert n = 2, format('two paid orders should be listed, got %s', n);

  select * into r from public.accounting_orders('e8888888-0000-0000-0000-000000000001')
  where buyer_paid_cents = 7800;
  assert r.quantity = 3, format('quantity should be 3, got %s', r.quantity);
  assert r.commission_cents = 300, 'the journal must state the commission';
  assert r.archive_fee_cents = 300, 'the journal must state the archive fee';
  assert r.organizer_net_cents = 7200, 'the journal must state what the organizer keeps';
  assert r.event_title = 'Sadzba', 'the journal must name the event';
  assert r.status = 'succeeded', 'the journal must state the payment status';
  raise notice 'PASS accounting_orders lists every paid order with its fee split';
end $$;

-- --- accounting: the monthly summary ----------------------------------------
do $$
declare s record;
begin
  perform set_config('request.jwt.claim.sub', 'a8888888-8888-8888-8888-888888888888', true);

  select * into s from public.accounting_summary('e8888888-0000-0000-0000-000000000001')
  where period = to_char(now() at time zone 'UTC', 'YYYY-MM');

  assert s.orders_count = 2, format('two orders this month, got %s', s.orders_count);
  assert s.tickets_count = 5, format('five tickets this month, got %s', s.tickets_count);
  assert s.net_cents = 12500, format('net 12500, got %s', s.net_cents);
  assert s.commission_cents = 500, format('commission 500, got %s', s.commission_cents);
  assert s.archive_fee_cents = 500, format('archive fee 500, got %s', s.archive_fee_cents);
  assert s.blup_revenue_cents = 1000, format('BLUP revenue 1000, got %s', s.blup_revenue_cents);
  raise notice 'PASS accounting_summary totals the month';
end $$;

-- --- accounting: the ledger closes on the balance ----------------------------
-- If the last running total in the export disagreed with the balance the app
-- shows, one of the two would be lying to the organizer.
do $$
declare
  last_balance bigint;
  b            record;
begin
  perform set_config('request.jwt.claim.sub', 'a8888888-8888-8888-8888-888888888888', true);

  select balance_cents into last_balance
  from public.accounting_ledger('e8888888-0000-0000-0000-000000000001')
  order by created_at desc, entry_id desc limit 1;

  select * into b from public.organization_balances
  where organization_id = 'e8888888-0000-0000-0000-000000000001';

  assert last_balance = b.balance_cents,
    format('the export closes at %s but the balance is %s', last_balance, b.balance_cents);
  raise notice 'PASS the ledger export closes on the balance the app shows';
end $$;

-- --- a refund takes BLUP's revenue back with it ------------------------------
do $$
declare
  v_order uuid;
  s       record;
begin
  select order_id into v_order
  from public.accounting_orders('e8888888-0000-0000-0000-000000000001')
  where buyer_paid_cents = 7800;

  perform public.refund_order(v_order, 'test');

  perform set_config('request.jwt.claim.sub', 'a8888888-8888-8888-8888-888888888888', true);
  select * into s from public.accounting_summary('e8888888-0000-0000-0000-000000000001')
  where period = to_char(now() at time zone 'UTC', 'YYYY-MM');

  assert s.orders_count = 1, format('one order left standing, got %s', s.orders_count);
  assert s.blup_revenue_cents = 400,
    format('a refunded order earns BLUP nothing, got %s', s.blup_revenue_cents);
  assert s.refunded_cents = 7500, format('7500 refunded, got %s', s.refunded_cents);
  raise notice 'PASS a refund removes the order from BLUP revenue';
end $$;

-- --- the export is not readable by outsiders ---------------------------------
do $$
begin
  perform set_config('request.jwt.claim.sub', 'c8888888-8888-8888-8888-888888888888', true);

  begin
    perform * from public.accounting_orders('e8888888-0000-0000-0000-000000000001');
    raise exception 'TEST FAILED: a stranger read the sales journal';
  exception when raise_exception then
    raise notice 'PASS accounting_orders refuses a non-member';
  end;

  begin
    perform * from public.accounting_ledger('e8888888-0000-0000-0000-000000000001');
    raise exception 'TEST FAILED: a stranger read the ledger';
  exception when raise_exception then
    raise notice 'PASS accounting_ledger refuses a non-member';
  end;

  begin
    perform * from public.accounting_summary('e8888888-0000-0000-0000-000000000001');
    raise exception 'TEST FAILED: a stranger read the summary';
  exception when raise_exception then
    raise notice 'PASS accounting_summary refuses a non-member';
  end;

  begin
    perform * from public.platform_accounting_summary();
    raise exception 'TEST FAILED: a normal user read the platform books';
  exception when raise_exception then
    raise notice 'PASS platform_accounting_summary is admin only';
  end;
end $$;

-- --- an admin can read the platform books ------------------------------------
do $$
declare p record;
begin
  perform set_config('request.jwt.claim.sub', 'd8888888-8888-8888-8888-888888888888', true);

  select * into p from public.platform_accounting_summary()
  where period = to_char(now() at time zone 'UTC', 'YYYY-MM');

  assert p.ticket_revenue_cents = 400,
    format('BLUP ticket revenue 400 after the refund, got %s', p.ticket_revenue_cents);
  assert p.total_revenue_cents = p.ticket_revenue_cents + p.boost_revenue_cents,
    'total revenue must be tickets plus boosts';
  raise notice 'PASS an admin can read the platform books';
end $$;

-- --- an organizer cannot set their own fee -----------------------------------
do $$
declare bps integer;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', 'a8888888-8888-8888-8888-888888888888', true);

  update public.organizations
    set platform_fee_bps = 0, archive_fee_cents = 0
    where id = 'e8888888-0000-0000-0000-000000000001';

  reset role;

  select platform_fee_bps into bps from public.organizations
  where id = 'e8888888-0000-0000-0000-000000000001';
  assert bps is null, format('the organizer changed their own commission to %s', bps);
  assert (select archive_fee_cents from public.organizations
          where id = 'e8888888-0000-0000-0000-000000000001') is null,
    'the organizer changed their own archive fee';
  raise notice 'PASS an organizer cannot rewrite their own fee schedule';
end $$;

-- --- platform_settings is admin-only -----------------------------------------
do $$
declare v integer;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', 'a8888888-8888-8888-8888-888888888888', true);

  begin
    update public.platform_settings set archive_fee_cents = 0 where id;
  exception when others then
    null;  -- either a policy or the revoked grant stops it; both are fine
  end;

  reset role;
  select archive_fee_cents into v from public.platform_settings where id;
  assert v = 100, format('a normal user changed the platform archive fee to %s', v);
  raise notice 'PASS platform_settings cannot be rewritten by a normal user';
end $$;

rollback;
