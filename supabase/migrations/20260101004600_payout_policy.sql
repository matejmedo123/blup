-- ============================================================================
-- BLUP · 0046 · Payout policy, reserves and disputes
-- ============================================================================
-- Until now the organizer's money became payable `settlement_days` after the
-- SALE. For a ticket sold eight months before a festival that is seven days
-- after the sale — roughly seven months BEFORE the event happens. The whole
-- point of holding the money is to still be holding it when the thing that can
-- go wrong goes wrong, so the anchor has to be the event, not the sale.
--
-- A card dispute for "service not provided" runs 120 days from the date the
-- customer expected the service, capped at 540 days from the transaction. So
-- the hold is in two parts:
--
--   * the main amount, payable a few days after the event
--   * a reserve, a percentage held considerably longer
--
-- How long and how much depends on how much history the organizer has with us.
-- That matrix lives in `payout_tiers` as DATA rather than in this function,
-- because it belongs in an annex to the contract: it has to be changeable
-- without an amendment, and without a migration.
--
-- An advance before the event is deliberately not a right. It is something BLUP
-- may grant, which is why it is an admin-only function with a per-tier cap and
-- an earliest date — the moment an organizer is entitled to money up front, the
-- only leverage we have over them is gone.
-- ============================================================================
set search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- The policy matrix
-- ---------------------------------------------------------------------------
create table if not exists public.payout_tiers (
  tier                  smallint primary key check (tier between 0 and 2),
  label                 text    not null,
  -- Advance before the event. 0 bps means: no advance at this tier, ever.
  advance_max_bps       integer not null default 0    check (advance_max_bps between 0 and 10000),
  -- How many days before the event an advance may first be paid.
  advance_earliest_days integer not null default 0    check (advance_earliest_days between 0 and 365),
  -- Main payout: this many days AFTER the event.
  payout_delay_days     integer not null default 5    check (payout_delay_days between 0 and 90),
  -- Share held back beyond the main payout. 1500 = 15.00 %.
  reserve_bps           integer not null default 1500 check (reserve_bps between 0 and 10000),
  -- When the reserve is released, in days after the event.
  reserve_release_days  integer not null default 90   check (reserve_release_days between 0 and 540),

  constraint payout_tiers_reserve_after_main check (reserve_release_days >= payout_delay_days)
);

insert into public.payout_tiers
  (tier, label, advance_max_bps, advance_earliest_days, payout_delay_days, reserve_bps, reserve_release_days)
values
  (0, 'Nový organizátor',        0,  0, 5, 1500, 90),
  (1, '1–2 eventy',           2500,  7, 3, 1200, 60),
  (2, '3+ bez incidentu',     5000, 14, 2, 1000, 45)
on conflict (tier) do nothing;

alter table public.payout_tiers enable row level security;

drop policy if exists payout_tiers_select on public.payout_tiers;
create policy payout_tiers_select on public.payout_tiers for select using (true);

drop policy if exists payout_tiers_write on public.payout_tiers;
create policy payout_tiers_write on public.payout_tiers
  for all using (public.is_full_admin()) with check (public.is_full_admin());

-- ---------------------------------------------------------------------------
-- Where an organization sits in that matrix
-- ---------------------------------------------------------------------------
alter table public.organizations
  add column if not exists payout_tier smallint not null default 0
    references public.payout_tiers (tier),
  -- Set by an admin to pin a tier that the automatic calculation would not give.
  -- Null means "follow the history".
  add column if not exists payout_tier_override smallint
    references public.payout_tiers (tier),
  add column if not exists payout_tier_note text;

