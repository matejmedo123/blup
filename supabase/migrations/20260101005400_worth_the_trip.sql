-- ============================================================================
-- BLUP · 0054 · Events worth travelling for
-- ============================================================================
-- Discovery stops at the radius, which is right for "what is on tonight" and
-- wrong for everything else. Somebody in Nitra never sees the one concert in
-- Bratislava they would actually have driven to — not because it was ranked
-- low, but because it was never in the list.
--
-- This is the second list: deliberately few, deliberately far, and only things
-- that clear a much higher bar than a nearby event has to. A short trip is a
-- real cost, so the answer has to be worth it — an event nobody is going to,
-- two hours away, is noise.
-- ============================================================================
set search_path = public, extensions;

create or replace function public.events_worth_the_trip(
  p_user_id  uuid default auth.uid(),
  p_lat      double precision default null,
  p_lon      double precision default null,
  -- Where the local list ends; this one starts there.
  p_near_m   double precision default 50000,
  -- And stops here: beyond about two hours nobody is going for the evening.
  p_far_m    double precision default 220000,
  p_limit    integer default 6
)
returns setof public.event_feed_item
language sql
stable
security definer
set search_path = public, extensions
as $$
  with me as (
    select
      coalesce(p_lat, pr.latitude)  as lat,
      coalesce(p_lon, pr.longitude) as lon
    from public.profiles pr
    where pr.id = p_user_id
  ),
  -- What this person has shown they care about: the categories they ticked, and
  -- the categories of events they have actually gone to.
  taste as (
    select distinct c as category
    from (
      select i.category as c
      from public.user_interests ui
      join public.interests i on i.id = ui.interest_id
      where ui.user_id = p_user_id
      union all
      select e.category
      from public.event_attendees a
      join public.events e on e.id = a.event_id
      where a.user_id = p_user_id and a.status in ('going', 'checked_in')
    ) t
    where c is not null
  ),
  candidates as (
    select
      e.*,
      public.blup_distance_m(m.lat, m.lon, e.latitude, e.longitude) as distance_m
    from public.events e, me m
    where m.lat is not null
      and e.status = 'published'
      and e.visibility = 'public'
      and not e.listed_by_platform
      and coalesce(e.end_at, e.start_at + interval '4 hours') >= now()
      -- Far enough ahead to actually plan a trip.
      and e.start_at <= now() + interval '45 days'
      and e.creator_id is distinct from p_user_id
      -- Not already in the local list, and not unreachably far.
      and public.blup_distance_m(m.lat, m.lon, e.latitude, e.longitude) between p_near_m and p_far_m
      -- Nothing they have already responded to.
      and not exists (
        select 1 from public.event_attendees a
        where a.event_id = e.id and a.user_id = p_user_id
      )
  ),
  scored as (
    select
      c.*,
      (
        -- The bar: this has to be an event, not just an event that exists.
        -- Attendance is the strongest honest signal of that.
        least(1.0, c.attendee_count / 40.0) * 3.0
        + least(1.0, c.saved_count / 25.0) * 1.0
        -- Matching what they like counts for a lot at this distance: nobody
        -- drives an hour for a category they are indifferent to.
        + case when exists (select 1 from taste t where t.category = any (c.categories))
               then 2.5 else 0.0 end
        -- Friends going is the reason people travel.
        + least(1.0, (
            select count(*) from public.event_attendees a
            join public.friendships f
              on ((f.requester_id = p_user_id and f.addressee_id = a.user_id)
               or (f.addressee_id = p_user_id and f.requester_id = a.user_id))
            where a.event_id = c.id and a.status = 'going' and f.status = 'accepted'
          ) / 3.0) * 3.0
        -- And distance still costs something, just far less than it does nearby.
        - (c.distance_m / p_far_m) * 1.5
      ) as trip_score
    from candidates c
  )
  select
    s.id, s.title, s.description, s.cover_image_url, s.category, s.tags,
    s.latitude, s.longitude, s.address, s.venue_name, s.city,
    s.start_at, s.end_at, s.is_free, s.price_cents, s.currency, s.capacity,
    s.attendee_count, s.saved_count, s.like_count, s.comment_count,
    s.status, s.visibility, s.creator_id,
    p.username, p.display_name, p.avatar_url,
    s.organization_id, o.name, (o.verification_status = 'verified'),
    s.distance_m,
    0::integer as friends_going,
    false      as is_saved,
    false      as is_attending,
    s.trip_score::numeric as score,
    jsonb_build_object('reason', 'worth_the_trip', 'distance_km', round((s.distance_m / 1000)::numeric))
  from scored s
  left join public.profiles p on p.id = s.creator_id
  left join public.organizations o on o.id = s.organization_id
  -- A real bar, not a ranking: below this nothing is shown at all, because an
  -- empty section is a better answer than a bad suggestion two hours away.
  where s.trip_score >= 2.0
  order by s.trip_score desc, s.start_at asc
  limit p_limit;
$$;

grant execute on function public.events_worth_the_trip(uuid, double precision, double precision, double precision, double precision, integer)
  to anon, authenticated;
