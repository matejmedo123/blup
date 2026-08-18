-- ============================================================================
-- BLUP · 0002 · Profiles, interests, follows/friendships
-- ============================================================================

-- ---------------------------------------------------------------------------
-- profiles: 1:1 with auth.users. Passwords/credentials stay in auth.users and
-- are managed exclusively by Supabase Auth (never written by application code).
-- ---------------------------------------------------------------------------

-- Resolve the citext type and pgcrypto functions regardless of which schema
-- the extensions were installed into (public locally, extensions on Supabase).
set search_path = public, extensions;
create table if not exists public.profiles (
  id                uuid primary key references auth.users (id) on delete cascade,
  email             citext,
  username          citext unique,
  display_name      text,
  avatar_url        text,
  bio               text,
  city              text,
  country           text,
  latitude          double precision,
  longitude         double precision,
  location_updated_at timestamptz,
  app_role          app_role      not null default 'user',
  -- privacy
  is_private        boolean       not null default false,
  show_location     boolean       not null default true,
  anonymous_mode    boolean       not null default false, -- premium feature
  allow_dm          boolean       not null default true,
  -- lifecycle
  onboarding_completed boolean    not null default false,
  is_suspended      boolean       not null default false,
  suspended_reason  text,
  locale            text          not null default 'en',
  created_at        timestamptz   not null default now(),
  updated_at        timestamptz   not null default now(),

  constraint profiles_username_format
    check (username is null or username ~ '^[a-z0-9_\.]{3,24}$'),
  constraint profiles_bio_len check (bio is null or char_length(bio) <= 300),
  constraint profiles_display_name_len
    check (display_name is null or char_length(display_name) between 1 and 60),
  constraint profiles_lat_range
    check (latitude is null or latitude between -90 and 90),
  constraint profiles_lon_range
    check (longitude is null or longitude between -180 and 180)
);

create index if not exists profiles_username_idx on public.profiles (username);
create index if not exists profiles_city_idx on public.profiles (city);
create index if not exists profiles_geo_idx on public.profiles (latitude, longitude);

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- Auto-provision a profile row whenever Supabase Auth creates a user.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  base_username text;
  candidate     text;
  suffix        integer := 0;
begin
  base_username := lower(regexp_replace(
    coalesce(
      new.raw_user_meta_data ->> 'username',
      split_part(coalesce(new.email, 'blupper'), '@', 1)
    ),
    '[^a-z0-9_\.]', '', 'g'
  ));

  if char_length(base_username) < 3 then
    base_username := 'blupper' || base_username;
  end if;
  base_username := substr(base_username, 1, 20);

  candidate := base_username;
  while exists (select 1 from public.profiles p where p.username = candidate::citext) loop
    suffix := suffix + 1;
    candidate := substr(base_username, 1, 20) || suffix::text;
  end loop;

  insert into public.profiles (id, email, username, display_name)
  values (
    new.id,
    new.email,
    candidate,
    coalesce(new.raw_user_meta_data ->> 'display_name', candidate)
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- interests
-- ---------------------------------------------------------------------------
create table if not exists public.interests (
  id         uuid primary key default gen_random_uuid(),
  slug       text not null unique,
  name       text not null,
  category   text not null,
  emoji      text,
  sort_order integer not null default 100,
  created_at timestamptz not null default now()
);

create index if not exists interests_category_idx on public.interests (category, sort_order);

create table if not exists public.user_interests (
  user_id     uuid not null references public.profiles (id) on delete cascade,
  interest_id uuid not null references public.interests (id) on delete cascade,
  weight      numeric(4,2) not null default 1.0 check (weight between 0 and 5),
  created_at  timestamptz not null default now(),
  primary key (user_id, interest_id)
);

create index if not exists user_interests_interest_idx on public.user_interests (interest_id);

-- ---------------------------------------------------------------------------
-- follows / friendships
-- ---------------------------------------------------------------------------
create table if not exists public.follows (
  follower_id  uuid not null references public.profiles (id) on delete cascade,
  following_id uuid not null references public.profiles (id) on delete cascade,
  created_at   timestamptz not null default now(),
  primary key (follower_id, following_id),
  constraint follows_no_self check (follower_id <> following_id)
);

create index if not exists follows_following_idx on public.follows (following_id);

create table if not exists public.friendships (
  id           uuid primary key default gen_random_uuid(),
  requester_id uuid not null references public.profiles (id) on delete cascade,
  addressee_id uuid not null references public.profiles (id) on delete cascade,
  status       friendship_status not null default 'pending',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint friendships_no_self check (requester_id <> addressee_id),
  constraint friendships_unique_pair unique (requester_id, addressee_id)
);

create index if not exists friendships_addressee_idx on public.friendships (addressee_id, status);

drop trigger if exists friendships_set_updated_at on public.friendships;
create trigger friendships_set_updated_at
  before update on public.friendships
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Authorization helpers (used by RLS across the schema)
-- ---------------------------------------------------------------------------
create or replace function public.is_admin(uid uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = uid and p.app_role in ('admin', 'moderator')
  );
$$;

create or replace function public.is_full_admin(uid uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select exists (
    select 1 from public.profiles p where p.id = uid and p.app_role = 'admin'
  );
$$;

create or replace function public.is_following(target uuid, viewer uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select exists (
    select 1 from public.follows f
    where f.follower_id = viewer and f.following_id = target
  );
$$;
