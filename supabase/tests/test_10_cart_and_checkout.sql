-- ============================================================================
-- BLUP test 10 · Basket, reservations, the 20-ticket cap, grouped checkout
-- ============================================================================
-- What is actually being proved here:
--
--   · a basket line takes stock away from other shoppers while it is alive
--   · an expired line gives it back without anything having to sweep it
--   · 20 tickets per order is a rule of the database, not of the browser
--   · a basket turns into one order per ticket type under one payment
--   · a basket promo code is counted once and split to the cent
--   · one payment issues every ticket in the basket, and the money balances
-- ============================================================================
\set ON_ERROR_STOP on

begin;

insert into auth.users (id, email, raw_user_meta_data) values
  ('a1010101-0000-0000-0000-000000000001', 'org10@example.com',   '{"display_name":"Org"}'),
  ('b1010101-0000-0000-0000-000000000001', 'buyer10@example.com', '{"display_name":"Buyer"}'),
  ('c1010101-0000-0000-0000-000000000001', 'rival10@example.com', '{"display_name":"Rival"}');

do $$
declare v_org uuid; v_event uuid;
begin
  insert into public.organizations (id, name, slug, created_by, verification_status, payouts_enabled)
  values ('d1010101-0000-0000-0000-000000000001', 'Cart Co', 'cart-co',
          'a1010101-0000-0000-0000-000000000001', 'verified', true)
  returning id into v_org;

  insert into public.events (id, creator_id, organization_id, title, category, start_at,
                             latitude, longitude, is_free, price_cents, status, venue_name)
  values ('d1010101-0000-0000-0000-000000000002', 'a1010101-0000-0000-0000-000000000001',
          v_org, 'Basket Night', 'techno', now() + interval '9 days',
          48.1486, 17.1077, false, 1500, 'published', 'Stará tržnica')
  returning id into v_event;

  -- A second event, to prove a basket cannot straddle two organizers.
  insert into public.events (id, creator_id, organization_id, title, category, start_at,
                             latitude, longitude, is_free, price_cents, status)
  values ('d1010101-0000-0000-0000-000000000003', 'a1010101-0000-0000-0000-000000000001',
          v_org, 'Other Night', 'house', now() + interval '10 days',
          48.1486, 17.1077, false, 1000, 'published');

  insert into public.ticket_types (id, event_id, name, price_cents, quantity_total, max_per_order)
  values
    ('d1010101-0000-0000-0000-000000000010', v_event, 'Early bird', 1500, 30, 25),
    ('d1010101-0000-0000-0000-000000000011', v_event, 'Standard',   2200, 30, 25),
    ('d1010101-0000-0000-0000-000000000012', v_event, 'Last two',    900,  2, 25),
    ('d1010101-0000-0000-0000-000000000013', 'd1010101-0000-0000-0000-000000000003',
     'Other event', 1000, 10, 10);
end $$;

-- --- a line holds stock against everybody else -------------------------------
do $$
declare left_for_rival integer;
begin
  perform set_config('request.jwt.claim.sub', 'b1010101-0000-0000-0000-000000000001', true);
  perform public.cart_add('d1010101-0000-0000-0000-000000000012', 1);

  perform set_config('request.jwt.claim.sub', 'c1010101-0000-0000-0000-000000000001', true);
  select available into left_for_rival
  from public.ticket_type_availability('d1010101-0000-0000-0000-000000000012');

  assert left_for_rival = 1,
    format('a live reservation must take stock away from others, saw %s left', left_for_rival);
  raise notice 'PASS a basket line reserves against other shoppers';
end $$;

-- --- an expired line gives it back, with nothing having to sweep -------------
do $$
declare left_for_rival integer;
begin
  update public.cart_items set expires_at = now() - interval '1 second'
  where ticket_type_id = 'd1010101-0000-0000-0000-000000000012';

  perform set_config('request.jwt.claim.sub', 'c1010101-0000-0000-0000-000000000001', true);
  select available into left_for_rival
  from public.ticket_type_availability('d1010101-0000-0000-0000-000000000012');

  assert left_for_rival = 2,
    format('an expired hold must release stock immediately, saw %s left', left_for_rival);

  -- and the sweep is only housekeeping
  perform public.release_expired_holds();
  assert not exists (select 1 from public.cart_items
                     where ticket_type_id = 'd1010101-0000-0000-0000-000000000012'),
    'the sweep removes the dead row';
  raise notice 'PASS an expired reservation returns the tickets to the pool';
