-- ============================================================================
-- BLUP · 0056 · Buying a ticket without an account, and where buyers are from
-- ============================================================================
-- Making somebody register before they can pay is the most expensive sentence
-- on the whole site. A ticket already works without an account — a comp sent to
-- an address scans at the door and follows its owner into the app if they ever
-- sign up (migration 0049) — so the only thing missing was letting them pay.
--
-- What a guest gives us is exactly what a ticket needs and nothing else: the
-- name to print on it, the address to send it to, and the town they are coming
-- from. The town is not a formality — it is what puts a dot on the organizer's
-- map, and knowing that half the room drives in from Nitra is the difference
-- between advertising in the right city and guessing.
--
-- Nothing here is trusted from the browser. Every amount is still computed by
-- create_order(), which is reachable only from the service-role Edge Functions.
-- ============================================================================

set search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- 1. Where the buyer is from
-- ---------------------------------------------------------------------------
-- On the order rather than only on the profile: a profile's town changes when
-- somebody moves, and last year's map would silently rewrite itself. The town
-- recorded here is the one they gave when they bought.
alter table public.orders
  add column if not exists buyer_city      text,
  add column if not exists buyer_latitude  double precision,
  add column if not exists buyer_longitude double precision;

alter table public.orders
  drop constraint if exists orders_buyer_coords;
alter table public.orders
  add constraint orders_buyer_coords check (
    (buyer_latitude is null and buyer_longitude is null)
    or (buyer_latitude between -90 and 90 and buyer_longitude between -180 and 180)
  );

create index if not exists orders_buyer_city_idx
  on public.orders (lower(buyer_city)) where buyer_city is not null;

-- ---------------------------------------------------------------------------
-- 2. A checkout can belong to an address instead of an account
-- ---------------------------------------------------------------------------
alter table public.checkouts alter column buyer_id drop not null;

alter table public.checkouts
  add column if not exists guest_email     citext,
  add column if not exists guest_name      text,
  add column if not exists buyer_city      text,
  add column if not exists buyer_latitude  double precision,
  add column if not exists buyer_longitude double precision,
  add column if not exists claim_token     text;

alter table public.checkouts
  drop constraint if exists checkouts_buyer_or_guest;
alter table public.checkouts
  add constraint checkouts_buyer_or_guest
    check (buyer_id is not null or guest_email is not null);

create unique index if not exists checkouts_claim_token_key
  on public.checkouts (claim_token) where claim_token is not null;

-- ---------------------------------------------------------------------------
-- 3. Ordering as a guest
-- ---------------------------------------------------------------------------
drop function if exists public.create_order(uuid, uuid, integer, text, integer, uuid, uuid);

create or replace function public.create_order(
  p_buyer_id          uuid,
  p_ticket_type_id    uuid,
  p_quantity          integer,
  p_promo_code        text default null,
  p_discount_override integer default null,
  p_promo_code_id     uuid default null,
  p_checkout_id       uuid default null,
  -- The guest half. Given together or not at all.
  p_guest_email       text default null,
  p_guest_name        text default null,
  p_buyer_city        text default null,
  p_buyer_latitude    double precision default null,
  p_buyer_longitude   double precision default null
)
returns public.orders
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  tt        record;
  ev        record;
  org       record;
  fees      jsonb;
  cap       integer;
  subtotal  integer;
  discount  integer := 0;
  net       integer;
  archive   integer;
  commis    integer;
  payer     text;
  promo     jsonb;
  promo_id  uuid;
  held      integer;
  guest     citext := nullif(lower(btrim(coalesce(p_guest_email, ''))), '')::citext;
  city      text   := nullif(btrim(coalesce(p_buyer_city, '')), '');
  lat       double precision := p_buyer_latitude;
  lng       double precision := p_buyer_longitude;
  new_order public.orders;
