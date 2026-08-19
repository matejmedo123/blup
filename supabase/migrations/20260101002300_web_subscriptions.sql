-- ============================================================================
-- BLUP · 0023 · Web subscriptions and Stripe customers
-- ============================================================================
-- Premium on the web is sold through Stripe rather than Apple. It is the same
-- product at the same shelf price; what changes is that the 15–30 % App Store
-- commission does not apply, which is the whole reason to launch on the web
-- first.
--
-- The two paths converge on one table. `premium_subscriptions` already has a
-- `stripe` platform value and a unique key on (platform, original_transaction_id),
-- so an Apple subscription and a Stripe one for the same person are two rows
-- and `is_premium()` sees whichever is active. Nobody is charged twice, and
-- somebody who starts on the web and later installs the app keeps their
-- subscription.
--
-- What is new here:
--   · stripe_customers — one Stripe customer per person, so cards and history
--     stay together instead of forking on every purchase
--   · web_premium_status() — what the subscribe screen needs to render honestly
--   · cancel/reactivate bookkeeping driven entirely by the webhook
-- ============================================================================

set search_path = public, extensions;

create table if not exists public.stripe_customers (
  user_id            uuid primary key references public.profiles (id) on delete cascade,
  stripe_customer_id text not null unique,
  created_at         timestamptz not null default now()
);

alter table public.stripe_customers enable row level security;

-- A person may see their own mapping (the app shows "manage billing"); nobody
-- writes it from a client.
drop policy if exists stripe_customers_select_own on public.stripe_customers;
create policy stripe_customers_select_own on public.stripe_customers
  for select using (user_id = auth.uid() or public.is_admin());

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on public.stripe_customers from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke insert, update, delete on public.stripe_customers from authenticated';
  end if;
end
$$;

/**
 * Records the Stripe customer for a person. Service-role only — the id comes
 * from Stripe, never from a client that could claim somebody else's.
 */
create or replace function public.link_stripe_customer(
  p_user_id  uuid,
  p_customer text
)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  insert into public.stripe_customers (user_id, stripe_customer_id)
  values (p_user_id, p_customer)
  on conflict (user_id) do update set stripe_customer_id = excluded.stripe_customer_id;

  return p_customer;
end;
$$;

/** The Stripe customer id for a person, or null if they have never paid. */
create or replace function public.stripe_customer_for(p_user_id uuid)
returns text
language sql
stable
security definer
set search_path = public, extensions
as $$
  select stripe_customer_id from public.stripe_customers where user_id = p_user_id;
$$;

/**
 * Resolves the user behind a Stripe customer id, so a webhook that only carries
 * `customer` can still find the person. Service-role only.
 */
create or replace function public.user_for_stripe_customer(p_customer text)
returns uuid
language sql
stable
security definer
set search_path = public, extensions
as $$
  select user_id from public.stripe_customers where stripe_customer_id = p_customer;
$$;

-- ---------------------------------------------------------------------------
-- What the subscribe screen needs
-- ---------------------------------------------------------------------------

/**
 * Premium state for the current user, told plainly: whether it is active, which
 * platform it came from, when it renews, and whether it is already set to stop.
 *
 * `managed_here` is the honest bit. A subscription bought through Apple cannot
 * be cancelled from a web page, and pretending otherwise leads someone to think
 * they cancelled when they did not.
 */
create or replace function public.web_premium_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  s   public.premium_subscriptions;
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'NOT_AUTHENTICATED';
  end if;

  select * into s
  from public.premium_subscriptions
  where user_id = uid
    and status in ('active', 'trialing', 'grace_period')
    and (expires_at is null or expires_at > now())
  order by expires_at desc nulls first
  limit 1;

  if not found then
    return jsonb_build_object(
      'active', false,
      'platform', null,
      'managed_here', true,
      'has_stripe_customer', public.stripe_customer_for(uid) is not null
    );
  end if;

  return jsonb_build_object(
    'active', true,
    'platform', s.platform,
    'product_id', s.product_id,
    'status', s.status,
    'expires_at', s.expires_at,
    'auto_renew', s.auto_renew,
    -- Only a Stripe subscription can be managed from a browser.
    'managed_here', s.platform = 'stripe',
    'has_stripe_customer', public.stripe_customer_for(uid) is not null
  );
end;
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke execute on function public.link_stripe_customer(uuid, text) from authenticated';
    execute 'revoke execute on function public.user_for_stripe_customer(text) from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke execute on function public.link_stripe_customer(uuid, text) from anon';
    execute 'revoke execute on function public.user_for_stripe_customer(text) from anon';
    execute 'revoke execute on function public.web_premium_status() from anon';
  end if;
end
$$;
