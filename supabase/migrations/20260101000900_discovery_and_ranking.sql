-- ============================================================================
-- BLUP · 0009 · Discovery RPCs and the recommendation ranker
-- ============================================================================
-- These functions are the read API for the app. They are SECURITY INVOKER on
-- purpose where possible so RLS still applies; where SECURITY DEFINER is used,
-- visibility is re-checked explicitly inside the query.
-- ============================================================================

-- Shared row shape for every event list the app renders.
drop type if exists public.event_feed_item cascade;
create type public.event_feed_item as (
  id               uuid,
  title            text,
  description      text,
  cover_image_url  text,
  category         text,
  tags             text[],
  latitude         double precision,
  longitude        double precision,
  address          text,
  venue_name       text,
  city             text,
  start_at         timestamptz,
  end_at           timestamptz,
  is_free          boolean,
  price_cents      integer,
  currency         text,
  capacity         integer,
  attendee_count   integer,
  saved_count      integer,
  like_count       integer,
  comment_count    integer,
  status           event_status,
  visibility       event_visibility,
  creator_id       uuid,
  creator_username text,
  creator_display_name text,
  creator_avatar_url text,
  organization_id  uuid,
  organization_name text,
  organization_verified boolean,
  distance_m       double precision,
  friends_going    integer,
  is_saved         boolean,
  is_attending     boolean,
  score            numeric,
  score_breakdown  jsonb
);

-- ---------------------------------------------------------------------------
-- events_nearby: plain geo + time query (the map and "Today near me" rail)
-- ---------------------------------------------------------------------------
create or replace function public.events_nearby(
  p_lat        double precision,
  p_lon        double precision,
  p_radius_m   double precision default 25000,
  p_from       timestamptz default now(),
  p_to         timestamptz default null,
  p_categories text[] default null,
  p_free_only  boolean default false,
  p_limit      integer default 50,
  p_offset     integer default 0
)
returns setof public.event_feed_item
language sql
stable
security definer
set search_path = public
as $$
  with me as (select auth.uid() as uid),
  bbox as (
    select
      p_lat - public.blup_lat_delta(p_radius_m) as min_lat,
      p_lat + public.blup_lat_delta(p_radius_m) as max_lat,
      p_lon - public.blup_lon_delta(p_radius_m, p_lat) as min_lon,
      p_lon + public.blup_lon_delta(p_radius_m, p_lat) as max_lon
  )
  select
    e.id, e.title, e.description, e.cover_image_url, e.category, e.tags,
    e.latitude, e.longitude, e.address, e.venue_name, e.city,
    e.start_at, e.end_at, e.is_free, e.price_cents, e.currency, e.capacity,
    e.attendee_count, e.saved_count, e.like_count, e.comment_count,
    e.status, e.visibility,
    e.creator_id, p.username::text, p.display_name, p.avatar_url,
    e.organization_id, o.name, (o.verification_status = 'verified'),
    public.blup_distance_m(p_lat, p_lon, e.latitude, e.longitude) as distance_m,
    (
      select count(*)::integer from public.event_attendees a
      join public.follows f on f.following_id = a.user_id
      where a.event_id = e.id and a.status in ('going', 'checked_in')
        and f.follower_id = (select uid from me)
    ) as friends_going,
    exists (select 1 from public.saved_events s
            where s.event_id = e.id and s.user_id = (select uid from me)) as is_saved,
    exists (select 1 from public.event_attendees a
            where a.event_id = e.id and a.user_id = (select uid from me)
              and a.status in ('going', 'interested', 'checked_in')) as is_attending,
    null::numeric as score,
    null::jsonb as score_breakdown
  from public.events e
  join public.profiles p on p.id = e.creator_id
  left join public.organizations o on o.id = e.organization_id
  cross join bbox b
  where e.status = 'published'
    and e.visibility in ('public', 'unlisted')
    and e.latitude between b.min_lat and b.max_lat
    and e.longitude between b.min_lon and b.max_lon
    and public.blup_distance_m(p_lat, p_lon, e.latitude, e.longitude) <= p_radius_m
    and coalesce(e.end_at, e.start_at + interval '4 hours') >= coalesce(p_from, now())
    and (p_to is null or e.start_at <= p_to)
    and (p_categories is null or e.category = any (p_categories))
    and (not p_free_only or e.is_free)
  order by e.start_at asc, distance_m asc
  limit greatest(1, least(coalesce(p_limit, 50), 200))
  offset greatest(0, coalesce(p_offset, 0));
