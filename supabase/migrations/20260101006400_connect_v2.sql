-- ============================================================================
-- BLUP · 0064 · Blup Connect, rebuilt on what "you know each other" means here
-- ============================================================================
-- v1 ranked people mostly on shared interests: 0.45 for liking the same things,
-- 0.20 for knowing the same people. That is backwards. Two people in Bratislava
-- who both ticked "techno" have nothing in common — there are forty thousand of
-- them. Two people in the same community, who were at the same event last
-- month, and who follow three of the same people, know each other in every way
-- that matters except having said so.
--
-- And communities were not used at all, which is where this app actually keeps
-- the answer to "who do you know".
--
-- The order, strongest evidence first:
--
--   they follow you        0.24   the single highest-converting suggestion in
--                                 any social product, and the politest: they
--                                 already reached out
--   shared communities     0.22   membership is a choice about people, not a
--                                 checkbox about taste
--   mutual follows         0.18   the same friends
--   events together        0.16   recent ones count more; three years ago is
--                                 not a connection
--   same crew              0.08   you literally went together
--   shared interests       0.08   the weakest evidence, demoted from the top
--   nearby                 0.04
--
-- Everything here is symmetric and public-by-choice: it is built from follows,
-- community membership and attendance that both people opted into. Nothing is
-- inferred from anything anybody hid — anonymous mode still removes you from it
-- entirely.
-- ============================================================================

set search_path = public, extensions;

-- Somebody you were suggested and passed on should not keep coming back.
create table if not exists public.connect_dismissals (
  user_id      uuid not null references public.profiles (id) on delete cascade,
  dismissed_id uuid not null references public.profiles (id) on delete cascade,
  created_at   timestamptz not null default now(),
  primary key (user_id, dismissed_id),
  constraint connect_dismissals_not_self check (user_id <> dismissed_id)
);

alter table public.connect_dismissals enable row level security;

drop policy if exists connect_dismissals_own on public.connect_dismissals;
create policy connect_dismissals_own on public.connect_dismissals
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create or replace function public.dismiss_person(p_user_id uuid)
returns void
language sql
security definer
set search_path = public, extensions
as $$
  insert into public.connect_dismissals (user_id, dismissed_id)
  values (auth.uid(), p_user_id)
  on conflict do nothing;
$$;

