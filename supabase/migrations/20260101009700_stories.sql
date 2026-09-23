-- ============================================================================
-- Príbehy — 24 hodín.
--
-- The row of circles above the feed was, until now, a list of people you
-- follow with a gradient ring drawn around each of them. Every ring said
-- "there is something new here"; none of them ever led anywhere but the
-- profile. This is the thing the ring was pretending to be.
--
-- Two rules shape the schema:
--
--   * 24 hours is a property of the story, not of the query. `expires_at` is
--     written once at insert and every read filters on it, so a story cannot
--     outlive its window because some caller forgot a where clause. A cron job
--     then deletes the rows and their pictures; expiry is not merely hiding.
--
--   * An organizer posts as the organization, the same way they post to the
--     feed. `organization_id` is the byline, `author_id` is always the human
--     who actually pressed the button — so a story can be attributed to a
--     brand and still traced to a person for moderation.
-- ============================================================================

create table if not exists public.stories (
  id              uuid primary key default gen_random_uuid(),
  author_id       uuid not null references public.profiles (id) on delete cascade,
  -- Posted under an organization's name. Checked against membership on insert.
  organization_id uuid references public.organizations (id) on delete cascade,
  -- What a story is: a picture. The caption is optional and short.
  image_url       text not null,
  caption         text,
  -- Optional: the event it is from, so a viewer can go straight there.
  event_id        uuid references public.events (id) on delete set null,
  view_count      integer not null default 0,
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null,

  constraint stories_caption_len check (caption is null or char_length(caption) <= 200),
  constraint stories_window check (expires_at > created_at)
);

create index if not exists stories_author_idx  on public.stories (author_id, created_at desc);
create index if not exists stories_live_idx    on public.stories (expires_at);
create index if not exists stories_org_idx     on public.stories (organization_id)
  where organization_id is not null;
-- The foreign key needs its own index: deleting an event has to find the
-- stories pointing at it, and without one that is a sequential scan of the
-- whole table taken while the delete holds its locks.
create index if not exists stories_event_idx   on public.stories (event_id)
  where event_id is not null;

-- Who has seen it. Also what makes the ring go grey once you have looked.
create table if not exists public.story_views (
  story_id  uuid not null references public.stories (id) on delete cascade,
  viewer_id uuid not null references public.profiles (id) on delete cascade,
  seen_at   timestamptz not null default now(),
  primary key (story_id, viewer_id)
);

create index if not exists story_views_viewer_idx on public.story_views (viewer_id);

