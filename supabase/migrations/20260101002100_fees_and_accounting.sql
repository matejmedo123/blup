-- ============================================================================
-- BLUP · 0021 · Platform fee model + accounting export
-- ============================================================================
-- Two things happen here.
--
-- 1. The fee becomes a fixed, stated pair instead of a per-organization guess:
--
--        commission     4.00 % of what the buyer actually pays for tickets
--        archive fee    1.00 € per ticket
--
--    Both are BLUP's revenue. They are stored once in `platform_settings` so
--    changing the price is an UPDATE, not a migration, and an organization may
--    still carry a negotiated override.
--
--    Who pays the archive fee is a deliberate, recorded decision rather than an
--    accident of arithmetic: by default the buyer does, as a visible line on
--    the checkout, which is how every ticketing platform states it and which
--    keeps a 3 € ticket from arriving at the organizer as 1.88 €. Flipping
--    `archive_fee_payer` to 'organizer' moves it to the organizer's side of the
--    ledger without touching a single line of application code.
--
--    The money always balances:
--
--        buyer pays      = net + archive fee   (when the buyer carries it)
--        organizer gets  = net − commission − archive fee (when they carry it)
--        BLUP keeps      = commission + archive fee, always
--
-- 2. Everything needed to hand an accountant a file: per-order rows, the raw
--    ledger with a running balance, and a monthly summary — as SQL functions
--    so the CSV is rendered from one authoritative source and not re-derived
--    in the app.
--
-- It also fixes a real accounting bug that predates it. `fulfill_order` used to
-- credit the organizer `subtotal_cents` — the list price — while the buyer had
-- only paid `subtotal − discount`. Every promo code therefore credited money
-- that was never collected. The ledger now moves `net_cents`, which is what
-- actually arrived.
-- ============================================================================

set search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- Platform-wide settings (single row)
-- ---------------------------------------------------------------------------
create table if not exists public.platform_settings (
  id                 boolean primary key default true check (id),
  -- 400 = 4.00 %
  platform_fee_bps   integer not null default 400 check (platform_fee_bps between 0 and 2000),
  -- charged once per ticket, in minor units (100 = 1.00 €)
  archive_fee_cents  integer not null default 100 check (archive_fee_cents >= 0),
  -- 'buyer'  -> added on top of the ticket price, shown at checkout
  -- 'organizer' -> deducted from the organizer's proceeds
  archive_fee_payer  text not null default 'buyer' check (archive_fee_payer in ('buyer', 'organizer')),
  settlement_days    integer not null default 7 check (settlement_days between 0 and 90),
  default_currency   text not null default 'EUR' check (char_length(default_currency) = 3),
  updated_at         timestamptz not null default now(),
  updated_by         uuid references public.profiles (id) on delete set null
);

insert into public.platform_settings (id) values (true) on conflict (id) do nothing;

alter table public.platform_settings enable row level security;

drop policy if exists platform_settings_select on public.platform_settings;
create policy platform_settings_select on public.platform_settings
  for select using (true);

drop policy if exists platform_settings_write on public.platform_settings;
create policy platform_settings_write on public.platform_settings
  for all using (public.is_full_admin()) with check (public.is_full_admin());

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke insert, update, delete on public.platform_settings from authenticated';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Organization-level overrides
--
-- `platform_fee_bps` stops being "300 unless someone changed it" and becomes a
-- true override: null means "use the platform setting". Rows still sitting on
-- the old 3 % default are moved to null so they pick up the new 4 %; a rate
-- that was deliberately negotiated to something else is left alone.
-- ---------------------------------------------------------------------------
alter table public.organizations alter column platform_fee_bps drop not null;
alter table public.organizations alter column platform_fee_bps set default null;
update public.organizations set platform_fee_bps = null where platform_fee_bps = 300;

alter table public.organizations
  add column if not exists archive_fee_cents integer
    check (archive_fee_cents is null or archive_fee_cents >= 0);