$$;

-- ---------------------------------------------------------------------------
-- search_events: full-text + filters (Explore tab)
-- ---------------------------------------------------------------------------
create or replace function public.search_events(
  p_query      text default null,
  p_lat        double precision default null,
  p_lon        double precision default null,
  p_radius_m   double precision default null,
  p_from       timestamptz default now(),
  p_to         timestamptz default null,
  p_categories text[] default null,
  p_free_only  boolean default false,
  p_max_price_cents integer default null,
  p_sort       text default 'start_at',   -- start_at | distance | popularity
  p_limit      integer default 40,
  p_offset     integer default 0
)
returns setof public.event_feed_item
language sql
stable
security definer
set search_path = public
as $$
  with me as (select auth.uid() as uid)
  select
    e.id, e.title, e.description, e.cover_image_url, e.category, e.tags,
    e.latitude, e.longitude, e.address, e.venue_name, e.city,
    e.start_at, e.end_at, e.is_free, e.price_cents, e.currency, e.capacity,
    e.attendee_count, e.saved_count, e.like_count, e.comment_count,
    e.status, e.visibility,
    e.creator_id, p.username::text, p.display_name, p.avatar_url,
    e.organization_id, o.name, (o.verification_status = 'verified'),
    case when p_lat is null or p_lon is null then null
         else public.blup_distance_m(p_lat, p_lon, e.latitude, e.longitude) end as distance_m,
    (
      select count(*)::integer from public.event_attendees a
      join public.follows f on f.following_id = a.user_id
      where a.event_id = e.id and a.status in ('going', 'checked_in')
        and f.follower_id = (select uid from me)
    ),
    exists (select 1 from public.saved_events s
            where s.event_id = e.id and s.user_id = (select uid from me)),
    exists (select 1 from public.event_attendees a
            where a.event_id = e.id and a.user_id = (select uid from me)
              and a.status in ('going', 'interested', 'checked_in')),
    null::numeric,
    null::jsonb
  from public.events e
  join public.profiles p on p.id = e.creator_id
  left join public.organizations o on o.id = e.organization_id
  where e.status = 'published'
    and e.visibility in ('public', 'unlisted')
    and coalesce(e.end_at, e.start_at + interval '4 hours') >= coalesce(p_from, now())
    and (p_to is null or e.start_at <= p_to)
    and (p_categories is null or e.category = any (p_categories))
    and (not p_free_only or e.is_free)
    and (p_max_price_cents is null or e.price_cents <= p_max_price_cents)
    and (
      p_query is null or char_length(trim(p_query)) = 0
      or to_tsvector('simple',
           coalesce(e.title, '') || ' ' || coalesce(e.description, '') || ' ' ||
           coalesce(e.venue_name, '') || ' ' || coalesce(e.city, ''))
         @@ plainto_tsquery('simple', p_query)
      or e.title ilike '%' || p_query || '%'
      or p_query = any (e.tags)
    )
    and (
      p_radius_m is null or p_lat is null or p_lon is null
      or public.blup_distance_m(p_lat, p_lon, e.latitude, e.longitude) <= p_radius_m
    )
  order by
    case when p_sort = 'distance' and p_lat is not null
         then public.blup_distance_m(p_lat, p_lon, e.latitude, e.longitude) end asc nulls last,
    case when p_sort = 'popularity'
         then (e.attendee_count + e.saved_count) end desc nulls last,
    case when p_sort not in ('distance', 'popularity') then e.start_at end asc
  limit greatest(1, least(coalesce(p_limit, 40), 100))
  offset greatest(0, coalesce(p_offset, 0));
$$;

