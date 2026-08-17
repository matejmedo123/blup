-- ============================================================================
-- BLUP · 0004 · Events, gallery, RSVP, saves, likes, views
-- ============================================================================

create table if not exists public.events (
  id               uuid primary key default gen_random_uuid(),
  creator_id       uuid not null references public.profiles (id) on delete cascade,
  organization_id  uuid references public.organizations (id) on delete set null,
  title            text not null,
  description      text,
  cover_image_url  text,
  category         text not null default 'other',
  tags             text[] not null default '{}',
  -- location
  latitude         double precision not null,
  longitude        double precision not null,
  address          text,
  venue_name       text,
  city             text,
  country          text,
  -- schedule
  start_at         timestamptz not null,
  end_at           timestamptz,
  timezone         text not null default 'UTC',
  -- capacity & pricing
  capacity         integer check (capacity is null or capacity > 0),
  is_free          boolean not null default true,
  price_cents      integer not null default 0 check (price_cents >= 0),
  currency         text not null default 'EUR' check (char_length(currency) = 3),
  -- state
  status           event_status not null default 'published',
  visibility       event_visibility not null default 'public',
  -- denormalised counters (maintained by triggers, never written by clients)
  attendee_count   integer not null default 0,
  interested_count integer not null default 0,
  saved_count      integer not null default 0,
  like_count       integer not null default 0,
  comment_count    integer not null default 0,
  view_count       integer not null default 0,
  tickets_sold     integer not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint events_title_len check (char_length(title) between 3 and 120),
  constraint events_description_len
    check (description is null or char_length(description) <= 5000),
  constraint events_lat_range check (latitude between -90 and 90),
  constraint events_lon_range check (longitude between -180 and 180),
  constraint events_end_after_start check (end_at is null or end_at > start_at),
  constraint events_tags_len check (array_length(tags, 1) is null or array_length(tags, 1) <= 10),
  -- Paid events must be owned by an organization (spec §12).
  constraint events_paid_requires_org
    check (is_free or organization_id is not null),
  constraint events_price_matches_free
    check ((is_free and price_cents = 0) or (not is_free))
);

create index if not exists events_geo_idx on public.events (latitude, longitude);
create index if not exists events_start_idx on public.events (start_at);
create index if not exists events_status_start_idx
  on public.events (status, visibility, start_at);
create index if not exists events_creator_idx on public.events (creator_id, start_at desc);
create index if not exists events_org_idx on public.events (organization_id, start_at desc);
create index if not exists events_category_idx on public.events (category, start_at);
create index if not exists events_tags_idx on public.events using gin (tags);
create index if not exists events_search_idx
  on public.events using gin (
    to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(description, '') || ' ' || coalesce(venue_name, '') || ' ' || coalesce(city, ''))
  );

drop trigger if exists events_set_updated_at on public.events;
create trigger events_set_updated_at
  before update on public.events
  for each row execute function public.set_updated_at();

-- A paid event may only be published by a VERIFIED organization.
create or replace function public.enforce_paid_event_rules()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not new.is_free then
    if new.organization_id is null then
      raise exception 'PAID_EVENT_REQUIRES_ORGANIZATION'
        using hint = 'Create or join a verified organization to sell tickets.';
    end if;
    if not public.is_org_verified(new.organization_id) then
      raise exception 'ORGANIZATION_NOT_VERIFIED'
        using hint = 'Your organization must be verified before selling tickets.';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists events_enforce_paid_rules on public.events;
create trigger events_enforce_paid_rules
  before insert or update of is_free, organization_id, price_cents on public.events
  for each row execute function public.enforce_paid_event_rules();

