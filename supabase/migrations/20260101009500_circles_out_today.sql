-- ---------------------------------------------------------------------------
-- „Tvoje kruhy dnes niekam idú" — only when they actually do.
--
-- The strip on the home screen was drawn from getFollowing(): everybody you
-- follow, with no reference to today at all. Follow one person and the app
-- announced that your circles were going out tonight, every night, forever.
-- It is a small line of text and it was simply not true, which is worse than
-- it being absent.
--
-- This is the query the line was always claiming to be: the people you follow
-- who are going to something that is on today, in *their* local reckoning of
-- today — an event at 01:00 tonight is still tonight to the person going to
-- it, so the window runs to the end of the day rather than the next 24 hours.
-- ---------------------------------------------------------------------------
create or replace function public.circles_out_today(p_limit integer default 12)
returns table (
  id            uuid,
  display_name  text,
  username      text,
  avatar_url    text,
  event_id      uuid,
  event_title   text,
  event_start_at timestamptz
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  with window_today as (
    select date_trunc('day', now()) as from_at,
           date_trunc('day', now()) + interval '1 day' as to_at
  ),
  -- One row per person: the first thing they are going to today, so somebody
  -- with three events does not take three of the five avatars.
  theirs as (
    select distinct on (a.user_id)
      a.user_id, e.id as event_id, e.title, e.start_at
    from public.event_attendees a
    join public.events e on e.id = a.event_id
    cross join window_today w
    where a.status in ('going', 'checked_in')
      and e.status = 'published'
      and e.visibility = 'public'
      -- On today: either it starts today, or it started earlier and is still
      -- running. A three-day festival counts on all three days.
      and e.start_at < w.to_at
      and coalesce(e.end_at, e.start_at) >= w.from_at
      and a.user_id in (
        select f.following_id from public.follows f where f.follower_id = auth.uid()
      )
    order by a.user_id, e.start_at
  )
  select p.id, p.display_name, p.username, p.avatar_url,
         theirs.event_id, theirs.title, theirs.start_at
  from theirs
  join public.profiles p on p.id = theirs.user_id
  where not p.is_suspended
  order by theirs.start_at
  limit greatest(p_limit, 1);
$$;

revoke execute on function public.circles_out_today(integer) from public;
grant execute on function public.circles_out_today(integer) to authenticated;
