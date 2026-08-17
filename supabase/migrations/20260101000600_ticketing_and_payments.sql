-- ============================================================================
-- BLUP · 0006 · Ticketing, orders, payments, ledger, payouts
-- ============================================================================
-- Money flow (see PAYMENTS.md):
--   order (pending) -> provider checkout -> webhook -> fulfill_order()
--     -> tickets issued
--     -> ledger: +gross to organization, -platform fee
--   payout request -> ledger: -payout
-- The client NEVER decides amounts or marks anything paid. Amounts are computed
-- by create_order() and payment state is only advanced by fulfill_order(),
-- which is reachable exclusively from the service-role Edge Functions.
-- ============================================================================

create table if not exists public.ticket_types (
  id             uuid primary key default gen_random_uuid(),
  event_id       uuid not null references public.events (id) on delete cascade,
  name           text not null,
  description    text,
  price_cents    integer not null check (price_cents >= 0),
  currency       text not null default 'EUR' check (char_length(currency) = 3),
  quantity_total integer not null check (quantity_total > 0),
  quantity_sold  integer not null default 0 check (quantity_sold >= 0),
  max_per_order  integer not null default 6 check (max_per_order between 1 and 50),
  sales_start_at timestamptz,
  sales_end_at   timestamptz,
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint ticket_types_name_len check (char_length(name) between 2 and 60),
  constraint ticket_types_not_oversold check (quantity_sold <= quantity_total),
  constraint ticket_types_sales_window
    check (sales_end_at is null or sales_start_at is null or sales_end_at > sales_start_at)
);

create index if not exists ticket_types_event_idx on public.ticket_types (event_id);

drop trigger if exists ticket_types_set_updated_at on public.ticket_types;
create trigger ticket_types_set_updated_at
  before update on public.ticket_types
  for each row execute function public.set_updated_at();

-- Selling tickets requires a verified organization on the event.
create or replace function public.enforce_ticket_type_rules()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  ev record;
begin
  select organization_id, currency into ev from public.events where id = new.event_id;

  if new.price_cents > 0 then
    if ev.organization_id is null then
      raise exception 'PAID_EVENT_REQUIRES_ORGANIZATION';
    end if;
    if not public.is_org_verified(ev.organization_id) then
      raise exception 'ORGANIZATION_NOT_VERIFIED';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists ticket_types_enforce_rules on public.ticket_types;
create trigger ticket_types_enforce_rules
  before insert or update of price_cents on public.ticket_types
  for each row execute function public.enforce_ticket_type_rules();

