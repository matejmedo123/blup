-- ============================================================================
-- BLUP · 0007 · Premium subscriptions (Apple StoreKit / Google Play / Stripe)
-- ============================================================================
-- Subscription state is ONLY ever written by the verification Edge Functions
-- (iap-verify-apple / iap-apple-notifications). The app can read its own state
-- but can never grant itself premium.
-- ============================================================================

create table if not exists public.premium_subscriptions (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid not null references public.profiles (id) on delete cascade,
  platform                subscription_platform not null,
  product_id              text not null,
  status                  subscription_status not null default 'expired',
  original_transaction_id text,
  latest_transaction_id   text,
  purchased_at            timestamptz,
  expires_at              timestamptz,
  auto_renew              boolean not null default false,
  environment             text not null default 'production'
                          check (environment in ('sandbox', 'production')),
  raw                     jsonb not null default '{}'::jsonb,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint premium_subscriptions_original_tx_unique
    unique (platform, original_transaction_id)
);

create index if not exists premium_subscriptions_user_idx
  on public.premium_subscriptions (user_id, status);

drop trigger if exists premium_subscriptions_set_updated_at on public.premium_subscriptions;
create trigger premium_subscriptions_set_updated_at
  before update on public.premium_subscriptions
  for each row execute function public.set_updated_at();

-- Append-only log of every store notification we processed (audit + debugging).
create table if not exists public.subscription_events (
  id              uuid primary key default gen_random_uuid(),
  subscription_id uuid references public.premium_subscriptions (id) on delete set null,
  user_id         uuid references public.profiles (id) on delete set null,
  platform        subscription_platform not null,
  notification_type text not null,
  payload         jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);

create index if not exists subscription_events_sub_idx
  on public.subscription_events (subscription_id, created_at desc);

-- Single source of truth for "is this user premium right now?"
create or replace function public.is_premium(uid uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.premium_subscriptions s
    where s.user_id = uid
      and s.status in ('active', 'trialing', 'grace_period')
      and (s.expires_at is null or s.expires_at > now())
  );
$$;

create or replace function public.my_premium_status()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (
      select jsonb_build_object(
        'is_premium', true,
        'platform', s.platform,
        'product_id', s.product_id,
        'status', s.status,
        'expires_at', s.expires_at,
        'auto_renew', s.auto_renew
      )
      from public.premium_subscriptions s
      where s.user_id = auth.uid()
        and s.status in ('active', 'trialing', 'grace_period')
        and (s.expires_at is null or s.expires_at > now())
      order by s.expires_at desc nulls first
      limit 1
    ),
    jsonb_build_object('is_premium', false, 'status', 'none')
  );
$$;

-- Upsert used by the receipt-verification Edge Functions (service role only).
create or replace function public.upsert_premium_subscription(
  p_user_id      uuid,
  p_platform     subscription_platform,
  p_product_id   text,
  p_status       subscription_status,
  p_original_tx  text,
  p_latest_tx    text,
  p_purchased_at timestamptz,
  p_expires_at   timestamptz,
  p_auto_renew   boolean,
  p_environment  text,
  p_raw          jsonb default '{}'::jsonb
)
returns public.premium_subscriptions
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.premium_subscriptions;
begin
  insert into public.premium_subscriptions (
    user_id, platform, product_id, status, original_transaction_id,
    latest_transaction_id, purchased_at, expires_at, auto_renew, environment, raw
  )
  values (
    p_user_id, p_platform, p_product_id, p_status, p_original_tx,
    p_latest_tx, p_purchased_at, p_expires_at, coalesce(p_auto_renew, false),
    coalesce(p_environment, 'production'), coalesce(p_raw, '{}'::jsonb)
  )
  on conflict (platform, original_transaction_id) do update
  set user_id = excluded.user_id,
      product_id = excluded.product_id,
      status = excluded.status,
      latest_transaction_id = excluded.latest_transaction_id,
      purchased_at = coalesce(excluded.purchased_at, public.premium_subscriptions.purchased_at),
      expires_at = excluded.expires_at,
      auto_renew = excluded.auto_renew,
      environment = excluded.environment,
      raw = excluded.raw
  returning * into s;

  insert into public.subscription_events (subscription_id, user_id, platform, notification_type, payload)
  values (s.id, p_user_id, p_platform, p_status::text, coalesce(p_raw, '{}'::jsonb));

  return s;
end;
$$;