begin
  if p_quantity is null or p_quantity < 1 then
    raise exception 'INVALID_QUANTITY';
  end if;

  -- Somebody has to own this order. Not both, not neither: an account or an
  -- address, and an address that at least looks like one.
  if p_buyer_id is null and guest is null then
    raise exception 'BUYER_REQUIRED';
  end if;
  if guest is not null and position('@' in guest::text) < 2 then
    raise exception 'INVALID_EMAIL';
  end if;

  cap := (public.cart_limits()->>'max_tickets_per_order')::integer;
  if p_quantity > cap then
    raise exception 'CART_LIMIT_REACHED';
  end if;

  select * into tt from public.ticket_types where id = p_ticket_type_id for update;
  if not found then
    raise exception 'TICKET_TYPE_NOT_FOUND';
  end if;
  if not tt.is_active then
    raise exception 'TICKET_TYPE_INACTIVE';
  end if;
  if p_quantity > tt.max_per_order then
    raise exception 'QUANTITY_ABOVE_LIMIT';
  end if;
  if tt.sales_start_at is not null and now() < tt.sales_start_at then
    raise exception 'SALES_NOT_STARTED';
  end if;
  if tt.sales_end_at is not null and now() > tt.sales_end_at then
    raise exception 'SALES_ENDED';
  end if;

  -- Everyone else's live reservations count as gone. The buyer's own basket
  -- does not: this order is what that basket turns into.
  held := public.held_quantity(tt.id, p_buyer_id);
  if tt.quantity_sold + held + p_quantity > tt.quantity_total then
    raise exception 'SOLD_OUT';
  end if;

  select * into ev from public.events where id = tt.event_id;
  if ev.status <> 'published' then
    raise exception 'EVENT_NOT_AVAILABLE';
  end if;
  if ev.organization_id is null then
    raise exception 'PAID_EVENT_REQUIRES_ORGANIZATION';
  end if;

  select * into org from public.organizations where id = ev.organization_id;

  -- Nothing was said about where the buyer is from, but we know them: take it
  -- from the profile so a signed-in purchase lands on the same map as a guest's.
  if p_buyer_id is not null and city is null then
    select p.city, p.latitude, p.longitude into city, lat, lng
    from public.profiles p where p.id = p_buyer_id;
  end if;

  fees     := public.resolve_fees(ev.organization_id);
  payer    := fees->>'archive_fee_payer';
  subtotal := tt.price_cents * p_quantity;

  if p_discount_override is not null then
    -- Basket path: the caller already validated the code and split it.
    discount := least(greatest(p_discount_override, 0), subtotal);
    promo_id := p_promo_code_id;
  elsif p_promo_code is not null and btrim(p_promo_code) <> '' then
    promo := public.evaluate_promo_code(ev.id, btrim(p_promo_code), subtotal);

    if not (promo->>'valid')::boolean then
      raise exception '%', promo->>'reason';
    end if;

    discount := (promo->>'amount_off')::integer;
    promo_id := (promo->>'promo_code_id')::uuid;
  end if;

  net     := greatest(subtotal - discount, 0);
  archive := case when net > 0
                  then (fees->>'archive_fee_cents')::integer * p_quantity
                  else 0 end;
  commis  := (net * (fees->>'platform_fee_bps')::integer) / 10000;

  insert into public.orders (
    event_id, organization_id, ticket_type_id, buyer_id, quantity,
    unit_price_cents, subtotal_cents, discount_cents, promo_code_id,
    commission_cents, archive_fee_cents, archive_fee_payer,
    platform_fee_cents, total_cents, currency, payment_status, provider,
    checkout_id, guest_email, guest_name, claim_token,
    buyer_city, buyer_latitude, buyer_longitude
  )
  values (
    ev.id, ev.organization_id, tt.id, p_buyer_id, p_quantity,
    tt.price_cents, subtotal, discount, promo_id,
    commis, archive, payer,
    commis + case when payer = 'organizer' then archive else 0 end,
    net + case when payer = 'buyer' then archive else 0 end,
    tt.currency, 'requires_payment', org.payment_provider,
    p_checkout_id, guest, nullif(btrim(coalesce(p_guest_name, '')), ''),
    -- The guest's only way back to their ticket if they read the e-mail on a
    -- different device, or sign up later with a different address.
    case when guest is not null then public.blup_short_code(24) end,
    city, lat, lng
  )
  returning * into new_order;

  -- The basket path counts the code once, in create_checkout().
  if promo_id is not null and p_discount_override is null then
    update public.promo_codes
      set used_count = used_count + 1
      where id = promo_id;
  end if;

  -- The basket path records one redemption for the whole basket in
  -- create_checkout(); a single-line order records its own here. A guest has no
  -- user id to record, and the redemption is tied to the order either way.
  if promo_id is not null and discount > 0 and p_discount_override is null then
    insert into public.promo_redemptions (promo_code_id, order_id, user_id, amount_off)
    values (promo_id, new_order.id, p_buyer_id, discount);
  end if;

  return new_order;
end;
$$;

