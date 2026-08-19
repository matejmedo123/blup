-- ============================================================================
-- BLUP · 0020 · Buying a boost through the payment gateway
-- ============================================================================
-- A boost is paid visibility, so it follows exactly the same money path as a
-- ticket: the database prices it, the payment provider charges it, and the
-- WEBHOOK is what activates it. A boost that was never paid for never lifts an
-- event's score, however the client behaves.
--
-- 0018 created event_boosts as an internal row. This migration makes it a
-- purchasable thing: a price list, a payment status, and the pair of functions
-- that create and confirm the purchase.
-- ============================================================================


-- Resolve the citext type and pgcrypto functions regardless of which schema
-- the extensions were installed into (public locally, extensions on Supabase).
set search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- What you can buy
-- ---------------------------------------------------------------------------
create table if not exists public.boost_packages (
  code         text primary key,
  name         text not null,
  hours        integer not null check (hours > 0),
  weight       numeric(4,2) not null check (weight > 0 and weight <= 0.5),
  price_cents  integer not null check (price_cents > 0),
  currency     text not null default 'EUR',
  is_active    boolean not null default true,
  sort_order   integer not null default 0
);

insert into public.boost_packages (code, name, hours, weight, price_cents, sort_order) values
  ('boost_24', 'Boost na 24 hodín', 24, 0.10,  700, 10),
  ('boost_48', 'Boost na 48 hodín', 48, 0.15, 1200, 20),
  ('boost_7d', 'Boost na týždeň',  168, 0.22, 3900, 30)
on conflict (code) do update
  set name = excluded.name,
      hours = excluded.hours,
      weight = excluded.weight,
      price_cents = excluded.price_cents,
      sort_order = excluded.sort_order;

-- ---------------------------------------------------------------------------
-- A boost is now a purchase
-- ---------------------------------------------------------------------------
alter table public.event_boosts
  add column if not exists package_code text references public.boost_packages (code);

alter table public.event_boosts
  add column if not exists payment_status payment_status not null default 'succeeded';

alter table public.event_boosts
  add column if not exists provider payment_provider not null default 'manual';

alter table public.event_boosts
  add column if not exists provider_reference text;

alter table public.event_boosts
  add column if not exists buyer_id uuid references public.profiles (id) on delete set null;

alter table public.event_boosts
  add column if not exists paid_at timestamptz;

alter table public.event_boosts
  add column if not exists failure_reason text;

-- One live payment reference per provider, so a replayed webhook cannot create
-- a second boost.
create unique index if not exists event_boosts_provider_reference_key
  on public.event_boosts (provider, provider_reference)
  where provider_reference is not null;

/**
 * Only a PAID boost counts.
 *
 * Redefined from 0018: an unpaid or failed purchase must not lift the score,
 * which is the whole reason the webhook exists.
 */
create or replace function public.boost_weight_for(p_event uuid)
returns numeric
language sql
stable
security definer
set search_path = public, extensions
as $$
  select coalesce(max(weight), 0)
  from public.event_boosts
  where event_id = p_event
    and payment_status = 'succeeded'
    and now() between starts_at and ends_at;
$$;

-- ---------------------------------------------------------------------------
-- Creating the purchase
-- ---------------------------------------------------------------------------
create or replace function public.create_boost_order(
  p_event   uuid,
  p_package text
)
returns public.event_boosts
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_me      uuid := auth.uid();
  v_event   public.events%rowtype;
  v_package public.boost_packages%rowtype;
  v_start   timestamptz;
  v_boost   public.event_boosts;