-- ---------------------------------------------------------------------------
-- Posting one.
-- ---------------------------------------------------------------------------
create or replace function public.create_story(
  p_image_url    text,
  p_caption      text default null,
  p_event_id     uuid default null,
  p_organization uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_me    uuid := auth.uid();
  v_story uuid;
  v_live  integer;
begin
  if v_me is null then
    raise exception 'UNAUTHENTICATED';
  end if;

  if p_image_url is null or char_length(trim(p_image_url)) = 0 then
    raise exception 'IMAGE_REQUIRED';
  end if;

  -- Only somewhere we actually store pictures. Without this the column is an
  -- open redirect with a 24-hour audience attached to it.
  if p_image_url !~ '^https://[a-z0-9.-]+/storage/v1/object/(public|sign)/' then
    raise exception 'INVALID_IMAGE_URL';
  end if;

  -- Posting under a brand's name is the brand's decision, not the poster's.
  if p_organization is not null
     and not public.is_org_member(
       p_organization, array['owner', 'admin', 'event_manager']::org_role[], v_me
     ) then
    raise exception 'NOT_AUTHORIZED';
  end if;

  -- A cap, because a story costs nothing to post and the row is what everybody
  -- who follows you has to page through.
  select count(*) into v_live
  from public.stories s
  where s.author_id = v_me and s.expires_at > now();

  if v_live >= 20 then
    raise exception 'TOO_MANY_STORIES';
  end if;

  insert into public.stories (author_id, organization_id, image_url, caption, event_id, expires_at)
  values (
    v_me, p_organization, trim(p_image_url), nullif(trim(coalesce(p_caption, '')), ''),
    p_event_id, now() + interval '24 hours'
  )
  returning id into v_story;

  return v_story;
end;
$$;

revoke execute on function public.create_story(text, text, uuid, uuid) from public;
grant execute on function public.create_story(text, text, uuid, uuid) to authenticated;

create or replace function public.delete_story(p_story uuid)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  delete from public.stories
  where id = p_story and author_id = auth.uid();

  if not found then
    raise exception 'NOT_AUTHORIZED';
  end if;
end;
$$;

revoke execute on function public.delete_story(uuid) from public;
grant execute on function public.delete_story(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Watching one.
-- ---------------------------------------------------------------------------
create or replace function public.mark_story_seen(p_story uuid)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then
    return;
  end if;

  -- Your own story is not a view of it; otherwise every author sees a 1 they
  -- put there themselves.
  if exists (select 1 from public.stories s where s.id = p_story and s.author_id = v_me) then
    return;
  end if;

  insert into public.story_views (story_id, viewer_id)
  values (p_story, v_me)
  on conflict do nothing;

  if found then
    update public.stories set view_count = view_count + 1 where id = p_story;
  end if;
end;
$$;

revoke execute on function public.mark_story_seen(uuid) from public;
grant execute on function public.mark_story_seen(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- The row above the feed: one entry per author who has something live, in the
-- order that puts what you have not seen first.
-- ---------------------------------------------------------------------------
create or replace function public.story_rings(p_limit integer default 30)
returns table (
  author_id       uuid,
  organization_id uuid,
  display_name    text,
  username        text,
  avatar_url      text,
  story_count     integer,
  unseen_count    integer,
  latest_at       timestamptz,
  is_mine         boolean
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  with me as (select auth.uid() as id),
  live as (
    select s.id, s.author_id, s.organization_id, s.created_at
    from public.stories s
    where s.expires_at > now()
      and (
        s.author_id = (select id from me)
        or exists (
          select 1 from public.follows f
          where f.follower_id = (select id from me) and f.following_id = s.author_id
        )
      )
  ),
  grouped as (
    select
      live.author_id,
      -- An author posting under one organization shows that brand's name;
      -- mixing two bylines in one ring would be dishonest, so the newest wins.
      (array_agg(live.organization_id order by live.created_at desc))[1] as organization_id,
      count(*)::integer as story_count,
      count(*) filter (
        where not exists (
          select 1 from public.story_views v
          where v.story_id = live.id and v.viewer_id = (select id from me)
        )
      )::integer as unseen_count,
      max(live.created_at) as latest_at
    from live
    group by live.author_id
  )
  select
    g.author_id,
    g.organization_id,
    coalesce(o.name, p.display_name),
    p.username,
    coalesce(o.logo_url, p.avatar_url),
    g.story_count,
    g.unseen_count,
    g.latest_at,
    g.author_id = (select id from me)
  from grouped g
  join public.profiles p on p.id = g.author_id
  left join public.organizations o on o.id = g.organization_id
  where not p.is_suspended
  -- Yours first (so you can check what you posted), then unseen, then newest.
  order by (g.author_id = (select id from me)) desc, g.unseen_count desc, g.latest_at desc
  limit greatest(p_limit, 1);
$$;

revoke execute on function public.story_rings(integer) from public;
grant execute on function public.story_rings(integer) to authenticated;

-- Every live story of one author, oldest first — the order they are watched in.
create or replace function public.stories_of(p_author uuid)
returns table (
  id              uuid,
  author_id       uuid,
  organization_id uuid,
  image_url       text,
  caption         text,
  event_id        uuid,
  event_title     text,
  event_slug      text,
  created_at      timestamptz,
  expires_at      timestamptz,
  view_count      integer,
  seen_by_me      boolean
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  select
    s.id, s.author_id, s.organization_id, s.image_url, s.caption,
    s.event_id, e.title, e.slug, s.created_at, s.expires_at,
    -- The counter is the author's business; everybody else gets zero rather
    -- than a number that turns watching into a public act.
    case when s.author_id = auth.uid() then s.view_count else 0 end,
    exists (
      select 1 from public.story_views v
      where v.story_id = s.id and v.viewer_id = auth.uid()
    )
  from public.stories s
  left join public.events e on e.id = s.event_id
  where s.author_id = p_author
    and s.expires_at > now()
    and (
      s.author_id = auth.uid()
      or exists (
        select 1 from public.follows f
        where f.follower_id = auth.uid() and f.following_id = s.author_id
      )
    )
  order by s.created_at;
$$;

revoke execute on function public.stories_of(uuid) from public;
grant execute on function public.stories_of(uuid) to authenticated;

-- Who watched mine. Only the author may ask.
create or replace function public.story_viewers(p_story uuid, p_limit integer default 100)
returns table (
  viewer_id    uuid,
  display_name text,
  username     text,
  avatar_url   text,
  seen_at      timestamptz
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  select p.id, p.display_name, p.username, p.avatar_url, v.seen_at
  from public.story_views v
  join public.stories s on s.id = v.story_id and s.author_id = auth.uid()
  join public.profiles p on p.id = v.viewer_id
  where v.story_id = p_story
  order by v.seen_at desc
  limit greatest(p_limit, 1);
$$;

revoke execute on function public.story_viewers(uuid, integer) from public;
grant execute on function public.story_viewers(uuid, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- Expiry, for real.
--
-- Every read already filters on expires_at, so nothing expired is ever shown.
-- This is the other half: the rows and the pictures go away rather than piling
-- up invisibly for ever. Run from the existing cron schedule.
-- ---------------------------------------------------------------------------
create or replace function public.purge_expired_stories()
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_gone integer;
begin
  with dead as (
    delete from public.stories
    where expires_at < now() - interval '1 hour'
    returning 1
  )
  select count(*)::integer into v_gone from dead;

  return coalesce(v_gone, 0);
end;
$$;

revoke execute on function public.purge_expired_stories() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- RLS. Reads go through the functions above, but the table is exposed to
-- PostgREST, so the policies have to stand on their own.
-- ---------------------------------------------------------------------------
alter table public.stories     enable row level security;
alter table public.story_views enable row level security;

drop policy if exists stories_select on public.stories;
create policy stories_select on public.stories
  for select using (
    expires_at > now()
    and (
      author_id = auth.uid()
      or exists (
        select 1 from public.follows f
        where f.follower_id = auth.uid() and f.following_id = stories.author_id
      )
    )
  );

-- Writes go through create_story()/delete_story() only: those are what check
-- the organization membership, the URL and the cap.
drop policy if exists stories_delete_own on public.stories;
create policy stories_delete_own on public.stories
  for delete using (author_id = auth.uid());

drop policy if exists story_views_select on public.story_views;
create policy story_views_select on public.story_views
  for select using (
    viewer_id = auth.uid()
    or exists (
      select 1 from public.stories s
      where s.id = story_views.story_id and s.author_id = auth.uid()
    )
  );

do $$
begin
  execute 'grant select, delete on public.stories to authenticated';
  execute 'grant select on public.story_views to authenticated';
end
$$;

-- ---------------------------------------------------------------------------
-- Where the pictures live. Public-read like avatars: a story is shown to
-- everybody who follows you, and signing every one of them per view would cost
-- a round trip each without making the picture any less reachable.
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('storage.buckets') is null then
    raise notice 'storage schema not present – skipping stories bucket';
    return;
  end if;

  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('stories', 'stories', true, 10485760,
          array['image/jpeg', 'image/png', 'image/webp', 'image/heic'])
  on conflict (id) do update
    set public = excluded.public,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;

  execute 'drop policy if exists "blup stories are readable" on storage.objects';
  execute $p$
    create policy "blup stories are readable" on storage.objects
      for select using (bucket_id = 'stories')
  $p$;

  execute 'drop policy if exists "blup stories upload own" on storage.objects';
  execute $p$
    create policy "blup stories upload own" on storage.objects
      for insert with check (
        bucket_id = 'stories' and (storage.foldername(name))[1] = auth.uid()::text
      )
  $p$;

  execute 'drop policy if exists "blup stories delete own" on storage.objects';
  execute $p$
    create policy "blup stories delete own" on storage.objects
      for delete using (
        bucket_id = 'stories' and (storage.foldername(name))[1] = auth.uid()::text
      )
  $p$;
end
$$;