end $$;

-- --- one basket, one event ----------------------------------------------------
do $$
begin
  perform set_config('request.jwt.claim.sub', 'b1010101-0000-0000-0000-000000000001', true);
  perform public.cart_clear();
  perform public.cart_add('d1010101-0000-0000-0000-000000000010', 2);

  begin
    perform public.cart_add('d1010101-0000-0000-0000-000000000013', 1);
    raise exception 'TEST FAILED: a basket accepted tickets for a second event';
  exception when raise_exception then
    if sqlerrm like 'TEST FAILED%' then raise; end if;
    raise notice 'PASS a basket refuses a second event (%)', sqlerrm;
  end;
end $$;

-- --- ten is the ceiling, and the database is the one enforcing it -----------
do $$
declare basket jsonb;
begin
  perform set_config('request.jwt.claim.sub', 'b1010101-0000-0000-0000-000000000001', true);
  perform public.cart_clear();

  basket := public.cart_add('d1010101-0000-0000-0000-000000000010', 6);
  assert (basket->>'quantity')::int = 6, 'six went in';

  basket := public.cart_add('d1010101-0000-0000-0000-000000000011', 4);
  assert (basket->>'quantity')::int = 10, 'ten is allowed';

  begin
    perform public.cart_add('d1010101-0000-0000-0000-000000000011', 1);
    raise exception 'TEST FAILED: an 11th ticket was accepted';
  exception when raise_exception then
    if sqlerrm like 'TEST FAILED%' then raise; end if;
    assert sqlerrm = 'CART_LIMIT_REACHED', format('expected CART_LIMIT_REACHED, got %s', sqlerrm);
    raise notice 'PASS the 11th ticket is refused';
  end;

  -- and the same ceiling applies to a direct order, not only to the basket
  begin
    perform public.create_order(
      p_buyer_id => 'b1010101-0000-0000-0000-000000000001',
      p_ticket_type_id => 'd1010101-0000-0000-0000-000000000010',
      p_quantity => 11);
    raise exception 'TEST FAILED: create_order accepted 11 tickets';
  exception when raise_exception then
    if sqlerrm like 'TEST FAILED%' then raise; end if;
    assert sqlerrm = 'CART_LIMIT_REACHED', format('expected CART_LIMIT_REACHED, got %s', sqlerrm);
    raise notice 'PASS create_order enforces the same ceiling';
  end;
end $$;

-- --- the quote is what the order will cost -----------------------------------
do $$
declare quoted jsonb; co public.checkouts; ordered integer;
begin
  perform set_config('request.jwt.claim.sub', 'b1010101-0000-0000-0000-000000000001', true);
  perform public.cart_clear();
  perform public.cart_add('d1010101-0000-0000-0000-000000000010', 3);   -- 3 x 15.00
  perform public.cart_add('d1010101-0000-0000-0000-000000000011', 5);   -- 5 x 22.00

  quoted := public.cart_view(null);

  assert (quoted->>'subtotal_cents')::int = 4500 + 11000,
    format('subtotal should be 155.00, saw %s', quoted->>'subtotal_cents');
  assert (quoted->>'archive_fee_cents')::int = 800,
    format('8 tickets carry 8.00 of archive fee, saw %s', quoted->>'archive_fee_cents');
  assert (quoted->>'total_cents')::int = 15500 + 800,
    format('total should be 163.00, saw %s', quoted->>'total_cents');
  assert (quoted->>'seconds_left')::int between 800 and 900,
    'the hold is a quarter of an hour';

  co := public.create_checkout('b1010101-0000-0000-0000-000000000001');

  select sum(total_cents) into ordered from public.orders where checkout_id = co.id;
  assert ordered = (quoted->>'total_cents')::int,
    format('the orders must cost what the basket quoted: %s vs %s', ordered, quoted->>'total_cents');
  assert co.total_cents = ordered, 'the checkout carries the same total';
  assert (select count(*) from public.orders where checkout_id = co.id) = 2,
    'one order per ticket type';
  assert not exists (select 1 from public.cart_items
                     where user_id = 'b1010101-0000-0000-0000-000000000001'),
    'the basket is consumed by the checkout';

  raise notice 'PASS the basket quote is the price of the orders';
end $$;

