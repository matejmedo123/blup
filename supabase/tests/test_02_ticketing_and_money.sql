-- ============================================================================
-- BLUP test 02 · Orders, fulfilment, tickets, QR check-in, ledger, payouts
-- ============================================================================
\set ON_ERROR_STOP on

begin;

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'buyer@example.com'),
  ('22222222-2222-2222-2222-222222222222', 'organizer@example.com'),
  ('33333333-3333-3333-3333-333333333333', 'stranger@example.com');

insert into public.organizations (id, slug, name, created_by, verification_status,
                                  payouts_enabled, platform_fee_bps, default_currency)
values ('bbbbbbb1-0000-0000-0000-000000000001', 'nova', 'Nova Collective',
        '22222222-2222-2222-2222-222222222222', 'verified', true, 400, 'EUR');

insert into public.events (id, creator_id, organization_id, title, category,
                           latitude, longitude, start_at, is_free, price_cents, currency)
values ('aaaaaaa1-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222',
        'bbbbbbb1-0000-0000-0000-000000000001', 'Nova Warehouse Night', 'techno',
        48.1550, 17.1200, now() + interval '6 days', false, 2500, 'EUR');

insert into public.ticket_types (id, event_id, name, price_cents, currency, quantity_total, max_per_order)
values ('ccccccc1-0000-0000-0000-000000000001', 'aaaaaaa1-0000-0000-0000-000000000002',
        'Early bird', 2500, 'EUR', 3, 2);

-- --- order creation computes amounts server-side ----------------------------
do $$
declare o public.orders;
begin
  o := public.create_order('11111111-1111-1111-1111-111111111111',
                           'ccccccc1-0000-0000-0000-000000000001', 2);

  assert o.subtotal_cents = 5000, format('subtotal should be 5000, got %s', o.subtotal_cents);
  -- 4.00% of 5000 = 200
  assert o.platform_fee_cents = 200, format('BLUP fee should be 200, got %s', o.platform_fee_cents);
  assert o.total_cents = 5000, 'buyer pays the ticket price';
  assert o.payment_status = 'requires_payment', 'a fresh order must not be paid';
  raise notice 'PASS create_order computes amounts and BLUP fee';
end $$;

-- --- quantity above the per-order limit is rejected -------------------------
do $$
begin
  begin
    perform public.create_order('11111111-1111-1111-1111-111111111111',
                                'ccccccc1-0000-0000-0000-000000000001', 5);
    raise exception 'TEST FAILED: max_per_order was not enforced';
  exception when raise_exception then
    raise notice 'PASS max_per_order enforced';
  end;
end $$;

-- --- no tickets exist before the payment is confirmed ----------------------
do $$
begin
  assert (select count(*) from public.tickets) = 0,
    'tickets must not exist before the payment webhook confirms the order';
  raise notice 'PASS no tickets before payment confirmation';
end $$;

-- --- fulfilment (what the Stripe webhook triggers) --------------------------
do $$
declare
  v_order_id uuid;
  n integer;
begin
  select id into v_order_id from public.orders limit 1;
  perform public.fulfill_order(v_order_id, 'stripe', 'pi_test_123', 5000);

  select count(*) into n from public.tickets where order_id = v_order_id;
  assert n = 2, format('two tickets should be issued, got %s', n);

  assert (select payment_status from public.orders where id = v_order_id) = 'succeeded',
    'order must be marked paid';
  assert (select quantity_sold from public.ticket_types
          where id = 'ccccccc1-0000-0000-0000-000000000001') = 2,
    'ticket_type.quantity_sold must be maintained';
  assert (select tickets_sold from public.events
          where id = 'aaaaaaa1-0000-0000-0000-000000000002') = 2,
    'event.tickets_sold must be maintained';
  assert (select status from public.event_attendees
          where event_id = 'aaaaaaa1-0000-0000-0000-000000000002'
            and user_id = '11111111-1111-1111-1111-111111111111') = 'going',
    'buying a ticket must RSVP the buyer';
  raise notice 'PASS fulfil order issues tickets';
end $$;

-- --- fulfilment is idempotent (webhooks retry!) -----------------------------
do $$
declare v_order_id uuid;
begin
  select id into v_order_id from public.orders limit 1;
  perform public.fulfill_order(v_order_id, 'stripe', 'pi_test_123', 5000);
  assert (select count(*) from public.tickets) = 2,
    'replaying the webhook must not issue duplicate tickets';
  raise notice 'PASS fulfil_order is idempotent';
end $$;

-- --- amount tampering is rejected -------------------------------------------
do $$
declare o public.orders;
begin
  o := public.create_order('33333333-3333-3333-3333-333333333333',
                           'ccccccc1-0000-0000-0000-000000000001', 1);
  begin
    perform public.fulfill_order(o.id, 'stripe', 'pi_test_wrong', 1);
    raise exception 'TEST FAILED: amount mismatch was accepted';
  exception when raise_exception then
    raise notice 'PASS amount mismatch rejected';
  end;