-- The same trigger that stops an organizer from verifying themselves must stop
-- them from setting their own archive fee to zero.
create or replace function public.protect_organization_privileges()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if auth.uid() is not null and not public.is_admin() then
    new.verification_status := old.verification_status;
    new.payouts_enabled     := old.payouts_enabled;
    new.charges_enabled     := old.charges_enabled;
    new.platform_fee_bps    := old.platform_fee_bps;
    new.archive_fee_cents   := old.archive_fee_cents;
    new.stripe_account_id   := old.stripe_account_id;
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Order columns
--
-- platform_fee_cents keeps its old meaning — what is deducted from the
-- organizer — so every existing view and report stays correct. What BLUP
-- actually earns is `blup_revenue_cents`, which is the two components added
-- together no matter who was billed for them.
-- ---------------------------------------------------------------------------
alter table public.orders
  add column if not exists commission_cents integer not null default 0
    check (commission_cents >= 0);

alter table public.orders
  add column if not exists archive_fee_cents integer not null default 0
    check (archive_fee_cents >= 0);

alter table public.orders
  add column if not exists archive_fee_payer text not null default 'buyer'
    check (archive_fee_payer in ('buyer', 'organizer'));

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'orders' and column_name = 'net_cents'
  ) then
    execute 'alter table public.orders
             add column net_cents integer
             generated always as (subtotal_cents - discount_cents) stored';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'orders' and column_name = 'blup_revenue_cents'
  ) then
    execute 'alter table public.orders
             add column blup_revenue_cents integer
             generated always as (commission_cents + archive_fee_cents) stored';
  end if;
end
$$;

-- Orders written before this migration carried the whole fee in one column.
update public.orders
  set commission_cents = platform_fee_cents
  where commission_cents = 0 and platform_fee_cents > 0;

-- ---------------------------------------------------------------------------
-- Fee resolution
-- ---------------------------------------------------------------------------

/**
 * The fee schedule that applies to one organization: the platform values,
 * with any negotiated override laid on top.
 */
create or replace function public.resolve_fees(p_organization_id uuid default null)
returns jsonb
language sql
stable
security definer
set search_path = public, extensions
as $$
  select jsonb_build_object(
    'platform_fee_bps',  coalesce(org.platform_fee_bps, s.platform_fee_bps),
    'archive_fee_cents', coalesce(org.archive_fee_cents, s.archive_fee_cents),
    'archive_fee_payer', s.archive_fee_payer,
    'settlement_days',   s.settlement_days,
    'currency',          coalesce(org.default_currency, s.default_currency)
  )
  from public.platform_settings s
  left join public.organizations org on org.id = p_organization_id
  where s.id;
$$;

/**
 * Prices a basket without creating anything, so checkout can show the archive
 * fee before the buyer commits. Same arithmetic as create_order() — one place
 * decides what a ticket costs, and the app never adds numbers of its own.
 *
 * Returns `valid: false` with a `reason` instead of raising, because a bad
 * promo code is a normal thing for a user to type, not an exception.
 */