-- ---------------------------------------------------------------------------
-- Gallery
-- ---------------------------------------------------------------------------
create table if not exists public.event_images (
  id         uuid primary key default gen_random_uuid(),
  event_id   uuid not null references public.events (id) on delete cascade,
  url        text not null,
  storage_path text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists event_images_event_idx on public.event_images (event_id, sort_order);

-- ---------------------------------------------------------------------------
-- RSVP / saves / likes / views
-- ---------------------------------------------------------------------------
create table if not exists public.event_attendees (
  event_id   uuid not null references public.events (id) on delete cascade,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  status     attendee_status not null default 'going',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (event_id, user_id)
);

create index if not exists event_attendees_user_idx
  on public.event_attendees (user_id, status);

drop trigger if exists event_attendees_set_updated_at on public.event_attendees;
create trigger event_attendees_set_updated_at
  before update on public.event_attendees
  for each row execute function public.set_updated_at();

create table if not exists public.saved_events (
  user_id    uuid not null references public.profiles (id) on delete cascade,
  event_id   uuid not null references public.events (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, event_id)
);

create index if not exists saved_events_event_idx on public.saved_events (event_id);

create table if not exists public.event_likes (
  user_id    uuid not null references public.profiles (id) on delete cascade,
  event_id   uuid not null references public.events (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, event_id)
);

create index if not exists event_likes_event_idx on public.event_likes (event_id);

create table if not exists public.event_views (
  id         bigserial primary key,
  event_id   uuid not null references public.events (id) on delete cascade,
  user_id    uuid references public.profiles (id) on delete set null,
  source     text not null default 'unknown',
  created_at timestamptz not null default now()
);

create index if not exists event_views_event_idx on public.event_views (event_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Counter maintenance
-- ---------------------------------------------------------------------------
create or replace function public.sync_event_attendee_counts()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target_event uuid := coalesce(new.event_id, old.event_id);
begin
  update public.events e
  set attendee_count = (
        select count(*) from public.event_attendees a
        where a.event_id = target_event and a.status in ('going', 'checked_in')
      ),
      interested_count = (
        select count(*) from public.event_attendees a
        where a.event_id = target_event and a.status = 'interested'
      )
  where e.id = target_event;
  return null;
end;
$$;

drop trigger if exists event_attendees_sync_counts on public.event_attendees;
create trigger event_attendees_sync_counts
  after insert or update or delete on public.event_attendees
  for each row execute function public.sync_event_attendee_counts();

create or replace function public.sync_event_saved_count()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target_event uuid := coalesce(new.event_id, old.event_id);
begin
  update public.events e
  set saved_count = (select count(*) from public.saved_events s where s.event_id = target_event)
  where e.id = target_event;
  return null;
end;
$$;

drop trigger if exists saved_events_sync_count on public.saved_events;
create trigger saved_events_sync_count
  after insert or delete on public.saved_events
  for each row execute function public.sync_event_saved_count();

create or replace function public.sync_event_like_count()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target_event uuid := coalesce(new.event_id, old.event_id);
begin
  update public.events e
  set like_count = (select count(*) from public.event_likes l where l.event_id = target_event)
  where e.id = target_event;
  return null;
end;
$$;

drop trigger if exists event_likes_sync_count on public.event_likes;
create trigger event_likes_sync_count
  after insert or delete on public.event_likes
  for each row execute function public.sync_event_like_count();

-- Capacity guard: refuse RSVP 'going' when the event is full.
create or replace function public.enforce_event_capacity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  cap   integer;
  going integer;
begin
  if new.status <> 'going' then
    return new;
  end if;

  select capacity into cap from public.events where id = new.event_id;
  if cap is null then
    return new;
  end if;

  select count(*) into going
  from public.event_attendees a
  where a.event_id = new.event_id
    and a.status in ('going', 'checked_in')
    and a.user_id <> new.user_id;

  if going >= cap then
    raise exception 'EVENT_AT_CAPACITY' using hint = 'This event is full.';
  end if;

  return new;
end;
$$;

drop trigger if exists event_attendees_capacity on public.event_attendees;
create trigger event_attendees_capacity
  before insert or update of status on public.event_attendees
  for each row execute function public.enforce_event_capacity();

-- Visibility helper used by RLS and discovery RPCs.
create or replace function public.can_view_event(e_id uuid, viewer uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.events e
    where e.id = e_id
      and (
        -- creator / organizer / admin always sees it
        e.creator_id = viewer
        or (e.organization_id is not null and public.is_org_member(e.organization_id, null, viewer))
        or public.is_admin(viewer)
        -- everyone else only sees live events
        or (
          e.status = 'published'
          and (
            e.visibility in ('public', 'unlisted')
            or (e.visibility = 'followers' and viewer is not null
                and exists (select 1 from public.follows f
                            where f.follower_id = viewer and f.following_id = e.creator_id))
          )
        )
      )
  );
$$;
