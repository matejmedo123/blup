-- ============================================================================
-- BLUP · 0025 · Basket, 15-minute reservations, grouped checkout
-- ============================================================================
-- Until now one order meant one ticket type, which is fine on a phone where you
-- tap "Kúpiť" on a single row. On the web people expect a basket: two standard
-- and one VIP, one payment, one confirmation mail.
--
-- Three things make that work without rewriting the money model.
--
-- 1. `cart_items` is a *reservation*, not a note to self. A line holds its
--    tickets for `cart_hold_minutes` (15 by default) and is counted as taken
--    for everybody else during that time. When it expires the stock returns to
--    the pool on its own — no cron needed for correctness, because every read
--    of availability ignores expired rows, and `release_expired_holds()` only
--    tidies up afterwards.
--
-- 2. A basket may hold at most `max_tickets_per_order` tickets (20). The cap
--    lives in platform_settings next to the fees, is enforced in `cart_add`
--    *and* in `create_order`, and is not something the browser can talk its way
--    around.
--
-- 3. A basket pays once. `checkouts` is the payment envelope: it owns the
--    Stripe reference and the total, and it owns one order per ticket type.
--    Each order keeps its own commission, archive fee and ledger entries
--    exactly as before, so accounting, refunds, analytics and the export all
--    keep working with no idea that a basket existed. The single-line native
--    path is untouched — those orders simply have `checkout_id` null.
--
-- The one subtlety is the promo code. A code discounts the *basket*, so it is
-- evaluated once against the basket subtotal and then split across the lines by
-- largest remainder, which makes the parts add up to the whole to the cent. The
-- code's use counter goes up once, not once per line.
-- ============================================================================

set search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- Limits live with the fees
-- ---------------------------------------------------------------------------
alter table public.platform_settings
  add column if not exists max_tickets_per_order integer not null default 20,
  add column if not exists cart_hold_minutes     integer not null default 15;

alter table public.platform_settings
  drop constraint if exists platform_settings_max_tickets_chk;
alter table public.platform_settings
  add constraint platform_settings_max_tickets_chk
  check (max_tickets_per_order between 1 and 100);

alter table public.platform_settings
  drop constraint if exists platform_settings_hold_minutes_chk;
alter table public.platform_settings
  add constraint platform_settings_hold_minutes_chk
  check (cart_hold_minutes between 1 and 120);

create or replace function public.cart_limits()
returns jsonb
language sql
stable
security definer
set search_path = public, extensions
as $$
  select jsonb_build_object(
    'max_tickets_per_order', coalesce(s.max_tickets_per_order, 20),
    'hold_minutes',          coalesce(s.cart_hold_minutes, 15)
  )
  from (select * from public.platform_settings where id limit 1) s;
$$;

-- ---------------------------------------------------------------------------
-- The basket
-- ---------------------------------------------------------------------------
create table if not exists public.cart_items (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles (id) on delete cascade,
  event_id       uuid not null references public.events (id) on delete cascade,
  ticket_type_id uuid not null references public.ticket_types (id) on delete cascade,
  quantity       integer not null check (quantity between 1 and 100),
  -- The reservation. Past this instant the line holds nothing.
  expires_at     timestamptz not null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (user_id, ticket_type_id)
);

create index if not exists cart_items_user_idx on public.cart_items (user_id);
create index if not exists cart_items_type_idx on public.cart_items (ticket_type_id, expires_at);
create index if not exists cart_items_expiry_idx on public.cart_items (expires_at);

drop trigger if exists cart_items_set_updated_at on public.cart_items;
create trigger cart_items_set_updated_at
  before update on public.cart_items
  for each row execute function public.set_updated_at();

alter table public.cart_items enable row level security;

-- Read and drop your own basket directly; everything that *adds* stock to it
-- goes through cart_add(), which is where availability is decided.
drop policy if exists cart_items_select on public.cart_items;
create policy cart_items_select on public.cart_items
  for select using (user_id = auth.uid());