create or replace function public.quote_order(
  p_ticket_type_id uuid,
  p_quantity       integer,
  p_promo_code     text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  tt       record;
  ev       record;
  fees     jsonb;
  subtotal integer;
  discount integer := 0;
  net      integer;
  archive  integer;
  commis   integer;
  promo    jsonb;
  reason   text;
begin
  if p_quantity is null or p_quantity < 1 then
    return jsonb_build_object('valid', false, 'reason', 'INVALID_QUANTITY');
  end if;

  select * into tt from public.ticket_types where id = p_ticket_type_id;
  if not found then
    return jsonb_build_object('valid', false, 'reason', 'TICKET_TYPE_NOT_FOUND');
  end if;

  select * into ev from public.events where id = tt.event_id;

  if not tt.is_active then
    reason := 'TICKET_TYPE_INACTIVE';
  elsif p_quantity > tt.max_per_order then
    reason := 'QUANTITY_ABOVE_LIMIT';
  elsif tt.sales_start_at is not null and now() < tt.sales_start_at then
    reason := 'SALES_NOT_STARTED';
  elsif tt.sales_end_at is not null and now() > tt.sales_end_at then
    reason := 'SALES_ENDED';
  elsif tt.quantity_sold + p_quantity > tt.quantity_total then
    reason := 'SOLD_OUT';
  elsif ev.status <> 'published' then
    reason := 'EVENT_NOT_AVAILABLE';
  end if;

  fees     := public.resolve_fees(ev.organization_id);
  subtotal := tt.price_cents * p_quantity;

  if p_promo_code is not null and btrim(p_promo_code) <> '' then
    promo := public.evaluate_promo_code(ev.id, btrim(p_promo_code), subtotal);
    if (promo->>'valid')::boolean then
      discount := (promo->>'amount_off')::integer;
    else
      reason := coalesce(reason, promo->>'reason');
    end if;
  end if;

  net := greatest(subtotal - discount, 0);

  -- A free ticket stays free. The archive fee pays for keeping a paid ticket's
  -- record and receipt, so charging it on a zero-price ticket would be a fee
  -- for nothing.
  archive := case when net > 0
                  then (fees->>'archive_fee_cents')::integer * p_quantity
                  else 0 end;
  commis  := (net * (fees->>'platform_fee_bps')::integer) / 10000;

  return jsonb_build_object(
    'valid',              reason is null,
    'reason',             reason,
    'ticket_type_id',     tt.id,
    'event_id',           tt.event_id,
    'quantity',           p_quantity,
    'unit_price_cents',   tt.price_cents,
    'subtotal_cents',     subtotal,
    'discount_cents',     discount,
    'net_cents',          net,
    'archive_fee_cents',  archive,
    'archive_fee_payer',  fees->>'archive_fee_payer',
    'commission_cents',   commis,
    'platform_fee_bps',   (fees->>'platform_fee_bps')::integer,
    'buyer_total_cents',  net + case when fees->>'archive_fee_payer' = 'buyer' then archive else 0 end,
    'organizer_net_cents', net - commis - case when fees->>'archive_fee_payer' = 'organizer' then archive else 0 end,
    'blup_revenue_cents', commis + archive,
    'currency',           tt.currency,
    'promo',              promo
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Order creation on the new schedule
-- ---------------------------------------------------------------------------
create or replace function public.create_order(
  p_buyer_id       uuid,
  p_ticket_type_id uuid,
  p_quantity       integer,
  p_promo_code     text default null
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
  subtotal  integer;
  discount  integer := 0;
  net       integer;
  archive   integer;
  commis    integer;
  payer     text;
  promo     jsonb;
  promo_id  uuid;
  new_order public.orders;
begin
  if p_quantity is null or p_quantity < 1 then
    raise exception 'INVALID_QUANTITY';
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
  if tt.quantity_sold + p_quantity > tt.quantity_total then
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

  if p_promo_code is not null and btrim(p_promo_code) <> '' then
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
    platform_fee_cents, total_cents, currency, payment_status, provider
  )
  values (
    ev.id, ev.organization_id, tt.id, p_buyer_id, p_quantity,
    tt.price_cents, subtotal, discount, promo_id,
    commis, archive, payer,
    -- what the organizer is charged
    commis + case when payer = 'organizer' then archive else 0 end,
    -- what the buyer is charged
    net + case when payer = 'buyer' then archive else 0 end,
    tt.currency, 'requires_payment', org.payment_provider
  )
  returning * into new_order;

  if promo_id is not null then
    update public.promo_codes
      set used_count = used_count + 1
      where id = promo_id;

    insert into public.promo_redemptions (promo_code_id, order_id, user_id, amount_off)
    values (promo_id, new_order.id, p_buyer_id, discount);
  end if;

  return new_order;
end;
$$;

-- ---------------------------------------------------------------------------
-- Fulfilment — ledger now moves what was actually collected
-- ---------------------------------------------------------------------------
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
  o        public.orders;
  i        integer;
  settle   integer;
begin
  select * into o from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'ORDER_NOT_FOUND';
  end if;

  -- Already fulfilled: return the existing tickets instead of duplicating.
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
    settle := (public.resolve_fees(o.organization_id)->>'settlement_days')::integer;

    -- The sale credits what the buyer actually paid for tickets — net of any
    -- promo discount, and without the archive fee, which never belonged to the
    -- organizer in the first place.
    insert into public.ledger_entries (organization_id, event_id, order_id, type, amount_cents, currency, description, available_at)
    values (o.organization_id, o.event_id, o.id, 'sale', o.net_cents, o.currency,
            'Ticket sale x' || o.quantity, now() + make_interval(days => settle));

    if o.commission_cents > 0 then
      insert into public.ledger_entries (organization_id, event_id, order_id, type, amount_cents, currency, description, available_at)
      values (o.organization_id, o.event_id, o.id, 'platform_fee', -o.commission_cents, o.currency,
              'BLUP commission', now() + make_interval(days => settle));
    end if;

    if o.archive_fee_payer = 'organizer' and o.archive_fee_cents > 0 then
      insert into public.ledger_entries (organization_id, event_id, order_id, type, amount_cents, currency, description, available_at)
      values (o.organization_id, o.event_id, o.id, 'platform_fee', -o.archive_fee_cents, o.currency,
              'BLUP archive fee x' || o.quantity, now() + make_interval(days => settle));
    end if;
  end if;

  -- Buying a ticket implies attendance.
  insert into public.event_attendees (event_id, user_id, status)
  values (o.event_id, o.buyer_id, 'going')
  on conflict (event_id, user_id) do update set status = 'going';

  insert into public.notifications (user_id, type, title, body, event_id, data)
  values (
    o.buyer_id, 'ticket_confirmed', 'Ticket confirmed',
    'Your ticket is ready. Show the QR code at the door.',
    o.event_id, jsonb_build_object('order_id', o.id)
  );

  return query select * from public.tickets t where t.order_id = o.id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Refunds — a refunded order earns BLUP nothing
-- ---------------------------------------------------------------------------
create or replace function public.refund_order(p_order_id uuid, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  o public.orders;
begin
  select * into o from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'ORDER_NOT_FOUND';
  end if;
  if o.payment_status <> 'succeeded' then
    raise exception 'ORDER_NOT_REFUNDABLE';
  end if;

  update public.orders
  set payment_status = 'refunded', refunded_at = now(), failure_reason = p_reason
  where id = o.id;

  update public.tickets set status = 'refunded' where order_id = o.id and status = 'valid';

  if o.organization_id is not null then
    insert into public.ledger_entries (organization_id, event_id, order_id, type, amount_cents, currency, description, available_at)
    values (o.organization_id, o.event_id, o.id, 'refund', -o.net_cents, o.currency, 'Refund', now());

    if o.platform_fee_cents > 0 then
      insert into public.ledger_entries (organization_id, event_id, order_id, type, amount_cents, currency, description, available_at)
      values (o.organization_id, o.event_id, o.id, 'adjustment', o.platform_fee_cents, o.currency,
              'BLUP fee reversal', now());
    end if;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Balances, now split so an organizer can see the two fees apart
-- ---------------------------------------------------------------------------
drop view if exists public.organization_balances;
create view public.organization_balances
with (security_invoker = true)
as
select
  o.id as organization_id,
  o.default_currency as currency,
  coalesce(sum(l.amount_cents), 0)::bigint as balance_cents,
  coalesce(sum(l.amount_cents) filter (where l.available_at <= now()), 0)::bigint as available_cents,
  coalesce(sum(l.amount_cents) filter (where l.available_at > now()), 0)::bigint as pending_cents,
  coalesce(sum(l.amount_cents) filter (where l.type = 'sale'), 0)::bigint as gross_sales_cents,
  coalesce(-sum(l.amount_cents) filter (where l.type = 'platform_fee'), 0)::bigint as platform_fee_cents,
  coalesce(-sum(l.amount_cents) filter (where l.type = 'platform_fee' and l.description like 'BLUP commission%'), 0)::bigint as commission_cents,
  coalesce(-sum(l.amount_cents) filter (where l.type = 'platform_fee' and l.description like 'BLUP archive fee%'), 0)::bigint as archive_fee_cents,
  coalesce(-sum(l.amount_cents) filter (where l.type = 'refund'), 0)::bigint as refunded_cents,
  coalesce(-sum(l.amount_cents) filter (where l.type = 'payout'), 0)::bigint as paid_out_cents
from public.organizations o
left join public.ledger_entries l on l.organization_id = o.id
group by o.id, o.default_currency;


-- ---------------------------------------------------------------------------
-- Accounting export
--
-- Three views of the same money, all server-side so the CSV an accountant gets
-- and the numbers the organizer sees in the app can never disagree:
--
--   accounting_orders   one row per order — the sales journal
--   accounting_ledger   every ledger movement with a running balance
--   accounting_summary  one row per month — what goes on a tax return
--
-- Each one is SECURITY DEFINER and asks whether the caller may see this
-- organization's finances *before* it reads a row. The check is a statement,
-- not a WHERE predicate: a predicate is only evaluated if the planner decides
-- to evaluate it, and an authorization rule the optimizer is allowed to skip
-- is not an authorization rule.
-- ---------------------------------------------------------------------------

/**
 * Raises unless the caller may read this organization's money. Owner, admin and
 * finance roles qualify, as does a BLUP admin. A service-role call (auth.uid()
 * is null) is the Edge Function acting on a request it has already authorized.
 */
create or replace function public.assert_can_read_finances(p_organization_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
begin
  if auth.uid() is null then
    return;
  end if;
  if public.is_admin() then
    return;
  end if;
  if public.is_org_member(p_organization_id, array['owner', 'admin', 'finance']::org_role[]) then
    return;
  end if;
  raise exception 'NOT_AUTHORIZED';
end;
$$;

/**
 * The sales journal. One row per order, in the order they were paid.
 *
 * `p_from` and `p_to` are inclusive dates in UTC; null means unbounded. Only
 * orders that reached a terminal money state are listed — a basket abandoned at
 * the payment sheet is not a business event.
 */
create or replace function public.accounting_orders(
  p_organization_id uuid,
  p_from            date default null,
  p_to              date default null
)
returns table (
  paid_on             date,
  paid_at             timestamptz,
  order_id            uuid,
  provider_reference  text,
  event_title         text,
  ticket_type         text,
  quantity            integer,
  unit_price_cents    integer,
  subtotal_cents      integer,
  discount_cents      integer,
  promo_code          text,
  net_cents           integer,
  commission_cents    integer,
  archive_fee_cents   integer,
  archive_fee_payer   text,
  buyer_paid_cents    integer,
  organizer_net_cents integer,
  blup_revenue_cents  integer,
  currency            text,
  status              text
)
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
begin
  perform public.assert_can_read_finances(p_organization_id);

  return query
  select
    (coalesce(o.paid_at, o.created_at) at time zone 'UTC')::date,
    o.paid_at,
    o.id,
    o.provider_reference,
    ev.title,
    tt.name,
    o.quantity,
    o.unit_price_cents,
    o.subtotal_cents,
    o.discount_cents,
    pc.code::text,
    o.net_cents,
    o.commission_cents,
    o.archive_fee_cents,
    o.archive_fee_payer,
    o.total_cents,
    o.net_cents - o.platform_fee_cents,
    o.blup_revenue_cents,
    o.currency,
    o.payment_status::text
  from public.orders o
  join public.events ev on ev.id = o.event_id
  join public.ticket_types tt on tt.id = o.ticket_type_id
  left join public.promo_codes pc on pc.id = o.promo_code_id
  where o.organization_id = p_organization_id
    and o.payment_status in ('succeeded', 'refunded')
    and (p_from is null or (coalesce(o.paid_at, o.created_at) at time zone 'UTC')::date >= p_from)
    and (p_to   is null or (coalesce(o.paid_at, o.created_at) at time zone 'UTC')::date <= p_to)
  order by o.paid_at nulls last, o.created_at;
end;
$$;

/**
 * Every movement on the organization's balance, with the running total after
 * each one — the form a bookkeeper expects to reconcile against a bank
 * statement.
 *
 * The running total is computed over the whole history and only then filtered
 * to the requested period, so the first row of a March export opens at the
 * balance February actually closed on rather than at zero.
 */
create or replace function public.accounting_ledger(
  p_organization_id uuid,
  p_from            date default null,
  p_to              date default null
)
returns table (
  booked_on     date,
  created_at    timestamptz,
  entry_id      uuid,
  entry_type    text,
  description   text,
  event_title   text,
  order_id      uuid,
  payout_id     uuid,
  amount_cents  integer,
  balance_cents bigint,
  available_on  date,
  currency      text
)
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
begin
  perform public.assert_can_read_finances(p_organization_id);

  return query
  with entries as (
    select
      l.*,
      sum(l.amount_cents) over (order by l.created_at, l.id
                                rows between unbounded preceding and current row) as running
    from public.ledger_entries l
    where l.organization_id = p_organization_id
  )
  select
    (e.created_at at time zone 'UTC')::date,
    e.created_at,
    e.id,
    e.type::text,
    e.description,
    ev.title,
    e.order_id,
    e.payout_id,
    e.amount_cents,
    e.running::bigint,
    (e.available_at at time zone 'UTC')::date,
    e.currency
  from entries e
  left join public.events ev on ev.id = e.event_id
  where (p_from is null or (e.created_at at time zone 'UTC')::date >= p_from)
    and (p_to   is null or (e.created_at at time zone 'UTC')::date <= p_to)
  order by e.created_at, e.id;
end;
$$;

/**
 * One row per calendar month: what was sold, what BLUP took, what is left.
 * No running balance here on purpose — a month is a period, not a point, and a
 * closing balance belongs to the ledger export.
 */
create or replace function public.accounting_summary(
  p_organization_id uuid,
  p_from            date default null,
  p_to              date default null
)
returns table (
  period              text,
  orders_count        bigint,
  tickets_count       bigint,
  gross_cents         bigint,
  discount_cents      bigint,
  net_cents           bigint,
  commission_cents    bigint,
  archive_fee_cents   bigint,
  blup_revenue_cents  bigint,
  organizer_net_cents bigint,
  refunded_cents      bigint,
  currency            text
)
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
begin
  perform public.assert_can_read_finances(p_organization_id);

  return query
  select
    to_char(date_trunc('month', coalesce(o.paid_at, o.created_at) at time zone 'UTC'), 'YYYY-MM'),
    count(*) filter (where o.payment_status = 'succeeded'),
    coalesce(sum(o.quantity)            filter (where o.payment_status = 'succeeded'), 0)::bigint,
    coalesce(sum(o.subtotal_cents)      filter (where o.payment_status = 'succeeded'), 0)::bigint,
    coalesce(sum(o.discount_cents)      filter (where o.payment_status = 'succeeded'), 0)::bigint,
    coalesce(sum(o.net_cents)           filter (where o.payment_status = 'succeeded'), 0)::bigint,
    coalesce(sum(o.commission_cents)    filter (where o.payment_status = 'succeeded'), 0)::bigint,
    coalesce(sum(o.archive_fee_cents)   filter (where o.payment_status = 'succeeded'), 0)::bigint,
    coalesce(sum(o.blup_revenue_cents)  filter (where o.payment_status = 'succeeded'), 0)::bigint,
    coalesce(sum(o.net_cents - o.platform_fee_cents) filter (where o.payment_status = 'succeeded'), 0)::bigint,
    coalesce(sum(o.net_cents)           filter (where o.payment_status = 'refunded'), 0)::bigint,
    max(o.currency)
  from public.orders o
  where o.organization_id = p_organization_id
    and o.payment_status in ('succeeded', 'refunded')
    and (p_from is null or (coalesce(o.paid_at, o.created_at) at time zone 'UTC')::date >= p_from)
    and (p_to   is null or (coalesce(o.paid_at, o.created_at) at time zone 'UTC')::date <= p_to)
  group by 1
  order by 1;
end;
$$;

/**
 * The same monthly shape for the whole platform, plus boost sales, for BLUP's
 * own books. Admin only — there is no organization to be a member of.
 */
create or replace function public.platform_accounting_summary(
  p_from date default null,
  p_to   date default null
)
returns table (
  period              text,
  orders_count        bigint,
  tickets_count       bigint,
  gross_cents         bigint,
  discount_cents      bigint,
  net_cents           bigint,
  commission_cents    bigint,
  archive_fee_cents   bigint,
  ticket_revenue_cents bigint,
  boost_revenue_cents bigint,
  total_revenue_cents bigint,
  organizer_net_cents bigint,
  refunded_cents      bigint,
  currency            text
)
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
begin
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'NOT_AUTHORIZED';
  end if;

  return query
  with months as (
    select
      to_char(date_trunc('month', coalesce(o.paid_at, o.created_at) at time zone 'UTC'), 'YYYY-MM') as p,
      count(*) filter (where o.payment_status = 'succeeded') as orders_count,
      coalesce(sum(o.quantity)           filter (where o.payment_status = 'succeeded'), 0)::bigint as tickets_count,
      coalesce(sum(o.subtotal_cents)     filter (where o.payment_status = 'succeeded'), 0)::bigint as gross_cents,
      coalesce(sum(o.discount_cents)     filter (where o.payment_status = 'succeeded'), 0)::bigint as discount_cents,
      coalesce(sum(o.net_cents)          filter (where o.payment_status = 'succeeded'), 0)::bigint as net_cents,
      coalesce(sum(o.commission_cents)   filter (where o.payment_status = 'succeeded'), 0)::bigint as commission_cents,
      coalesce(sum(o.archive_fee_cents)  filter (where o.payment_status = 'succeeded'), 0)::bigint as archive_fee_cents,
      coalesce(sum(o.blup_revenue_cents) filter (where o.payment_status = 'succeeded'), 0)::bigint as ticket_revenue_cents,
      coalesce(sum(o.net_cents - o.platform_fee_cents) filter (where o.payment_status = 'succeeded'), 0)::bigint as organizer_net_cents,
      coalesce(sum(o.net_cents)          filter (where o.payment_status = 'refunded'), 0)::bigint as refunded_cents,
      max(o.currency) as currency
    from public.orders o
    where o.payment_status in ('succeeded', 'refunded')
      and (p_from is null or (coalesce(o.paid_at, o.created_at) at time zone 'UTC')::date >= p_from)
      and (p_to   is null or (coalesce(o.paid_at, o.created_at) at time zone 'UTC')::date <= p_to)
    group by 1
  ),
  boosts as (
    select
      to_char(date_trunc('month', b.created_at at time zone 'UTC'), 'YYYY-MM') as p,
      coalesce(sum(b.amount_cents), 0)::bigint as boost_revenue_cents
    from public.event_boosts b
    where b.payment_status = 'succeeded'
      and (p_from is null or (b.created_at at time zone 'UTC')::date >= p_from)
      and (p_to   is null or (b.created_at at time zone 'UTC')::date <= p_to)
    group by 1
  )
  select
    coalesce(m.p, bo.p),
    coalesce(m.orders_count, 0),
    coalesce(m.tickets_count, 0),
    coalesce(m.gross_cents, 0),
    coalesce(m.discount_cents, 0),
    coalesce(m.net_cents, 0),
    coalesce(m.commission_cents, 0),
    coalesce(m.archive_fee_cents, 0),
    coalesce(m.ticket_revenue_cents, 0),
    coalesce(bo.boost_revenue_cents, 0),
    coalesce(m.ticket_revenue_cents, 0) + coalesce(bo.boost_revenue_cents, 0),
    coalesce(m.organizer_net_cents, 0),
    coalesce(m.refunded_cents, 0),
    coalesce(m.currency, 'EUR')
  from months m
  full outer join boosts bo on bo.p = m.p
  order by 1;
end;
$$;

-- ---------------------------------------------------------------------------
-- Reports that quoted the old single fee
-- ---------------------------------------------------------------------------
create or replace function public.event_analytics(p_event_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  ev     record;
  result jsonb;
begin
  select * into ev from public.events where id = p_event_id;
  if not found then
    raise exception 'EVENT_NOT_FOUND';
  end if;

  -- Unchanged from 0009: this migration only widens what the function reports,
  -- never who may read it.
  if not (
    ev.creator_id = auth.uid()
    or (ev.organization_id is not null and public.is_org_member(ev.organization_id, null, auth.uid()))
    or public.is_admin()
  ) then
    raise exception 'NOT_AUTHORIZED';
  end if;

  select jsonb_build_object(
    'event_id', ev.id,
    'title', ev.title,
    'views', ev.view_count,
    'unique_viewers', (select count(distinct user_id) from public.event_views where event_id = ev.id),
    'saves', ev.saved_count,
    'likes', ev.like_count,
    'comments', ev.comment_count,
    'rsvp_going', ev.attendee_count,
    'rsvp_interested', ev.interested_count,
    'checked_in', (select count(*) from public.tickets where event_id = ev.id and status = 'used'),
    'tickets_sold', ev.tickets_sold,
    'conversion_rate', case when ev.view_count > 0
                            then round((ev.tickets_sold::numeric / ev.view_count) * 100, 2)
                            else 0 end,
    -- gross is the list price, net is what was collected after promo codes
    'gross_revenue_cents', coalesce((
      select sum(o.subtotal_cents) from public.orders o
      where o.event_id = ev.id and o.payment_status = 'succeeded'), 0),
    'discount_cents', coalesce((
      select sum(o.discount_cents) from public.orders o
      where o.event_id = ev.id and o.payment_status = 'succeeded'), 0),
    'net_revenue_cents', coalesce((
      select sum(o.net_cents) from public.orders o
      where o.event_id = ev.id and o.payment_status = 'succeeded'), 0),
    'commission_cents', coalesce((
      select sum(o.commission_cents) from public.orders o
      where o.event_id = ev.id and o.payment_status = 'succeeded'), 0),
    'archive_fee_cents', coalesce((
      select sum(o.archive_fee_cents) from public.orders o
      where o.event_id = ev.id and o.payment_status = 'succeeded'), 0),
    -- what the organizer is charged; the buyer-paid archive fee is not in here
    'platform_fee_cents', coalesce((
      select sum(o.platform_fee_cents) from public.orders o
      where o.event_id = ev.id and o.payment_status = 'succeeded'), 0),
    'organizer_net_cents', coalesce((
      select sum(o.net_cents - o.platform_fee_cents) from public.orders o
      where o.event_id = ev.id and o.payment_status = 'succeeded'), 0),
    'buyers_paid_cents', coalesce((
      select sum(o.total_cents) from public.orders o
      where o.event_id = ev.id and o.payment_status = 'succeeded'), 0),
    'currency', ev.currency
  ) into result;

  return result;
end;
$$;

create or replace function public.admin_platform_stats()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
begin
  if not public.is_admin() then
    raise exception 'NOT_AUTHORIZED';
  end if;

  return jsonb_build_object(
    'users', (select count(*) from public.profiles),
    'suspended_users', (select count(*) from public.profiles where is_suspended),
    'events', (select count(*) from public.events),
    'published_events', (select count(*) from public.events where status = 'published'),
    'organizations', (select count(*) from public.organizations),
    'pending_verifications', (select count(*) from public.organization_verification_requests where status = 'pending'),
    'tickets', (select count(*) from public.tickets),
    'open_reports', (select count(*) from public.reports where status = 'open'),
    'gross_sales_cents', coalesce((select sum(subtotal_cents) from public.orders where payment_status = 'succeeded'), 0),
    'net_sales_cents', coalesce((select sum(net_cents) from public.orders where payment_status = 'succeeded'), 0),
    'commission_cents', coalesce((select sum(commission_cents) from public.orders where payment_status = 'succeeded'), 0),
    'archive_fee_cents', coalesce((select sum(archive_fee_cents) from public.orders where payment_status = 'succeeded'), 0),
    'boost_revenue_cents', coalesce((select sum(amount_cents) from public.event_boosts where payment_status = 'succeeded'), 0),
    'platform_revenue_cents',
      coalesce((select sum(blup_revenue_cents) from public.orders where payment_status = 'succeeded'), 0)
      + coalesce((select sum(amount_cents) from public.event_boosts where payment_status = 'succeeded'), 0),
    'pending_payouts', (select count(*) from public.payouts where status = 'pending'),
    'premium_users', (select count(distinct user_id) from public.premium_subscriptions
                      where status in ('active', 'trialing', 'grace_period')
                        and (expires_at is null or expires_at > now()))
  );
end;
$$;
