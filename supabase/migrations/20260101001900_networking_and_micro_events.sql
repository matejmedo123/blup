-- ============================================================================
-- BLUP · 0019 · Post-event networking + micro-events in communities
-- ============================================================================
-- Two features from the concept document:
--
--   post-event networking  "návrhy, koho si mohol stretnúť"
--   micro-events           small events hosted inside a community
--
-- Both are built on rows that already exist — who attended what, and which
-- community a person belongs to — so neither invents a social graph.
-- ============================================================================


-- Resolve the citext type and pgcrypto functions regardless of which schema
-- the extensions were installed into (public locally, extensions on Supabase).
set search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- Micro-events: an event can belong to a community.
-- ---------------------------------------------------------------------------
alter table public.events
  add column if not exists community_id uuid references public.communities (id) on delete set null;

create index if not exists events_community_idx
  on public.events (community_id, start_at) where community_id is not null;

/**
 * Only a member may host an event under a community's name, and only a member
 * of that community — otherwise anyone could publish under someone else's
 * banner. Checked in a trigger rather than a policy so the message is specific.
 */
create or replace function public.enforce_community_event_membership()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if new.community_id is null then
    return new;
  end if;

  if not exists (
    select 1 from public.community_members
    where community_id = new.community_id and user_id = new.creator_id
  ) then
    raise exception 'NOT_COMMUNITY_MEMBER';
  end if;

  return new;
end;
$$;

drop trigger if exists events_community_membership on public.events;
create trigger events_community_membership
  before insert or update of community_id on public.events
  for each row execute function public.enforce_community_event_membership();

/** Upcoming events hosted by a community. */
create or replace function public.community_events(
  p_community uuid,
  p_limit integer default 20
)
returns setof public.event_feed_item
language sql
stable
security definer
set search_path = public, extensions
as $$
  select
    e.id, e.title, e.description, e.cover_image_url, e.category, e.tags,
    e.latitude, e.longitude, e.address, e.venue_name, e.city,
    e.start_at, e.end_at, e.is_free, e.price_cents, e.currency, e.capacity,
    e.attendee_count, e.saved_count, e.like_count, e.comment_count,
    e.status, e.visibility,
    e.creator_id, p.username::text, p.display_name, p.avatar_url,
    e.organization_id, o.name, (o.verification_status = 'verified'),
    null::double precision,
    0,
    exists (select 1 from public.saved_events se
             where se.event_id = e.id and se.user_id = auth.uid()),
    exists (select 1 from public.event_attendees a
             where a.event_id = e.id and a.user_id = auth.uid()
               and a.status in ('going', 'interested', 'checked_in')),
    null::numeric,
    null::jsonb
  from public.events e
  join public.profiles p on p.id = e.creator_id
  left join public.organizations o on o.id = e.organization_id
  where e.community_id = p_community
    and e.status = 'published'
    and e.start_at > now() - interval '6 hours'
  order by e.start_at asc
  limit greatest(1, least(coalesce(p_limit, 20), 100));
$$;

-- ---------------------------------------------------------------------------
-- Post-event networking
--
-- "Koho si mohol stretnúť": people who were at the same finished event as you,
-- whom you do not already follow. Ranked by how many events you shared, then
-- by shared interests — the same signals the people ranker uses, restricted to
-- events that have actually happened.
-- ---------------------------------------------------------------------------
create or replace function public.post_event_matches(
  p_days  integer default 30,
  p_limit integer default 20
)
returns table (
  user_id         uuid,
  username        text,
  display_name    text,
  avatar_url      text,
  shared_events   integer,
  shared_interests integer,
  shared_interest_names text[],
  last_event_id   uuid,
  last_event_title text,
  last_event_at   timestamptz
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  with me as (
    select auth.uid() as id
  ),
  -- Events I actually attended that are now over.
  my_past as (
    select a.event_id, e.title, e.start_at
    from public.event_attendees a
    join public.events e on e.id = a.event_id
    cross join me
    where a.user_id = me.id
      and a.status in ('going', 'checked_in')
      and e.start_at < now()
      and e.start_at > now() - make_interval(days => greatest(coalesce(p_days, 30), 1))
  ),
  -- Everyone else who was at those events.
  others as (
    select
      a.user_id,
      count(distinct a.event_id)::integer as shared_events,
      (array_agg(mp.event_id order by mp.start_at desc))[1] as last_event_id,
      (array_agg(mp.title    order by mp.start_at desc))[1] as last_event_title,
      max(mp.start_at) as last_event_at
    from public.event_attendees a
    join my_past mp on mp.event_id = a.event_id
    cross join me
    where a.user_id <> me.id
      and a.status in ('going', 'checked_in')
    group by a.user_id
  ),
  overlap as (
    select
      o.*,
      coalesce(si.n, 0)::integer as shared_interests,
      coalesce(si.names, array[]::text[]) as shared_interest_names
    from others o
    cross join me
    left join lateral (
      select count(*)::integer as n, array_agg(i.name order by i.name) as names
      from public.user_interests ui_them
      join public.user_interests ui_me
        on ui_me.interest_id = ui_them.interest_id and ui_me.user_id = me.id
      join public.interests i on i.id = ui_them.interest_id
      where ui_them.user_id = o.user_id
    ) si on true
  )
  select
    ov.user_id,
    pr.username::text,
    pr.display_name,
    pr.avatar_url,
    ov.shared_events,
    ov.shared_interests,
    ov.shared_interest_names,
    ov.last_event_id,
    ov.last_event_title,
    ov.last_event_at
  from overlap ov
  join public.profiles pr on pr.id = ov.user_id
  cross join me
  where not pr.is_suspended
    and not pr.anonymous_mode
    and (not pr.is_private or public.is_following(pr.id, me.id))
    -- Only people you have not already connected with.
    and not exists (
      select 1 from public.follows f
      where f.follower_id = me.id and f.following_id = ov.user_id
    )
  order by ov.shared_events desc, ov.shared_interests desc, ov.last_event_at desc
  limit greatest(1, least(coalesce(p_limit, 20), 50));
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.post_event_matches(integer, integer) to authenticated';
    execute 'grant execute on function public.community_events(uuid, integer) to authenticated';
  end if;
end
$$;