-- ---------------------------------------------------------------------------
-- recommend_events: the BLUP ranker (spec §10)
--
--   score = 0.30 * interest_match
--         + 0.22 * distance_score
--         + 0.16 * social_relevance
--         + 0.14 * past_behaviour
--         + 0.10 * popularity
--         + 0.08 * time_relevance
--
-- Every component is normalised to 0..1 and returned in `score_breakdown`
-- so the debug screen can explain any recommendation.
-- ---------------------------------------------------------------------------
create or replace function public.recommend_events(
  p_user_id  uuid default auth.uid(),
  p_lat      double precision default null,
  p_lon      double precision default null,
  p_radius_m double precision default 50000,
  p_limit    integer default 30,
  p_offset   integer default 0
)
returns setof public.event_feed_item
language sql
stable
security definer
set search_path = public
as $$
  with
  viewer as (
    select
      coalesce(p_lat, pr.latitude)  as lat,
      coalesce(p_lon, pr.longitude) as lon
    from public.profiles pr
    where pr.id = p_user_id
  ),
  my_interests as (
    select i.slug, i.category, ui.weight
    from public.user_interests ui
    join public.interests i on i.id = ui.interest_id
    where ui.user_id = p_user_id
  ),
  interest_total as (
    select greatest(1, count(*))::numeric as n from my_interests
  ),
  -- Category affinity learned from past behaviour.
  behaviour as (
    select
      e.category,
      sum(
        case s.signal
          when 'swipe_right'     then 1.0
          when 'save'            then 1.5
          when 'rsvp_going'      then 2.0
          when 'rsvp_interested' then 1.0
          when 'ticket_purchase' then 3.0
          when 'attended'        then 3.0
          when 'like'            then 1.0
          when 'open_detail'     then 0.4
          when 'comment'         then 1.0
          when 'share'           then 1.0
          when 'swipe_left'      then -1.5
          else 0.0
        end * s.weight
      ) as affinity
    from public.user_event_signals s
    join public.events e on e.id = s.event_id
    where s.user_id = p_user_id
      and s.created_at > now() - interval '180 days'
    group by e.category
  ),
  behaviour_max as (
    select greatest(1.0, coalesce(max(abs(affinity)), 1.0)) as m from behaviour
  ),
  candidates as (
    select
      e.*,
      case
        when (select lat from viewer) is null then null
        else public.blup_distance_m((select lat from viewer), (select lon from viewer),
                                    e.latitude, e.longitude)
      end as distance_m,
      (
        select count(*)::integer
        from public.event_attendees a
        join public.follows f on f.following_id = a.user_id
        where a.event_id = e.id and a.status in ('going', 'checked_in')
          and f.follower_id = p_user_id
      ) as friends_going,
      exists (
        select 1 from public.follows f where f.follower_id = p_user_id and f.following_id = e.creator_id
      ) as follows_creator,
      (
        select count(*)::numeric
        from my_interests mi
        where mi.slug = e.category
           or mi.category = e.category
           or mi.slug = any (e.tags)
      ) as interest_hits,
      coalesce((select b.affinity from behaviour b where b.category = e.category), 0)::numeric as cat_affinity
    from public.events e
    where e.status = 'published'
      and e.visibility in ('public', 'unlisted')
      and e.start_at > now() - interval '2 hours'
      and e.creator_id <> p_user_id
      -- exclude what the user already dismissed
      and not exists (
        select 1 from public.user_event_signals s
        where s.user_id = p_user_id and s.event_id = e.id and s.signal = 'swipe_left'
      )
  ),
  scored as (
    select
      c.*,
      -- 1. interest match: 3 matching interests == perfect
      least(1.0, c.interest_hits / 3.0) as s_interest,
      -- 2. distance: linear decay inside the radius; unknown location == neutral
      case
        when c.distance_m is null then 0.5
        when c.distance_m > p_radius_m then 0.0
        else 1.0 - (c.distance_m / nullif(p_radius_m, 0))
      end as s_distance,
      -- 3. social relevance
      least(1.0, (c.friends_going::numeric / 3.0) + case when c.follows_creator then 0.34 else 0 end)
        as s_social,
      -- 4. past behaviour (normalised, clamped to 0..1)
      greatest(0.0, least(1.0, 0.5 + (c.cat_affinity / (2.0 * (select m from behaviour_max)))))
        as s_behaviour,
      -- 5. popularity
      least(1.0, (c.attendee_count + 0.5 * c.saved_count + 0.05 * c.view_count)::numeric / 50.0)
        as s_popularity,
      -- 6. time relevance: soon is better, 14-day horizon
      case
        when c.start_at < now() then 0.0
        when c.start_at <= now() + interval '24 hours' then 1.0
        else greatest(0.0,
          1.0 - (extract(epoch from (c.start_at - now())) / 3600.0 - 24.0) / (24.0 * 14.0))
      end as s_time
    from candidates c
    where c.distance_m is null or c.distance_m <= p_radius_m
  ),
  final as (
    select
      s.*,
      round(
        (0.30 * s.s_interest + 0.22 * s.s_distance + 0.16 * s.s_social +
         0.14 * s.s_behaviour + 0.10 * s.s_popularity + 0.08 * s.s_time)::numeric,
        4
      ) as total_score
    from scored s
  )
  select
    f.id, f.title, f.description, f.cover_image_url, f.category, f.tags,
    f.latitude, f.longitude, f.address, f.venue_name, f.city,
    f.start_at, f.end_at, f.is_free, f.price_cents, f.currency, f.capacity,
    f.attendee_count, f.saved_count, f.like_count, f.comment_count,
    f.status, f.visibility,
    f.creator_id, p.username::text, p.display_name, p.avatar_url,
    f.organization_id, o.name, (o.verification_status = 'verified'),
    f.distance_m,
    f.friends_going,
    exists (select 1 from public.saved_events se where se.event_id = f.id and se.user_id = p_user_id),
    exists (select 1 from public.event_attendees a
            where a.event_id = f.id and a.user_id = p_user_id
              and a.status in ('going', 'interested', 'checked_in')),
    f.total_score,
    jsonb_build_object(
      'engine', 'sql_ranker_v1',
      'final_score', f.total_score,
      'components', jsonb_build_object(
        'interest_match',   round(f.s_interest::numeric, 4),
        'distance_score',   round(f.s_distance::numeric, 4),
        'social_relevance', round(f.s_social::numeric, 4),
        'past_behaviour',   round(f.s_behaviour::numeric, 4),
        'popularity',       round(f.s_popularity::numeric, 4),
        'time_relevance',   round(f.s_time::numeric, 4)
      ),
      'weights', jsonb_build_object(
        'interest_match', 0.30, 'distance_score', 0.22, 'social_relevance', 0.16,
        'past_behaviour', 0.14, 'popularity', 0.10, 'time_relevance', 0.08
      ),
      'facts', jsonb_build_object(
        'interest_hits', f.interest_hits,
        'friends_going', f.friends_going,
        'follows_creator', f.follows_creator,
        'distance_m', round(coalesce(f.distance_m, 0)::numeric, 0),
        'category_affinity', round(f.cat_affinity, 2)
      )
    )
  from final f
  join public.profiles p on p.id = f.creator_id
  left join public.organizations o on o.id = f.organization_id
  order by f.total_score desc, f.start_at asc
  limit greatest(1, least(coalesce(p_limit, 30), 100))
  offset greatest(0, coalesce(p_offset, 0));
