-- ============================================================================
-- BLUP · 0005b · Notifications & push tokens
-- ============================================================================


-- Resolve the citext type and pgcrypto functions regardless of which schema
-- the extensions were installed into (public locally, extensions on Supabase).
set search_path = public, extensions;
create table if not exists public.notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles (id) on delete cascade,
  type       notification_type not null,
  title      text not null,
  body       text,
  actor_id   uuid references public.profiles (id) on delete set null,
  event_id   uuid references public.events (id) on delete cascade,
  data       jsonb not null default '{}'::jsonb,
  read_at    timestamptz,
  pushed_at  timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists notifications_user_idx
  on public.notifications (user_id, created_at desc);
create index if not exists notifications_unread_idx
  on public.notifications (user_id) where read_at is null;

create table if not exists public.push_tokens (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles (id) on delete cascade,
  token        text not null unique,
  platform     text not null check (platform in ('ios', 'android', 'web')),
  device_name  text,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index if not exists push_tokens_user_idx on public.push_tokens (user_id);

create table if not exists public.notification_preferences (
  user_id                uuid primary key references public.profiles (id) on delete cascade,
  push_enabled           boolean not null default true,
  new_follower           boolean not null default true,
  friend_requests        boolean not null default true,
  event_reminders        boolean not null default true,
  friend_attending       boolean not null default true,
  ticket_updates         boolean not null default true,
  weekly_recommendations boolean not null default true,
  updated_at             timestamptz not null default now()
);

drop trigger if exists notification_preferences_set_updated_at on public.notification_preferences;
create trigger notification_preferences_set_updated_at
  before update on public.notification_preferences
  for each row execute function public.set_updated_at();

-- Central helper so every feature emits notifications the same way.
create or replace function public.notify_user(
  p_user_id  uuid,
  p_type     notification_type,
  p_title    text,
  p_body     text default null,
  p_actor_id uuid default null,
  p_event_id uuid default null,
  p_data     jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  new_id uuid;
begin
  if p_user_id is null or p_user_id = p_actor_id then
    return null; -- never notify yourself about your own action
  end if;

  insert into public.notifications (user_id, type, title, body, actor_id, event_id, data)
  values (p_user_id, p_type, p_title, p_body, p_actor_id, p_event_id, p_data)
  returning id into new_id;

  return new_id;
end;
$$;

-- New follower notification
create or replace function public.on_follow_created()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  actor_name text;
begin
  select coalesce(display_name, username::text) into actor_name
  from public.profiles where id = new.follower_id;

  perform public.notify_user(
    new.following_id, 'new_follower', 'New follower',
    coalesce(actor_name, 'Someone') || ' started following you',
    new.follower_id, null,
    jsonb_build_object('follower_id', new.follower_id)
  );
  return new;
end;
$$;

drop trigger if exists follows_notify on public.follows;
create trigger follows_notify
  after insert on public.follows
  for each row execute function public.on_follow_created();

-- Friend request / acceptance notifications
create or replace function public.on_friendship_change()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  actor_name text;
begin
  if tg_op = 'INSERT' then
    select coalesce(display_name, username::text) into actor_name
    from public.profiles where id = new.requester_id;
    perform public.notify_user(
      new.addressee_id, 'friend_request', 'Friend request',
      coalesce(actor_name, 'Someone') || ' wants to connect',
      new.requester_id, null, jsonb_build_object('friendship_id', new.id)
    );
  elsif tg_op = 'UPDATE' and new.status = 'accepted' and old.status <> 'accepted' then
    select coalesce(display_name, username::text) into actor_name
    from public.profiles where id = new.addressee_id;
    perform public.notify_user(
      new.requester_id, 'friend_accepted', 'Friend request accepted',
      coalesce(actor_name, 'Someone') || ' accepted your request',
      new.addressee_id, null, jsonb_build_object('friendship_id', new.id)
    );
  end if;
  return new;
end;
$$;

drop trigger if exists friendships_notify on public.friendships;
create trigger friendships_notify
  after insert or update on public.friendships
  for each row execute function public.on_friendship_change();

-- "Someone you follow is going to this event"
create or replace function public.on_attendee_created()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  actor_name text;
  ev         record;
begin
  if new.status <> 'going' then
    return new;
  end if;

  select coalesce(display_name, username::text) into actor_name
  from public.profiles where id = new.user_id;

  select id, title into ev from public.events where id = new.event_id;

  perform public.notify_user(
    f.follower_id, 'friend_attending', 'Someone you follow is going',
    coalesce(actor_name, 'Someone') || ' is going to ' || ev.title,
    new.user_id, ev.id, jsonb_build_object('event_id', ev.id)
  )
  from public.follows f
  where f.following_id = new.user_id;

  return new;
end;
$$;

drop trigger if exists event_attendees_notify on public.event_attendees;
create trigger event_attendees_notify
  after insert on public.event_attendees
  for each row execute function public.on_attendee_created();

-- New comment on your event
create or replace function public.on_comment_created()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  ev         record;
  actor_name text;
begin
  if new.event_id is null then
    return new;
  end if;

  select id, title, creator_id into ev from public.events where id = new.event_id;
  select coalesce(display_name, username::text) into actor_name
  from public.profiles where id = new.user_id;

  perform public.notify_user(
    ev.creator_id, 'new_comment', 'New comment',
    coalesce(actor_name, 'Someone') || ' commented on ' || ev.title,
    new.user_id, ev.id, jsonb_build_object('comment_id', new.id)
  );
  return new;
end;
$$;

drop trigger if exists comments_notify on public.comments;
create trigger comments_notify
  after insert on public.comments
  for each row execute function public.on_comment_created();

-- Mark notifications read (bulk or single)
create or replace function public.mark_notifications_read(p_ids uuid[] default null)
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  affected integer;
begin
  update public.notifications
  set read_at = now()
  where user_id = auth.uid()
    and read_at is null
    and (p_ids is null or id = any (p_ids));
  get diagnostics affected = row_count;
  return affected;
end;
$$;