begin
  if v_me is null then
    raise exception 'UNAUTHENTICATED';
  end if;

  select * into v_package from public.boost_packages where code = p_package and is_active;
  if not found then
    raise exception 'BOOST_PACKAGE_NOT_FOUND';
  end if;

  select * into v_event from public.events where id = p_event;
  if not found or v_event.status <> 'published' then
    raise exception 'EVENT_NOT_AVAILABLE';
  end if;

  -- Only the host, or somebody who runs the hosting organization, may promote it.
  if v_event.creator_id <> v_me
     and not (v_event.organization_id is not null
              and public.is_org_member(v_event.organization_id,
                                       array['owner','admin']::org_role[]))
  then
    raise exception 'NOT_AUTHORIZED';
  end if;

  if v_event.start_at < now() then
    raise exception 'EVENT_ALREADY_STARTED';
  end if;

  -- A live boost is not replaced; a queued one starts when the current ends.
  select greatest(now(), coalesce(max(ends_at), now())) into v_start
  from public.event_boosts
  where event_id = p_event and payment_status = 'succeeded' and ends_at > now();

  insert into public.event_boosts (
    event_id, organization_id, package_code, buyer_id,
    starts_at, ends_at, weight, amount_cents, currency,
    payment_status, provider, created_by
  )
  values (
    p_event, v_event.organization_id, v_package.code, v_me,
    v_start, v_start + make_interval(hours => v_package.hours),
    v_package.weight, v_package.price_cents, v_package.currency,
    'requires_payment', 'stripe', v_me
  )
  returning * into v_boost;

  return v_boost;
end;
$$;

/**
 * Confirming it. Called by the webhook with the amount the provider actually
 * captured; a mismatch fails the boost rather than activating it, exactly as
 * fulfill_order() does for a ticket. Idempotent.
 */
create or replace function public.activate_boost(
  p_boost_id           uuid,
  p_provider           payment_provider,
  p_provider_reference text,
  p_amount_cents       integer
)
returns public.event_boosts
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_boost public.event_boosts;
begin
  select * into v_boost from public.event_boosts where id = p_boost_id for update;
  if not found then
    raise exception 'BOOST_NOT_FOUND';
  end if;

  if v_boost.payment_status = 'succeeded' then
    return v_boost;  -- already confirmed; a replayed webhook is not an error
  end if;

  -- A mismatch raises and writes nothing. Marking the row failed here would be
  -- pointless: the exception rolls the write back with it, exactly as it does
  -- in fulfill_order(). What matters is that the boost is NOT activated, so it
  -- keeps promoting nothing while the webhook error is investigated.
  if p_amount_cents is not null and p_amount_cents <> v_boost.amount_cents then
    raise exception 'AMOUNT_MISMATCH: expected % got %', v_boost.amount_cents, p_amount_cents;
  end if;

  -- The clock starts when the money lands, not when the sheet opened.
  update public.event_boosts
    set payment_status = 'succeeded',
        provider = p_provider,
        provider_reference = p_provider_reference,
        paid_at = now(),
        starts_at = greatest(starts_at, now()),
        ends_at = greatest(starts_at, now())
                  + (ends_at - starts_at)
    where id = p_boost_id
    returning * into v_boost;

  perform public.notify_user(
    v_boost.buyer_id,
    'payout_update'::notification_type,
    'Boost je aktívny 🚀',
    'Tvoj event je zvýraznený vo výbere. V zozname je označený ako sponzorovaný.',
    null,
    v_boost.event_id,
    jsonb_build_object('boost_id', v_boost.id)
  );

  return v_boost;
end;
$$;

create or replace function public.fail_boost(p_boost_id uuid, p_reason text)
returns void
language sql
security definer
set search_path = public, extensions
as $$
  update public.event_boosts
    set payment_status = 'failed', failure_reason = p_reason
    where id = p_boost_id and payment_status <> 'succeeded';
$$;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.boost_packages enable row level security;

drop policy if exists boost_packages_select on public.boost_packages;
create policy boost_packages_select on public.boost_packages for select using (true);

-- 0018 made boosts publicly readable so a card can label itself sponsored.
-- Keep that, but only for boosts that are actually paid; a pending purchase is
-- the buyer's business.
drop policy if exists event_boosts_select on public.event_boosts;
create policy event_boosts_select on public.event_boosts
  for select using (
    payment_status = 'succeeded'
    or buyer_id = auth.uid()
    or public.is_admin()
    or exists (
      select 1 from public.events e
      where e.id = event_id and e.creator_id = auth.uid()
    )
  );

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke insert, update, delete on public.boost_packages from authenticated';
    execute 'grant execute on function public.create_boost_order(uuid, text) to authenticated';
  end if;
end
$$;
