-- ============================================================================
-- BLUP · 0057 · The numbers an organizer actually runs the business on
-- ============================================================================
-- What existed: views, saves, RSVPs, a sales curve and the money split, one
-- event at a time. What was missing is everything you need on a Monday morning
-- across all of them at once — which event sold, which ticket type, how people
-- paid, where they came from, how many walked away at the checkout, and how
-- much of the takings is actually withdrawable.
--
-- Deliberately *not* a dashboard of vanity numbers. Every function here answers
-- a question somebody asks out loud:
--
--   "Which of my events is carrying the others?"      sales_by_event
--   "Which ticket type should I print more of?"       sales_by_ticket_type
--   "Did people pay by card or Apple Pay?"            sales_by_method
--   "Where do I advertise next?"                      sales_by_city
--   "How many of them actually turned up?"            sales_totals.checked_in
--   "How many started paying and gave up?"            checkout_funnel
--   "What is mine, and when can I have it?"           sales_totals
--
-- Authorisation is one rule in one place: scope_events() reduces whatever the
-- caller asked for to the events they are actually entitled to see, and every
-- function below starts from it. There is no way to pass an event id that
-- widens it.
-- ============================================================================

set search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- Which events may this caller read?
-- ---------------------------------------------------------------------------
create or replace function public.scope_events(
  p_event_ids       uuid[] default null,
  p_organization_id uuid   default null
)
returns table (event_id uuid)
language sql
stable
security definer
set search_path = public, extensions
as $$
  select e.id
  from public.events e
  where
    -- Mine to read: I made it, I am staff of the organization behind it, or I
    -- am an admin of BLUP.
    (
      e.creator_id = auth.uid()
      or (e.organization_id is not null and public.is_org_member(e.organization_id, null, auth.uid()))
      or public.is_admin()
    )
    and (p_event_ids is null or e.id = any(p_event_ids))
    and (p_organization_id is null or e.organization_id = p_organization_id);
$$;

