-- ============================================================================
-- BLUP test 33 · What a visitor with no account can see and do
-- ============================================================================
-- The bug this exists for: buying without an account was built, tested and
-- shipped — and unreachable, because the button in front of it went through the
-- basket, and a basket belongs to an account. The purchase path is only as open
-- as its narrowest step, so every step is asserted here as `anon`.
\set ON_ERROR_STOP on

begin;

insert into auth.users (id, email) values
  ('22222222-2222-2222-2222-222222222222', 'organizer@blup.test');

insert into public.organizations (id, slug, name, created_by, verification_status)
values ('bbbbbbb1-0000-0000-0000-000000000001', 'nova', 'Nova Collective',
        '22222222-2222-2222-2222-222222222222', 'verified');

insert into public.organization_members (organization_id, user_id, role)
values ('bbbbbbb1-0000-0000-0000-000000000001',
        '22222222-2222-2222-2222-222222222222', 'owner')
on conflict do nothing;

insert into public.events (id, creator_id, organization_id, title, category,
                           latitude, longitude, start_at, end_at, is_free, price_cents,
                           status, visibility)
values ('aaaaaaa1-0000-0000-0000-0000000000b1', '22222222-2222-2222-2222-222222222222',
        'bbbbbbb1-0000-0000-0000-000000000001', 'Nova Warehouse', 'techno',
        48.1550, 17.1200, now() + interval '10 days', now() + interval '10 days 6 hours',
        false, 2500, 'published', 'public');

insert into public.ticket_types (id, event_id, name, price_cents, currency, quantity_total, max_per_order)
values ('ccccccc1-0000-0000-0000-0000000000c1', 'aaaaaaa1-0000-0000-0000-0000000000b1',
        'Standard', 2500, 'EUR', 50, 6);

-- --- the checkout screen can be rendered without an account ------------------
do $$
declare
  ev_seen  integer;
  tt_seen  integer;
  price    integer;
begin
  set local role anon;

  select count(*) into ev_seen from public.events
  where id = 'aaaaaaa1-0000-0000-0000-0000000000b1';
  assert ev_seen = 1, 'a published event is readable without an account';

  select count(*), max(price_cents) into tt_seen, price
  from public.ticket_types where event_id = 'aaaaaaa1-0000-0000-0000-0000000000b1';
  assert tt_seen = 1, format('and so are its ticket types, got %s', tt_seen);
  assert price = 2500, 'with the price on them — otherwise the checkout is blank';

  reset role;
  raise notice 'PASS a visitor can see what there is to buy';
end $$;

-- --- and can be quoted a price ----------------------------------------------
-- The checkout shows the total before asking for anything. If this needed an
-- account the screen would show a blank total to exactly the people being
-- asked to trust it with a card.
do $$
declare q jsonb;
begin
  set local role anon;
  select public.quote_order('ccccccc1-0000-0000-0000-0000000000c1', 2, null) into q;
  assert (q ->> 'valid')::boolean, format('the quote must work for a guest: %s', q);
  assert (q ->> 'buyer_total_cents')::int > 0, 'with a real total';
  reset role;
  raise notice 'PASS a visitor is quoted the price before being asked for anything';
end $$;

-- --- but still cannot reserve, price, or fulfil anything itself --------------
-- The guest path runs through the Edge Function and the service role. None of
-- it is reachable from a browser, with or without an account.
do $$
declare failed boolean;
begin
  set local role anon;

  failed := false;
  begin
    perform public.create_order(
      p_buyer_id => null, p_ticket_type_id => 'ccccccc1-0000-0000-0000-0000000000c1',
      p_quantity => 1, p_guest_email => 'host@example.com');
  exception when others then failed := true;
  end;
  assert failed, 'a browser cannot create its own order';

  failed := false;
  begin
    perform public.cart_add('ccccccc1-0000-0000-0000-0000000000c1', 1);
  exception when others then failed := true;
  end;
  assert failed, 'nor hold stock in a basket';

  reset role;
  raise notice 'PASS opening the door to guests did not open it to the browser';
end $$;

-- --- a guest ticket is private, token or not ---------------------------------
do $$
declare
  o      public.orders;
  failed boolean := false;
  n      integer;
begin
  o := public.create_order(
    p_buyer_id => null, p_ticket_type_id => 'ccccccc1-0000-0000-0000-0000000000c1',
    p_quantity => 1, p_guest_email => 'host@example.com', p_guest_name => 'Jana');
  perform public.fulfill_order(o.id, 'stripe'::payment_provider, 'pi_guest_33', o.total_cents);

  set local role anon;

  -- Not through the table: without a buyer there is no row-level match, and
  -- there must not be a policy that hands out ownerless rows.
  select count(*) into n from public.tickets where order_id = o.id;
  assert n = 0, format('a guest ticket is not public just because nobody owns it, got %s', n);

  -- And not by guessing the id either.
  begin
    perform public.guest_order_status(o.id, 'guess');
  exception when others then failed := true;
  end;
  assert failed, 'the token is the whole lock';

  -- With the token it opens, and only then.
  assert (public.guest_order_status(o.id, o.claim_token) ->> 'status') = 'succeeded';

  reset role;
  raise notice 'PASS the ticket opens with the token and with nothing else';
end $$;

rollback;