drop policy if exists cart_items_delete on public.cart_items;
create policy cart_items_delete on public.cart_items
  for delete using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Availability
-- ---------------------------------------------------------------------------
-- Held = live basket lines + orders that are on their way to a provider. An
-- order in `processing` has a payment session open against it and keeps its
-- stock until the webhook resolves it either way.
create or replace function public.held_quantity(
  p_ticket_type_id uuid,
  p_exclude_user   uuid default null
)
returns integer
language sql
stable
security definer
set search_path = public, extensions
as $$
  select
    coalesce((
      select sum(c.quantity) from public.cart_items c
      where c.ticket_type_id = p_ticket_type_id
        and c.expires_at > now()
        and (p_exclude_user is null or c.user_id <> p_exclude_user)
    ), 0)::integer
    + coalesce((
      select sum(o.quantity) from public.orders o
      where o.ticket_type_id = p_ticket_type_id
        and (
          o.payment_status = 'processing'
          or (o.payment_status = 'requires_payment' and o.expires_at > now())
        )
    ), 0)::integer;
$$;

create or replace function public.ticket_type_availability(p_ticket_type_id uuid)
returns table (
  quantity_total integer,
  quantity_sold  integer,
  held           integer,
  available      integer
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  select
    tt.quantity_total,
    tt.quantity_sold,
    public.held_quantity(tt.id, null),
    greatest(tt.quantity_total - tt.quantity_sold - public.held_quantity(tt.id, null), 0)
  from public.ticket_types tt
  where tt.id = p_ticket_type_id;
$$;

-- Housekeeping only: correctness never depends on this having run.
create or replace function public.release_expired_holds()
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  removed integer;
begin
  delete from public.cart_items where expires_at <= now();
  get diagnostics removed = row_count;

  -- An order that never reached a provider expires with the basket it came
  -- from. One that is `processing` is left alone: its fate belongs to the
  -- webhook, not to a timer.
  update public.orders
  set payment_status = 'cancelled',
      failure_reason = coalesce(failure_reason, 'RESERVATION_EXPIRED')
  where payment_status = 'requires_payment'
    and expires_at <= now();

  update public.checkouts
  set status = 'expired'
  where status = 'pending' and expires_at <= now();

  return removed;
end;
$$;

-- ---------------------------------------------------------------------------
-- Basket operations (all scoped to auth.uid())
-- ---------------------------------------------------------------------------
create or replace function public.cart_add(
  p_ticket_type_id uuid,
  p_quantity       integer default 1
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  uid       uuid := auth.uid();
  limits    jsonb;
  cap       integer;
  hold      integer;
  tt        record;
  ev        record;
  mine      integer;
  others    integer;
  in_basket integer;
  wanted    integer;
begin
  if uid is null then
    raise exception 'AUTH_REQUIRED';
  end if;
  if p_quantity is null or p_quantity < 1 then
    raise exception 'INVALID_QUANTITY';
  end if;

  perform public.release_expired_holds();

  limits := public.cart_limits();
  cap    := (limits->>'max_tickets_per_order')::integer;
  hold   := (limits->>'hold_minutes')::integer;

  -- Serialises two people racing for the last ticket of this type.
  select * into tt from public.ticket_types where id = p_ticket_type_id for update;
  if not found then
    raise exception 'TICKET_TYPE_NOT_FOUND';
  end if;
  if not tt.is_active then
    raise exception 'TICKET_TYPE_INACTIVE';
  end if;
  if tt.sales_start_at is not null and now() < tt.sales_start_at then
    raise exception 'SALES_NOT_STARTED';
  end if;
  if tt.sales_end_at is not null and now() > tt.sales_end_at then
    raise exception 'SALES_ENDED';
  end if;

  select * into ev from public.events where id = tt.event_id;
  if ev.status <> 'published' then
    raise exception 'EVENT_NOT_AVAILABLE';
  end if;
  if coalesce(ev.end_at, ev.start_at) < now() then
    raise exception 'EVENT_ALREADY_OVER';
  end if;

  -- One basket, one event: a single payment settles to a single organizer.
  if exists (
    select 1 from public.cart_items c
    where c.user_id = uid and c.event_id <> ev.id and c.expires_at > now()
  ) then
    raise exception 'CART_OTHER_EVENT';
  end if;

  select coalesce(quantity, 0) into mine
  from public.cart_items where user_id = uid and ticket_type_id = tt.id;
  mine := coalesce(mine, 0);

  select coalesce(sum(quantity), 0) into in_basket
  from public.cart_items
  where user_id = uid and expires_at > now() and ticket_type_id <> tt.id;

  wanted := mine + p_quantity;

  if wanted > tt.max_per_order then
    raise exception 'QUANTITY_ABOVE_LIMIT';
  end if;
  if in_basket + wanted > cap then
    raise exception 'CART_LIMIT_REACHED';
  end if;

  others := public.held_quantity(tt.id, uid);
  if tt.quantity_sold + others + wanted > tt.quantity_total then
    raise exception 'SOLD_OUT';
  end if;

  insert into public.cart_items (user_id, event_id, ticket_type_id, quantity, expires_at)
  values (uid, ev.id, tt.id, wanted, now() + make_interval(mins => hold))
  on conflict (user_id, ticket_type_id) do update
    set quantity = excluded.quantity,
        -- Touching the basket restarts the clock for the whole basket, which is
        -- what a shopper expects and what every ticketing site does.
        expires_at = excluded.expires_at;

  update public.cart_items
  set expires_at = now() + make_interval(mins => hold)
  where user_id = uid;

  return public.cart_view(null);
end;
$$;

create or replace function public.cart_set_quantity(
  p_ticket_type_id uuid,
  p_quantity       integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  delete from public.cart_items where user_id = uid and ticket_type_id = p_ticket_type_id;

  if p_quantity is null or p_quantity < 1 then
    return public.cart_view(null);
  end if;

  return public.cart_add(p_ticket_type_id, p_quantity);
end;
$$;

create or replace function public.cart_remove(p_ticket_type_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'AUTH_REQUIRED';
  end if;
  delete from public.cart_items where user_id = uid and ticket_type_id = p_ticket_type_id;
  return public.cart_view(null);
end;
$$;

create or replace function public.cart_clear()
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'AUTH_REQUIRED';
  end if;
  delete from public.cart_items where user_id = uid;
  return public.cart_view(null);
end;
$$;

-- ---------------------------------------------------------------------------
-- What the basket costs
-- ---------------------------------------------------------------------------
-- The same arithmetic the order will use, so the number on the basket page and
-- the number on the card statement are the same number.
create or replace function public.cart_view(p_promo_code text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  uid       uuid := auth.uid();
  limits    jsonb;
  ev        record;
  fees      jsonb;
  lines     jsonb := '[]'::jsonb;
  line      record;
  quantity  integer := 0;
  subtotal  integer := 0;
  discount  integer := 0;
  net       integer;
  archive   integer := 0;
  commis    integer;
  payer     text;
  promo     jsonb;
  promo_err text;
  expires   timestamptz;
  currency  text := 'EUR';
begin
  limits := public.cart_limits();

  if uid is null then
    return jsonb_build_object(
      'lines', lines, 'quantity', 0, 'total_cents', 0, 'currency', currency,
      'limits', limits, 'event', null, 'expires_at', null, 'seconds_left', 0
    );
  end if;

  select min(c.expires_at) into expires
  from public.cart_items c
  where c.user_id = uid and c.expires_at > now();

  select e.* into ev
  from public.events e
  join public.cart_items c on c.event_id = e.id
  where c.user_id = uid and c.expires_at > now()
  limit 1;

  if not found then
    return jsonb_build_object(
      'lines', lines, 'quantity', 0, 'subtotal_cents', 0, 'discount_cents', 0,
      'archive_fee_cents', 0, 'total_cents', 0, 'currency', currency,
      'limits', limits, 'event', null, 'expires_at', null, 'seconds_left', 0
    );
  end if;

  fees  := public.resolve_fees(ev.organization_id);
  payer := fees->>'archive_fee_payer';

  for line in
    select c.ticket_type_id, c.quantity, c.expires_at,
           tt.name, tt.price_cents, tt.currency, tt.max_per_order,
           greatest(tt.quantity_total - tt.quantity_sold - public.held_quantity(tt.id, uid), 0) as available
    from public.cart_items c
    join public.ticket_types tt on tt.id = c.ticket_type_id
    where c.user_id = uid and c.expires_at > now()
    order by tt.price_cents desc, tt.name asc
  loop
    quantity := quantity + line.quantity;
    subtotal := subtotal + line.price_cents * line.quantity;
    currency := line.currency;

    lines := lines || jsonb_build_object(
      'ticket_type_id', line.ticket_type_id,
      'name',           line.name,
      'quantity',       line.quantity,
      'unit_price_cents', line.price_cents,
      'line_total_cents', line.price_cents * line.quantity,
      'max_per_order',  least(line.max_per_order, (limits->>'max_tickets_per_order')::integer),
      'available',      line.available,
      'currency',       line.currency
    );
  end loop;

  if p_promo_code is not null and btrim(p_promo_code) <> '' then
    promo := public.evaluate_promo_code(ev.id, btrim(p_promo_code), subtotal);
    if (promo->>'valid')::boolean then
      discount := (promo->>'amount_off')::integer;
    else
      promo_err := promo->>'reason';
    end if;
  end if;

  net     := greatest(subtotal - discount, 0);
  archive := case when net > 0
                  then (fees->>'archive_fee_cents')::integer * quantity
                  else 0 end;
  commis  := (net * (fees->>'platform_fee_bps')::integer) / 10000;

  return jsonb_build_object(
    'event', jsonb_build_object(
      'id', ev.id, 'title', ev.title, 'start_at', ev.start_at,
      'venue_name', ev.venue_name, 'city', ev.city, 'cover_image_url', ev.cover_image_url
    ),
    'lines',             lines,
    'quantity',          quantity,
    'subtotal_cents',    subtotal,
    'discount_cents',    discount,
    'promo_error',       promo_err,
    'archive_fee_cents', case when payer = 'buyer' then archive else 0 end,
    'commission_cents',  commis,
    'total_cents',       net + case when payer = 'buyer' then archive else 0 end,
    'currency',          currency,
    'expires_at',        expires,
    'seconds_left',      greatest(extract(epoch from (expires - now()))::integer, 0),
    'limits',            limits
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Checkouts — one payment, many orders
-- ---------------------------------------------------------------------------
create table if not exists public.checkouts (
  id                 uuid primary key default gen_random_uuid(),
  buyer_id           uuid not null references public.profiles (id) on delete restrict,
  event_id           uuid not null references public.events (id) on delete restrict,
  organization_id    uuid references public.organizations (id) on delete set null,
  status             text not null default 'pending'
                     check (status in ('pending', 'paid', 'cancelled', 'expired', 'failed')),
  quantity           integer not null check (quantity between 1 and 100),
  subtotal_cents     integer not null check (subtotal_cents >= 0),
  discount_cents     integer not null default 0 check (discount_cents >= 0),
  commission_cents   integer not null default 0 check (commission_cents >= 0),
  archive_fee_cents  integer not null default 0 check (archive_fee_cents >= 0),
  total_cents        integer not null check (total_cents >= 0),
  currency           text not null check (char_length(currency) = 3),
  provider           payment_provider not null default 'stripe',
  provider_reference text,
  promo_code_id      uuid references public.promo_codes (id) on delete set null,
  expires_at         timestamptz not null default now() + interval '30 minutes',
  paid_at            timestamptz,
  failure_reason     text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create unique index if not exists checkouts_provider_reference_key
  on public.checkouts (provider, provider_reference)
  where provider_reference is not null;
create index if not exists checkouts_buyer_idx on public.checkouts (buyer_id, created_at desc);

drop trigger if exists checkouts_set_updated_at on public.checkouts;
create trigger checkouts_set_updated_at
  before update on public.checkouts
  for each row execute function public.set_updated_at();

alter table public.checkouts enable row level security;

drop policy if exists checkouts_select on public.checkouts;
create policy checkouts_select on public.checkouts
  for select using (buyer_id = auth.uid() or public.is_admin());

alter table public.orders
  add column if not exists checkout_id uuid references public.checkouts (id) on delete set null;
create index if not exists orders_checkout_idx on public.orders (checkout_id);

-- ---------------------------------------------------------------------------
-- create_order gains a service-role-only discount override
-- ---------------------------------------------------------------------------
-- A basket's promo code is evaluated once for the whole basket, so the per-line
-- orders are told what their share is instead of each re-evaluating the code
-- and each consuming a use of it.
drop function if exists public.create_order(uuid, uuid, integer, text);

create or replace function public.create_order(
  p_buyer_id          uuid,
  p_ticket_type_id    uuid,
  p_quantity          integer,
  p_promo_code        text default null,
  p_discount_override integer default null,
  p_promo_code_id     uuid default null,
  p_checkout_id       uuid default null
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
  new_order public.orders;
begin
  if p_quantity is null or p_quantity < 1 then
    raise exception 'INVALID_QUANTITY';
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
    checkout_id
  )
  values (
    ev.id, ev.organization_id, tt.id, p_buyer_id, p_quantity,
    tt.price_cents, subtotal, discount, promo_id,
    commis, archive, payer,
    commis + case when payer = 'organizer' then archive else 0 end,
    net + case when payer = 'buyer' then archive else 0 end,
    tt.currency, 'requires_payment', org.payment_provider,
    p_checkout_id
  )
  returning * into new_order;

  -- The basket path counts the code once, in create_checkout().
  if promo_id is not null and p_discount_override is null then
    update public.promo_codes
      set used_count = used_count + 1
      where id = promo_id;
  end if;

  -- The basket path records one redemption for the whole basket in
  -- create_checkout(); a single-line order records its own here.
  if promo_id is not null and discount > 0 and p_discount_override is null then
    insert into public.promo_redemptions (promo_code_id, order_id, user_id, amount_off)
    values (promo_id, new_order.id, p_buyer_id, discount);
  end if;

  return new_order;
end;
$$;

-- ---------------------------------------------------------------------------
-- Basket -> orders
-- ---------------------------------------------------------------------------
create or replace function public.create_checkout(
  p_buyer_id   uuid,
  p_promo_code text default null
)
returns public.checkouts
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  cap        integer;
  ev         record;
  fees       jsonb;
  payer      text;
  line       record;
  quantity   integer := 0;
  subtotal   integer := 0;
  discount   integer := 0;
  promo      jsonb;
  promo_id   uuid;
  co         public.checkouts;
  ord        public.orders;
  share      integer;
  assigned   integer := 0;
  idx        integer := 0;
  n_lines    integer;
  sum_sub    integer := 0;
  sum_comm   integer := 0;
  sum_arch   integer := 0;
  sum_total  integer := 0;
  cur        text := 'EUR';
begin
  if p_buyer_id is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  perform public.release_expired_holds();

  cap := (public.cart_limits()->>'max_tickets_per_order')::integer;

  select e.* into ev
  from public.events e
  join public.cart_items c on c.event_id = e.id
  where c.user_id = p_buyer_id and c.expires_at > now()
  limit 1;

  if not found then
    raise exception 'CART_EMPTY';
  end if;

  select coalesce(sum(c.quantity), 0), coalesce(sum(tt.price_cents * c.quantity), 0), count(*)
    into quantity, subtotal, n_lines
  from public.cart_items c
  join public.ticket_types tt on tt.id = c.ticket_type_id
  where c.user_id = p_buyer_id and c.expires_at > now();

  if quantity < 1 then
    raise exception 'CART_EMPTY';
  end if;
  if quantity > cap then
    raise exception 'CART_LIMIT_REACHED';
  end if;

  fees  := public.resolve_fees(ev.organization_id);
  payer := fees->>'archive_fee_payer';

  if p_promo_code is not null and btrim(p_promo_code) <> '' then
    promo := public.evaluate_promo_code(ev.id, btrim(p_promo_code), subtotal);
    if not (promo->>'valid')::boolean then
      raise exception '%', promo->>'reason';
    end if;
    discount := (promo->>'amount_off')::integer;
    promo_id := (promo->>'promo_code_id')::uuid;
  end if;

  insert into public.checkouts (
    buyer_id, event_id, organization_id, quantity, subtotal_cents, discount_cents,
    total_cents, currency, promo_code_id, provider
  )
  values (
    p_buyer_id, ev.id, ev.organization_id, quantity, subtotal, discount,
    0, coalesce((select default_currency from public.organizations where id = ev.organization_id), 'EUR'),
    promo_id,
    coalesce((select payment_provider from public.organizations where id = ev.organization_id), 'stripe')
  )
  returning * into co;

  -- Largest-remainder split of the basket discount across the lines. Ordered by
  -- line value so the rounding cent lands on the biggest line, and the last
  -- line takes whatever is left so the parts sum to the whole exactly.
  for line in
    select c.ticket_type_id, c.quantity, tt.price_cents,
           tt.price_cents * c.quantity as line_subtotal
    from public.cart_items c
    join public.ticket_types tt on tt.id = c.ticket_type_id
    where c.user_id = p_buyer_id and c.expires_at > now()
    order by tt.price_cents * c.quantity desc, c.ticket_type_id
  loop
    idx := idx + 1;

    if discount = 0 or subtotal = 0 then
      share := 0;
    elsif idx = n_lines then
      share := discount - assigned;
    else
      share := (discount * line.line_subtotal) / subtotal;
    end if;
    assigned := assigned + share;

    ord := public.create_order(
      p_buyer_id          => p_buyer_id,
      p_ticket_type_id    => line.ticket_type_id,
      p_quantity          => line.quantity,
      p_promo_code        => null,
      p_discount_override => case when discount > 0 then share else null end,
      p_promo_code_id     => case when discount > 0 then promo_id else null end,
      p_checkout_id       => co.id
    );

    sum_sub   := sum_sub + ord.subtotal_cents;
    sum_comm  := sum_comm + ord.commission_cents;
    sum_arch  := sum_arch + ord.archive_fee_cents;
    sum_total := sum_total + ord.total_cents;
    cur       := ord.currency;
  end loop;

  if promo_id is not null then
    update public.promo_codes set used_count = used_count + 1 where id = promo_id;

    insert into public.promo_redemptions (promo_code_id, order_id, user_id, amount_off)
    select promo_id, o.id, p_buyer_id, discount
    from public.orders o
    where o.checkout_id = co.id
    order by o.created_at, o.id
    limit 1;
  end if;

  update public.checkouts
  set subtotal_cents    = sum_sub,
      commission_cents  = sum_comm,
      archive_fee_cents = case when payer = 'buyer' then sum_arch else 0 end,
      total_cents       = sum_total,
      currency          = cur
  where id = co.id
  returning * into co;

  -- The basket has become orders; the reservation now lives on the orders.
  delete from public.cart_items where user_id = p_buyer_id;

  return co;
end;
$$;

-- ---------------------------------------------------------------------------
-- One payment fulfils every order in the checkout
-- ---------------------------------------------------------------------------
create or replace function public.fulfill_checkout(
  p_checkout_id        uuid,
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
  co  public.checkouts;
  ord public.orders;
  n   integer := 0;
begin
  select * into co from public.checkouts where id = p_checkout_id for update;
  if not found then
    raise exception 'CHECKOUT_NOT_FOUND';
  end if;

  if co.status = 'paid' then
    return query
      select t.* from public.tickets t
      join public.orders o on o.id = t.order_id
      where o.checkout_id = co.id;
    return;
  end if;

  if p_amount_cents is not null and p_amount_cents <> co.total_cents then
    raise exception 'AMOUNT_MISMATCH: expected % got %', co.total_cents, p_amount_cents;
  end if;

  update public.checkouts
  set status = 'paid',
      provider = p_provider,
      provider_reference = coalesce(p_provider_reference, provider_reference),
      paid_at = now()
  where id = co.id;

  -- Each order keeps its own reference so the unique index on (provider,
  -- reference) stays meaningful and a refund can still be traced back to the
  -- one payment: `pi_123#1`, `pi_123#2`, ...
  for ord in
    select * from public.orders where checkout_id = co.id order by created_at, id
  loop
    n := n + 1;
    perform public.fulfill_order(
      ord.id, p_provider,
      case when p_provider_reference is null then null
           else p_provider_reference || '#' || n end,
      ord.total_cents
    );
  end loop;

  return query
    select t.* from public.tickets t
    join public.orders o on o.id = t.order_id
    where o.checkout_id = co.id;
end;
$$;

create or replace function public.fail_checkout(p_checkout_id uuid, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  ord public.orders;
begin
  update public.checkouts
  set status = 'failed', failure_reason = p_reason
  where id = p_checkout_id and status = 'pending';

  for ord in select * from public.orders where checkout_id = p_checkout_id loop
    perform public.fail_order(ord.id, p_reason);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
do $$
declare
  fn text;
  service_only text[] := array[
    'public.create_order(uuid, uuid, integer, text, integer, uuid, uuid)',
    'public.create_checkout(uuid, text)',
    'public.fulfill_checkout(uuid, payment_provider, text, integer)',
    'public.fail_checkout(uuid, text)',
    'public.release_expired_holds()'
  ];
begin
  foreach fn in array service_only loop
    if to_regprocedure(fn) is not null then
      execute format('revoke all on function %s from public', fn);
      if exists (select 1 from pg_roles where rolname = 'anon') then
        execute format('revoke all on function %s from anon', fn);
      end if;
      if exists (select 1 from pg_roles where rolname = 'authenticated') then
        execute format('revoke all on function %s from authenticated', fn);
      end if;
      if exists (select 1 from pg_roles where rolname = 'service_role') then
        execute format('grant execute on function %s to service_role', fn);
      end if;
    end if;
  end loop;

  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    -- The basket itself is the caller's own: these authorize on auth.uid().
    execute 'grant execute on function
               public.cart_add(uuid, integer),
               public.cart_set_quantity(uuid, integer),
               public.cart_remove(uuid),
               public.cart_clear(),
               public.cart_view(text),
               public.cart_limits(),
               public.ticket_type_availability(uuid)
             to authenticated';
    execute 'revoke insert, update, delete on public.checkouts from authenticated';
    execute 'revoke update on public.cart_items from authenticated';
    execute 'revoke insert on public.cart_items from authenticated';
  end if;

  if exists (select 1 from pg_roles where rolname = 'anon') then
    -- A visitor may see how many are left before deciding to sign up.
    execute 'grant execute on function
               public.ticket_type_availability(uuid), public.cart_limits()
             to anon';
    execute 'revoke all on public.cart_items, public.checkouts from anon';
  end if;
end
$$;