-- ---------------------------------------------------------------------------
-- Orders
-- ---------------------------------------------------------------------------
create table if not exists public.orders (
  id                 uuid primary key default gen_random_uuid(),
  event_id           uuid not null references public.events (id) on delete restrict,
  organization_id    uuid references public.organizations (id) on delete set null,
  ticket_type_id     uuid not null references public.ticket_types (id) on delete restrict,
  buyer_id           uuid not null references public.profiles (id) on delete restrict,
  quantity           integer not null check (quantity between 1 and 50),
  unit_price_cents   integer not null check (unit_price_cents >= 0),
  subtotal_cents     integer not null check (subtotal_cents >= 0),
  platform_fee_cents integer not null default 0 check (platform_fee_cents >= 0),
  total_cents        integer not null check (total_cents >= 0),
  currency           text not null check (char_length(currency) = 3),
  payment_status     payment_status not null default 'requires_payment',
  provider           payment_provider not null default 'stripe',
  provider_reference text,          -- e.g. Stripe PaymentIntent id
  provider_client_secret_last4 text,-- diagnostics only, never the full secret
  expires_at         timestamptz not null default now() + interval '30 minutes',
  paid_at            timestamptz,
  refunded_at        timestamptz,
  failure_reason     text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create unique index if not exists orders_provider_reference_key
  on public.orders (provider, provider_reference)
  where provider_reference is not null;
create index if not exists orders_buyer_idx on public.orders (buyer_id, created_at desc);
create index if not exists orders_event_idx on public.orders (event_id, created_at desc);
create index if not exists orders_org_idx on public.orders (organization_id, created_at desc);

drop trigger if exists orders_set_updated_at on public.orders;
create trigger orders_set_updated_at
  before update on public.orders
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Payments (one row per provider transaction attempt)
-- ---------------------------------------------------------------------------
create table if not exists public.payments (
  id                 uuid primary key default gen_random_uuid(),
  order_id           uuid references public.orders (id) on delete set null,
  user_id            uuid references public.profiles (id) on delete set null,
  provider           payment_provider not null,
  provider_reference text not null,
  amount_cents       integer not null,
  currency           text not null check (char_length(currency) = 3),
  status             payment_status not null,
  raw                jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  constraint payments_provider_ref_unique unique (provider, provider_reference)
);

create index if not exists payments_order_idx on public.payments (order_id);

-- Raw webhook deliveries, used for idempotency + audit.
create table if not exists public.webhook_events (
  id           uuid primary key default gen_random_uuid(),
  provider     payment_provider not null,
  event_id     text not null,
  type         text not null,
  payload      jsonb not null,
  processed_at timestamptz,
  error        text,
  created_at   timestamptz not null default now(),
  constraint webhook_events_unique unique (provider, event_id)
);

-- ---------------------------------------------------------------------------
-- Tickets
-- ---------------------------------------------------------------------------
create table if not exists public.tickets (
  id             uuid primary key default gen_random_uuid(),
  order_id       uuid references public.orders (id) on delete set null,
  event_id       uuid not null references public.events (id) on delete cascade,
  ticket_type_id uuid references public.ticket_types (id) on delete set null,
  buyer_id       uuid not null references public.profiles (id) on delete cascade,
  holder_name    text,
  code           text not null unique,
  qr_secret      text not null,
  status         ticket_status not null default 'valid',
  price_cents    integer not null default 0,
  currency       text not null default 'EUR',
  checked_in_at  timestamptz,
  checked_in_by  uuid references public.profiles (id) on delete set null,
  created_at     timestamptz not null default now()
);

create index if not exists tickets_buyer_idx on public.tickets (buyer_id, created_at desc);
create index if not exists tickets_event_idx on public.tickets (event_id, status);

create or replace function public.sync_ticket_counts()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target_event uuid := coalesce(new.event_id, old.event_id);
  target_type  uuid := coalesce(new.ticket_type_id, old.ticket_type_id);
begin
  update public.events e
  set tickets_sold = (
    select count(*) from public.tickets t
    where t.event_id = target_event and t.status in ('valid', 'used')
  )
  where e.id = target_event;

  if target_type is not null then
    update public.ticket_types tt
    set quantity_sold = (
      select count(*) from public.tickets t
      where t.ticket_type_id = target_type and t.status in ('valid', 'used')
    )
    where tt.id = target_type;
  end if;

  return null;
end;
$$;

drop trigger if exists tickets_sync_counts on public.tickets;
create trigger tickets_sync_counts
  after insert or update or delete on public.tickets
  for each row execute function public.sync_ticket_counts();

-- ---------------------------------------------------------------------------
-- Ledger & payouts
-- ---------------------------------------------------------------------------
create table if not exists public.ledger_entries (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  event_id        uuid references public.events (id) on delete set null,
  order_id        uuid references public.orders (id) on delete set null,
  payout_id       uuid,
  type            ledger_entry_type not null,
  -- signed: sale = +gross, platform_fee = -fee, payout = -amount
  amount_cents    integer not null,
  currency        text not null check (char_length(currency) = 3),
  -- funds only become withdrawable after the settlement delay
  available_at    timestamptz not null default now() + interval '7 days',
  description     text,
  created_at      timestamptz not null default now()
);

create index if not exists ledger_org_idx on public.ledger_entries (organization_id, created_at desc);
create index if not exists ledger_order_idx on public.ledger_entries (order_id);

create table if not exists public.payouts (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations (id) on delete cascade,
  amount_cents        integer not null check (amount_cents > 0),
  currency            text not null check (char_length(currency) = 3),
  status              payout_status not null default 'pending',
  provider            payment_provider not null default 'stripe',
  provider_transfer_id text,
  requested_by        uuid references public.profiles (id) on delete set null,
  requested_at        timestamptz not null default now(),
  processed_at        timestamptz,
  failure_reason      text
);

create index if not exists payouts_org_idx on public.payouts (organization_id, requested_at desc);

alter table public.ledger_entries
  drop constraint if exists ledger_entries_payout_fk;
alter table public.ledger_entries
  add constraint ledger_entries_payout_fk
  foreign key (payout_id) references public.payouts (id) on delete set null;

-- Organizer balance = sum of ledger. Available = settled entries only.
create or replace view public.organization_balances as
select
  o.id as organization_id,
  o.default_currency as currency,
  coalesce(sum(l.amount_cents), 0)::bigint as balance_cents,
  coalesce(sum(l.amount_cents) filter (where l.available_at <= now()), 0)::bigint as available_cents,
  coalesce(sum(l.amount_cents) filter (where l.available_at > now()), 0)::bigint as pending_cents,
  coalesce(sum(l.amount_cents) filter (where l.type = 'sale'), 0)::bigint as gross_sales_cents,
  coalesce(-sum(l.amount_cents) filter (where l.type = 'platform_fee'), 0)::bigint as platform_fee_cents,
  coalesce(-sum(l.amount_cents) filter (where l.type = 'payout'), 0)::bigint as paid_out_cents
from public.organizations o
left join public.ledger_entries l on l.organization_id = o.id
group by o.id, o.default_currency;

-- ---------------------------------------------------------------------------
-- Order lifecycle functions
-- ---------------------------------------------------------------------------

-- Creates a pending order and computes all amounts server-side.
-- Called from the checkout Edge Function with the buyer's id.
create or replace function public.create_order(
  p_buyer_id       uuid,
  p_ticket_type_id uuid,
  p_quantity       integer
)
returns public.orders
language plpgsql
security definer
set search_path = public
as $$
declare
  tt       record;
  ev       record;
  org      record;
  fee_bps  integer;
  subtotal integer;
  fee      integer;
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
  fee_bps  := coalesce(org.platform_fee_bps, 300);
  subtotal := tt.price_cents * p_quantity;
  fee      := (subtotal * fee_bps) / 10000;

  insert into public.orders (
    event_id, organization_id, ticket_type_id, buyer_id, quantity,
    unit_price_cents, subtotal_cents, platform_fee_cents, total_cents,
    currency, payment_status, provider
  )
  values (
    ev.id, ev.organization_id, tt.id, p_buyer_id, p_quantity,
    tt.price_cents, subtotal, fee, subtotal,
    tt.currency, 'requires_payment', org.payment_provider
  )
  returning * into new_order;

  return new_order;
end;
$$;

-- Marks an order paid, issues tickets and writes the ledger. Idempotent.
create or replace function public.fulfill_order(
  p_order_id           uuid,
  p_provider           payment_provider,
  p_provider_reference text,
  p_amount_cents       integer
)
returns setof public.tickets
language plpgsql
security definer
set search_path = public
as $$
declare
  o        public.orders;
  i        integer;
  fee_bps  integer;
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
    insert into public.ledger_entries (organization_id, event_id, order_id, type, amount_cents, currency, description)
    values (o.organization_id, o.event_id, o.id, 'sale', o.subtotal_cents, o.currency,
            'Ticket sale x' || o.quantity);

    if o.platform_fee_cents > 0 then
      insert into public.ledger_entries (organization_id, event_id, order_id, type, amount_cents, currency, description)
      values (o.organization_id, o.event_id, o.id, 'platform_fee', -o.platform_fee_cents, o.currency,
              'BLUP platform fee');
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

create or replace function public.fail_order(p_order_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.orders
  set payment_status = 'failed', failure_reason = p_reason
  where id = p_order_id and payment_status <> 'succeeded';
end;
$$;

create or replace function public.refund_order(p_order_id uuid, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public
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
    values (o.organization_id, o.event_id, o.id, 'refund', -o.subtotal_cents, o.currency, 'Refund', now());

    if o.platform_fee_cents > 0 then
      insert into public.ledger_entries (organization_id, event_id, order_id, type, amount_cents, currency, description, available_at)
      values (o.organization_id, o.event_id, o.id, 'adjustment', o.platform_fee_cents, o.currency,
              'Platform fee reversal', now());
    end if;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Door check-in — the QR code is validated entirely server side.
-- QR payload: blup://t/<code>/<qr_secret>
-- ---------------------------------------------------------------------------
create or replace function public.check_in_ticket(
  p_code      text,
  p_qr_secret text,
  p_event_id  uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  t   public.tickets;
  ev  public.events;
  who uuid := auth.uid();
begin
  select * into t from public.tickets where code = p_code for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'TICKET_NOT_FOUND');
  end if;

  if t.qr_secret <> p_qr_secret then
    return jsonb_build_object('ok', false, 'reason', 'INVALID_SIGNATURE');
  end if;

  select * into ev from public.events where id = t.event_id;

  if p_event_id is not null and p_event_id <> t.event_id then
    return jsonb_build_object('ok', false, 'reason', 'WRONG_EVENT');
  end if;

  -- Only the event creator, an organizer of the owning org, or an admin may scan.
  if not (
    ev.creator_id = who
    or (ev.organization_id is not null and public.is_org_member(ev.organization_id, null, who))
    or public.is_admin(who)
  ) then
    return jsonb_build_object('ok', false, 'reason', 'NOT_AUTHORIZED');
  end if;

  if t.status = 'used' then
    return jsonb_build_object(
      'ok', false, 'reason', 'ALREADY_USED',
      'checked_in_at', t.checked_in_at
    );
  end if;

  if t.status <> 'valid' then
    return jsonb_build_object('ok', false, 'reason', upper(t.status::text));
  end if;

  update public.tickets
  set status = 'used', checked_in_at = now(), checked_in_by = who
  where id = t.id;

  update public.event_attendees
  set status = 'checked_in'
  where event_id = t.event_id and user_id = t.buyer_id;

  return jsonb_build_object(
    'ok', true,
    'ticket_id', t.id,
    'event_id', t.event_id,
    'event_title', ev.title,
    'buyer_id', t.buyer_id,
    'checked_in_at', now()
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Payout request — validated against the real settled balance.
-- ---------------------------------------------------------------------------
create or replace function public.request_payout(
  p_organization_id uuid,
  p_amount_cents    integer
)
returns public.payouts
language plpgsql
security definer
set search_path = public
as $$
declare
  bal  record;
  org  record;
  p    public.payouts;
begin
  if not (public.is_org_member(p_organization_id, array['owner', 'finance']::org_role[])
          or public.is_full_admin()) then
    raise exception 'NOT_AUTHORIZED';
  end if;

  select * into org from public.organizations where id = p_organization_id;
  if not found then
    raise exception 'ORGANIZATION_NOT_FOUND';
  end if;
  if not org.payouts_enabled then
    raise exception 'PAYOUTS_NOT_ENABLED'
      using hint = 'Complete payout onboarding (KYC) with the payment provider first.';
  end if;

  select * into bal from public.organization_balances where organization_id = p_organization_id;

  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'INVALID_AMOUNT';
  end if;
  if p_amount_cents > bal.available_cents then
    raise exception 'INSUFFICIENT_AVAILABLE_BALANCE: available %', bal.available_cents;
  end if;

  insert into public.payouts (organization_id, amount_cents, currency, status, provider, requested_by)
  values (p_organization_id, p_amount_cents, org.default_currency, 'pending', org.payment_provider, auth.uid())
  returning * into p;

  insert into public.ledger_entries (organization_id, payout_id, type, amount_cents, currency, description, available_at)
  values (p_organization_id, p.id, 'payout', -p_amount_cents, org.default_currency, 'Payout request', now());

  insert into public.notifications (user_id, type, title, body, data)
  select m.user_id, 'payout_update', 'Payout requested',
         'Your payout request is being processed.',
         jsonb_build_object('payout_id', p.id, 'amount_cents', p_amount_cents)
  from public.organization_members m
  where m.organization_id = p_organization_id and m.role in ('owner', 'finance');

  return p;
end;
$$;