revoke all on function public.create_order(
  uuid, uuid, integer, text, integer, uuid, uuid, text, text, text, double precision, double precision
) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. A fulfilled guest order has to produce a guest ticket
-- ---------------------------------------------------------------------------
-- Without this the insert fails outright: tickets carry the same "an account or
-- an address" constraint, and a guest order has no account to put on them. The
-- rest of fulfill_order is untouched — this is the ticket insert and nothing
-- else, so the money path keeps its single definition in 0046.
create or replace function public.copy_guest_to_ticket()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  o record;
begin
  if new.buyer_id is not null or new.guest_email is not null or new.order_id is null then
    return new;
  end if;

  select guest_email, guest_name into o from public.orders where id = new.order_id;
  new.guest_email := o.guest_email;
  new.guest_name  := coalesce(new.guest_name, o.guest_name);
  new.holder_name := coalesce(new.holder_name, o.guest_name);
  return new;
end;
$$;

drop trigger if exists tickets_copy_guest on public.tickets;
create trigger tickets_copy_guest
  before insert on public.tickets
  for each row execute function public.copy_guest_to_ticket();

-- ---------------------------------------------------------------------------
-- 5. How many pending orders one address may leave lying around
-- ---------------------------------------------------------------------------
-- A guest order needs no account, so nothing stops a script from opening
-- thousands and holding every seat in the house until they expire. An account
-- has the same hole, but an account is at least a thing that can be blocked.
create or replace function public.guest_order_throttle()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  recent integer;
begin
  if new.guest_email is null or new.buyer_id is not null then
    return new;
  end if;

  select count(*) into recent
  from public.orders o
  where o.guest_email = new.guest_email
    and o.created_at > now() - interval '1 hour'
    and o.payment_status = 'requires_payment';

  if recent >= 6 then
    raise exception 'TOO_MANY_PENDING_ORDERS'
      using hint = 'Dokonči alebo nechaj vypršať rozpracované objednávky.';
  end if;

  return new;
end;
$$;

drop trigger if exists orders_guest_throttle on public.orders;
create trigger orders_guest_throttle
  before insert on public.orders
  for each row execute function public.guest_order_throttle();