revoke all on function public.scope_events(uuid[], uuid) from public, anon;
grant execute on function public.scope_events(uuid[], uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- The tiles across the top
-- ---------------------------------------------------------------------------
create or replace function public.sales_totals(
  p_event_ids       uuid[]      default null,
  p_organization_id uuid        default null,
  p_from            timestamptz default null,
  p_to              timestamptz default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  scope uuid[];
  out_json jsonb;
  prev_gross bigint;
  span interval;
begin
  select array_agg(event_id) into scope
  from public.scope_events(p_event_ids, p_organization_id);

  if scope is null then
    -- Not "no data": no events this caller may read. Same shape either way, so
    -- the screen renders zeroes rather than an error.
    scope := '{}'::uuid[];
  end if;

  span := coalesce(p_to, now()) - coalesce(p_from, now() - interval '30 days');

  -- The same window, immediately before this one. Without it a number is just a
  -- number; with it you can tell whether it is going the right way.
  select coalesce(sum(o.subtotal_cents - o.discount_cents), 0) into prev_gross
  from public.orders o
  where o.event_id = any(scope)
    and o.payment_status = 'succeeded'
    and o.paid_at is not null
    and o.paid_at >= coalesce(p_from, now() - interval '30 days') - span
    and o.paid_at <  coalesce(p_from, now() - interval '30 days');

  select jsonb_build_object(
    'events',            cardinality(scope),
    'orders_paid',       count(*) filter (where o.payment_status = 'succeeded'),
    'orders_total',      count(*),
    'tickets',           coalesce(sum(o.quantity) filter (where o.payment_status = 'succeeded'), 0),
    'gross_cents',       coalesce(sum(o.subtotal_cents - o.discount_cents)
                                  filter (where o.payment_status = 'succeeded'), 0),
    'discount_cents',    coalesce(sum(o.discount_cents) filter (where o.payment_status = 'succeeded'), 0),
    'commission_cents',  coalesce(sum(o.commission_cents) filter (where o.payment_status = 'succeeded'), 0),
    'archive_fee_cents', coalesce(sum(o.archive_fee_cents) filter (where o.payment_status = 'succeeded'), 0),
    -- What the organizer actually keeps. orders.net_cents is the price after a
    -- promo code, not after our cut — using it here would have told every
    -- organizer they earn exactly the shelf price.
    'organizer_net_cents', coalesce(sum(o.net_cents - o.commission_cents
                     - case when o.archive_fee_payer = 'organizer' then o.archive_fee_cents else 0 end)
                                    filter (where o.payment_status = 'succeeded'), 0),
    'refunded_cents',    coalesce(sum(o.total_cents) filter (where o.payment_status = 'refunded'), 0),
    'refunded_orders',   count(*) filter (where o.payment_status = 'refunded'),
    'failed_orders',     count(*) filter (where o.payment_status = 'failed'),
    'prev_gross_cents',  prev_gross,
    'currency',          coalesce(max(o.currency), 'EUR')
  )
  into out_json
  from public.orders o
  where o.event_id = any(scope)
    and (p_from is null or coalesce(o.paid_at, o.created_at) >= p_from)
    and (p_to   is null or coalesce(o.paid_at, o.created_at) <= p_to);

  -- Tickets are counted from the tickets themselves, not from order quantities:
  -- a comp has no order line worth money but is a person in the room, and a
  -- deactivated ticket is not.
  out_json := out_json || (
    select jsonb_build_object(
      'tickets_valid',  count(*) filter (where t.status = 'valid'),
      'tickets_used',   count(*) filter (where t.status = 'used'),
      'tickets_void',   count(*) filter (where t.status in ('cancelled', 'refunded')),
      'complimentary',  count(*) filter (where coalesce(t.is_complimentary, false)),
      'checked_in_pct', case when count(*) filter (where t.status in ('valid', 'used')) = 0 then 0
                        else round(
                          100.0 * count(*) filter (where t.status = 'used')
                          / count(*) filter (where t.status in ('valid', 'used')), 1) end
    )
    from public.tickets t
    where t.event_id = any(scope)
      and (p_from is null or t.created_at >= p_from)
      and (p_to   is null or t.created_at <= p_to)
  );

  -- Money that is settled versus money still being held. Only for people
  -- entitled to the organization's balance; an event creator without a role in
  -- the organization sees the sales and not the bank.
  out_json := out_json || coalesce((
    select jsonb_build_object(
      'available_cents', coalesce(sum(b.available_cents), 0),
      'pending_cents',   coalesce(sum(b.pending_cents), 0),
      'reserve_cents',   coalesce(sum(b.reserve_cents), 0),
      'paid_out_cents',  coalesce(sum(b.paid_out_cents), 0)
    )
    from public.organization_balances b
    where b.organization_id in (
      select distinct e.organization_id from public.events e
      where e.id = any(scope) and e.organization_id is not null
    )
  ), '{}'::jsonb);

  out_json := out_json || (
    select jsonb_build_object(
      'disputes_open',        count(*) filter (where d.status = 'open'),
      'disputes_open_cents',  coalesce(sum(d.amount_cents) filter (where d.status = 'open'), 0)
    )
    from public.payment_disputes d
    where d.event_id = any(scope)
  );

  return out_json;
end;
$$;

revoke all on function public.sales_totals(uuid[], uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.sales_totals(uuid[], uuid, timestamptz, timestamptz) to authenticated;

-- ---------------------------------------------------------------------------
-- Per event
-- ---------------------------------------------------------------------------
create or replace function public.sales_by_event(
  p_event_ids       uuid[]      default null,
  p_organization_id uuid        default null,
  p_from            timestamptz default null,
  p_to              timestamptz default null
)
returns table (
  event_id     uuid,
  title        text,
  start_at     timestamptz,
  city         text,
  status       event_status,
  tickets      bigint,
  orders       bigint,
  gross_cents  bigint,
  organizer_net_cents bigint,
  checked_in   bigint,
  currency     text
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  select
    e.id, e.title, e.start_at, e.city, e.status,
    coalesce(sum(o.quantity) filter (where o.payment_status = 'succeeded'), 0)::bigint,
    count(o.id) filter (where o.payment_status = 'succeeded')::bigint,
    coalesce(sum(o.subtotal_cents - o.discount_cents) filter (where o.payment_status = 'succeeded'), 0)::bigint,
    coalesce(sum(o.net_cents - o.commission_cents
                     - case when o.archive_fee_payer = 'organizer' then o.archive_fee_cents else 0 end)
             filter (where o.payment_status = 'succeeded'), 0)::bigint,
    (select count(*) from public.tickets t where t.event_id = e.id and t.status = 'used')::bigint,
    coalesce(max(o.currency), 'EUR')
  from public.events e
  join public.scope_events(p_event_ids, p_organization_id) s on s.event_id = e.id
  left join public.orders o on o.event_id = e.id
    and (p_from is null or coalesce(o.paid_at, o.created_at) >= p_from)
    and (p_to   is null or coalesce(o.paid_at, o.created_at) <= p_to)
  group by e.id, e.title, e.start_at, e.city, e.status
  order by coalesce(sum(o.subtotal_cents - o.discount_cents) filter (where o.payment_status = 'succeeded'), 0) desc,
           e.start_at desc;
$$;

revoke all on function public.sales_by_event(uuid[], uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.sales_by_event(uuid[], uuid, timestamptz, timestamptz) to authenticated;

-- ---------------------------------------------------------------------------
-- Per ticket type
-- ---------------------------------------------------------------------------
create or replace function public.sales_by_ticket_type(
  p_event_ids       uuid[]      default null,
  p_organization_id uuid        default null,
  p_from            timestamptz default null,
  p_to              timestamptz default null
)
returns table (
  ticket_type_id uuid,
  name           text,
  event_title    text,
  price_cents    integer,
  sold           bigint,
  remaining      integer,
  gross_cents    bigint,
  currency       text
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  select
    tt.id, tt.name, e.title, tt.price_cents,
    coalesce(sum(o.quantity) filter (where o.payment_status = 'succeeded'), 0)::bigint,
    greatest(tt.quantity_total - tt.quantity_sold, 0),
    coalesce(sum(o.subtotal_cents - o.discount_cents) filter (where o.payment_status = 'succeeded'), 0)::bigint,
    tt.currency
  from public.ticket_types tt
  join public.events e on e.id = tt.event_id
  join public.scope_events(p_event_ids, p_organization_id) s on s.event_id = e.id
  left join public.orders o on o.ticket_type_id = tt.id
    and (p_from is null or coalesce(o.paid_at, o.created_at) >= p_from)
    and (p_to   is null or coalesce(o.paid_at, o.created_at) <= p_to)
  group by tt.id, tt.name, e.title, tt.price_cents, tt.quantity_total, tt.quantity_sold, tt.currency
  order by coalesce(sum(o.quantity) filter (where o.payment_status = 'succeeded'), 0) desc, tt.name;
$$;

revoke all on function public.sales_by_ticket_type(uuid[], uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.sales_by_ticket_type(uuid[], uuid, timestamptz, timestamptz) to authenticated;

-- ---------------------------------------------------------------------------
-- How they paid
-- ---------------------------------------------------------------------------
-- Provider plus whether the buyer had an account. "Guest" is not a payment
-- method, but it is the number that answers "was letting people buy without
-- registering worth it?", and that is the same question as this table.
create or replace function public.sales_by_method(
  p_event_ids       uuid[]      default null,
  p_organization_id uuid        default null,
  p_from            timestamptz default null,
  p_to              timestamptz default null
)
returns table (
  method      text,
  orders      bigint,
  tickets     bigint,
  gross_cents bigint,
  currency    text
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  select
    case
      when o.provider = 'manual' then 'Zdarma / ručne'
      when o.buyer_id is null    then 'Karta (bez účtu)'
      else 'Karta (účet)'
    end as method,
    count(*)::bigint,
    coalesce(sum(o.quantity), 0)::bigint,
    coalesce(sum(o.subtotal_cents - o.discount_cents), 0)::bigint,
    coalesce(max(o.currency), 'EUR')
  from public.orders o
  join public.scope_events(p_event_ids, p_organization_id) s on s.event_id = o.event_id
  where o.payment_status = 'succeeded'
    and (p_from is null or o.paid_at >= p_from)
    and (p_to   is null or o.paid_at <= p_to)
  group by 1
  order by 4 desc;
$$;

revoke all on function public.sales_by_method(uuid[], uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.sales_by_method(uuid[], uuid, timestamptz, timestamptz) to authenticated;

-- ---------------------------------------------------------------------------
-- Where they are from
-- ---------------------------------------------------------------------------
-- The map. A row needs coordinates to be a dot, and a town with no coordinates
-- is still a row in the list underneath — dropping it would quietly understate
-- the towns we happen not to have geocoded.
create or replace function public.sales_by_city(
  p_event_ids       uuid[]      default null,
  p_organization_id uuid        default null,
  p_from            timestamptz default null,
  p_to              timestamptz default null,
  p_limit           integer     default 60
)
returns table (
  city        text,
  orders      bigint,
  tickets     bigint,
  gross_cents bigint,
  latitude    double precision,
  longitude   double precision
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  select
    coalesce(nullif(btrim(o.buyer_city), ''), 'Neuvedené') as city,
    count(*)::bigint,
    coalesce(sum(o.quantity), 0)::bigint,
    coalesce(sum(o.subtotal_cents - o.discount_cents), 0)::bigint,
    -- One point per town: the average of what buyers gave. They are all within
    -- the same town, so the middle of them is the town.
    avg(o.buyer_latitude)  filter (where o.buyer_latitude is not null),
    avg(o.buyer_longitude) filter (where o.buyer_longitude is not null)
  from public.orders o
  join public.scope_events(p_event_ids, p_organization_id) s on s.event_id = o.event_id
  where o.payment_status = 'succeeded'
    and (p_from is null or o.paid_at >= p_from)
    and (p_to   is null or o.paid_at <= p_to)
  group by 1
  order by 3 desc, 1
  limit least(greatest(coalesce(p_limit, 60), 1), 500);
$$;

revoke all on function public.sales_by_city(uuid[], uuid, timestamptz, timestamptz, integer) from public, anon;
grant execute on function public.sales_by_city(uuid[], uuid, timestamptz, timestamptz, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- Who walked away, and where
-- ---------------------------------------------------------------------------
-- The funnel, from the page to the ticket. Each step is a real row somewhere,
-- not an estimate:
--
--   views      event_views           opened the event
--   baskets    cart_items            put a ticket in the basket
--   started    orders                got as far as a payment being created
--   paid       orders (succeeded)    money actually moved
--
-- The gap between `started` and `paid` is the one worth money: those people
-- decided to buy, reached the card form, and did not finish. Anything that
-- expired or failed is counted separately, because "changed their mind" and
-- "the card was declined" are different problems with different fixes.
create or replace function public.checkout_funnel(
  p_event_ids       uuid[]      default null,
  p_organization_id uuid        default null,
  p_from            timestamptz default null,
  p_to              timestamptz default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  scope   uuid[];
  v_from  timestamptz := coalesce(p_from, now() - interval '30 days');
  v_to    timestamptz := coalesce(p_to, now());
  views   bigint;
  baskets bigint;
  started bigint;
  paid    bigint;
  expired bigint;
  failed  bigint;
  lost    bigint;
begin
  select array_agg(event_id) into scope
  from public.scope_events(p_event_ids, p_organization_id);
  if scope is null then scope := '{}'::uuid[]; end if;

  select count(*) into views
  from public.event_views v
  where v.event_id = any(scope) and v.created_at between v_from and v_to;

  select count(distinct coalesce(c.user_id::text, c.id::text)) into baskets
  from public.cart_items c
  where c.event_id = any(scope) and c.created_at between v_from and v_to;

  -- "Paid" is `paid_at is not null`, not `payment_status = 'succeeded'`. An
  -- order that was paid and later refunded did finish the checkout; counting it
  -- as abandoned would blame the payment form for a refund and quietly make the
  -- success rate fall every time somebody gets their money back.
  select
    count(*),
    count(*) filter (where o.paid_at is not null),
    count(*) filter (where o.payment_status = 'requires_payment' and o.expires_at <= now()),
    count(*) filter (where o.payment_status = 'failed')
  into started, paid, expired, failed
  from public.orders o
  where o.event_id = any(scope) and o.created_at between v_from and v_to;

  -- Abandoned: started and never finished, for any reason. Counted rather than
  -- derived in the client so "úspešnosť" means the same thing everywhere.
  lost := greatest(started - paid, 0);

  return jsonb_build_object(
    'views',         views,
    'baskets',       baskets,
    'started',       started,
    'paid',          paid,
    'abandoned',     lost,
    'expired',       expired,
    'failed',        failed,
    -- Of the people who started paying, how many finished.
    'success_pct',   case when started = 0 then 0
                     else round(100.0 * paid / started, 1) end,
    -- Of the people who opened the event, how many bought.
    'view_to_paid_pct', case when views = 0 then 0
                        else round(100.0 * paid / views, 2) end,
    -- What the abandoned ones would have been worth. Not a promise — a size.
    'abandoned_cents', coalesce((
      select sum(o.total_cents) from public.orders o
      where o.event_id = any(scope)
        and o.created_at between v_from and v_to
        and o.paid_at is null
    ), 0),
    'from', v_from,
    'to',   v_to
  );
end;
$$;

revoke all on function public.checkout_funnel(uuid[], uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.checkout_funnel(uuid[], uuid, timestamptz, timestamptz) to authenticated;

-- ---------------------------------------------------------------------------
-- The export
-- ---------------------------------------------------------------------------
-- One row per paid order, with everything an accountant or a spreadsheet wants.
-- Built here rather than in the client so the CSV cannot disagree with the
-- screen above it.
create or replace function public.sales_rows(
  p_event_ids       uuid[]      default null,
  p_organization_id uuid        default null,
  p_from            timestamptz default null,
  p_to              timestamptz default null,
  p_limit           integer     default 5000
)
returns table (
  paid_at        timestamptz,
  event_title    text,
  ticket_type    text,
  quantity       integer,
  gross_cents    integer,
  discount_cents integer,
  commission_cents integer,
  archive_fee_cents integer,
  organizer_net_cents integer,
  currency       text,
  buyer          text,
  email          text,
  city           text,
  has_account    boolean,
  order_id       uuid
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  select
    o.paid_at,
    e.title,
    tt.name,
    o.quantity,
    o.subtotal_cents - o.discount_cents,
    o.discount_cents,
    o.commission_cents,
    o.archive_fee_cents,
    o.net_cents - o.commission_cents
      - case when o.archive_fee_payer = 'organizer' then o.archive_fee_cents else 0 end,
    o.currency,
    coalesce(nullif(btrim(coalesce(p.display_name, '')), ''), o.guest_name, p.username::text, 'Hosť'),
    coalesce(public.ticket_email_for(o.buyer_id), o.guest_email::text),
    o.buyer_city,
    o.buyer_id is not null,
    o.id
  from public.orders o
  join public.scope_events(p_event_ids, p_organization_id) s on s.event_id = o.event_id
  join public.events e on e.id = o.event_id
  left join public.ticket_types tt on tt.id = o.ticket_type_id
  left join public.profiles p on p.id = o.buyer_id
  where o.payment_status = 'succeeded'
    and (p_from is null or o.paid_at >= p_from)
    and (p_to   is null or o.paid_at <= p_to)
  order by o.paid_at desc
  limit least(greatest(coalesce(p_limit, 5000), 1), 20000);
$$;

revoke all on function public.sales_rows(uuid[], uuid, timestamptz, timestamptz, integer) from public, anon;
grant execute on function public.sales_rows(uuid[], uuid, timestamptz, timestamptz, integer) to authenticated;
