-- ============================================================================
-- BLUP · 0003 · Organizations (organizer layer), members, verification
-- ============================================================================
-- Rule (product spec §12/§13): free events can be created by any user, but
-- ticketed (paid) events must belong to a verified organization. The paid-event
-- constraint is enforced in 0004 (events) + 0006 (ticket types).
-- ============================================================================


-- Resolve the citext type and pgcrypto functions regardless of which schema
-- the extensions were installed into (public locally, extensions on Supabase).
set search_path = public, extensions;
create table if not exists public.organizations (
  id                  uuid primary key default gen_random_uuid(),
  slug                citext not null unique,
  name                text not null,
  logo_url            text,
  cover_url           text,
  description         text,
  website             text,
  contact_email       citext,
  contact_phone       text,
  country             text,
  city                text,
  verification_status verification_status not null default 'unverified',
  -- payments / payouts
  payment_provider    payment_provider not null default 'stripe',
  stripe_account_id   text unique,
  charges_enabled     boolean not null default false,
  payouts_enabled     boolean not null default false,
  -- BLUP takes a platform fee on every ticket sale (basis points, 300 = 3.00%)
  platform_fee_bps    integer not null default 300 check (platform_fee_bps between 0 and 2000),
  default_currency    text not null default 'EUR' check (char_length(default_currency) = 3),
  created_by          uuid not null references public.profiles (id) on delete restrict,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint organizations_slug_format check (slug ~ '^[a-z0-9][a-z0-9\-]{1,38}[a-z0-9]$'),
  constraint organizations_name_len check (char_length(name) between 2 and 80)
);

create index if not exists organizations_verification_idx
  on public.organizations (verification_status);

drop trigger if exists organizations_set_updated_at on public.organizations;
create trigger organizations_set_updated_at
  before update on public.organizations
  for each row execute function public.set_updated_at();

create table if not exists public.organization_members (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id         uuid not null references public.profiles (id) on delete cascade,
  role            org_role not null default 'event_manager',
  created_at      timestamptz not null default now(),
  primary key (organization_id, user_id)
);

create index if not exists organization_members_user_idx on public.organization_members (user_id);

create table if not exists public.organization_verification_requests (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations (id) on delete cascade,
  submitted_by        uuid not null references public.profiles (id) on delete cascade,
  legal_name          text not null,
  registration_number text,
  vat_number          text,
  contact_email       citext not null,
  contact_phone       text,
  address             text,
  documents           jsonb not null default '[]'::jsonb, -- [{ path, kind, uploaded_at }]
  status              verification_status not null default 'pending',
  reviewer_id         uuid references public.profiles (id) on delete set null,
  review_notes        text,
  created_at          timestamptz not null default now(),
  reviewed_at         timestamptz
);

create index if not exists org_verification_status_idx
  on public.organization_verification_requests (status, created_at desc);
create index if not exists org_verification_org_idx
  on public.organization_verification_requests (organization_id);

-- Organizer authorization helper. `required` = NULL means "any member".
create or replace function public.is_org_member(
  org      uuid,
  required org_role[] default null,
  uid      uuid default auth.uid()
)
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select exists (
    select 1
    from public.organization_members m
    where m.organization_id = org
      and m.user_id = uid
      and (required is null or m.role = any (required))
  );
$$;

create or replace function public.is_org_verified(org uuid)
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select exists (
    select 1 from public.organizations o
    where o.id = org and o.verification_status = 'verified'
  );
$$;

-- The creator of an organization automatically becomes its owner.
create or replace function public.handle_new_organization()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  insert into public.organization_members (organization_id, user_id, role)
  values (new.id, new.created_by, 'owner')
  on conflict do nothing;
  return new;
end;
$$;

drop trigger if exists on_organization_created on public.organizations;
create trigger on_organization_created
  after insert on public.organizations
  for each row execute function public.handle_new_organization();