-- ---------------------------------------------------------------------------
-- 6. Reading your own guest order back
-- ---------------------------------------------------------------------------
-- The thank-you page has no session to read the order with, so it asks by id
-- plus the claim token that only the buyer's browser and the e-mail have.
create or replace function public.guest_order_status(
  p_order_id uuid,
  p_token    text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  o  record;
  ev record;
begin
  if p_order_id is null or nullif(btrim(coalesce(p_token, '')), '') is null then
    raise exception 'INVALID_INPUT';
  end if;

  select * into o from public.orders
  where id = p_order_id and claim_token = btrim(p_token);

  if not found then
    raise exception 'ORDER_NOT_FOUND';
  end if;

  select title, start_at, venue_name, city into ev
  from public.events where id = o.event_id;

  return jsonb_build_object(
    'order_id',       o.id,
    'status',         o.payment_status,
    'quantity',       o.quantity,
    'total_cents',    o.total_cents,
    'currency',       o.currency,
    'guest_email',    o.guest_email,
    'guest_name',     o.guest_name,
    'event_title',    ev.title,
    'event_start_at', ev.start_at,
    'venue_name',     ev.venue_name,
    'city',           ev.city,
    'tickets', coalesce((
      select jsonb_agg(jsonb_build_object(
        'code', t.code, 'qr_secret', t.qr_secret, 'status', t.status
      ) order by t.created_at)
      from public.tickets t where t.order_id = o.id
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.guest_order_status(uuid, text) from public;
grant execute on function public.guest_order_status(uuid, text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 7. Fulfilment, with nobody to mark as going
-- ---------------------------------------------------------------------------
-- Re-stated whole rather than patched around, because this is the function that
-- turns money into tickets and it should be readable in one piece. The only
-- change from 0046 is the guard below: a guest has no account to add to the
-- attendee list and no inbox to notify, and the null id made the insert fail
-- *after* the payment had gone through.
create or replace function public.fulfill_order(
  p_order_id           uuid,
  p_provider           payment_provider,
  p_provider_reference text,
  p_amount_cents       integer
)
returns setof public.tickets
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  o           public.orders;
  i           integer;
  pol         public.payout_tiers;
  anchor      timestamptz;
  main_at     timestamptz;
  reserve_at  timestamptz;
  reserve_c   integer;
  main_c      integer;
begin
  select * into o from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'ORDER_NOT_FOUND';
  end if;

  if o.payment_status = 'succeeded' then
    return query select * from public.tickets t where t.order_id = o.id;
    return;
  end if;

  if p_amount_cents is not null and p_amount_cents <> o.total_cents then
    raise exception 'AMOUNT_MISMATCH: expected % got %', o.total_cents, p_amount_cents;
  end if;

  update public.orders
  set payment_status = 'succeeded',
      provider = p_provider,
      provider_reference = coalesce(p_provider_reference, provider_reference),
      paid_at = now()
  where id = o.id;

  insert into public.payments (order_id, user_id, provider, provider_reference, amount_cents, currency, status)
  values (o.id, o.buyer_id, p_provider, p_provider_reference, o.total_cents, o.currency, 'succeeded')
  on conflict (provider, provider_reference) do nothing;

  for i in 1..o.quantity loop
    insert into public.tickets (
      order_id, event_id, ticket_type_id, buyer_id, code, qr_secret,
      price_cents, currency
    )
    values (
      o.id, o.event_id, o.ticket_type_id, o.buyer_id,
      'BLP-' || public.blup_short_code(10),
      encode(gen_random_bytes(24), 'hex'),
      o.unit_price_cents, o.currency
    );
  end loop;

  if o.organization_id is not null then
    pol    := public.payout_policy_for(o.organization_id);
    anchor := public.event_settlement_anchor(o.event_id);

    -- A sale with no event date to hang on falls back to the sale date. It
    -- should not happen, and if it does, holding the money for the full
    -- reserve window is the safe direction to be wrong in.
    if anchor is null then
      anchor := now();
    end if;

    main_at    := anchor + make_interval(days => pol.payout_delay_days);
    reserve_at := anchor + make_interval(days => pol.reserve_release_days);

    -- Rounded down, so the reserve is never a cent more than policy and the
    -- two halves always add back to exactly net_cents.
    reserve_c := (o.net_cents * pol.reserve_bps) / 10000;
    main_c    := o.net_cents - reserve_c;

    if main_c <> 0 then
      insert into public.ledger_entries
        (organization_id, event_id, order_id, type, amount_cents, currency, description, available_at, is_reserve)
      values (o.organization_id, o.event_id, o.id, 'sale', main_c, o.currency,
              'Ticket sale x' || o.quantity, main_at, false);
    end if;

    if reserve_c <> 0 then
      insert into public.ledger_entries
        (organization_id, event_id, order_id, type, amount_cents, currency, description, available_at, is_reserve)
      values (o.organization_id, o.event_id, o.id, 'sale', reserve_c, o.currency,
              'Rezerva ' || (pol.reserve_bps / 100.0) || ' % · uvoľnenie ' ||
              to_char(reserve_at, 'DD.MM.YYYY'), reserve_at, true);
    end if;

    -- Our own fee is not held against a dispute: it is deducted at the same
    -- moment as the main amount, and it is ours from then on.
    if o.commission_cents > 0 then
      insert into public.ledger_entries
        (organization_id, event_id, order_id, type, amount_cents, currency, description, available_at)
      values (o.organization_id, o.event_id, o.id, 'platform_fee', -o.commission_cents, o.currency,
              'BLUP commission', main_at);
    end if;

    if o.archive_fee_payer = 'organizer' and o.archive_fee_cents > 0 then
      insert into public.ledger_entries
        (organization_id, event_id, order_id, type, amount_cents, currency, description, available_at)
      values (o.organization_id, o.event_id, o.id, 'platform_fee', -o.archive_fee_cents, o.currency,
              'BLUP archive fee x' || o.quantity, main_at);
    end if;
  end if;

  -- Only somebody with an account can be marked as going, or be sent a
  -- notification in the app. A guest has neither, and inserting their null id
  -- here is what made the whole fulfilment fail — the money had already moved.
  -- Their copy is the e-mail below, which is queued either way.
  if o.buyer_id is not null then
    insert into public.event_attendees (event_id, user_id, status)
    values (o.event_id, o.buyer_id, 'going')
    on conflict (event_id, user_id) do update set status = 'going';

    insert into public.notifications (user_id, type, title, body, event_id, data)
    values (
      o.buyer_id, 'ticket_confirmed', 'Ticket confirmed',
      'Your ticket is ready. Show the QR code at the door.',
      o.event_id, jsonb_build_object('order_id', o.id)
    );
  end if;

  perform public.queue_ticket_email(o.id);

  return query select * from public.tickets t where t.order_id = o.id;
end;
$$;