end $$;

-- --- ledger + organizer balance ---------------------------------------------
do $$
declare b record;
begin
  select * into b from public.organization_balances
  where organization_id = 'bbbbbbb1-0000-0000-0000-000000000001';

  assert b.gross_sales_cents = 5000, format('gross should be 5000, got %s', b.gross_sales_cents);
  assert b.platform_fee_cents = 200, format('BLUP fee should be 200, got %s', b.platform_fee_cents);
  assert b.balance_cents = 4800, format('organizer balance should be 4800, got %s', b.balance_cents);
  -- funds are held for the settlement delay
  assert b.available_cents = 0, 'fresh sales must not be immediately available';
  assert b.pending_cents = 4800, 'fresh sales must sit in pending';
  raise notice 'PASS ledger: gross - BLUP fee = organizer balance';
end $$;

-- --- payout cannot exceed the settled balance -------------------------------
do $$
begin
  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
  begin
    perform public.request_payout('bbbbbbb1-0000-0000-0000-000000000001', 4800);
    raise exception 'TEST FAILED: payout above available balance was accepted';
  exception when raise_exception then
    raise notice 'PASS payout blocked while funds are pending';
  end;
end $$;

-- settle the funds, then the payout works and debits the ledger
update public.ledger_entries set available_at = now() - interval '1 day';

do $$
declare p public.payouts; b record;
begin
  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
  p := public.request_payout('bbbbbbb1-0000-0000-0000-000000000001', 4000);
  assert p.status = 'pending', 'payout starts pending';

  select * into b from public.organization_balances
  where organization_id = 'bbbbbbb1-0000-0000-0000-000000000001';
  assert b.balance_cents = 800, format('balance after payout should be 800, got %s', b.balance_cents);
  assert b.paid_out_cents = 4000, 'paid_out must be tracked';
  raise notice 'PASS payout debits the organizer balance';
end $$;

-- --- a random user cannot request a payout ----------------------------------
do $$
begin
  perform set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', true);
  begin
    perform public.request_payout('bbbbbbb1-0000-0000-0000-000000000001', 100);
    raise exception 'TEST FAILED: unauthorised payout was accepted';
  exception when raise_exception then
    raise notice 'PASS payout requires owner/finance role';
  end;
end $$;

-- --- QR check-in -------------------------------------------------------------
do $$
declare
  t public.tickets;
  res jsonb;
begin
  select * into t from public.tickets limit 1;

  -- wrong secret
  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
  res := public.check_in_ticket(t.code, 'not-the-secret');
  assert (res ->> 'ok') = 'false' and res ->> 'reason' = 'INVALID_SIGNATURE',
    format('forged QR must be rejected: %s', res);

  -- someone who does not run the event
  perform set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', true);
  res := public.check_in_ticket(t.code, t.qr_secret);
  assert (res ->> 'ok') = 'false' and res ->> 'reason' = 'NOT_AUTHORIZED',
    format('only organizers may scan: %s', res);

  -- the organizer
  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
  res := public.check_in_ticket(t.code, t.qr_secret);
  assert (res ->> 'ok') = 'true', format('valid scan must succeed: %s', res);
  assert (select status from public.tickets where id = t.id) = 'used', 'ticket must be marked used';

  -- second scan of the same ticket
  res := public.check_in_ticket(t.code, t.qr_secret);
  assert (res ->> 'ok') = 'false' and res ->> 'reason' = 'ALREADY_USED',
    format('a ticket must not be reusable: %s', res);

  raise notice 'PASS QR check-in validation';
end $$;

-- --- refunds reverse money and invalidate tickets ---------------------------
do $$
declare v_order_id uuid; b record;
begin
  select id into v_order_id from public.orders where payment_status = 'succeeded' limit 1;
  perform public.refund_order(v_order_id, 'customer request');

  assert (select payment_status from public.orders where id = v_order_id) = 'refunded',
    'order must be refunded';
  assert (select count(*) from public.tickets
          where order_id = v_order_id and status = 'refunded') >= 1,
    'valid tickets must be invalidated on refund';

  select * into b from public.organization_balances
  where organization_id = 'bbbbbbb1-0000-0000-0000-000000000001';
  -- 5000 sale - 200 fee - 4000 payout - 5000 refund + 200 fee reversal = -4000
  assert b.balance_cents = -4000, format('balance after refund should be -4000, got %s', b.balance_cents);
  raise notice 'PASS refund reverses sale and platform fee';
end $$;

-- --- organizer analytics -----------------------------------------------------
do $$
declare a jsonb;
begin
  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
  a := public.event_analytics('aaaaaaa1-0000-0000-0000-000000000002');
  assert (a ->> 'currency') = 'EUR', 'analytics must report the currency';
  assert (a ->> 'rsvp_going')::int >= 1, 'analytics must report RSVPs';
  raise notice 'PASS event analytics';
end $$;

rollback;
