-- ============================================================================
-- BLUP test 31 · Paying for a ticket without an account
-- ============================================================================
-- The point of the whole thing: somebody clicks a link from Instagram, buys a
-- ticket, and never makes an account. What must hold is that the money is
-- priced exactly as it is for a signed-in buyer, the ticket works at the door,
-- and the town they typed ends up on the organizer's map.
\set ON_ERROR_STOP on

begin;

insert into auth.users (id, email) values
  ('22222222-2222-2222-2222-222222222222', 'organizer@blup.test'),
  ('44444444-4444-4444-4444-444444444444', 'kupujuci@blup.test');

update public.profiles
set city = 'Nitra', latitude = 48.3069, longitude = 18.0864, display_name = 'Peter Účet'
where id = '44444444-4444-4444-4444-444444444444';

insert into public.organizations (id, slug, name, created_by, verification_status)
values ('bbbbbbb1-0000-0000-0000-000000000001', 'nova', 'Nova Collective',
        '22222222-2222-2222-2222-222222222222', 'verified');

insert into public.organization_members (organization_id, user_id, role)
values ('bbbbbbb1-0000-0000-0000-000000000001',
        '22222222-2222-2222-2222-222222222222', 'owner')
on conflict do nothing;

insert into public.events (id, creator_id, organization_id, title, category,
                           latitude, longitude, start_at, end_at, is_free, price_cents)
values ('aaaaaaa1-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222',
        'bbbbbbb1-0000-0000-0000-000000000001', 'Nova Warehouse', 'techno',
        48.1550, 17.1200, now() + interval '10 days', now() + interval '10 days 6 hours',
        false, 2500);

insert into public.ticket_types (id, event_id, name, price_cents, currency, quantity_total, max_per_order)
values ('ccccccc1-0000-0000-0000-000000000001', 'aaaaaaa1-0000-0000-0000-000000000002',
        'Standard', 2500, 'EUR', 40, 6);

-- --- a guest order is priced exactly like an account's -----------------------
do $$
declare
  guest_order   public.orders;
  account_order public.orders;
begin
  guest_order := public.create_order(
    p_buyer_id        => null,
    p_ticket_type_id  => 'ccccccc1-0000-0000-0000-000000000001',
    p_quantity        => 2,
    p_guest_email     => 'Host@Example.COM',
    p_guest_name      => 'Jana Hosťová',
    p_buyer_city      => 'Nitra',
    p_buyer_latitude  => 48.3069,
    p_buyer_longitude => 18.0864);

  account_order := public.create_order(
    p_buyer_id       => '44444444-4444-4444-4444-444444444444',
    p_ticket_type_id => 'ccccccc1-0000-0000-0000-000000000001',
    p_quantity       => 2);

  assert guest_order.subtotal_cents = account_order.subtotal_cents,
    format('subtotal %s vs %s', guest_order.subtotal_cents, account_order.subtotal_cents);
  assert guest_order.commission_cents = account_order.commission_cents, 'same commission';
  assert guest_order.archive_fee_cents = account_order.archive_fee_cents, 'same archive fee';
  assert guest_order.total_cents = account_order.total_cents,
    format('total %s vs %s', guest_order.total_cents, account_order.total_cents);

  assert guest_order.buyer_id is null, 'a guest order has no buyer';
  assert guest_order.guest_email = 'host@example.com', 'the address is folded to lower case';
  assert guest_order.claim_token is not null, 'and carries a way back to the ticket';

  -- The signed-in buyer never typed a town; it came off their profile, so both
  -- kinds of purchase land on the same map.
  assert account_order.buyer_city = 'Nitra',
    format('expected the profile town, got %s', account_order.buyer_city);
  assert account_order.buyer_latitude is not null, 'and its coordinates';

  raise notice 'PASS a guest pays exactly what an account pays';
end $$;

-- --- neither an account nor an address is not a buyer ------------------------
do $$
declare failed boolean := false;
begin
  begin
    perform public.create_order(
      p_buyer_id => null, p_ticket_type_id => 'ccccccc1-0000-0000-0000-000000000001',
      p_quantity => 1);
  exception when others then failed := true;
  end;
  assert failed, 'an order with nobody on it must be refused';

  failed := false;
  begin
    perform public.create_order(
      p_buyer_id => null, p_ticket_type_id => 'ccccccc1-0000-0000-0000-000000000001',
      p_quantity => 1, p_guest_email => 'not-an-address');
  exception when others then failed := true;
  end;
  assert failed, 'and so must one addressed to something that is not an address';

  raise notice 'PASS an order belongs to an account or to an address';
end $$;

-- --- paying it produces a working ticket -------------------------------------
do $$
declare
  o      public.orders;
  t      public.tickets;
  result jsonb;