-- ---------------------------------------------------------------------------
-- Disputes
-- ---------------------------------------------------------------------------
-- A dispute is the one event that must stop money leaving, so it gets a table
-- of its own rather than a flag on the order: it has its own lifecycle, it can
-- outlive the order, and we need to be able to count them per organizer.
create table if not exists public.payment_disputes (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid references public.organizations (id) on delete cascade,
  order_id           uuid references public.orders (id) on delete set null,
  event_id           uuid references public.events (id) on delete set null,
  -- The provider's dispute id. Unique, so a replayed webhook cannot open two.
  provider_reference text not null unique,
  charge_reference   text,
  amount_cents       integer not null check (amount_cents >= 0),
  currency           text not null default 'EUR' check (char_length(currency) = 3),
  reason             text,
  status             text not null default 'open'
    check (status in ('open', 'won', 'lost', 'withdrawn')),
  opened_at          timestamptz not null default now(),
  closed_at          timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists payment_disputes_org_status_idx
  on public.payment_disputes (organization_id, status);
create index if not exists payment_disputes_order_idx
  on public.payment_disputes (order_id);

drop trigger if exists payment_disputes_set_updated_at on public.payment_disputes;
create trigger payment_disputes_set_updated_at
  before update on public.payment_disputes
  for each row execute function public.set_updated_at();

alter table public.payment_disputes enable row level security;

-- An organizer sees their own disputes — they are the one who has to respond to
-- them — but only the service role and admins may write.
drop policy if exists payment_disputes_select on public.payment_disputes;
create policy payment_disputes_select on public.payment_disputes
  for select using (
    public.is_full_admin()
    or public.is_org_member(organization_id, array['owner', 'finance']::org_role[])
  );

drop policy if exists payment_disputes_write on public.payment_disputes;
create policy payment_disputes_write on public.payment_disputes
  for all using (public.is_full_admin()) with check (public.is_full_admin());

-- ---------------------------------------------------------------------------
-- Reserve marking on the ledger
-- ---------------------------------------------------------------------------
alter table public.ledger_entries
  add column if not exists is_reserve boolean not null default false;

create index if not exists ledger_entries_reserve_idx
  on public.ledger_entries (organization_id, is_reserve, available_at);

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- The tier an organization has earned, ignoring any admin override.
-- Counting from the tables rather than from a stored counter: a counter that
-- drifts here silently pays people earlier than policy allows.
create or replace function public.earned_payout_tier(p_organization_id uuid)
returns smallint
language sql
stable
set search_path = public, extensions
as $$
  with history as (
    select
      (select count(*)
         from public.events e
        where e.organization_id = p_organization_id
          and e.status in ('published', 'completed')
          and coalesce(e.end_at, e.start_at) < now()) as done,
      (select count(*)
         from public.payment_disputes d
        where d.organization_id = p_organization_id
          and d.status in ('open', 'lost')) as incidents
  )
  select case
    when incidents > 0 then 0::smallint
    when done >= 3     then 2::smallint
    when done >= 1     then 1::smallint
    else 0::smallint
  end
  from history;
$$;

-- The tier actually applied: an admin override wins, otherwise the history.
create or replace function public.effective_payout_tier(p_organization_id uuid)
returns smallint
language sql
stable
set search_path = public, extensions
as $$
  select coalesce(
    (select o.payout_tier_override from public.organizations o where o.id = p_organization_id),
    public.earned_payout_tier(p_organization_id)
  );
$$;

-- Everything the sale needs to know in one row.
create or replace function public.payout_policy_for(p_organization_id uuid)
returns public.payout_tiers
language sql
stable
set search_path = public, extensions
as $$
  select t.* from public.payout_tiers t
  where t.tier = public.effective_payout_tier(p_organization_id);
$$;

-- An open dispute freezes every payout for that organizer, not only the event
-- the dispute came from. Money is fungible; a hold that one event can route
-- around is not a hold.
create or replace function public.organization_payouts_frozen(p_organization_id uuid)
returns boolean
language sql
stable
set search_path = public, extensions
as $$
  select exists (
    select 1 from public.payment_disputes d
    where d.organization_id = p_organization_id and d.status = 'open'
  );
$$;

-- The moment the event is over — end time when there is one, start otherwise.
create or replace function public.event_settlement_anchor(p_event_id uuid)
returns timestamptz
language sql
stable
set search_path = public, extensions
as $$
  select coalesce(e.end_at, e.start_at) from public.events e where e.id = p_event_id;
$$;

-- ---------------------------------------------------------------------------
-- Balances, now with the reserve broken out
-- ---------------------------------------------------------------------------
drop view if exists public.organization_balances;
create view public.organization_balances
-- security_invoker so the view reads under the caller's own RLS rather than the
-- owner's. Dropping it here would quietly turn every balance into public data.
with (security_invoker = true)
as
select
  o.id as organization_id,
  o.default_currency as currency,
  coalesce(sum(l.amount_cents), 0)::bigint as balance_cents,
  coalesce(sum(l.amount_cents) filter (where l.available_at <= now()), 0)::bigint as available_cents,
  coalesce(sum(l.amount_cents) filter (where l.available_at > now()), 0)::bigint as pending_cents,
  -- Of the pending amount, how much is the reserve specifically. The organizer
  -- asks this the day after the event, every time.
  coalesce(sum(l.amount_cents) filter (where l.available_at > now() and l.is_reserve), 0)::bigint
    as reserve_cents,
  min(l.available_at) filter (where l.available_at > now()) as next_release_at,
  coalesce(sum(l.amount_cents) filter (where l.type = 'sale'), 0)::bigint as gross_sales_cents,
  coalesce(-sum(l.amount_cents) filter (where l.type = 'platform_fee'), 0)::bigint as platform_fee_cents,
  coalesce(-sum(l.amount_cents) filter (where l.type = 'platform_fee' and l.description like 'BLUP commission%'), 0)::bigint as commission_cents,
  coalesce(-sum(l.amount_cents) filter (where l.type = 'platform_fee' and l.description like 'BLUP archive fee%'), 0)::bigint as archive_fee_cents,
  coalesce(-sum(l.amount_cents) filter (where l.type = 'refund'), 0)::bigint as refunded_cents,
  coalesce(-sum(l.amount_cents) filter (where l.type = 'payout'), 0)::bigint as paid_out_cents,
  -- Whether an organizer is frozen, and what tier they are on, is answered only
  -- for people entitled to ask. Organizations themselves are publicly readable,
  -- so an ungated column here would broadcast "this organizer has an open card
  -- dispute" to every visitor.
  case when public.is_org_member(o.id, array['owner', 'finance']::org_role[]) or public.is_full_admin()
       then public.effective_payout_tier(o.id) end as payout_tier,
  case when public.is_org_member(o.id, array['owner', 'finance']::org_role[]) or public.is_full_admin()
       then public.organization_payouts_frozen(o.id) end as payouts_frozen
from public.organizations o
left join public.ledger_entries l on l.organization_id = o.id
group by o.id, o.default_currency;

-- ---------------------------------------------------------------------------
-- The sale, re-anchored
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

  insert into public.event_attendees (event_id, user_id, status)
  values (o.event_id, o.buyer_id, 'going')
  on conflict (event_id, user_id) do update set status = 'going';

  insert into public.notifications (user_id, type, title, body, event_id, data)
  values (
    o.buyer_id, 'ticket_confirmed', 'Ticket confirmed',
    'Your ticket is ready. Show the QR code at the door.',
    o.event_id, jsonb_build_object('order_id', o.id)
  );

  perform public.queue_ticket_email(o.id);

  return query select * from public.tickets t where t.order_id = o.id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Recording a dispute
-- ---------------------------------------------------------------------------
-- Called by the webhook with the service role. Idempotent on the provider's
-- dispute id, because webhooks are delivered more than once by design.
create or replace function public.record_dispute_opened(
  p_provider_reference text,
  p_charge_reference   text,
  p_order_id           uuid,
  p_amount_cents       integer,
  p_currency           text,
  p_reason             text
)
returns public.payment_disputes
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  o public.orders;
  d public.payment_disputes;
begin
  select * into o from public.orders where id = p_order_id;

  insert into public.payment_disputes (
    organization_id, order_id, event_id, provider_reference, charge_reference,
    amount_cents, currency, reason, status
  )
  values (
    o.organization_id, o.id, o.event_id, p_provider_reference, p_charge_reference,
    coalesce(p_amount_cents, 0), coalesce(p_currency, 'EUR'), p_reason, 'open'
  )
  on conflict (provider_reference) do update
    set charge_reference = excluded.charge_reference,
        reason           = coalesce(excluded.reason, public.payment_disputes.reason)
  returning * into d;

  -- The organizer has to know, because they are the one who has to produce the
  -- evidence, and because their payouts have just stopped.
  if d.organization_id is not null then
    insert into public.notifications (user_id, type, title, body, event_id, data)
    select m.user_id, 'payout_update', 'Sporná platba',
           'Zákazník napadol platbu. Výplaty sú pozastavené, kým sa spor neuzavrie.',
           d.event_id,
           jsonb_build_object('dispute_id', d.id, 'amount_cents', d.amount_cents)
    from public.organization_members m
    where m.organization_id = d.organization_id and m.role in ('owner', 'finance');
  end if;

  return d;
end;
$$;

-- Closing it. A lost dispute takes the money back out of the ledger; a won one
-- only lifts the freeze, because nothing ever left.
create or replace function public.record_dispute_closed(
  p_provider_reference text,
  p_status             text
)
returns public.payment_disputes
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  d public.payment_disputes;
begin
  if p_status not in ('won', 'lost', 'withdrawn') then
    raise exception 'INVALID_DISPUTE_STATUS: %', p_status;
  end if;

  update public.payment_disputes
  set status = p_status, closed_at = now()
  where provider_reference = p_provider_reference
    and status = 'open'
  returning * into d;

  if not found then
    -- Already closed, or never opened here. Either way there is nothing to do,
    -- and raising would make the provider retry the webhook forever.
    select * into d from public.payment_disputes
    where provider_reference = p_provider_reference;
    return d;
  end if;

  if p_status = 'lost' and d.organization_id is not null then
    insert into public.ledger_entries
      (organization_id, event_id, order_id, type, amount_cents, currency, description, available_at)
    values (d.organization_id, d.event_id, d.order_id, 'refund', -d.amount_cents, d.currency,
            'Prehratý spor · ' || coalesce(d.reason, 'chargeback'), now());
  end if;

  if d.organization_id is not null then
    insert into public.notifications (user_id, type, title, body, event_id, data)
    select m.user_id, 'payout_update',
           case when p_status = 'lost' then 'Spor prehratý' else 'Spor uzavretý' end,
           case when p_status = 'lost'
                then 'Suma bola odpísaná z tvojho zostatku.'
                else 'Spor sa skončil v tvoj prospech. Výplaty sú opäť možné.' end,
           d.event_id, jsonb_build_object('dispute_id', d.id)
    from public.organization_members m
    where m.organization_id = d.organization_id and m.role in ('owner', 'finance');
  end if;

  return d;
end;
$$;

-- ---------------------------------------------------------------------------
-- request_payout — same as before, plus the freeze
-- ---------------------------------------------------------------------------
create or replace function public.request_payout(
  p_organization_id uuid,
  p_amount_cents    integer
)
returns public.payouts
language plpgsql
security definer
set search_path = public, extensions
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

  if public.organization_payouts_frozen(p_organization_id) then
    raise exception 'PAYOUTS_FROZEN_DISPUTE'
      using hint = 'An open card dispute freezes payouts until it is resolved.';
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

-- ---------------------------------------------------------------------------
-- The advance
-- ---------------------------------------------------------------------------
-- An advance is a payout, so it lives in the payouts table — but it has to be
-- distinguishable from an ordinary one, and it belongs to a specific event,
-- because the cap is per event.
alter table public.payouts
  add column if not exists is_advance boolean not null default false,
  add column if not exists event_id uuid references public.events (id) on delete set null;

-- What an organizer could be advanced on one event right now, and why not when
-- the answer is nothing. Readable by the organizer so the screen can explain
-- itself rather than just greying a button out.
create or replace function public.advance_quote(
  p_organization_id uuid,
  p_event_id        uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  pol        public.payout_tiers;
  anchor     timestamptz;
  opens_at   timestamptz;
  pending_c  bigint;
  taken_c    bigint;
  cap_c      bigint;
begin
  if not (public.is_org_member(p_organization_id, array['owner', 'finance']::org_role[])
          or public.is_full_admin()) then
    raise exception 'NOT_AUTHORIZED';
  end if;

  pol    := public.payout_policy_for(p_organization_id);
  anchor := public.event_settlement_anchor(p_event_id);

  if pol.advance_max_bps = 0 then
    return jsonb_build_object('eligible', false, 'reason', 'TIER_NO_ADVANCE',
                              'tier', pol.tier, 'max_cents', 0);
  end if;
  if anchor is null then
    return jsonb_build_object('eligible', false, 'reason', 'EVENT_NOT_FOUND', 'max_cents', 0);
  end if;
  if public.organization_payouts_frozen(p_organization_id) then
    return jsonb_build_object('eligible', false, 'reason', 'PAYOUTS_FROZEN_DISPUTE', 'max_cents', 0);
  end if;

  opens_at := anchor - make_interval(days => pol.advance_earliest_days);
  if now() < opens_at then
    return jsonb_build_object('eligible', false, 'reason', 'TOO_EARLY',
                              'opens_at', opens_at, 'tier', pol.tier, 'max_cents', 0);
  end if;

  -- Only the not-yet-released, non-reserve sales of THIS event can be advanced.
  -- The reserve is the part that must survive the event, so it is never
  -- advanceable at any tier.
  select coalesce(sum(l.amount_cents), 0) into pending_c
  from public.ledger_entries l
  where l.organization_id = p_organization_id
    and l.event_id = p_event_id
    and l.type = 'sale'
    and not l.is_reserve
    and l.available_at > now();

  select coalesce(sum(-l.amount_cents), 0) into taken_c
  from public.ledger_entries l
  join public.payouts p on p.id = l.payout_id
  where l.organization_id = p_organization_id
    and l.type = 'payout'
    and p.is_advance
    and p.event_id = p_event_id;

  cap_c := ((pending_c + taken_c) * pol.advance_max_bps) / 10000 - taken_c;

  return jsonb_build_object(
    'eligible',  cap_c > 0,
    'reason',    case when cap_c > 0 then null else 'NOTHING_AVAILABLE' end,
    'tier',      pol.tier,
    'max_bps',   pol.advance_max_bps,
    'opens_at',  opens_at,
    'max_cents', greatest(0, cap_c)
  );
end;
$$;

-- Granting it. Admin-only on purpose: section 5 of the setup document is
-- explicit that an advance must never be something the organizer can take.
create or replace function public.approve_payout_advance(
  p_organization_id uuid,
  p_event_id        uuid,
  p_amount_cents    integer,
  p_note            text default null
)
returns public.payouts
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  quote jsonb;
  org   record;
  p     public.payouts;
begin
  if not public.is_full_admin() then
    raise exception 'NOT_AUTHORIZED';
  end if;

  select * into org from public.organizations where id = p_organization_id;
  if not found then
    raise exception 'ORGANIZATION_NOT_FOUND';
  end if;
  if not org.payouts_enabled then
    raise exception 'PAYOUTS_NOT_ENABLED';
  end if;

  quote := public.advance_quote(p_organization_id, p_event_id);

  if not (quote->>'eligible')::boolean then
    raise exception 'ADVANCE_NOT_ELIGIBLE: %', coalesce(quote->>'reason', 'unknown');
  end if;
  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'INVALID_AMOUNT';
  end if;
  if p_amount_cents > (quote->>'max_cents')::bigint then
    raise exception 'ADVANCE_OVER_CAP: max %', (quote->>'max_cents')::bigint;
  end if;

  insert into public.payouts
    (organization_id, event_id, amount_cents, currency, status, provider, requested_by, is_advance)
  values
    (p_organization_id, p_event_id, p_amount_cents, org.default_currency, 'pending',
     org.payment_provider, auth.uid(), true)
  returning * into p;

  -- Deliberately available immediately: the money has left, so the balance must
  -- say so now. Available balance can go negative until the sales mature, which
  -- is exactly right — it is what stops a second advance on the same tickets.
  insert into public.ledger_entries
    (organization_id, event_id, payout_id, type, amount_cents, currency, description, available_at)
  values (p_organization_id, p_event_id, p.id, 'payout', -p_amount_cents, org.default_currency,
          coalesce(p_note, 'Záloha pred podujatím'), now());

  insert into public.notifications (user_id, type, title, body, event_id, data)
  select m.user_id, 'payout_update', 'Záloha schválená',
         'BLUP schválil zálohu na tvoje podujatie.',
         p_event_id, jsonb_build_object('payout_id', p.id, 'amount_cents', p_amount_cents)
  from public.organization_members m
  where m.organization_id = p_organization_id and m.role in ('owner', 'finance');

  return p;
end;
$$;

-- ---------------------------------------------------------------------------
-- Admin: pin or release a tier
-- ---------------------------------------------------------------------------
create or replace function public.admin_set_payout_tier(
  p_organization_id uuid,
  p_tier            smallint,   -- null clears the override and follows history
  p_note            text default null
)
returns public.organizations
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  org public.organizations;
begin
  if not public.is_full_admin() then
    raise exception 'NOT_AUTHORIZED';
  end if;
  if p_tier is not null and not exists (select 1 from public.payout_tiers where tier = p_tier) then
    raise exception 'UNKNOWN_TIER: %', p_tier;
  end if;

  update public.organizations
  set payout_tier_override = p_tier,
      payout_tier_note     = p_note,
      payout_tier          = coalesce(p_tier, public.earned_payout_tier(p_organization_id))
  where id = p_organization_id
  returning * into org;

  if not found then
    raise exception 'ORGANIZATION_NOT_FOUND';
  end if;

  return org;
end;
$$;

-- Marking a provider payout as actually landed (or not). Called by the webhook.
create or replace function public.mark_payout_settled(
  p_payout_id uuid,
  p_status    payout_status,
  p_reference text default null
)
returns public.payouts
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  p public.payouts;
begin
  update public.payouts
  set status = p_status,
      provider_transfer_id = coalesce(p_reference, provider_transfer_id),
      processed_at = case when p_status = 'paid' then now() else processed_at end
  where id = p_payout_id
  returning * into p;

  if not found then
    raise exception 'PAYOUT_NOT_FOUND';
  end if;

  -- A failed payout puts the money back: the ledger debit was written when the
  -- payout was requested, on the assumption it would arrive.
  if p_status = 'failed' then
    insert into public.ledger_entries
      (organization_id, payout_id, type, amount_cents, currency, description, available_at)
    values (p.organization_id, p.id, 'adjustment', p.amount_cents, p.currency,
            'Neúspešná výplata — vrátené na zostatok', now());
  end if;

  insert into public.notifications (user_id, type, title, body, data)
  select m.user_id, 'payout_update',
         case p_status when 'paid' then 'Výplata odoslaná' else 'Výplata zlyhala' end,
         case p_status when 'paid' then 'Peniaze sú na ceste na tvoj účet.'
                       else 'Výplatu sa nepodarilo odoslať. Skontroluj bankové údaje.' end,
         jsonb_build_object('payout_id', p.id, 'amount_cents', p.amount_cents)
  from public.organization_members m
  where m.organization_id = p.organization_id and m.role in ('owner', 'finance');

  return p;
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges — these follow the same rule as the rest: nothing that moves money
-- is callable by an anonymous visitor.
-- ---------------------------------------------------------------------------
revoke all on function public.record_dispute_opened(text, text, uuid, integer, text, text) from public, anon, authenticated;
revoke all on function public.record_dispute_closed(text, text) from public, anon, authenticated;
revoke all on function public.mark_payout_settled(uuid, payout_status, text) from public, anon, authenticated;
revoke all on function public.approve_payout_advance(uuid, uuid, integer, text) from public, anon;
revoke all on function public.admin_set_payout_tier(uuid, smallint, text) from public, anon;
grant execute on function public.approve_payout_advance(uuid, uuid, integer, text) to authenticated;
grant execute on function public.admin_set_payout_tier(uuid, smallint, text) to authenticated;
grant execute on function public.advance_quote(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Admin dashboard: open disputes belong on the front page
-- ---------------------------------------------------------------------------
-- An open dispute silently stops an organizer being paid. If nobody sees the
-- count, the first anyone hears of it is the organizer asking why their money
-- has not arrived.
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
    'open_disputes', (select count(*) from public.payment_disputes where status = 'open'),
    'frozen_organizations',
      (select count(distinct organization_id) from public.payment_disputes where status = 'open'),
    'premium_users', (select count(distinct user_id) from public.premium_subscriptions
                      where status in ('active', 'trialing', 'grace_period')
                        and (expires_at is null or expires_at > now()))
  );
end;
$$;