-- --- one payment issues every ticket, and the money balances -----------------
do $$
declare co public.checkouts; issued integer; blup integer; organiser integer;
begin
  perform set_config('request.jwt.claim.sub', 'b1010101-0000-0000-0000-000000000001', true);
  perform public.cart_clear();
  perform public.cart_add('d1010101-0000-0000-0000-000000000010', 2);
  perform public.cart_add('d1010101-0000-0000-0000-000000000011', 3);

  co := public.create_checkout('b1010101-0000-0000-0000-000000000001');

  select count(*) into issued
  from public.fulfill_checkout(co.id, 'stripe', 'pi_basket_test', co.total_cents);

  assert issued = 5, format('five tickets should exist, saw %s', issued);

  select sum(blup_revenue_cents), sum(net_cents - commission_cents)
    into blup, organiser
  from public.orders where checkout_id = co.id;

  assert blup + organiser = co.total_cents,
    format('buyer paid %s but organizer %s + BLUP %s do not add up',
           co.total_cents, organiser, blup);

  -- the references stay unique per order while pointing at one payment
  assert (select count(distinct provider_reference) from public.orders where checkout_id = co.id) = 2,
    'each order in a basket keeps its own reference';
  assert (select bool_and(provider_reference like 'pi_basket_test#%')
          from public.orders where checkout_id = co.id),
    'and each reference traces back to the one payment';

  -- replaying the same webhook must not mint a second set of tickets
  perform public.fulfill_checkout(co.id, 'stripe', 'pi_basket_test', co.total_cents);
  select count(*) into issued
  from public.tickets t join public.orders o on o.id = t.order_id
  where o.checkout_id = co.id;
  assert issued = 5, format('a replayed webhook must not duplicate tickets, saw %s', issued);

  raise notice 'PASS one payment issues the whole basket, once, and the money balances';
end $$;

-- --- a basket promo code is counted once and split to the cent ---------------
do $$
declare co public.checkouts; split integer; uses integer;
begin
  insert into public.promo_codes (event_id, code, kind, value, is_active)
  values ('d1010101-0000-0000-0000-000000000002', 'BASKET7', 'fixed', 777, true);

  perform set_config('request.jwt.claim.sub', 'b1010101-0000-0000-0000-000000000001', true);
  perform public.cart_clear();
  perform public.cart_add('d1010101-0000-0000-0000-000000000010', 3);
  perform public.cart_add('d1010101-0000-0000-0000-000000000011', 5);

  co := public.create_checkout('b1010101-0000-0000-0000-000000000001', 'BASKET7');

  select sum(discount_cents) into split from public.orders where checkout_id = co.id;
  assert split = 777,
    format('the split must add up to the discount exactly, saw %s', split);

  select used_count into uses from public.promo_codes where code = 'BASKET7';
  assert uses = 1, format('a basket consumes one use, not one per line, saw %s', uses);

  assert (select count(*) from public.promo_redemptions r
          join public.promo_codes p on p.id = r.promo_code_id
          where p.code = 'BASKET7') = 1,
    'and records one redemption';

  raise notice 'PASS a basket discount is counted once and split exactly';
end $$;

-- --- the basket belongs to its owner ------------------------------------------
do $$
begin
  perform set_config('request.jwt.claim.sub', 'c1010101-0000-0000-0000-000000000001', true);
  perform public.cart_clear();
  perform public.cart_add('d1010101-0000-0000-0000-000000000010', 1);

  perform set_config('request.jwt.claim.sub', 'b1010101-0000-0000-0000-000000000001', true);
  assert (public.cart_view(null)->>'quantity')::int = 0,
    'one person must never see another person''s basket';

  raise notice 'PASS a basket is private to its owner';
end $$;

-- --- an anonymous visitor has no basket at all --------------------------------
do $$
begin
  perform set_config('request.jwt.claim.sub', '', true);
  assert (public.cart_view(null)->>'quantity')::int = 0, 'a guest has an empty basket';

  begin
    perform public.cart_add('d1010101-0000-0000-0000-000000000010', 1);
    raise exception 'TEST FAILED: a guest reserved tickets';
  exception when raise_exception then
    if sqlerrm like 'TEST FAILED%' then raise; end if;
    assert sqlerrm = 'AUTH_REQUIRED', format('expected AUTH_REQUIRED, got %s', sqlerrm);
    raise notice 'PASS a guest cannot hold stock';
  end;
end $$;

rollback;