begin
  select * into o from public.orders where guest_email = 'host@example.com' limit 1;

  perform public.fulfill_order(o.id, 'stripe'::payment_provider, 'pi_guest_test', o.total_cents);

  select * into t from public.tickets where order_id = o.id limit 1;
  assert t.buyer_id is null, 'the ticket has no owner either';
  assert t.guest_email = 'host@example.com', 'but it knows the address it went to';
  assert t.holder_name = 'Jana Hosťová', 'and the name to print on it';
  assert t.status = 'valid', 'and it is valid';

  -- The thing that actually matters: it scans.
  select public.check_in_ticket(t.code, t.qr_secret) into result;
  assert (result ->> 'ok')::boolean, format('the QR must work at the door, got %s', result);

  raise notice 'PASS a guest ticket is a real ticket at the door';
end $$;

-- --- and the e-mail with it goes out ----------------------------------------
do $$
declare queued integer;
begin
  select count(*) into queued
  from public.email_deliveries d
  join public.orders o on o.id = d.order_id
  where o.guest_email = 'host@example.com' and d.kind = 'ticket';

  assert queued >= 1, format('expected a queued ticket e-mail, got %s', queued);

  -- And addressed to what they typed, not to an account that does not exist.
  assert exists (
    select 1 from public.email_deliveries d
    join public.orders o on o.id = d.order_id
    where o.guest_email = 'host@example.com' and d.to_email = 'host@example.com'
  ), 'the e-mail goes to the address on the order';
  raise notice 'PASS the ticket is e-mailed to the address that was typed';
end $$;

-- --- reading the order back needs the token, not an account ------------------
do $$
declare
  o      public.orders;
  status jsonb;
  failed boolean := false;
begin
  select * into o from public.orders where guest_email = 'host@example.com' limit 1;

  set local role anon;
  select public.guest_order_status(o.id, o.claim_token) into status;
  assert status ->> 'status' = 'succeeded', format('got %s', status ->> 'status');
  assert jsonb_array_length(status -> 'tickets') = 2, 'both tickets come back';
  assert (status -> 'tickets' -> 0 ->> 'qr_secret') is not null, 'with the QR to show at the door';

  begin
    perform public.guest_order_status(o.id, 'wrong-token');
  exception when others then failed := true;
  end;
  assert failed, 'a wrong token gets nothing';
  reset role;

  raise notice 'PASS the order is readable with the token and not without it';
end $$;

-- --- one address cannot hold the whole room ----------------------------------
do $$
declare
  refused integer := 0;
  made    integer;
  i       integer;
begin
  for i in 1..10 loop
    begin
      perform public.create_order(
        p_buyer_id => null,
        p_ticket_type_id => 'ccccccc1-0000-0000-0000-000000000001',
        p_quantity => 1,
        p_guest_email => 'spam@example.com');
    exception when others then refused := refused + 1;
    end;
  end loop;

  select count(*) into made from public.orders where guest_email = 'spam@example.com';

  assert refused > 0, 'a run of unpaid guest orders from one address must be stopped';
  assert made = 6, format('expected the throttle to stop at 6, got %s', made);
  raise notice 'PASS one address cannot sit on unlimited unpaid orders (% odmietnutých)', refused;
end $$;

-- --- the town ends up on the organizer's map ---------------------------------
do $$
declare
  r record;
  found_nitra boolean := false;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);

  for r in select * from public.sales_by_city(array['aaaaaaa1-0000-0000-0000-000000000002']::uuid[]) loop
    if r.city = 'Nitra' then
      found_nitra := true;
      assert r.tickets = 2, format('expected 2 tickets from Nitra, got %s', r.tickets);
      assert r.latitude is not null and r.longitude is not null, 'with a point to draw';
      assert abs(r.latitude - 48.3069) < 0.01, format('at Nitra, got %s', r.latitude);
    end if;
  end loop;

  assert found_nitra, 'the town the buyer typed must show up in the map data';
  reset role;

  raise notice 'PASS a purchase puts its town on the map';
end $$;

-- --- and a stranger sees none of it -----------------------------------------
do $$
declare rows_seen integer;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '44444444-4444-4444-4444-444444444444', true);

  select count(*) into rows_seen
  from public.sales_by_city(array['aaaaaaa1-0000-0000-0000-000000000002']::uuid[]);
  assert rows_seen = 0, format('somebody else''s buyers are not your data, got %s rows', rows_seen);

  select count(*) into rows_seen
  from public.sales_rows(array['aaaaaaa1-0000-0000-0000-000000000002']::uuid[]);
  assert rows_seen = 0, 'nor are their names and addresses';

  reset role;
  raise notice 'PASS the statistics are scoped to your own events';
end $$;

rollback;