$$;

-- Persists a recommendation run so the debug screen shows what was actually served.
create or replace function public.log_recommendation_run(
  p_context text,
  p_params  jsonb,
  p_items   jsonb   -- [{ event_id, rank, score, breakdown }]
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run_id uuid;
begin
  if auth.uid() is null then
    return null;
  end if;

  insert into public.ai_recommendation_runs (user_id, context, params)
  values (auth.uid(), coalesce(p_context, 'for_you'), coalesce(p_params, '{}'::jsonb))
  returning id into v_run_id;

  insert into public.ai_recommendation_items (run_id, event_id, rank, score, breakdown)
  select
    v_run_id,
    (item ->> 'event_id')::uuid,
    coalesce((item ->> 'rank')::integer, 0),
    coalesce((item ->> 'score')::numeric, 0),
    coalesce(item -> 'breakdown', '{}'::jsonb)
  from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) as item
  on conflict (run_id, event_id) do nothing;

  return v_run_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- recommend_people: "People like you" (spec §11)
-- ---------------------------------------------------------------------------
create or replace function public.recommend_people(
  p_user_id uuid default auth.uid(),
  p_event_id uuid default null,   -- when set: rank people attending this event
  p_limit   integer default 20
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
set search_path = public
as $$
  with me as (
    select id, latitude, longitude from public.profiles where id = p_user_id
  ),
  my_interests as (
    select interest_id from public.user_interests where user_id = p_user_id
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
      (
        select count(*)::integer
        from public.follows f1
        join public.follows f2 on f2.following_id = f1.following_id and f2.follower_id = p_user_id
        where f1.follower_id = c.id
      ) as mutual_follows,
      case
        when (select latitude from me) is null or c.latitude is null then null
        else public.blup_distance_m((select latitude from me), (select longitude from me),
                                    c.latitude, c.longitude)
      end as distance_m
    from candidates c
  )
  select
    e.id, e.username::text, e.display_name, e.avatar_url, e.bio, e.city,
    e.shared_interests,
    e.shared_interest_names,
    e.mutual_events,
    e.mutual_follows,
    (p_event_id is not null) as same_event,
    e.distance_m,
    round((
      0.45 * least(1.0, e.shared_interests::numeric / 4.0) +
      0.25 * least(1.0, e.mutual_events::numeric / 3.0) +
      0.20 * least(1.0, e.mutual_follows::numeric / 5.0) +
      0.10 * case
               when e.distance_m is null then 0.5
               else greatest(0.0, 1.0 - least(1.0, e.distance_m / 50000.0))
             end
    )::numeric, 4) as score,
    jsonb_build_object(
      'components', jsonb_build_object(
        'shared_interests', e.shared_interests,
        'mutual_events', e.mutual_events,
        'mutual_follows', e.mutual_follows,
        'distance_m', round(coalesce(e.distance_m, 0)::numeric, 0)
      ),
      'weights', jsonb_build_object(
        'shared_interests', 0.45, 'mutual_events', 0.25,
        'mutual_follows', 0.20, 'proximity', 0.10
      )
    )
  from enriched e
  where e.shared_interests > 0 or e.mutual_events > 0 or e.mutual_follows > 0 or p_event_id is not null
  order by score desc, e.shared_interests desc
  limit greatest(1, least(coalesce(p_limit, 20), 50));
$$;

-- ---------------------------------------------------------------------------
-- Organizer analytics (spec §33)
-- ---------------------------------------------------------------------------
create or replace function public.event_analytics(p_event_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  ev     record;
  result jsonb;
begin
  select * into ev from public.events where id = p_event_id;
  if not found then
    raise exception 'EVENT_NOT_FOUND';
  end if;

  if not (
    ev.creator_id = auth.uid()
    or (ev.organization_id is not null and public.is_org_member(ev.organization_id, null, auth.uid()))
    or public.is_admin()
  ) then
    raise exception 'NOT_AUTHORIZED';
  end if;

  select jsonb_build_object(
    'event_id', ev.id,
    'title', ev.title,
    'views', ev.view_count,
    'unique_viewers', (select count(distinct user_id) from public.event_views where event_id = ev.id),
    'saves', ev.saved_count,
    'likes', ev.like_count,
    'comments', ev.comment_count,
    'rsvp_going', ev.attendee_count,
    'rsvp_interested', ev.interested_count,
    'checked_in', (select count(*) from public.tickets where event_id = ev.id and status = 'used'),
    'tickets_sold', ev.tickets_sold,
    'conversion_rate', case when ev.view_count > 0
                            then round((ev.tickets_sold::numeric / ev.view_count) * 100, 2)
                            else 0 end,
    'gross_revenue_cents', coalesce((
      select sum(o.subtotal_cents) from public.orders o
      where o.event_id = ev.id and o.payment_status = 'succeeded'), 0),
    'platform_fee_cents', coalesce((
      select sum(o.platform_fee_cents) from public.orders o
      where o.event_id = ev.id and o.payment_status = 'succeeded'), 0),
    'organizer_net_cents', coalesce((
      select sum(o.subtotal_cents - o.platform_fee_cents) from public.orders o
      where o.event_id = ev.id and o.payment_status = 'succeeded'), 0),
    'currency', ev.currency
  ) into result;

  return result;
end;
$$;
