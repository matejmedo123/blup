-- ============================================================================
-- BLUP · 0005 · Social layer: communities, crews, posts, comments
-- ============================================================================


-- Resolve the citext type and pgcrypto functions regardless of which schema
-- the extensions were installed into (public locally, extensions on Supabase).
set search_path = public, extensions;
create table if not exists public.communities (
  id           uuid primary key default gen_random_uuid(),
  slug         citext not null unique,
  name         text not null,
  description  text,
  cover_url    text,
  category     text not null default 'other',
  city         text,
  is_private   boolean not null default false,
  created_by   uuid not null references public.profiles (id) on delete cascade,
  member_count integer not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint communities_name_len check (char_length(name) between 2 and 60),
  constraint communities_slug_format check (slug ~ '^[a-z0-9][a-z0-9\-]{1,38}[a-z0-9]$')
);

drop trigger if exists communities_set_updated_at on public.communities;
create trigger communities_set_updated_at
  before update on public.communities
  for each row execute function public.set_updated_at();

create table if not exists public.community_members (
  community_id uuid not null references public.communities (id) on delete cascade,
  user_id      uuid not null references public.profiles (id) on delete cascade,
  role         community_role not null default 'member',
  created_at   timestamptz not null default now(),
  primary key (community_id, user_id)
);

create index if not exists community_members_user_idx on public.community_members (user_id);

create or replace function public.sync_community_member_count()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  target uuid := coalesce(new.community_id, old.community_id);
begin
  update public.communities c
  set member_count = (select count(*) from public.community_members m where m.community_id = target)
  where c.id = target;
  return null;
end;
$$;

drop trigger if exists community_members_sync_count on public.community_members;
create trigger community_members_sync_count
  after insert or delete on public.community_members
  for each row execute function public.sync_community_member_count();

create or replace function public.handle_new_community()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  insert into public.community_members (community_id, user_id, role)
  values (new.id, new.created_by, 'owner')
  on conflict do nothing;
  return new;
end;
$$;

drop trigger if exists on_community_created on public.communities;
create trigger on_community_created
  after insert on public.communities
  for each row execute function public.handle_new_community();

create or replace function public.is_community_member(cid uuid, uid uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select exists (
    select 1 from public.community_members m where m.community_id = cid and m.user_id = uid
  );
$$;

-- ---------------------------------------------------------------------------
-- Event crews — small groups going to an event together ("BLUP Connect")
-- ---------------------------------------------------------------------------
create table if not exists public.event_crews (
  id           uuid primary key default gen_random_uuid(),
  event_id     uuid not null references public.events (id) on delete cascade,
  name         text not null,
  description  text,
  created_by   uuid not null references public.profiles (id) on delete cascade,
  max_size     integer not null default 8 check (max_size between 2 and 50),
  is_open      boolean not null default true,
  created_at   timestamptz not null default now(),
  constraint event_crews_name_len check (char_length(name) between 2 and 60)
);

create index if not exists event_crews_event_idx on public.event_crews (event_id);

create table if not exists public.event_crew_members (
  crew_id    uuid not null references public.event_crews (id) on delete cascade,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (crew_id, user_id)
);

create or replace function public.handle_new_crew()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  insert into public.event_crew_members (crew_id, user_id)
  values (new.id, new.created_by)
  on conflict do nothing;
  return new;
end;
$$;

drop trigger if exists on_crew_created on public.event_crews;
create trigger on_crew_created
  after insert on public.event_crews
  for each row execute function public.handle_new_crew();

create or replace function public.enforce_crew_size()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  cap integer;
  cnt integer;
begin
  select max_size into cap from public.event_crews where id = new.crew_id;
  select count(*) into cnt from public.event_crew_members where crew_id = new.crew_id;
  if cnt >= cap then
    raise exception 'CREW_FULL';
  end if;
  return new;
end;
$$;

drop trigger if exists event_crew_members_size on public.event_crew_members;
create trigger event_crew_members_size
  before insert on public.event_crew_members
  for each row execute function public.enforce_crew_size();

-- ---------------------------------------------------------------------------
-- Posts & comments
-- ---------------------------------------------------------------------------
create table if not exists public.posts (
  id            uuid primary key default gen_random_uuid(),
  author_id     uuid not null references public.profiles (id) on delete cascade,
  event_id      uuid references public.events (id) on delete cascade,
  community_id  uuid references public.communities (id) on delete cascade,
  body          text not null,
  image_url     text,
  like_count    integer not null default 0,
  comment_count integer not null default 0,
  is_deleted    boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint posts_body_len check (char_length(body) between 1 and 2000)
);

create index if not exists posts_author_idx on public.posts (author_id, created_at desc);
create index if not exists posts_event_idx on public.posts (event_id, created_at desc);
create index if not exists posts_community_idx on public.posts (community_id, created_at desc);

drop trigger if exists posts_set_updated_at on public.posts;
create trigger posts_set_updated_at
  before update on public.posts
  for each row execute function public.set_updated_at();

create table if not exists public.post_likes (
  post_id    uuid not null references public.posts (id) on delete cascade,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);

create or replace function public.sync_post_like_count()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  target uuid := coalesce(new.post_id, old.post_id);
begin
  update public.posts p
  set like_count = (select count(*) from public.post_likes l where l.post_id = target)
  where p.id = target;
  return null;
end;
$$;

drop trigger if exists post_likes_sync_count on public.post_likes;
create trigger post_likes_sync_count
  after insert or delete on public.post_likes
  for each row execute function public.sync_post_like_count();

create table if not exists public.comments (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles (id) on delete cascade,
  event_id   uuid references public.events (id) on delete cascade,
  post_id    uuid references public.posts (id) on delete cascade,
  parent_id  uuid references public.comments (id) on delete cascade,
  body       text not null,
  is_deleted boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint comments_body_len check (char_length(body) between 1 and 1000),
  -- exactly one target
  constraint comments_single_target check (
    (event_id is not null and post_id is null) or
    (event_id is null and post_id is not null)
  )
);

create index if not exists comments_event_idx on public.comments (event_id, created_at desc);
create index if not exists comments_post_idx on public.comments (post_id, created_at desc);
create index if not exists comments_user_idx on public.comments (user_id, created_at desc);

drop trigger if exists comments_set_updated_at on public.comments;
create trigger comments_set_updated_at
  before update on public.comments
  for each row execute function public.set_updated_at();

create or replace function public.sync_comment_counts()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  target_event uuid := coalesce(new.event_id, old.event_id);
  target_post  uuid := coalesce(new.post_id, old.post_id);
begin
  if target_event is not null then
    update public.events e
    set comment_count = (
      select count(*) from public.comments c
      where c.event_id = target_event and not c.is_deleted
    )
    where e.id = target_event;
  end if;

  if target_post is not null then
    update public.posts p
    set comment_count = (
      select count(*) from public.comments c
      where c.post_id = target_post and not c.is_deleted
    )
    where p.id = target_post;
  end if;

  return null;
end;
$$;

drop trigger if exists comments_sync_counts on public.comments;
create trigger comments_sync_counts
  after insert or update or delete on public.comments
  for each row execute function public.sync_comment_counts();