revoke all on function public.dismiss_person(uuid) from public, anon;
grant execute on function public.dismiss_person(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- The ranking
-- ---------------------------------------------------------------------------
create or replace function public.recommend_people(
  p_user_id  uuid default auth.uid(),
  p_event_id uuid default null,   -- when set: rank people attending this event
  p_limit    integer default 20
)
returns table (
  user_id            uuid,
  username           text,
  display_name       text,
  avatar_url         text,
  bio                text,
  city               text,
  shared_interests   integer,
  shared_interest_names text[],
  mutual_events      integer,
  mutual_follows     integer,
  same_event         boolean,
  distance_m         double precision,
  score              numeric,
  score_breakdown    jsonb
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  with me as (
    select id, latitude, longitude from public.profiles where id = p_user_id
  ),
  my_interests as (
    select interest_id from public.user_interests where user_id = p_user_id
  ),
  my_communities as (
    select community_id from public.community_members where user_id = p_user_id
  ),
  candidates as (
    select p.*
    from public.profiles p
    where p.id <> p_user_id
      and not p.is_suspended
      and not p.anonymous_mode
      and (
        p_event_id is null
        or exists (
          select 1 from public.event_attendees a
          where a.event_id = p_event_id and a.user_id = p.id
            and a.status in ('going', 'interested', 'checked_in')
        )
      )
      and not exists (
        select 1 from public.follows f
        where f.follower_id = p_user_id and f.following_id = p.id
      )
      -- Passed on once is an answer.
      and not exists (
        select 1 from public.connect_dismissals d
        where d.user_id = p_user_id and d.dismissed_id = p.id
      )
  ),
  enriched as (
    select
      c.id, c.username, c.display_name, c.avatar_url, c.bio, c.city,
      c.latitude, c.longitude,
      (
        select count(*)::integer from public.user_interests ui
        where ui.user_id = c.id and ui.interest_id in (select interest_id from my_interests)
      ) as shared_interests,
      (
        select coalesce(array_agg(i.name order by i.name), '{}')
        from public.user_interests ui
        join public.interests i on i.id = ui.interest_id
        where ui.user_id = c.id and ui.interest_id in (select interest_id from my_interests)
      ) as shared_interest_names,
      (
        select count(*)::integer
        from public.event_attendees a1
        join public.event_attendees a2 on a2.event_id = a1.event_id and a2.user_id = p_user_id
        where a1.user_id = c.id
      ) as mutual_events,
      -- Weighted by when. Something you were both at last month is evidence;
      -- something three years ago is a coincidence.
      (
        select coalesce(sum(
          exp(-extract(epoch from (now() - e.start_at)) / (180.0 * 86400.0))
        ), 0)::numeric
        from public.event_attendees a1
        join public.event_attendees a2 on a2.event_id = a1.event_id and a2.user_id = p_user_id
        join public.events e on e.id = a1.event_id
        where a1.user_id = c.id and e.start_at <= now()
      ) as recent_together,
      (
        select count(*)::integer
        from public.follows f1
        join public.follows f2 on f2.following_id = f1.following_id and f2.follower_id = p_user_id
        where f1.follower_id = c.id
      ) as mutual_follows,
      -- Communities: the thing v1 did not look at, and the thing this app
      -- actually uses to mean "these people are in the same scene".
      (
        select count(*)::integer
        from public.community_members cm
        where cm.user_id = c.id and cm.community_id in (select community_id from my_communities)
      ) as shared_communities,
      (
        select coalesce(array_agg(co.name order by co.name), '{}')
        from public.community_members cm
        join public.communities co on co.id = cm.community_id
        where cm.user_id = c.id and cm.community_id in (select community_id from my_communities)
      ) as shared_community_names,
      -- Went together, literally.
      (
        select count(*)::integer
        from public.event_crew_members m1
        join public.event_crew_members m2 on m2.crew_id = m1.crew_id and m2.user_id = p_user_id
        where m1.user_id = c.id
      ) as shared_crews,
      exists (
        select 1 from public.follows f
        where f.follower_id = c.id and f.following_id = p_user_id
      ) as follows_me,
      case
        when (select latitude from me) is null or c.latitude is null then null
        else public.blup_distance_m((select latitude from me), (select longitude from me),
                                    c.latitude, c.longitude)
      end as distance_m
    from candidates c
  ),
  scored as (
    select
      e.*,
      case when e.follows_me then 1.0 else 0.0 end as s_follows_me,
      least(1.0, e.shared_communities::numeric / 2.0) as s_communities,
      least(1.0, e.mutual_follows::numeric / 5.0) as s_mutuals,
      least(1.0, e.recent_together / 2.0) as s_together,
      least(1.0, e.shared_crews::numeric / 1.0) as s_crew,
      least(1.0, e.shared_interests::numeric / 4.0) as s_interests,
      case
        when e.distance_m is null then 0.5
        else greatest(0.0, 1.0 - least(1.0, e.distance_m / 50000.0))
      end as s_near
    from enriched e
  )
  select
    s.id, s.username::text, s.display_name, s.avatar_url, s.bio, s.city,
    s.shared_interests,
    s.shared_interest_names,
    s.mutual_events,
    s.mutual_follows,
    (p_event_id is not null) as same_event,
    s.distance_m,
    round((
      0.24 * s.s_follows_me +
      0.22 * s.s_communities +
      0.18 * s.s_mutuals +
      0.16 * s.s_together +
      0.08 * s.s_crew +
      0.08 * s.s_interests +
      0.04 * s.s_near
    )::numeric, 4) as score,
    jsonb_build_object(
      'engine', 'connect_v2',
      'components', jsonb_build_object(
        'follows_me',        round(s.s_follows_me::numeric, 4),
        'shared_communities', round(s.s_communities::numeric, 4),
        'mutual_follows',    round(s.s_mutuals::numeric, 4),
        'events_together',   round(s.s_together::numeric, 4),
        'shared_crew',       round(s.s_crew::numeric, 4),
        'shared_interests',  round(s.s_interests::numeric, 4),
        'nearby',            round(s.s_near::numeric, 4)
      ),
      'facts', jsonb_build_object(
        'follows_me', s.follows_me,
        'shared_communities', s.shared_communities,
        'shared_community_names', s.shared_community_names,
        'shared_crews', s.shared_crews,
        'mutual_events', s.mutual_events,
        'mutual_follows', s.mutual_follows,
        'shared_interests', s.shared_interests,
        'distance_m', round(coalesce(s.distance_m, 0)::numeric, 0)
      ),
      -- Why, in the order somebody would say it out loud. Strongest evidence
      -- first, and never a reason that is not true of this pair.
      'reason', case
        when s.follows_me then 'follows_you'
        when s.shared_communities > 0 then 'community'
        when s.shared_crews > 0 then 'crew'
        when s.mutual_follows >= 2 then 'mutuals'
        when s.mutual_events > 0 then 'together'
        when s.shared_interests > 0 then 'interests'
        else 'nearby'
      end
    )
  from scored s
  -- Somebody with nothing in common at all is not a suggestion, it is a list of
  -- strangers. v1 returned them, ranked by distance.
  where s.follows_me
     or s.shared_communities > 0
     or s.shared_crews > 0
     or s.mutual_follows > 0
     or s.mutual_events > 0
     or s.shared_interests > 0
     or p_event_id is not null
  order by score desc, s.username
  limit greatest(1, least(coalesce(p_limit, 20), 100));
$$;

grant execute on function public.recommend_people(uuid, uuid, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- People you may know, inside a community
-- ---------------------------------------------------------------------------
-- The place the question is actually asked. Same evidence, scoped to one room,
-- and it excludes the people you already follow so the list is somebody to meet
-- rather than a membership roll.
create or replace function public.community_people_you_may_know(
  p_community_id uuid,
  p_user_id      uuid default auth.uid(),
  p_limit        integer default 12
)
returns table (
  user_id      uuid,
  username     text,
  display_name text,
  avatar_url   text,
  mutual_follows integer,
  mutual_events  integer,
  role         community_role,
  reason       text
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  select
    p.id, p.username::text, p.display_name, p.avatar_url,
    (
      select count(*)::integer
      from public.follows f1
      join public.follows f2 on f2.following_id = f1.following_id and f2.follower_id = p_user_id
      where f1.follower_id = p.id
    ) as mutual_follows,
    (
      select count(*)::integer
      from public.event_attendees a1
      join public.event_attendees a2 on a2.event_id = a1.event_id and a2.user_id = p_user_id
      where a1.user_id = p.id
    ) as mutual_events,
    cm.role,
    case
      when exists (select 1 from public.follows f
                   where f.follower_id = p.id and f.following_id = p_user_id) then 'follows_you'
      when exists (
        select 1 from public.event_attendees a1
        join public.event_attendees a2 on a2.event_id = a1.event_id and a2.user_id = p_user_id
        where a1.user_id = p.id
      ) then 'together'
      else 'community'
    end as reason
  from public.community_members cm
  join public.profiles p on p.id = cm.user_id
  where cm.community_id = p_community_id
    and p.id <> p_user_id
    and not p.is_suspended
    and not p.anonymous_mode
    -- Only for members. A private community's roll is not a public directory,
    -- and this function reads it under the definer's rights.
    and exists (
      select 1 from public.community_members mine
      where mine.community_id = p_community_id and mine.user_id = p_user_id
    )
    and not exists (
      select 1 from public.follows f
      where f.follower_id = p_user_id and f.following_id = p.id
    )
    and not exists (
      select 1 from public.connect_dismissals d
      where d.user_id = p_user_id and d.dismissed_id = p.id
    )
  order by
    exists (select 1 from public.follows f
            where f.follower_id = p.id and f.following_id = p_user_id) desc,
    (
      select count(*) from public.follows f1
      join public.follows f2 on f2.following_id = f1.following_id and f2.follower_id = p_user_id
      where f1.follower_id = p.id
    ) desc,
    p.username
  limit greatest(1, least(coalesce(p_limit, 12), 50));
$$;

revoke all on function public.community_people_you_may_know(uuid, uuid, integer) from public, anon;
grant execute on function public.community_people_you_may_know(uuid, uuid, integer) to authenticated;
